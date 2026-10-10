// Pure judgement of a Bash command: no `$`, so every rule is testable alone.
// A rule either refuses outright (`deny`) or asks register.ts to probe git
// first (`probe`); a command that matches nothing is allowed.

export type Probe =
  | { kind: 'dirty'; cwd?: string; git: string[]; paths: string[]; verb: string }
  | { kind: 'ww-no-verify'; cwd?: string; git: string[] }

export type Verdict = { deny: string } | { probe: Probe }

export type BrowserEnv = { isHeaded: boolean; isAutoConnect: boolean }

const NAME = 'crew-seatbelt'

// The directory names writing-workbench reserves for author data
// (projects/writing-workbench/AGENTS.md "Manuscript privacy").
export const WW_RESERVED = new Set([
  '.writing-workbench',
  'project-data',
  'user-data',
  'projects',
  'manuscripts',
  'notes',
  'ocr',
  'research-corpus',
])

export const WW_REMOTE = /[/:]writing-workbench(\.git)?\/?$/

// Splits a shell command into simple commands (argv lists), dropping
// quotes, comments and heredoc bodies. Best effort: `$(...)` and variables
// are left as text, so the seatbelt is a seatbelt, not a sandbox.
export function segments(command: string): string[][] {
  const out: string[][] = []
  const heredocs: { tag: string; isIndented: boolean }[] = []
  let cur: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  const n = command.length
  const flushWord = () => {
    if (inWord) cur.push(word)
    word = ''
    inWord = false
  }
  const flushSeg = () => {
    flushWord()
    if (cur.length > 0) out.push(cur)
    cur = []
  }
  while (i < n) {
    const c = command[i] as string
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end < 0 ? n : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop + 1
    } else if (c === '"') {
      let j = i + 1
      while (j < n && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < n) {
          word += command[j + 1]
          j += 2
        } else {
          word += command[j]
          j += 1
        }
      }
      inWord = true
      i = j + 1
    } else if (c === '\\') {
      if (command[i + 1] !== '\n') {
        word += command[i + 1] ?? ''
        inWord = true
      }
      i += 2
    } else if (c === '#' && !inWord) {
      while (i < n && command[i] !== '\n') i += 1
    } else if (c === '<' && command.startsWith('<<', i) && !command.startsWith('<<<', i)) {
      flushWord()
      i += 2
      const isIndented = command[i] === '-'
      if (isIndented) i += 1
      while (command[i] === ' ' || command[i] === '\t') i += 1
      let tag = ''
      while (i < n && !/[\s;&|<>()]/.test(command[i] as string)) {
        const ch = command[i] as string
        if (ch !== "'" && ch !== '"' && ch !== '\\') tag += ch
        i += 1
      }
      if (tag !== '') heredocs.push({ tag, isIndented })
    } else if (c === '\n') {
      flushSeg()
      i += 1
      for (const doc of heredocs.splice(0)) {
        while (i < n) {
          const end = command.indexOf('\n', i)
          const stop = end < 0 ? n : end
          const line = command.slice(i, stop)
          i = stop + 1
          if ((doc.isIndented ? line.replace(/^\t+/, '') : line) === doc.tag) break
        }
      }
    } else if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) {
      word += c
      inWord = true
      i += 1
    } else if (';&|()'.includes(c)) {
      flushSeg()
      i += 1
    } else if (c === ' ' || c === '\t') {
      flushWord()
      i += 1
    } else {
      word += c
      inWord = true
      i += 1
    }
  }
  flushSeg()

  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const REDIRECT_ALONE = /^(\d*|&)(>>?|<)$/
const REDIRECT = /^(\d*|&)(>>?|<|>&)/
const WRAPPERS = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'builtin', '!'])

export type Simple = { argv: string[]; assignments: string[] }

