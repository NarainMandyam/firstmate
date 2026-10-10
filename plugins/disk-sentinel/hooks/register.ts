import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { DiskSentinelStatus } from "../types";

const POLL_MS = 60_000;
const DEFAULT_THRESHOLD_GB = 15;
// The status line stays empty until free space is this close above the threshold.
const NEAR_MARGIN_GB = 10;
const DISK_PATH = "/System/Volumes/Data";
const WARN = "⚠";
const KB_PER_GB = 1024 * 1024;

const lastStatus = atom(
  { plugin: "disk-sentinel", key: "lastStatus" } as const,
  null,
);

export type TargetDir = { path: string; sizeKb: number };
export type LiveWorktree = { taskId: string; worktree: string };
export type TargetReport = TargetDir & { isLive: boolean; ownerTaskId?: string };

/** Parses `df -k`'s last line: Filesystem, 1024-blocks, Used, Available, ... */
export function parseDfKb(
  stdout: string,
): { totalKb: number; availKb: number } | undefined {
  const lines = stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return undefined;

  const fields = last.trim().split(/\s+/);
  const totalKb = Number(fields[1]);
  const availKb = Number(fields[3]);

  return Number.isFinite(totalKb) && Number.isFinite(availKb)
    ? { totalKb, availKb }
    : undefined;
}

