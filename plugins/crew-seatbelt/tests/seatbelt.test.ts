import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const WORKER = { FM_TASK_ID: 'fm-task' }
const WW = 'https://github.com/NarainMandyam/writing-workbench.git'

type Git = (args: readonly string[]) => { exitCode: number; stdout: string }

// Stands in for the engine beneath the plugin: an environment, git's
// answers, and a tool that runs whatever reaches it.
function world(on: On, env: Record<string, string>, git: Git = () => ({ exitCode: 0, stdout: '' })) {
  mock.env(on, env)
  on('process.run', ($, e) => ({
    value: { ...git(e.argv.slice(1)), stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } }))
}

async function bash($: Engine, command: string, isBackground = false): Promise<string | undefined> {
  const ran = await $.tool.call({ tool: 'Bash', command, run_in_background: isBackground })

  return ran.deny ?? (ran.isError === true ? (ran.text ?? 'error') : undefined)
}

const denied = expect.stringContaining('crew-seatbelt')

test('inert outside a worker session and when switched off', async ($, on) => {
  world(on, { FM_TASK_ID: 'fm-task', FM_SEATBELT_OFF: '1' })
  expect(await bash($, 'pkill -f vite')).toBeUndefined()
})

test('inert in the captain\'s own session (no FM_TASK_ID)', async ($, on) => {
  world(on, {})
  expect(await bash($, 'pkill -f vite')).toBeUndefined()
})

test('pkill and killall by name are refused; kill by pid runs', async ($, on) => {
  world(on, WORKER)
  expect(await bash($, 'cd web && pkill -f vite')).toEqual(denied)
  expect(await bash($, 'kill 4242')).toBeUndefined()
})

test('screen-touching commands are refused; headless browsing runs', async ($, on) => {
  world(on, WORKER)
  expect(await bash($, 'osascript -e \'tell application "System Events" to keystroke "r"\'')).toEqual(denied)
  expect(await bash($, 'npx playwright test --headed')).toEqual(denied)
  expect(await bash($, 'CHROME_DEVTOOLS_AXI_HEADED=1 chrome-devtools-axi open http://localhost:5173')).toEqual(denied)
  expect(await bash($, 'chrome-devtools-axi open http://localhost:5173 && npx playwright test')).toBeUndefined()
  expect(await bash($, 'git commit -m "open the editor; pkill nothing"')).toBeUndefined()
})

test('checkout or restore of a file with uncommitted changes is refused', async ($, on) => {
  world(on, WORKER, args =>
    args.includes('src/dirty.ts') ? { exitCode: 0, stdout: ' M src/dirty.ts\n' } : { exitCode: 0, stdout: '' },
  )
  expect(await bash($, 'git checkout src/dirty.ts')).toEqual(expect.stringContaining('src/dirty.ts'))
  expect(await bash($, 'git restore -- src/dirty.ts')).toEqual(denied)
  expect(await bash($, 'git checkout HEAD -- src/clean.ts')).toBeUndefined()
  expect(await bash($, 'git restore --staged src/dirty.ts')).toBeUndefined()
})

test('bare stash and pop are refused; a tagged stash runs', async ($, on) => {
  world(on, WORKER)
  expect(await bash($, 'git stash')).toEqual(denied)
  expect(await bash($, 'git stash pop')).toEqual(denied)
  expect(await bash($, 'git stash push -u -m "fm-task-wip"')).toBeUndefined()
})

test('a backgrounded build or test run is refused; a background dev server runs', async ($, on) => {
  world(on, WORKER)
  expect(await bash($, 'cargo test --workspace', true)).toEqual(denied)
  expect(await bash($, 'npm run dev -- --port 5180', true)).toBeUndefined()
  expect(await bash($, 'cargo test --workspace')).toBeUndefined()
})

test('--no-verify commits are refused in writing-workbench alone', async ($, on) => {
  let remote = WW
  world(on, WORKER, args =>
    args[0] === 'remote' ? { exitCode: 0, stdout: `${remote}\n` } : { exitCode: 0, stdout: '/wt/ww\n' },
  )
  expect(await bash($, 'git commit --no-verify -m "wip"')).toEqual(denied)
  expect(await bash($, 'git commit -m "wip"')).toBeUndefined()
  remote = 'https://github.com/NarainMandyam/firstmate.git'
  expect(await bash($, 'git commit --no-verify -m "wip"')).toBeUndefined()
})

test('writing under a reserved directory of writing-workbench is refused', async ($, on) => {
  world(on, WORKER, args =>
    args[0] === 'remote' ? { exitCode: 0, stdout: `${WW}\n` } : { exitCode: 0, stdout: '/wt/ww\n' },
  )
  const write = (file_path: string) => $.tool.call({ tool: 'Write', file_path, content: 'x' })
  const refused = async (path: string) => {
    const ran = await write(path)
    return ran.deny ?? (ran.isError === true ? ran.text : undefined)
  }
  expect(await refused('/wt/ww/src/notes/Pane.svelte')).toEqual(denied)
  expect(await refused('/wt/ww/src/screens/notebook/notes.ts')).toBeUndefined()
})

test('a check that fails refuses the call', async ($, on) => {
  mock.env(on, WORKER)
  on('process.run', () => {
    throw new Error('git is gone')
  })
  on('tool.call', () => ({ result: { stdout: 'ran', stderr: '', interrupted: false } }))
  expect(await bash($, 'git checkout src/a.ts')).toEqual(denied)
})
