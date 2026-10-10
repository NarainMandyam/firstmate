import type { EngineInterface, Register } from 'claude-code'

import {
  NO_VERIFY_DENY,
  WW_REMOTE,
  WW_RESERVED,
  dirtyDeny,
  isOn,
  judge,
  reservedDeny,
  reservedDir,
} from './rules'
import type { Probe } from './rules'

// Deny-only: every hook either refuses with the safe alternative or passes
// the call on unchanged. A guard that throws refuses (the `.catch` below).
const FAILED = 'crew-seatbelt: its check failed, so the call was refused. Retry it; if it keeps failing, report blocked.'

const RESERVED_PATH = new RegExp(`/(${[...WW_RESERVED].map(d => d.replace('.', '\\.')).join('|')})/`)

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await isWorker($))) return next(e)
    const browser = {
      isHeaded: isOn((await $.env.get('CHROME_DEVTOOLS_AXI_HEADED')) ?? ''),
      isAutoConnect: isOn((await $.env.get('CHROME_DEVTOOLS_AXI_AUTO_CONNECT')) ?? ''),
    }
    for (const verdict of judge(e.command, e.run_in_background === true, browser)) {
      const deny = 'deny' in verdict ? verdict.deny : await probe($, verdict.probe)
      if (deny !== undefined) return { deny }
    }

    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))

  for (const tool of ['Write', 'Edit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      if (!RESERVED_PATH.test(e.file_path) || !(await isWorker($))) return next(e)
      const repo = await wwRepo($, undefined, [])
      const dir = repo === undefined ? undefined : reservedDir(repo, e.file_path)

      return dir === undefined ? next(e) : { deny: reservedDeny(dir) }
    }).catch(($, e, next) => (next.called ? next(e) : { deny: FAILED }))
  }
}

type Engine = EngineInterface

// Workers carry FM_TASK_ID (bin/fm-spawn.sh); the captain's own session does
// not, so the seatbelt stays out of it. FM_SEATBELT_OFF=1 turns it off.
async function isWorker($: Engine): Promise<boolean> {
  const task = await $.env.get('FM_TASK_ID')
  const off = await $.env.get('FM_SEATBELT_OFF')

  return task !== undefined && task !== '' && off !== '1'
}

async function git($: Engine, cwd: string | undefined, pre: readonly string[], args: readonly string[]) {
  return $.process.run(['git', ...pre, ...args], cwd === undefined ? {} : { cwd })
}

// The top level of the writing-workbench checkout the session works in, or
// undefined anywhere else.
async function wwRepo($: Engine, cwd: string | undefined, pre: readonly string[]): Promise<string | undefined> {
  const remote = await git($, cwd, pre, ['remote', 'get-url', 'origin'])
  if (remote.exitCode !== 0 || !WW_REMOTE.test(remote.stdout.trim())) return undefined
  const top = await git($, cwd, pre, ['rev-parse', '--show-toplevel'])

  return top.exitCode === 0 ? top.stdout.trim() : undefined
}

// A probe denies only on positive evidence: a git that cannot answer (not a
// repository, a bad path) lets the command run and fail on its own.
async function probe($: Engine, p: Probe): Promise<string | undefined> {
  if (p.kind === 'dirty') {
    const status = await git($, p.cwd, p.git, ['status', '--porcelain', '--untracked-files=no', '--', ...p.paths])

    return status.exitCode === 0 && status.stdout.trim() !== '' ? dirtyDeny(p.verb, status.stdout) : undefined
  }

  return (await wwRepo($, p.cwd, p.git)) === undefined ? undefined : NO_VERIFY_DENY
}