/** Parses `du -sk <path>`'s output: a size in KB, then a tab, then the path. */
export function parseDuKb(stdout: string): number | undefined {
  const size = Number(stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(size) ? size : undefined;
}

/** Parses one `state/<id>.meta` file's `worktree=` line. */
export function parseMetaWorktree(metaText: string): string | undefined {
  const match = metaText.match(/^worktree=(.*)$/m);
  return match?.[1]?.trim() || undefined;
}

export function formatGb(kb: number): string {
  return `${(kb / KB_PER_GB).toFixed(1)}G`;
}

/**
 * The status-line entry for `freeKb` of free space against `thresholdGb`:
 * nothing while free space is comfortably above the threshold (more than
 * NEAR_MARGIN_GB over it), `disk <N>G free` once it is within that margin,
 * and the same flagged `⚠` once it is below.
 */
export function statusText(freeKb: number, thresholdGb: number): string | undefined {
  if (freeKb >= (thresholdGb + NEAR_MARGIN_GB) * KB_PER_GB) return undefined;
  const reading = `disk ${formatGb(freeKb)} free`;
  return freeKb < thresholdGb * KB_PER_GB ? `${WARN} ${reading}` : reading;
}

/** `path` with the home directory folded to `~`, so a listing stays short. */
export function tildify(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

/** Marks each target dir live when it sits under a recorded live worktree. */
export function crossCheckTargets(
  targets: readonly TargetDir[],
  liveWorktrees: readonly LiveWorktree[],
): TargetReport[] {
  return targets.map(target => {
    const owner = liveWorktrees.find(
      w =>
        target.path === w.worktree ||
        target.path.startsWith(w.worktree.replace(/\/+$/, "") + "/"),
    );

    return {
      ...target,
      isLive: owner !== undefined,
      ownerTaskId: owner?.taskId,
    };
  });
}

/**
 * Whether `root` looks like a firstmate home: its own `AGENTS.md` and
 * `bin/fm-session-start.sh`, resolved relative to `root` rather than a
 * hardcoded path so the check holds for any captain's checkout.
 */
export async function isFirstmateHome($: EngineInterface, root: string): Promise<boolean> {
  const agents = await $.fs.read(`${root}/AGENTS.md`).catch(() => undefined);
  if (agents === undefined || !agents.trimStart().startsWith("# Firstmate")) {
    return false;
  }

  return $.fs.exists(`${root}/bin/fm-session-start.sh`).catch(() => false);
}

/**
 * The firstmate home root when this session is firstmate's own primary
 * session (no `FM_TASK_ID`, a session root that looks like a firstmate
 * home), `undefined` otherwise - the scope gate every hook below checks
 * first so the mod stays inert in a crewmate or secondmate session and in
 * any other project.
 */
export async function activeHome($: EngineInterface): Promise<string | undefined> {
  const taskId = await $.env.get("FM_TASK_ID");
  if (taskId) return undefined;

  const root = await $.session.root();
  return (await isFirstmateHome($, root)) ? root : undefined;
}

async function liveWorktreesOf($: EngineInterface, root: string): Promise<LiveWorktree[]> {
  const stateDir = `${root}/state`;
  if (!(await $.fs.exists(stateDir).catch(() => false))) return [];

  const entries = await $.fs.list(stateDir).catch(() => []);
  const metaFiles = entries.filter(e => e.kind === "file" && e.name.endsWith(".meta"));

  const result: LiveWorktree[] = [];
  for (const entry of metaFiles) {
    const text = await $.fs.read(`${stateDir}/${entry.name}`).catch(() => undefined);
    if (text === undefined) continue;

    const worktree = parseMetaWorktree(text);
    if (worktree) result.push({ taskId: entry.name.slice(0, -".meta".length), worktree });
  }

  return result;
}

async function pollDisk($: EngineInterface, thresholdGb: number): Promise<void> {
  const home = await activeHome($);
  if (home === undefined) return;

  const ran = await $.process.run(["df", "-k", DISK_PATH]).catch(() => undefined);
  const parsed = ran && ran.exitCode === 0 ? parseDfKb(ran.stdout) : undefined;
  if (parsed === undefined) {
    $.ui.status(undefined);
    return;
  }

  $.ui.status(statusText(parsed.availKb, thresholdGb));

  const isBelowThreshold = parsed.availKb < thresholdGb * KB_PER_GB;
  const previous = await read($, lastStatus);

  if (isBelowThreshold && !(previous?.isBelowThreshold ?? false)) {
    const line = `${formatGb(parsed.availKb)} free on disk, under the ${thresholdGb}G line.`;
    $.ui.toast(`${line} /targets lists build caches you could clear.`, { timeoutMs: 10_000 });
    await $.ui.notify(line, { title: "disk-sentinel" }).catch(() => undefined);
  }

  const status: DiskSentinelStatus = {
    freeKb: parsed.availKb,
    totalKb: parsed.totalKb,
    isBelowThreshold,
  };
  await update($, lastStatus, () => status);
}

async function listTargets($: EngineInterface, root: string): Promise<string> {
  const home = await $.env.get("HOME");
  if (!home) return "disk-sentinel: HOME is not set, so treehouse copies cannot be located.";

  const treehouseDir = `${home}/.treehouse`;
  if (!(await $.fs.exists(treehouseDir).catch(() => false))) {
    return `No target dirs found under ${treehouseDir}.`;
  }

  const found = await $.process
    .run(["find", treehouseDir, "-type", "d", "-name", "target"], { timeoutMs: 30_000 })
    .catch(() => undefined);
  if (found === undefined || found.exitCode !== 0) {
    return `disk-sentinel: listing ${treehouseDir} failed.`;
  }

  const paths = found.stdout
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  if (paths.length === 0) return `No target dirs found under ${treehouseDir}.`;

  const sized: TargetDir[] = [];
  for (const path of paths) {
    const du = await $.process.run(["du", "-sk", path], { timeoutMs: 60_000 }).catch(() => undefined);
    sized.push({ path, sizeKb: du ? parseDuKb(du.stdout) ?? 0 : 0 });
  }

  const liveWorktrees = await liveWorktreesOf($, root);
  const report = crossCheckTargets(sized, liveWorktrees);
  return formatTargets(report, home);
}

/**
 * The /targets listing: idle dirs first (the ones that can go), largest
 * first within each group, each row its size, `idle` or the live task, and
 * its path with the home directory folded to `~`.
 */
export function formatTargets(report: readonly TargetReport[], home: string | undefined): string {
  const rows = [...report].sort((a, b) =>
    a.isLive === b.isLive ? b.sizeKb - a.sizeKb : a.isLive ? 1 : -1,
  );
  const totalKb = rows.reduce((sum, r) => sum + r.sizeKb, 0);
  const idleKb = rows.filter(r => !r.isLive).reduce((sum, r) => sum + r.sizeKb, 0);
  const tags = rows.map(r => (r.isLive ? `live ${r.ownerTaskId}` : "idle"));
  const tagWidth = Math.max(...tags.map(t => t.length));

  const lines = [`${rows.length} target dirs · ${formatGb(totalKb)} · ${formatGb(idleKb)} idle`];
  rows.forEach((r, i) => {
    lines.push(`  ${formatGb(r.sizeKb).padStart(7)}  ${tags[i]!.padEnd(tagWidth)}  ${tildify(r.path, home)}`);
  });
  lines.push("Nothing is deleted here; clear an idle one yourself when ready.");

  return lines.join("\n");
}

export const register: Register = (on, options) => {
  const thresholdGb =
    typeof options.freeThresholdGb === "number"
      ? options.freeThresholdGb
      : DEFAULT_THRESHOLD_GB;

  on("session.start", async ($, e, next) => {
    const home = await activeHome($);
    if (home === undefined) return next(e);

    await $.command.register({
      name: "targets",
      description: "List build-cache target dirs under treehouse copies and whether a live task still owns them",
    });

    $.clock.every(POLL_MS, () => {
      void pollDisk($, thresholdGb);
    });
    void pollDisk($, thresholdGb);

    return next(e);
  });

  on("command.run", { command: "targets" }, async $ => {
    const home = await activeHome($);
    if (home === undefined) {
      return { text: "disk-sentinel is inert outside firstmate's primary session." };
    }

    return { text: await listTargets($, home) };
  });
};
