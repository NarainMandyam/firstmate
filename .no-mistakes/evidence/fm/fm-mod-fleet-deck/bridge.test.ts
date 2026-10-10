import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'
const HOME = '/tmp/fd-e2e.yC8P/home'
const SNAP = "{\"schema\":\"fm-fleet-snapshot.v1\",\"generated\":\"2026-10-10T18:12:41Z\",\"fm_home\":\"/tmp/fd-e2e.yC8P/home\",\"roots\":{\"fm_root\":\"/tmp/fd-e2e.yC8P/home\",\"state\":\"/tmp/fd-e2e.yC8P/home/state\",\"data\":\"/tmp/fd-e2e.yC8P/home/data\",\"config\":\"/tmp/fd-e2e.yC8P/home/config\",\"projects\":\"/tmp/fd-e2e.yC8P/home/projects\"},\"backlog\":{\"path\":\"/tmp/fd-e2e.yC8P/home/data/backlog.md\",\"present\":true,\"records\":[{\"order\":1,\"state\":\"queued\",\"structured\":true,\"id\":\"ww-nav\",\"checked\":false,\"title\":\"Decide the nav shape\",\"repo\":\"writing-workbench\",\"kind\":\"scout\",\"priority\":null,\"hold_reason\":\"Captain: pick tabs or sidebar\",\"hold_kind\":\"captain\",\"hold_until\":null,\"hold_set\":null,\"blocked_by\":null,\"blocked_by_ids\":[],\"blocked_reason\":null,\"since\":\"2026-10-10\",\"merged\":null,\"reported\":null,\"done\":null,\"completion\":{\"verb\":null,\"date\":null},\"links\":[],\"pr_url\":null,\"report_path\":null,\"local_note\":null,\"raw\":\"- [ ] ww-nav - Decide the nav shape (repo: writing-workbench) (kind: scout) (since 2026-10-10) (hold: Captain: pick tabs or sidebar) (hold-kind: captain)\",\"body_lines\":[],\"body_excerpt\":null,\"unresolved_blocker_ids\":[],\"current_role\":\"queued\",\"requires_child_metadata\":false,\"hold_age_days\":0,\"hold_bucket\":\"live\",\"captain_actionable\":true}]},\"tasks\":[{\"id\":\"mp-b\",\"kind\":\"ship\",\"harness\":\"claude\",\"mode\":\"ship\",\"yolo\":\"off\",\"project\":\"MealPrepper\",\"spawn_gen\":null,\"backend\":\"tmux\",\"remote\":null,\"paths\":{\"meta\":{\"path\":\"/tmp/fd-e2e.yC8P/home/state/mp-b.meta\",\"present\":true},\"status_log\":{\"path\":\"/tmp/fd-e2e.yC8P/home/state/mp-b.status\",\"present\":false,\"kind\":\"event_history\",\"last_event\":{\"state\":\"\",\"note\":\"\",\"raw\":\"\"}},\"worktree\":{\"path\":\"/tmp/fd-e2e.yC8P/home/projects/mp-wt\",\"present\":true},\"home\":{\"path\":null,\"present\":false},\"report\":{\"path\":\"/tmp/fd-e2e.yC8P/home/data/mp-b/report.md\",\"present\":false}},\"secondmate_projects\":[],\"current_state\":{\"state\":\"unknown\",\"source\":\"pane\",\"detail\":\"harness state unavailable (unknown missing)\",\"raw\":\"state: unknown · source: pane · harness state unavailable (unknown missing)\",\"observed_at\":\"2026-10-10T18:12:41Z\",\"freshness\":\"fresh\"},\"endpoint\":{\"target\":\"firstmate:fm-mp-b\",\"exists\":true,\"agent_alive\":\"not_checked\",\"status\":\"unknown\",\"observed_at\":\"2026-10-10T18:12:41Z\",\"freshness\":\"fresh\"},\"pr\":{\"url\":\"https://github.com/NarainMandyam/MealPrepper/pull/2\",\"source\":\"meta\"},\"hints\":{\"pending_decision\":false,\"blocked_event\":false,\"open_decisions\":[],\"scout_report_present\":false,\"last_event_text\":\"\"},\"actions\":{\"watch\":\"bin/fm-peek.sh fm-mp-b\",\"steer\":\"bin/fm-send.sh fm-mp-b '<instruction>'\",\"return_channel_note\":null},\"backlog\":null}],\"main_inventory\":{\"valid\":true,\"reason\":null,\"orphan_in_flight\":[],\"unstructured_current_count\":0},\"scout_reports\":[],\"secondmate_current\":{\"registry\":{\"present\":false,\"available\":true,\"complete\":true,\"reason\":null,\"provenance\":\"registered-table\",\"path\":\"/tmp/fd-e2e.yC8P/home/data/secondmates.md\",\"freshness\":{\"status\":\"fresh\",\"observed_at\":\"2026-10-10T18:12:41Z\"},\"records\":[],\"input_truncated\":false,\"records_truncated\":false,\"reasons\":[],\"lines_in_window\":0,\"records_in_window\":0},\"records\":[],\"total_registered\":0,\"total\":0,\"shown\":0,\"truncated\":0},\"secondmate_landed\":{\"records\":[],\"truncated\":[],\"unreadable\":[],\"partial\":[]},\"secondmate_guidance\":{\"note\":\"For kind=secondmate, bearings selects validated structured state from that registered home; parent events and bounded terminal evidence are fallback-only supplements and never current-state authority.\"}}"
const DF = "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk1s2   488245288 374031032  86780068    82%    /System/Volumes/Data\n"
const ok = (stdout: string): ProcessRunResult => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
test('real snapshot drives the deck; answer and merge emit intake lines', async ($, on) => {
  const runs: { argv: readonly string[]; stdin?: string }[] = []
  mock.env(on, {})
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on, undefined)
  on('fs.exists', ($, e) => ({ value: !e.path.endsWith('/.fm-secondmate-home') }))
  on('fs.stat', ($, e) => ({ value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: 1_760_000_000_000 - 9_000, ...(e.resolve ? { realPath: e.path.replace(/\/+$/, '') } : {}) } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'kitty' as const } }))
  on('session.root', () => ({ value: HOME }))
  on('process.run', async ($, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    const s = e.argv[0] ?? ''
    if (s.endsWith('/bin/fm-fleet-snapshot.sh')) return { value: ok(SNAP) }
    if (s === 'df') return { value: ok(DF) }
    return { value: ok('closed: ww-nav\n') }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Box, Text } = $.ui.resolve(e); return h(Box, null, h(Text, null, 'engine band')) as RenderElement })
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  const band = await $.ui.mount({ plugin: 'fleet-deck', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 120, scroll: { offset: 0, bodyRows: 7 }, view: {} } })
  console.log('BAND:', (await band.find({ key: 'band' }))?.text)
  await band.press({ key: 'open-calls' })
  const calls = await $.ui.mount({ plugin: 'fleet-deck', surface: 'terminal', component: 'Pane', requestId: 'fleet-calls', props: { title: 'Calls', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  console.log('CALLS PANE:', (await calls.find({ type: 'Box' }))?.text)
  expect(await calls.find({ type: 'Text', text: 'Decide the nav shape' })).toBeDefined()
  await calls.input({ key: 'answer:ww-nav', text: 'tabs please' })
  await calls.press({ key: 'merge:mp-b' })
  const crew = await $.ui.mount({ plugin: 'fleet-deck', surface: 'terminal', component: 'Pane', requestId: 'fleet-crew', props: { title: 'Fleet', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  console.log('FLEET PANE:', (await crew.find({ type: 'Box' }))?.text)
  for (const r of runs) console.log('RUN', JSON.stringify(r))
})