// Drops redirections, leading assignments and wrapper commands, so argv[0]
// is the program that runs.
export function simplify(raw: readonly string[]): Simple {
  const words: string[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i] as string
    if (REDIRECT_ALONE.test(w)) {
      i += 1
    } else if (!REDIRECT.test(w)) {
      words.push(w)
    }
  }
  const assignments: string[] = []
  let k = 0
  for (;;) {
    const w = words[k]
    if (w === undefined) break
    if (ASSIGNMENT.test(w)) {
      assignments.push(w)
      k += 1
    } else if (WRAPPERS.has(w)) {
      k += 1
    } else if (w === 'env') {
      k += 1
      while (words[k]?.startsWith('-')) k += 1
    } else if (w === 'nice') {
      k += 1
      if (words[k] === '-n') k += 2
      else if (words[k]?.startsWith('-')) k += 1
    } else if (w === 'timeout') {
      k += 1
      while (words[k]?.startsWith('-')) k += 1
      k += 1
    } else {
      break
    }
  }

  return { argv: words.slice(k), assignments }
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function join(base: string | undefined, path: string): string {
  return base === undefined || path.startsWith('/') ? path : `${base}/${path}`
}

// git's global options before the subcommand, kept so a probe runs against
// the same repository the command names.
function gitParts(argv: readonly string[]) {
  const pre: string[] = []
  let i = 1
  while (i < argv.length) {
    const w = argv[i] as string
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') {
      pre.push(w, argv[i + 1] ?? '')
      i += 2
    } else if (w.startsWith('-')) {
      pre.push(w)
      i += 1
    } else {
      break
    }
  }

  return { pre, sub: argv[i], args: argv.slice(i + 1) }
}

// True when a short-option cluster (`-SW`) or a long option names the flag.
function hasFlag(args: readonly string[], short: string, long: string): boolean {
  return args.some(
    a => a === long || a.startsWith(`${long}=`) || (/^-[A-Za-z]+$/.test(a) && a.includes(short)),
  )
}

function operands(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === '--') return [...out, ...args.slice(i + 1)]
    if (valued.has(a)) i += 1
    else if (!a.startsWith('-')) out.push(a)
  }

  return out
}

function checkout(args: readonly string[]): string[] {
  const isBranchWork = args.some(a =>
    ['-b', '-B', '--orphan', '--detach', '-p', '--patch'].includes(a) || a.startsWith('--pathspec-from-file'),
  )
  if (isBranchWork) return []
  const paths = operands(args, new Set(['--conflict']))

  return paths.length === 1 && paths[0] === '-' ? [] : paths
}

function restore(args: readonly string[]): string[] {
  if (args.some(a => a.startsWith('--pathspec-from-file'))) return []
  const isStagedOnly = hasFlag(args, 'S', '--staged') && !hasFlag(args, 'W', '--worktree')

  return isStagedOnly ? [] : operands(args, new Set(['-s', '--source']))
}

function stash(args: readonly string[]): string | undefined {
  const action = args[0]?.startsWith('-') === false ? args[0] : undefined
  const rest = action === undefined ? args : args.slice(1)
  const hint =
    'Use a temporary WIP commit; if you must stash, run `git stash push -u -m "<unique-tag>"`, then `git stash apply <sha>` and drop only your own entry.'
  if (action === 'pop') {
    return `${NAME}: the stash stack is shared by every worktree of this repo, so \`git stash pop\` can take another session's changes. ${hint}`
  }
  const isPush = action === undefined || action === 'push'
  const hasMessage = rest.some(a => a === '-m' || a.startsWith('--message') || /^-[A-Za-z]*m/.test(a))
  if ((isPush && !hasMessage) || (action === 'save' && rest.every(a => a.startsWith('-')))) {
    return `${NAME}: the stash stack is shared by every worktree of this repo, so an unnamed stash can be popped by another session. ${hint}`
  }

  return undefined
}

function isNoVerifyCommit(args: readonly string[]): boolean {
  const valued = new Set(['-m', '-F', '-c', '-C', '-t', '--author', '--date', '--file', '--message', '--template'])
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string
    if (a === '--') return false
    if (valued.has(a)) i += 1
    else if (a === '--no-verify' || (/^-[A-Za-z]+$/.test(a) && (a.slice(1).split(/[mFcCt]/)[0] ?? '').includes('n'))) return true
  }

  return false
}

