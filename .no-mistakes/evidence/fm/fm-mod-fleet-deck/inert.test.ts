import { expect, mock, test } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'
const BAND = { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 7 }, view: {} }
const arm = (on: On, env: Record<string, string>, root: string, isHome: (p: string) => boolean) => {
  const runs: string[] = []
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on, undefined)
  on('session.root', () => ({ value: root }))
  on('fs.exists', ($, e) => ({ value: isHome(e.path) }))
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: 0, ...(e.resolve ? { realPath: e.path.replace(/\/+$/, '') } : {}) } }))
  on('process.run', ($, e) => { runs.push(e.argv.join(' ')); return { value: { exitCode: 0, stdout: '{}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box, Text } = $.ui.resolve(e); return h(Box, { key: 'engine-own' }, h(Text, null, 'engine band')) as RenderElement })
  return { runs, clock }
}
for (const [name, env, root, isHome] of [
  ['a project repo that is not a firstmate home', {}, '/x/MealPrepper', (p: string) => !p.endsWith('/AGENTS.md') && !p.endsWith('/.fm-secondmate-home')],
  ['FM_HOME pointing at a different home', { FM_HOME: '/srv/other-home' }, '/srv/fm-home', (p: string) => !p.endsWith('/.fm-secondmate-home')],
  ['a secondmate home', {}, '/srv/sm-home', (p: string) => true],
] as const) {
  test(`stays inert in ${name}`, async ($, on) => {
    const w = arm(on, env as Record<string, string>, root, isHome)
    await $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })
    await w.clock.advance(180_000)
    expect(w.runs).toEqual([])
    const band = await $.ui.mount({ plugin: 'fleet-deck', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect(await band.find({ key: 'engine-own' })).toBeDefined()
    expect(await band.find({ key: 'chip-calls' })).toBeUndefined()
    console.log(`${name}: band=${JSON.stringify((await band.find({ key: 'engine-own' }))?.text)} processRuns=${w.runs.length}`)
  })
}
