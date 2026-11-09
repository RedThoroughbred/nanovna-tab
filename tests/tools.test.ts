import { describe, expect, test } from 'claude-code/testing'

import { LIVE, LIVE_RESONANT } from './fixture'
import { LIVE_2M } from './fixture-bands'
import { LIVE_FILE, NOW, TOOL_PREFIX, start, world, type World } from './world'

// The three tools Claude can call (hooks/tools.ts), through the same fake world as the tab:
// vna.py answered from the fixtures, files in memory, no NanoVNA anywhere.

const NAMES = ['vna_reading', 'vna_antennas', 'vna_action'] as const

async function call($: any, tool: (typeof NAMES)[number], input: Record<string, unknown> = {}): Promise<string> {
  const r = await $.tool.call({ tool: `${TOOL_PREFIX}${tool}`, ...input })
  return String((r as any).text ?? (r as any).result ?? '')
}

// A tool call that waits for the (mock) clock: the call, time passing, the answer.
async function callSlow($: any, w: World, tool: (typeof NAMES)[number], input: Record<string, unknown>, ms: number): Promise<string> {
  const p = call($, tool, input)
  await w.clock.advance(ms)
  return p
}

function numbers(text: string): any {
  return JSON.parse(text.slice(text.indexOf('Numbers:\n') + 'Numbers:\n'.length))
}

const deviceCalls = (w: World) => w.calls.filter(c => !['library', 'presets', 'qc'].includes(c[0] ?? ''))

describe('the tools are registered', () => {
  test('each has its name, a description that says what never to do, and a schema', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.tools.map(t => t.name)).toEqual([...NAMES])
    const by = Object.fromEntries(w.tools.map(t => [t.name, t]))
    for (const t of w.tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description.length).toBeGreaterThan(200)
    }
    expect(by.vna_reading?.inputSchema.properties.fresh.type).toBe('boolean')
    expect(Object.keys(by.vna_antennas?.inputSchema.properties ?? {})).toEqual(['name', 'a', 'b'])
    expect(by.vna_action?.inputSchema.required).toEqual(['action'])
    // Only the safe actions can be asked for; nothing that calibrates, deletes or writes a slot.
    expect(by.vna_action?.inputSchema.properties.action.enum).toEqual(['save', 'markers', 'band', 'trim', 'export'])
    // Every description says never to connect a transmitting radio, and the action tool names what stays in the tab.
    expect(by.vna_reading?.description).toMatch(/Never connect a transmitting radio/)
    expect(by.vna_action?.description).toMatch(/Never connect a transmitting radio/)
    expect(by.vna_action?.description).toMatch(/will NOT calibrate, save the power-on layout, delete an antenna/)
    expect(by.vna_reading?.description).toMatch(/never changes anything on the NanoVNA/)
  })
})

describe('vna_reading', () => {
  test('answers from a fresh shared reading without touching the NanoVNA', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    await start($)
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE_RESONANT, at: NOW - 2000, by: 'sOther' }))
    const before = w.calls.length
    const text = await call($, 'vna_reading')
    expect(w.calls.slice(before).filter(c => c[0] === 'live')).toHaveLength(0)
    expect(text).toMatch(/Resonant at 917\.6 MHz/)
    const n = numbers(text)
    expect(n).toMatchObject({ connected: true, fresh: true, calibrated: true, grade: expect.stringMatching(/^[ABCF]$/) })
    expect(n.marks.map((m: any) => m.name)).toEqual(['Meshtastic', 'MeshCore', '915'])
    expect(n.marks[0]).toMatchObject({ mhz: 906.875, swr: expect.any(Number), returnLossDb: expect.any(Number), resistanceOhm: expect.any(Number), reactanceOhm: expect.any(Number) })
    expect(n.best.mhz).toBeGreaterThan(850)
    expect(n.trim.targetMhz).toBe(906.875)
    expect(n.ageSeconds).toBe(2)
  })

  test('takes one bounded vna.py live call when the shared reading is stale', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    w.reply.live = () => ({ ...LIVE_RESONANT, at: NOW + 50 })
    await start($)
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE, at: NOW - 60_000, by: 'sOther' }))
    const before = w.calls.length
    const text = await call($, 'vna_reading')
    const lives = w.calls.slice(before).filter(c => c[0] === 'live')
    expect(lives).toHaveLength(1)
    expect(lives[0]).toContain('--wait')
    expect(text).toMatch(/Resonant at 917\.6 MHz/)
    expect(numbers(text).fresh).toBe(true)
  })

  test('fresh: true sweeps again even when the shared reading is new', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    w.reply.live = () => ({ ...LIVE_RESONANT, at: NOW + 50 })
    await start($)
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE, at: NOW - 1000, by: 'sOther' }))
    const before = w.calls.length
    const text = await call($, 'vna_reading', { fresh: true })
    expect(w.calls.slice(before).filter(c => c[0] === 'live')).toHaveLength(1)
    expect(text).toMatch(/Resonant at 917\.6 MHz/)
  })

  test('not connected: says so, what to do, and that nothing was measured', async ($, on) => {
    const w = world(on, { connected: false })
    w.reply.poll = () => ({ idle: true })
    await start($)
    const text = await call($, 'vna_reading')
    expect(text).toMatch(/NanoVNA not connected\. Switch it on and plug it into the Mac with a USB-A to USB-C cable\./)
    expect(numbers(text)).toMatchObject({ connected: false })
  })

  test('busy or silent: the last reading comes back with its age and why', async ($, on) => {
    const w = world(on)
    const busy = () => ({ busy: true, say: 'NanoVNA busy: another session or command is talking to it.' })
    w.reply.poll = busy
    w.reply.live = busy
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE, at: NOW - 120_000, by: 'sOther' }))
    await start($)
    const text = await call($, 'vna_reading', { fresh: true })
    expect(text).toMatch(/^NanoVNA busy: another session or command is talking to it\. Showing the last reading, 2 min old\./)
    expect(numbers(text).fresh).toBe(false)
  })

  test('on another band it reads that band\'s targets and the calibration state', async ($, on) => {
    const w = world(on, LIVE_2M)
    w.reply.poll = () => ({ idle: true })
    await start($)
    const n = numbers(await call($, 'vna_reading', { fresh: true }))
    expect(n.band.id).toBe('2m')
    expect(n.marks.length).toBeGreaterThan(0)
    expect(n.marks[0].mhz).toBeGreaterThan(140)
    expect(n.marks[0].mhz).toBeLessThan(150)
  })
})

