import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/test/firstmate-home'

// Wires the bottom hooks the mod's scope check and its $ calls land on: a
// firstmate primary home at ROOT (AGENTS.md, bin/, state/ present, plain
// checkout git-dir === git-common-dir), plus capture hooks for the toast and
// prompt-fill calls a test asserts on.
function wirePrimaryHome(on: On, options: { taskId?: string } = {}) {
  mock.env(on, options.taskId === undefined ? {} : { FM_TASK_ID: options.taskId })

  on('session.root', () => ({ value: ROOT }))

  on('fs.exists', ($, e) => {
    if (e.path === `${ROOT}/.fm-secondmate-home`) return { value: false }
    const value = e.path === `${ROOT}/AGENTS.md` || e.path === `${ROOT}/bin` || e.path === `${ROOT}/state`
    return { value }
  })

  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '.git\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
}

function wireCapture(on: On) {
  const toasts: string[] = []
  const fills: { text: string; mode?: string }[] = []

  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  on('prompt.fill', ($, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })

  return { toasts, fills }
}

test('explains a persistent-cd refusal and offers the subshell fix', async ($, on) => {
  wirePrimaryHome(on)
  const { toasts, fills } = wireCapture(on)

  on('tool.call', { tool: 'Bash' }, () => ({
    isError: true,
    result: undefined,
    text: '[persistent-cd] a persistent top-level directory change would relocate the primary shell.',
  }))

  await $.tool.call({
    tool: 'Bash',
    command: 'cd ~/github/firstmate && FM_HOME=$PWD bin/fm-teardown.sh x',
  })

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain("move firstmate's own shell")
  expect(fills).toHaveLength(1)
  expect(fills[0]?.mode).toBe('replace')
  expect(fills[0]?.text).toBe('! (cd ~/github/firstmate && FM_HOME=$PWD bin/fm-teardown.sh x)')
})

test('explains a subagent-dispatch refusal with no command to offer', async ($, on) => {
  wirePrimaryHome(on)
  const { toasts, fills } = wireCapture(on)

  on('tool.call', { tool: 'Agent' }, () => ({
    isError: true,
    result: undefined,
    text: '[subagent-dispatch] the firstmate primary dispatches through the fleet, not the harness\'s own delegation tools.',
  }))

  await $.tool.call({ tool: 'Agent', description: 'do the thing', prompt: 'do the thing' })

  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('bin/fm-brief.sh')
  expect(fills).toHaveLength(0)
})

test('stays inert outside a firstmate primary session', async ($, on) => {
  wirePrimaryHome(on, { taskId: 'some-crewmate-task' })
  const { toasts, fills } = wireCapture(on)

  on('tool.call', { tool: 'Bash' }, () => ({
    isError: true,
    result: undefined,
    text: '[persistent-cd] a persistent top-level directory change would relocate the primary shell.',
  }))

  await $.tool.call({ tool: 'Bash', command: 'cd projects/foo && touch bar' })

  expect(toasts).toHaveLength(0)
  expect(fills).toHaveLength(0)
})