const SCRIPT = /^(build|test|ci)[\w.-]*\.(sh|zsh|bash)$/
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const BUILD_SCRIPT = /^(build|test)([:._-].*)?$/

// True for a build or test run, the commands brief rule 9 keeps in the
// foreground. Dev servers and watchers are left alone.
export function isBuildOrTest(argv: readonly string[]): boolean {
  const prog = basename(argv[0] ?? '')
  const args = argv.slice(1).filter(a => !a.startsWith('+'))
  const sub = args.find(a => !a.startsWith('-'))
  if (args.some(a => ['--watch', '-w', 'watch', 'dev'].includes(a))) return false
  if (SCRIPT.test(prog)) return true
  if (['bash', 'sh', 'zsh'].includes(prog) && argv[1] !== undefined && SCRIPT.test(basename(argv[1]))) return true
  if (prog === 'cargo') return ['build', 'test', 'check', 'clippy', 'nextest', 'bench'].includes(sub ?? '')
  if (prog === 'go' || prog === 'swift') return ['build', 'test'].includes(sub ?? '')
  if (['vitest', 'jest', 'pytest', 'tsc', 'xcodebuild'].includes(prog)) return true
  if (prog === 'playwright') return sub === 'test'
  if (prog === 'npx' || prog === 'bunx') return isBuildOrTest(argv.slice(1).filter(a => !a.startsWith('-')))
  if (SCRIPT_RUNNERS.has(prog)) {
    if (sub === 'test' || sub === 't') return true
    if (sub === 'run' || sub === 'run-script') {
      const script = args.slice(args.indexOf(sub) + 1).find(a => !a.startsWith('-'))
      return BUILD_SCRIPT.test(script ?? '')
    }
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
      return isBuildOrTest(args.slice(args.indexOf(sub) + 1).filter(a => !a.startsWith('-')))
    }
    return prog !== 'npm' && BUILD_SCRIPT.test(sub ?? '')
  }

  return false
}

const SCREEN = 'The captain must never see a worker test: no window may open or move on his screen.'
const HEADLESS = 'Test headlessly instead: a headless browser (Playwright\'s default, chrome-devtools-axi with no HEADED or AUTO_CONNECT variable), or read the file directly.'

export const isOn = (value: string) => value !== '' && value !== '0' && value.toLowerCase() !== 'false'

function screen(s: Simple, browser: BrowserEnv): string | undefined {
  const prog = basename(s.argv[0] ?? '')
  if (prog === 'osascript') return `${NAME}: osascript drives apps and keystrokes on the captain's screen. ${SCREEN} ${HEADLESS}`
  if (prog === 'screencapture') return `${NAME}: screencapture records the captain's own screen. ${SCREEN} Take a screenshot inside a headless browser instead.`
  if (prog === 'open') return `${NAME}: open launches an app or browser window on the captain's screen. ${SCREEN} ${HEADLESS}`
  const exported = prog === 'export' ? s.argv.slice(1) : []
  const headedVar = [...s.assignments, ...exported].find(a =>
    /^CHROME_DEVTOOLS_AXI_(HEADED|AUTO_CONNECT)=/.test(a) && isOn(a.slice(a.indexOf('=') + 1)),
  )
  if (headedVar !== undefined) {
    return `${NAME}: ${headedVar.slice(0, headedVar.indexOf('='))} makes chrome-devtools-axi show a window or drive the captain's own Chrome. ${SCREEN} Run chrome-devtools-axi without it; it is headless by default.`
  }
  if (prog === 'chrome-devtools-axi' && (browser.isHeaded || browser.isAutoConnect)) {
    return `${NAME}: this session's environment sets CHROME_DEVTOOLS_AXI_${browser.isHeaded ? 'HEADED' : 'AUTO_CONNECT'}, so chrome-devtools-axi would show a window or drive the captain's own Chrome. ${SCREEN} Report blocked instead of browsing.`
  }
  const flag = s.argv.find(a => a === '--headed' || a === '--headless=false' || a === '--no-headless')
  if (flag !== undefined) return `${NAME}: ${flag} opens a visible browser window on the captain's screen. ${SCREEN} Drop the flag; browsers run headless by default.`
  const isScript = ['node', 'npx', 'bun', 'bunx', 'deno', 'tsx'].includes(prog)
  if (isScript && s.argv.some(a => /headless\s*:\s*false/.test(a))) {
    return `${NAME}: headless: false opens a visible browser window on the captain's screen. ${SCREEN} Use headless: true.`
  }

  return undefined
}

