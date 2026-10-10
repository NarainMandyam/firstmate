import type { EngineInterface, Register } from 'claude-code'

// Stable reason codes from docs/cd-guard.md, docs/arm-pretool-check.md, and
// bin/fm-subagent-pretool-check.sh's "[subagent-dispatch]" code. Each guard
// writes one of these in square brackets ahead of its prose reason.
type KnownCode =
  | 'persistent-cd'
  | 'watcher-background'
  | 'watcher-pipeline'
  | 'watcher-redirection'
  | 'watcher-bundled'
  | 'watcher-nested'
  | 'broad-watcher-kill'
  | 'unclassifiable-protected-command'
  | 'watcher-direct'
  | 'subagent-dispatch'

type Rewrite = {
  explain: string
  // Only set where a mechanical, always-safe rewrite exists; every other
  // code gets an explanation alone, never a guessed command.
  fix?: (command: string) => string | undefined
}

const REWRITES: Record<KnownCode, Rewrite> = {
  'persistent-cd': {
    explain:
      "Refused: that would move firstmate's own shell, so a later command could run in the wrong place.",
    fix: command => {
      const match = /^(cd\s+\S+)\s*&&\s*(.+)$/s.exec(command.trim())
      return match === null ? undefined : `(${match[1]} && ${match[2]})`
    },
  },
  'watcher-direct': {
    explain:
      'Refused: the watcher must be started through its arm or checkpoint entry point, never run directly.',
    fix: command =>
      command.includes('fm-watch.sh')
        ? command.replace(/fm-watch\.sh\b/, 'fm-watch-arm.sh')
        : undefined,
  },
  'watcher-background': {
    explain:
      "Refused: the watcher command has to run where firstmate can see it succeed, not backgrounded or detached.",
    fix: command => {
      const trimmed = command.trim()
      if (/^nohup\s+/.test(trimmed)) return trimmed.replace(/^nohup\s+/, '')
      if (/[^&]&\s*$/.test(trimmed)) return trimmed.replace(/&\s*$/, '').trim()
      return undefined
    },
  },
  'watcher-pipeline': {
    explain: 'Refused: the watcher command cannot be part of a pipeline.',
  },
  'watcher-redirection': {
    explain: 'Refused: the watcher command cannot run with shell redirection.',
  },
  'watcher-bundled': {
    explain:
      'Refused: the watcher command has to be the one thing this call runs, not bundled with other commands.',
  },
  'watcher-nested': {
    explain:
      'Refused: the watcher command cannot run inside a wrapper, subshell, or another shell.',
  },
  'broad-watcher-kill': {
    explain:
      "Refused: that would kill every watcher on the machine, including other sessions' work. Stop only the exact process id you started.",
  },
  'unclassifiable-protected-command': {
    explain:
      "Refused: this command's shape could not be safely checked and it names a protected watcher command.",
  },
  'subagent-dispatch': {
    explain:
      'Refused: firstmate dispatches work through its own fleet tools, not this one, so the work stays tracked and survives a restart. Use bin/fm-brief.sh then bin/fm-spawn.sh instead.',
  },
}

const CODE_PATTERN = /\[([a-z-]+)\]/

function extractCode(text: string | undefined): KnownCode | undefined {
  if (text === undefined) return undefined
  const code = CODE_PATTERN.exec(text)?.[1]
  return code !== undefined && code in REWRITES ? (code as KnownCode) : undefined
}

// Mirrors bin/fm-primary-scope-lib.sh's fm_primary_scope_matches, from the
// mod side: active only in a genuine firstmate primary session, never in a
// crewmate/scout task worktree or an unrelated project.
async function computeIsPrimaryHome($: EngineInterface): Promise<boolean> {
  const taskId = await $.env.get('FM_TASK_ID')
  if (taskId !== undefined && taskId !== '') return false

  const root = await $.session.root()
  const [hasAgents, hasBin, hasState] = await Promise.all([
    $.fs.exists(`${root}/AGENTS.md`),
    $.fs.exists(`${root}/bin`),
    $.fs.exists(`${root}/state`),
  ])
  if (!hasAgents || !hasBin || !hasState) return false

  const isSecondmate = await $.fs.exists(`${root}/.fm-secondmate-home`)
  if (isSecondmate) return true

  const gitDir = await $.process.run(['git', '-C', root, 'rev-parse', '--git-dir']).catch(() => undefined)
  const commonDir = await $.process.run(['git', '-C', root, 'rev-parse', '--git-common-dir']).catch(() => undefined)
  if (gitDir === undefined || gitDir.exitCode !== 0) return false
  if (commonDir === undefined || commonDir.exitCode !== 0) return false
  return gitDir.stdout.trim() === commonDir.stdout.trim()
}

let isPrimaryHomePromise: Promise<boolean> | undefined

function isPrimaryHome($: EngineInterface): Promise<boolean> {
  if (isPrimaryHomePromise === undefined) {
    isPrimaryHomePromise = computeIsPrimaryHome($)
  }
  return isPrimaryHomePromise
}

export const register: Register = on => {
  // The Bash-shaped refusals: cd-guard and the watcher-arm seatbelt both
  // deny a Bash call, and a corrected command (when one exists) is a Bash
  // command too, so only this hook ever rewrites the prompt box.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError !== true) return ran
    if (!(await isPrimaryHome($))) return ran

    const code = extractCode(ran.text)
    if (code === undefined) return ran

    const rewrite = REWRITES[code]
    $.ui.toast(rewrite.explain)

    const fixed = rewrite.fix?.(e.command)
    if (fixed !== undefined && fixed !== e.command) {
      await $.prompt.fill({ text: `! ${fixed}`, mode: 'replace' })
    }

    return ran
  })

  // Every other guard shape (today, the subagent-dispatch guard), which
  // denies a non-Bash tool with no single corrected command to offer.
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Bash') return next(e)

    const ran = await next(e)
    if (ran.isError !== true) return ran
    if (!(await isPrimaryHome($))) return ran

    const code = extractCode(ran.text)
    if (code === undefined) return ran

    $.ui.toast(REWRITES[code].explain)
    return ran
  })
}