describe('vna_antennas', () => {
  test('lists the saved antennas with colour, versions and SWR; no device call', async ($, on) => {
    const w = world(on)
    await start($)
    const before = deviceCalls(w).length
    const text = await call($, 'vna_antennas')
    expect(text).toMatch(/^2 saved antennas, best SWR at 907 first:/)
    expect(text).toMatch(/Muzi Works #3 · \w[\w ]* · 2 versions · SWR 1\.2\d at 907, best 1\.\d\d at [\d.]+ MHz/)
    expect(text).toMatch(/Muzi Works #1 · \w[\w ]* · 1 version · SWR 1\.47 at 907/)
    expect(deviceCalls(w).length).toBe(before)
  })

  test('with a name: that antenna\'s history, one line per version', async ($, on) => {
    world(on)
    await start($)
    const text = await call($, 'vna_antennas', { name: 'muzi works #3' })
    expect(text).toMatch(/^Muzi Works #3: 2 sweeps, SWR at 907 1\.\d\d → 1\.\d\d/)
    expect(text.split('\n')).toHaveLength(3)
    expect(await call($, 'vna_antennas', { name: 'Nope' })).toMatch(/No saved antenna called "Nope"\. Saved: Muzi Works #3, Muzi Works #1/)
  })

  test('with a and b: the compare table, and a clear answer for a missing one', async ($, on) => {
    world(on)
    await start($)
    const text = await call($, 'vna_antennas', { a: 'Muzi Works #1', b: 'Muzi Works #3' })
    expect(text).toMatch(/A: Muzi Works #1/)
    expect(text).toMatch(/SWR @906\.875 +1\.47 +1\.2\d +← B/)
    expect(await call($, 'vna_antennas', { a: 'Muzi Works #1', b: 'Ghost' })).toMatch(/Could not find two saved antennas/)
  })
})

describe('vna_action', () => {
  test('save runs through the queue and keeps the antenna', async ($, on) => {
    const w = world(on)
    w.reply.save = () => ({ ...LIVE, ok: true, saved: '/Users/test/NanoVNA/sweeps/Nag-whip-20261008.s1p' })
    await start($)
    const text = await call($, 'vna_action', { action: 'save', name: 'Nag whip' })
    expect(text).toMatch(/^Saved Nag whip: SWR 1\.\d\d at 906\.875/)
    const save = w.calls.find(c => c[0] === 'save')
    expect(save?.slice(0, 2)).toEqual(['save', 'Nag whip'])
    await w.clock.advance(1500)
    const log = (w.files.get('/Users/test/Library/Application Support/vna/actions.jsonl') ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(log.find(l => l.action === 'Saving Nag whip')).toMatchObject({ ok: true })
  })

  test('save needs a name', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await call($, 'vna_action', { action: 'save' })).toMatch(/save needs a name/)
    expect(w.calls.some(c => c[0] === 'save')).toBe(false)
  })

  test('markers mesh and best', async ($, on) => {
    const w = world(on)
    await start($)
    expect(await call($, 'vna_action', { action: 'markers', value: 'best' })).toBe('Markers placed.')
    expect(await call($, 'vna_action', { action: 'markers', value: 'mesh' })).toBe('Markers placed.')
    expect(w.calls.filter(c => c[0] === 'markers').map(c => c[1])).toEqual(['best', 'mesh'])
    expect(await call($, 'vna_action', { action: 'markers', value: 'somewhere' })).toMatch(/markers needs value/)
  })

  test('band recalls a slot (mesh goes back); it never calibrates', async ($, on) => {
    const w = world(on)
    w.reply.band = args => (args[1] === '2m' ? { ...LIVE_2M, ok: true, say: '2 m ham: slot 1 recalled.' } : { ...LIVE, slot: 0, ok: true, say: 'Back to Meshtastic: slot 0 recalled.' })
    await start($)
    expect(await call($, 'vna_action', { action: 'band', value: '2m' })).toBe('2 m ham: slot 1 recalled.')
    expect(await call($, 'vna_action', { action: 'band', value: 'back' })).toMatch(/^Back to Meshtastic/)
    expect(w.calls.filter(c => c[0] === 'band').map(c => c[1])).toEqual(['2m', 'mesh'])
    expect(await call($, 'vna_action', { action: 'band', value: 'zzz' })).toMatch(/^No band zzz\./)
    expect(await call($, 'vna_action', { action: 'band', value: 'cal 2m' })).toMatch(/Calibration stays in the tab/)
    expect(w.calls.filter(c => c[0] === 'band' && c.includes('cal'))).toHaveLength(0)
  })

  test('trim: set a target, snip, and reset', async ($, on) => {
    const w = world(on, LIVE_RESONANT)
    w.reply.poll = () => ({ idle: true })
    await start($)
    const t = await call($, 'vna_action', { action: 'trim', value: '910.525' })
    expect(t).toMatch(/Trim · target 910\.525 MHz/)
    const s = await call($, 'vna_action', { action: 'trim', value: 'snip' })
    expect(s).toMatch(/^Logged #1: resonant at 917\.6 MHz/)
    expect(s).toMatch(/Changes \(1\):/)
    expect(await call($, 'vna_action', { action: 'trim', value: 'reset' })).toBe('Trim timeline cleared.')
    expect(await call($, 'vna_action', { action: 'trim', value: 'meshtastic' })).toMatch(/target 906\.875 MHz \(Meshtastic\)/)
    expect(await call($, 'vna_action', { action: 'trim', value: 'sideways' })).toMatch(/trim needs value/)
    // None of it touched the device's settings.
    expect(w.calls.filter(c => ['band', 'cal', 'preset', 'markers', 'save'].includes(c[0] ?? ''))).toHaveLength(0)
  })

  test('export makes the report card', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    w.reply.export = () => ({ ok: true, svg: '/Users/test/NanoVNA/exports/Nag-whip.svg', png: '/Users/test/NanoVNA/exports/Nag-whip.png', say: 'Exported /Users/test/NanoVNA/exports/Nag-whip.png (the SVG is beside it).' })
    await start($)
    const text = await call($, 'vna_action', { action: 'export', name: 'Nag whip' })
    expect(text).toBe('Exported /Users/test/NanoVNA/exports/Nag-whip.png (the SVG is beside it).')
    expect(w.calls.find(c => c[0] === 'export')).toContain('Nag whip')
  })

  test('a tool and a click share the queue: the second waits for the first, nothing overlaps', async ($, on) => {
    const w = world(on)
    w.slow.markers = 2000
    await start($)
    const a = call($, 'vna_action', { action: 'markers', value: 'mesh' })
    const b = call($, 'vna_action', { action: 'save', name: 'Late one' })
    await w.clock.advance(300)
    // While the markers press runs, the save has not started.
    expect(w.calls.some(c => c[0] === 'save')).toBe(false)
    w.reply.save = () => ({ ...LIVE, ok: true, saved: '/x/Late-one.s1p' })
    await w.clock.advance(2500)
    await a
    await w.clock.advance(500)
    expect(await b).toMatch(/^Saved Late one/)
    const order = w.calls.filter(c => c[0] === 'markers' || c[0] === 'save').map(c => c[0])
    expect(order).toEqual(['markers', 'save'])
  })

  test('calibrate, the power-on save, delete, the X trace and QC are refused: do it in the tab', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    await start($)
    const before = w.calls.length
    const said: Record<string, string> = {}
    for (const action of ['calibrate', 'cal', 'poweron', 'delete', 'x', 'qc', 'layout', 'slot']) said[action] = await call($, 'vna_action', { action, name: 'Nag whip', value: 'on' })
    expect(said.calibrate).toMatch(/Calibration stays in the tab/)
    expect(said.cal).toMatch(/Calibration stays in the tab/)
    expect(said.poweron).toMatch(/power-on save .* stay in the tab/)
    expect(said.slot).toMatch(/stay in the tab/)
    expect(said.delete).toMatch(/Deleting a saved antenna is done in the tab/)
    expect(said.x).toMatch(/stays in the tab/)
    expect(said.qc).toMatch(/made in the tab/)
    expect(said.layout).toMatch(/stay in the tab/)
    expect(await call($, 'vna_action', { action: 'frobnicate' })).toMatch(/vna_action can do save, markers, band, trim and export/)
    // Not one call went to vna.py for any of them (the tab's own background poll aside).
    expect(w.calls.slice(before).filter(c => !['library', 'presets', 'poll'].includes(c[0] ?? ''))).toHaveLength(0)
  })
})
