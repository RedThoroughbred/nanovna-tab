import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TOOL_PREFIX } from '../hooks/tools'
import { LIBRARY, LIVE, QC_LOG } from './fixture'
import { PRESETS } from './fixture-bands'

// Shared by the test files: the world beneath the plugin.
export const NOW = 1_000_000
export const LIVE_FILE = '/Users/test/Library/Application Support/vna/live.json'
export const LEASE_FILE = '/Users/test/Library/Caches/vna/lease.json'

// The world beneath the plugin: vna.py answered from the fixtures (or a test's own answer per verb,
// some of them slow on the mock clock), files in memory, every call recorded.
export const stored = new Map<string, unknown>()
export type World = {
  calls: string[][]
  clock: ReturnType<typeof mock.clock>
  files: Map<string, string>
  opened: string[]
  live: unknown
  slow: Record<string, number>
  reply: Record<string, (args: string[]) => unknown>
  status: (string | undefined)[]
  tools: { name: string; description: string; inputSchema: any }[]
}

export function world(on: On, live: unknown = LIVE, env?: Record<string, string>): World {
  const clock = mock.clock(on, { now: NOW })
  // A made-up home folder unless a test brings its own, so no test ever reads the real one.
  mock.env(on, { HOME: '/Users/test', ...env })
  const w: World = { calls: [], clock, files: new Map(), opened: [], live, slow: {}, reply: {}, status: [], tools: [] }
  stored.clear()
  on('store.get', async (_$, e) => ({ value: stored.get(e.key) }))
  on('store.set', async (_$, e) => {
    stored.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => {
    const v = w.files.get(String(e.path))
    if (v === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: v }
  })
  on('fs.write', async (_$, e) => {
    w.files.set(String(e.path), String(e.text))
    return { value: undefined }
  })
  on('ui.panes', async () => ({ value: [{ id: 'vna', title: 'VNA', isShown: true, isFocused: false, isPlaced: true }] }))
  on('process.run', async (_$, e) => {
    const reply = (o: unknown) => ({ value: { exitCode: 0, stdout: JSON.stringify(o), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === '/usr/bin/open') return reply({})
    // The mod-status file's mv and rm, on the files in memory.
    if (e.argv[0] === '/bin/mv') {
      w.files.set(String(e.argv[3]), w.files.get(String(e.argv[2])) ?? '')
      w.files.delete(String(e.argv[2]))
      return reply({})
    }
    if (e.argv[0] === '/bin/rm') {
      w.files.delete(String(e.argv[2]))
      return reply({})
    }
    const args = [...e.argv.slice(2)]
    w.calls.push(args)
    const verb = args[0] ?? ''
    if (w.slow[verb]) await clock.sleep(w.slow[verb] as number)
    const own = w.reply[verb]
    if (own) return reply(own(args))
    if (verb === 'library') return reply(LIBRARY)
    if (verb === 'presets') return reply(PRESETS)
    if (verb === 'qc' && args[1] === 'log') return reply(QC_LOG)
    if (verb === 'qc' && args[1] === 'save') return reply({ ...(w.live as object), ok: true, say: `${args[2]}: PASS.`, certificate: '/x/qc/cert.svg', record: { result: 'PASS' } })
    if (verb === 'markers') return reply({ ...(w.live as object), ok: true, say: 'Markers placed.' })
    if (verb === 'shot') return reply({ ...(w.live as object), png: '/x/shot.png' })
    return reply(w.live)
  })
  on('session.start', async () => ({ cwd: '/tmp' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', async (_$, e) => {
    w.tools.push(e as any)
    return { value: { tool: `${TOOL_PREFIX}${e.name}` } }
  })
  on('ui.open', async (_$, e) => {
    w.opened.push(String((e as any).id))
    return { value: { isPlaced: true as const } }
  })
  on('ui.status', async (_$, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async () => ({ value: undefined }))
  return w
}

export async function start($: any): Promise<void> {
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
}

// /vna <args> as the person typing it; the engine stamps origin and presentation.
export async function vna($: any, args: string): Promise<{ text?: string }> {
  return $.command.run({ command: 'vna', args })
}