// Every verdict the command earns, in the order its simple commands run.
export function judge(command: string, isBackground: boolean, browser: BrowserEnv, depth = 0): Verdict[] {
  const verdicts: Verdict[] = []
  let cwd: string | undefined
  for (const raw of segments(command)) {
    const s = simplify(raw)
    const argv = s.argv
    const prog = basename(argv[0] ?? '')
    if (prog === 'cd' && argv[1] !== undefined && !argv[1].startsWith('~') && argv[1] !== '-') {
      cwd = join(cwd, argv[1])
      continue
    }
    if (['bash', 'sh', 'zsh'].includes(prog) && argv[1] === '-c' && argv[2] !== undefined && depth < 3) {
      verdicts.push(...judge(argv[2], isBackground, browser, depth + 1))
      continue
    }
    if (prog === 'pkill' || prog === 'killall') {
      verdicts.push({
        deny: `${NAME}: ${prog} matches processes by name or pattern, so it kills every worker on this machine whose command matches. Stop only the exact process ids you started: \`kill <pid>\` (\`lsof -ti :<port>\` finds a server's pid).`,
      })
    }
    const seen = screen(s, browser)
    if (seen !== undefined) verdicts.push({ deny: seen })
    if (isBackground && isBuildOrTest(argv)) {
      verdicts.push({
        deny: `${NAME}: a build or test run must not be backgrounded and waited on. Run it in the foreground with a timeout (up to 600000 ms), or as a bounded command that returns on its own.`,
      })
    }
    if (prog !== 'git') continue
    const { pre, sub, args } = gitParts(argv)
    if (sub === 'checkout' || sub === 'restore') {
      const paths = sub === 'checkout' ? checkout(args) : restore(args)
      if (paths.length > 0) verdicts.push({ probe: { kind: 'dirty', cwd, git: pre, paths, verb: `git ${sub}` } })
    } else if (sub === 'stash') {
      const deny = stash(args)
      if (deny !== undefined) verdicts.push({ deny })
    } else if (sub === 'commit' && isNoVerifyCommit(args)) {
      verdicts.push({ probe: { kind: 'ww-no-verify', cwd, git: pre } })
    }
  }

  return verdicts
}

export function dirtyDeny(verb: string, porcelain: string): string {
  const files = porcelain
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.slice(3))
  const shown = files.slice(0, 5).join(', ') + (files.length > 5 ? `, and ${files.length - 5} more` : '')

  return `${NAME}: \`${verb}\` here would discard uncommitted changes in ${shown}, and they exist nowhere else. Commit them first (or copy the file aside), then restore from that commit or copy; diff before you discard.`
}

export const NO_VERIFY_DENY = `${NAME}: in writing-workbench the pre-commit hook is the manuscript-privacy check, and --no-verify skips it. Commit without --no-verify; if the hook refuses a file, move or rename it rather than bypassing the hook.`

// The reserved directory a path inside the repository lies under, if any.
export function reservedDir(toplevel: string, path: string): string | undefined {
  const root = toplevel.endsWith('/') ? toplevel : `${toplevel}/`
  if (!path.startsWith(root)) return undefined
  const dirs = path.slice(root.length).split('/').slice(0, -1)

  return dirs.find(d => WW_RESERVED.has(d))
}

export function reservedDeny(dir: string): string {
  return `${NAME}: ${dir}/ is a reserved directory name in writing-workbench; .gitignore and the pre-commit hook treat it as author data, so files under it never reach a commit. Put the file under a directory with another name (AGENTS.md "Manuscript privacy").`
}
