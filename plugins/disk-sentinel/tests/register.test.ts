import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";

import {
  crossCheckTargets,
  formatGb,
  formatTargets,
  parseDfKb,
  parseDuKb,
  parseMetaWorktree,
  statusText,
} from "../hooks/register";

const GB = 1024 * 1024;

test("parseDfKb reads the Available column off df -k's last line", () => {
  const stdout = [
    "Filesystem     1024-blocks      Used Available Capacity Mounted on",
    "/dev/disk3s1s1  994662584  10485760  78643200     12%   /System/Volumes/Data",
  ].join("\n");

  expect(parseDfKb(stdout)).toEqual({ totalKb: 994662584, availKb: 78643200 });
});

test("parseDfKb is undefined on garbage output", () => {
  expect(parseDfKb("")).toBeUndefined();
  expect(parseDfKb("not a df line at all\n")).toBeUndefined();
});

test("parseDuKb reads the leading size off du -sk's output", () => {
  expect(parseDuKb("15728640\t/Users/x/.treehouse/t/firstmate/target\n")).toBe(15728640);
  expect(parseDuKb("garbage")).toBeUndefined();
});

test("parseMetaWorktree reads the worktree= line out of a state/<id>.meta file", () => {
  const meta = ["window=firstmate:w6:p2", "worktree=/Users/x/.treehouse/firstmate-abc/4/firstmate", "project=/Users/x/github/firstmate"].join("\n");

  expect(parseMetaWorktree(meta)).toBe("/Users/x/.treehouse/firstmate-abc/4/firstmate");
  expect(parseMetaWorktree("no worktree line here")).toBeUndefined();
});

test("formatGb renders KB as one-decimal gigabytes", () => {
  expect(formatGb(15 * 1024 * 1024)).toBe("15.0G");
  expect(formatGb(0)).toBe("0.0G");
});

test("crossCheckTargets marks a target dir live only when a recorded worktree owns it", () => {
  const liveTarget = { path: "/h/.treehouse/a/4/firstmate/src-tauri/target", sizeKb: 1000 };
  const idleTarget = { path: "/h/.treehouse/a/9/firstmate/src-tauri/target", sizeKb: 2000 };
  const liveWorktrees = [{ taskId: "fm-mod-crew-seatbelt", worktree: "/h/.treehouse/a/4/firstmate" }];

  const report = crossCheckTargets([liveTarget, idleTarget], liveWorktrees);

  expect(report).toEqual([
    { ...liveTarget, isLive: true, ownerTaskId: "fm-mod-crew-seatbelt" },
    { ...idleTarget, isLive: false, ownerTaskId: undefined },
  ]);
});

test("statusText stays empty until free space is within 10G of the threshold, then flags a crossing", () => {
  expect(statusText(60 * GB, 40)).toBeUndefined();
  expect(statusText(50 * GB, 40)).toBeUndefined();
  expect(statusText(49.9 * GB, 40)).toBe("disk 49.9G free");
  expect(statusText(40 * GB, 40)).toBe("disk 40.0G free");
  expect(statusText(38.2 * GB, 40)).toBe("⚠ disk 38.2G free");
});

test("formatTargets lists idle dirs first, largest first, with the home folded to ~", () => {
  const text = formatTargets(
    [
      { path: "/h/.treehouse/a/4/firstmate/target", sizeKb: 1 * GB, isLive: true, ownerTaskId: "fm-x" },
      { path: "/h/.treehouse/a/9/firstmate/target", sizeKb: 2 * GB, isLive: false },
      { path: "/elsewhere/target", sizeKb: 3 * GB, isLive: false },
    ],
    "/h",
  );

  expect(text).toBe(
    [
      "3 target dirs · 6.0G · 5.0G idle",
      "     3.0G  idle       /elsewhere/target",
      "     2.0G  idle       ~/.treehouse/a/9/firstmate/target",
      "     1.0G  live fm-x  ~/.treehouse/a/4/firstmate/target",
      "Nothing is deleted here; clear an idle one yourself when ready.",
    ].join("\n"),
  );
});

const HOME = "/fleet/home";

// A firstmate home beneath the plugin whose disk reports `freeGb` free; collects the status line and alerts.
function home(on: On, freeGb: number) {
  const w = { statuses: [] as (string | undefined)[], toasts: [] as string[], notices: [] as string[], clock: mock.clock(on) };
  mock.env(on, {});
  on("session.root", () => ({ value: HOME }));
  on("fs.read", ($, e) => {
    if (e.path !== `${HOME}/AGENTS.md`) throw new Error("ENOENT");
    return { value: "# Firstmate\n" };
  });
  on("fs.exists", ($, e) => ({ value: e.path === `${HOME}/bin/fm-session-start.sh` }));
  on("command.register", ($, e) => ({ value: { command: e.name } }));
  on("process.run", ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === "df"
        ? `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 ${1000 * GB} 1 ${Math.round(freeGb * GB)} 1% /System/Volumes/Data\n`
        : "",
      stderr: "", isStdoutTruncated: false, isStderrTruncated: false,
    },
  }));
  on("ui.status", ($, e) => { w.statuses.push(e.text); return { value: undefined }; });
  on("ui.toast", ($, e) => { w.toasts.push(e.text); return { value: undefined }; });
  on("ui.notify", ($, e) => { w.notices.push(e.text); return { value: { isSent: true, channel: "terminal_bell" } }; });
  on("session.start", ($, e) => ({ cwd: e.cwd }));
  return w;
}

test("the status line is cleared while free space is comfortable and warns once below the threshold", { options: { freeThresholdGb: 40 } }, async ($, on) => {
  const w = home(on, 80);
  await $.session.start({ cwd: HOME, surface: "terminal", isInteractive: true });
  await w.clock.settle();
  expect(w.statuses).toEqual([undefined]);
  expect(w.toasts).toHaveLength(0);
});

test("crossing below the threshold shows the warning and alerts once", { options: { freeThresholdGb: 40 } }, async ($, on) => {
  const w = home(on, 38.2);
  await $.session.start({ cwd: HOME, surface: "terminal", isInteractive: true });
  await w.clock.settle();
  expect(w.statuses).toEqual(["⚠ disk 38.2G free"]);
  expect(w.toasts).toEqual(["38.2G free on disk, under the 40G line. /targets lists build caches you could clear."]);
  expect(w.notices).toEqual(["38.2G free on disk, under the 40G line."]);
});
