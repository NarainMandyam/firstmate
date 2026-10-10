import { expect, test } from "claude-code/testing";

import {
  crossCheckTargets,
  formatGb,
  parseDfKb,
  parseDuKb,
  parseMetaWorktree,
} from "../hooks/register";

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
