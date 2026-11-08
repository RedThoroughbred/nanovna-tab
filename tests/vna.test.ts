import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { LIBRARY, LIVE, LIVE_FAIL, LIVE_LONG, LIVE_RESONANT, QC_LOG } from './fixture'
import { LIVE_2M, PRESETS } from './fixture-bands'
import { LEASE_FILE, LIVE_FILE, NOW, start, stored, vna, world, type World } from './world'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const PANE = {
  plugin: 'vna',
  component: 'Pane' as const,
  requestId: 'vna',
  props: { title: 'VNA', isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
}
// A picture by what its alt text says (an Svg takes no key).
async function pic(ui: any, alt: RegExp): Promise<any> {
  return ((await ui.findAll({ type: 'Svg' })) as any[]).find(s => alt.test(String(s.props.alt)))
}

// The height a picture takes at its own width (capped by the drawing width): what the tab must pass.
function heightOf(source: string, maxW: number): number {
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(source.slice(0, 800))
  const w = Number(vb?.[1])
  const h = Number(vb?.[2])
  return Math.round((Math.min(w, maxW) * h) / w)
}

// The timing log the plugin wrote (~/Library/Application Support/vna/actions.jsonl), one record a line.
function logOf(w: World): any[] {
  const text = [...w.files.entries()].find(([path]) => path.endsWith('/vna/actions.jsonl'))?.[1] ?? ''
  return text
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
}

// A whip resonant at f0 MHz (a series R-L-C, X = 0 exactly at f0) swept 850–980 MHz, as vna.py reports it.
function whip(f0: number): unknown {
  const curve: [number, number][] = []
  const s11: [number, number][] = []
  for (let i = 0; i < 201; i++) {
    const f = 850 + (130 * i) / 200
    const r = 45 * (f / f0) ** 2
    const x = 45 * 8 * (f / f0 - f0 / f)
    const d = (r + 50) ** 2 + x * x
    const g: [number, number] = [((r - 50) * (r + 50) + x * x) / d, (100 * x) / d]
    const m = Math.hypot(g[0], g[1])
    curve.push([Number(f.toFixed(3)), Number(((1 + m) / (1 - m)).toFixed(3))])
    s11.push([Number(g[0].toFixed(5)), Number(g[1].toFixed(5))])
  }
  const swrAt = (mhz: number) => {
    const k = curve.findIndex(p => p[0] >= mhz)
    return (curve[k] as [number, number])[1]
  }
  const best = curve.reduce((a, b) => (b[1] < a[1] ? b : a))
  return {
    ...LIVE,
    curve,
    s11,
    markers: [],
    metrics: {
      meshtastic: { name: 'Meshtastic', mhz: 906.875, swr: swrAt(906.875) },
      meshcore: { name: 'MeshCore', mhz: 910.525, swr: swrAt(910.525) },
      mid: { name: '915', mhz: 915, swr: swrAt(915) },
      best: { mhz: best[0], swr: best[1] },
      under2: null,
      resonance: null,
    },
  }
}

describe('vna tab', () => {
  test('draws on every surface with the hero reading', async ($, on) => {
    world(on)
    await start($)
    await vna($, '')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      if (surface === 'terminal') {
        expect(await ui.find({ type: 'Text', text: /SWR 1\.\d\d at 906\.875 MHz · excellent/ })).toBeDefined()
      } else {
        const hero = await ui.findAll({ type: 'Svg' })
        expect(hero.length).toBeGreaterThan(1)
        expect(String(hero[0]?.props.alt)).toMatch(/at 906\.875 MHz \(Meshtastic\) · excellent: (under|about) \d*%? ?.*bounces back/)
      }
      expect(await ui.find({ type: 'Text', text: /X stays negative \(capacitive\)/ })).toBeDefined()
      expect(await ui.find({ key: 'mk-mesh' })).toBeDefined()
      // The five places, the guide and Export at the top, and ⤢ on the big views.
      for (const key of ['sec:measure', 'sec:trim', 'sec:library', 'sec:qc', 'sec:bands', 'guide', 'export', 'tab:reading', 'tab:chart']) {
        if (surface === 'terminal' && key === 'tab:chart') continue
        expect(await ui.find({ key })).toBeDefined()
      }
      // The phone has no Input, so it gets a one-press save instead.
      expect(Boolean(await ui.find({ key: 'save-quick' }))).toBe(surface === 'mobile')
      await ui.unmount()
    }
  })

  test('the view buttons switch the chart and remember it', async ($, on) => {
    world(on)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (const [key, alt] of [
      ['view:smith', /^Smith chart/],
      ['view:rx', /^R & X chart/],
      ['view:rl', /^Return loss chart/],
      ['view:swr', /^SWR chart/],
    ] as const) {
      await ui.press({ key })
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.some(s => alt.test(String(s.props.alt)))).toBe(true)
      for (const s of svgs) expect(String(s.props.source).length).toBeLessThan(131072)
    }
    await ui.press({ key: 'view:smith' })
    expect(stored.get('view')).toBe('smith')
  })

  test('/vna reports resonance with a cautious trimming hint', async ($, on) => {
    world(on, LIVE_RESONANT)
    await start($)
    const r = await vna($, '')
    expect(r.text).toMatch(/SWR 1\.\d\d at 906\.875 MHz \(Meshtastic\) · excellent/)
    expect(r.text).toMatch(/Resonant at 917\.6 MHz, 7\.1 MHz above 910\.525: for a simple whip that usually means slightly short/)
  })

  test('QC mode shows the verdict and records with the next unit number', async ($, on) => {
    const w = world(on)
    await start($)
    const r = await vna($, 'qc on')
    expect(r.text).toMatch(/QC PASS/)
    for (const surface of ['mobile', 'terminal'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      // The terminal lists the checks as text; the phone and desktop draw them on the stamp.
      if (surface === 'terminal') expect(await ui.find({ type: 'Text', text: /SWR ≤ 2\.0 across 902–928 MHz/ })).toBeDefined()
      else {
        const stamp = await pic(ui, /^QC /)
        expect(String(stamp?.props.alt)).toMatch(/^QC PASS: SWR ≤ 2\.0 across 902–928 MHz ✓/)
        expect(String(stamp?.props.source)).toContain('>PASS<')
      }
      expect((await ui.find({ key: 'qc-save' }))?.text).toBe('Save as Unit 7')
      await ui.unmount()
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'qc-save' })
    await w.clock.advance(50)
    const save = w.calls.find(c => c[0] === 'qc' && c[1] === 'save')
    expect(save?.slice(0, 3)).toEqual(['qc', 'save', 'Unit 7'])
    expect(save?.[3]).toBe('--rules')
    expect(JSON.parse(save?.[4] ?? '{}')).toMatchObject({ lo: 902, hi: 928, bandMax: 2, spotMax: 1.5 })
    expect(await ui.find({ key: 'qc-cert' })).toBeDefined()
    const off = await vna($, 'qc off')
    expect(off.text).toBe('QC mode off.')
  })

  test('compare, history and markers answer as text', async ($, on) => {
    const w = world(on)
    await start($)
    const c = await vna($, 'compare Muzi Works #1 Muzi Works #3')
    expect(c.text).toMatch(/A: Muzi Works #1/)
    expect(c.text).toMatch(/SWR @906\.875 +1\.47 +1\.2\d +← B/)
    const h = await vna($, 'history Muzi Works #3')
    expect(h.text).toMatch(/Muzi Works #3: 2 sweeps, SWR at 907 1\.\d\d → 1\.\d\d/)
    const m = await vna($, 'markers best')
    expect(m.text).toBe('Markers placed.')
    expect(w.calls.some(x => x[0] === 'markers' && x[1] === 'best')).toBe(true)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /History · Muzi Works #3/ })).toBeDefined()
    expect(await ui.find({ key: 'a:Muzi Works #1' })).toBeDefined()
  })
})

describe('the pictures', () => {
  test('every picture passes its height and stays under the size limit, in every place, on the desktop and the phone', async ($, on) => {
    world(on)
    await start($)
    await vna($, 'compare Muzi Works #1 Muzi Works #3')
    for (const [surface, maxW] of [
      ['desktop', 660],
      ['mobile', 360],
    ] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      const check = async (least: number) => {
        const svgs = await ui.findAll({ type: 'Svg' })
        expect(svgs.length).toBeGreaterThanOrEqual(least)
        for (const s of svgs) {
          const src = String(s.props.source)
          expect(src.length).toBeLessThan(131072)
          expect(src).not.toMatch(/<script|onload=|onclick=/)
          expect(typeof s.props.height).toBe('number')
          expect(s.props.height).toBe(heightOf(src, maxW))
        }
      }
      await ui.press({ key: 'sec:measure' })
      for (const key of ['view:swr', 'view:rl', 'view:rx', 'view:smith']) {
        await ui.press({ key })
        await check(3) // hero, trimming drawing, chart
      }
      await ui.press({ key: 'sec:library' })
      await check(3) // the compare chart and one card per antenna
      await ui.press({ key: 'sec:trim' })
      await check(2) // the live readout and the timeline
      await ui.press({ key: 'sec:qc' })
      await check(1)
      await ui.press({ key: 'sec:bands' })
      await check(2) // the band map and the dipole
      await ui.press({ key: 'guide' })
      await check(3)
      await ui.press({ key: 'guide' }) // closed again
      await ui.unmount()
    }
  })

  test('the hero is an LCD with a meter, a grade and a verdict', async ($, on) => {
    world(on)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const hero = await pic(ui, /^SWR 1\.\d\d at 906\.875/)
    expect(String(hero?.props.alt)).toMatch(/grade A: Great match for Meshtastic and MeshCore$/)
    const src = String(hero?.props.source)
    expect(src).toContain('<polygon')
    expect(src).toContain('MESHTASTIC · 906.875 MHz')
    expect(src).toContain('MESHCORE · 910.525 MHz')
    expect(src).toContain('>GRADE<')
    const t = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await t.find({ type: 'Text', text: 'Grade A · Great match for Meshtastic and MeshCore' })).toBeDefined()
  })

  test('a failing unit grades C, stamps FAIL and draws the cut-or-lengthen hint', async ($, on) => {
    world(on, LIVE_FAIL)
    await start($)
    const r = await vna($, 'qc on')
    expect(r.text).toMatch(/QC FAIL/)
    expect(r.text).toMatch(/Grade C · So-so match for Meshtastic and MeshCore/)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    const stamp = await pic(ui, /^QC /)
    expect(String(stamp?.props.source)).toContain('>FAIL<')
    expect(String(stamp?.props.alt)).toMatch(/^QC FAIL: /)
    await ui.press({ key: 'sec:measure' })
    const trim = await pic(ui, /^Trimming hint/)
    expect(String(trim?.props.alt)).toMatch(/^Trimming hint: Noticeably short by ~3\.0 mm\. Resonant at 945\.0 MHz, 34\.5 MHz above 910\.525/)
  })

  test('the trimming drawing says to cut a whip that resonates low', async ($, on) => {
    world(on, LIVE_LONG)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(String((await pic(ui, /^Trimming hint/))?.props.alt)).toMatch(/^Trimming hint: Slightly long: cut ~0\.9 mm\./)
  })

  test('the trimming drawing says a whip that resonates high is short', async ($, on) => {
    world(on, LIVE_RESONANT)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(String((await pic(ui, /^Trimming hint/))?.props.alt)).toMatch(/^Trimming hint: Slightly short by ~0\.6 mm\. Resonant at 917\.6 MHz, 7\.1 MHz above 910\.525/)
  })

  test('antenna cards in their own colours: a grade, a sparkline, the best point and resonance; A/B shades and names a winner', async ($, on) => {
    world(on)
    await start($)
    await vna($, 'compare Muzi Works #1 Muzi Works #3')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const card = await pic(ui, /^Muzi Works #3: grade/)
    expect(String(card?.props.alt)).toMatch(/^Muzi Works #3: grade A, SWR 1\.2\d at 906\.875 and 1\.2\d at 910\.525, best 1\.2\d at 909\.15 MHz, no resonance in the sweep · reads short, 2 versions/)
    expect(await ui.find({ key: 'ov:Muzi-Works-1-20261004.s1p' })).toBeDefined()
    expect(await ui.find({ key: 'h:Muzi Works #3' })).toBeDefined()
    const cmp = String((await pic(ui, /^Muzi Works #1 against Muzi Works #3$/))?.props.source)
    expect(cmp).toMatch(/★ B wins · 1\.2\d/)
    expect(cmp).toContain('A · Muzi Works #1')
    // Each antenna keeps one colour, its card's frame and name, and the same colour for A or B on the chart.
    const colors = stored.get('antColors') as Record<string, number>
    expect(new Set(Object.values(colors)).size).toBe(Object.keys(colors).length)
    const c1 = (await pic(ui, /^Muzi Works #1: grade/))?.props.source as string
    const c3 = String(card?.props.source)
    const name = (s: string) => /<text x="62\.0" y="31\.0" fill="(#[0-9a-f]{6})"/.exec(s)?.[1]
    expect(name(c1)).not.toBe(name(c3))
    expect(cmp).toContain(`stroke="${name(c1)}"`)
    expect(cmp).toContain(`stroke="${name(c3)}"`)
    // The phone gets the same cards, full width, and no text field.
    const phone = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(String((await pic(phone, /^Muzi Works #1: grade/))?.props.source)).toContain('width="360"')
    expect(await phone.find({ type: 'Input' })).toBeUndefined()
    // The terminal keeps its table, with the grade in a column and the name in its colour.
    const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await term.find({ key: 'a:Muzi Works #1' })).toBeDefined()
    expect((await term.find({ type: 'Text', text: 'Muzi Works #1' }))?.props.color).toBe(name(c1))
  })

  test('the terminal strip is coloured by zone', async ($, on) => {
    world(on, LIVE_FAIL)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const texts = await ui.findAll({ type: 'Text' })
    const strip = texts.filter(t => /^[▁▂▃▄▅▆▇█]+$/.test(String(t.text ?? '')))
    expect(strip.length).toBeGreaterThan(1)
    expect(new Set(strip.map(t => t.props.color)).size).toBeGreaterThan(1)
  })
})

describe('presses: shown at once, never dropped, run once, ahead of the polls', () => {
  test('the pending label is in the very next drawing; a press while another runs is queued; the newest waiting press wins', async ($, on) => {
    const w = world(on)
    await start($)
    await vna($, '')
    w.slow.markers = 2000
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ key: 'mk-mesh' }))?.text).toBe('Markers on 907 / 910.5 / 915')
    await ui.press({ key: 'mk-mesh' })
    // vna.py has not answered (it is asleep on the clock): the drawing already says so.
    const btn = await ui.find({ key: 'mk-mesh' })
    expect(btn?.text).toBe('Placing…')
    expect(btn?.props.variant).toBe('primary')
    expect(await ui.find({ type: 'Text', text: /^Placing markers: reading the sweep and moving the markers \(about \d+ s\)$/ })).toBeDefined()
    await ui.press({ key: 'mk-best' })
    expect((await ui.find({ key: 'mk-best' }))?.text).toBe('Queued: Moving M1 to the best point')
    expect((await ui.find({ key: 'mk-best' }))?.props.dimColor).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^Queued: Moving M1 to the best point, runs next$/ })).toBeDefined()
    // A newer press replaces the one waiting (the last click wins); nothing of it has run.
    await ui.press({ key: 'shot' })
    expect((await ui.find({ key: 'mk-best' }))?.text).toBe('Markers to best')
    expect((await ui.find({ key: 'shot' }))?.text).toBe('Queued: Screenshot')
    expect(w.calls.some(c => c[0] === 'shot')).toBe(false)
    await w.clock.advance(2100)
    const order = w.calls.map(c => c[0] + (c[1] && !c[1].startsWith('--') ? ` ${c[1]}` : ''))
    expect(order.indexOf('shot')).toBeGreaterThan(order.indexOf('markers mesh'))
    expect(order).not.toContain('markers best')
    expect((await ui.find({ key: 'mk-mesh' }))?.text).toBe('Markers on 907 / 910.5 / 915')
    expect(await ui.find({ type: 'Text', text: /^Placing markers: / })).toBeUndefined()
    // One line per press in the timing log, with when it was pressed, started and finished.
    await w.clock.advance(1100)
    const log = logOf(w)
    const shot = log.find(l => l.action === 'Screenshot')
    expect(shot).toMatchObject({ key: 'shot', queued: true, coalesced: 0, ok: true })
    expect(shot.startedAt).toBeGreaterThanOrEqual(shot.pressedAt)
    expect(shot.finishedAt).toBeGreaterThanOrEqual(shot.startedAt)
    expect(log.find(l => l.action === 'Moving M1 to the best point')).toMatchObject({ superseded: true, ok: null, by: 'Screenshot' })
    expect(log.find(l => l.key === 'markers mesh')).toMatchObject({ queued: false, ok: true })
  })

  test('three quick presses on one button run it once', async ($, on) => {
    const w = world(on)
    await start($)
    await vna($, '')
    w.slow.markers = 1500
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (let i = 0; i < 3; i++) await ui.press({ key: 'mk-mesh' })
    expect((await ui.find({ key: 'mk-mesh' }))?.text).toBe('Placing…')
    await w.clock.advance(2700)
    expect(w.calls.filter(c => c[0] === 'markers' && c[1] === 'mesh')).toHaveLength(1)
    expect(logOf(w).find(l => l.key === 'markers mesh')).toMatchObject({ coalesced: 2, ok: true })
  })

  test('a press waits only for the sweep already under way, and no poll runs while it runs or waits', async ($, on) => {
    const w = world(on)
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // The next sweep takes 2 s: the press comes while it is under way.
    w.slow.poll = 2000
    await w.clock.advance(3100)
    w.calls.length = 0
    w.slow.markers = 3500
    await ui.press({ key: 'mk-mesh' })
    expect((await ui.find({ key: 'mk-mesh' }))?.text).toBe('Placing…')
    expect(w.calls.some(c => c[0] === 'markers')).toBe(false)
    await w.clock.advance(5000)
    const o = w.calls.map(c => c[0])
    const mk = o.indexOf('markers')
    expect(mk).toBe(0)
    // The ticks every 3 s while the press ran asked for no sweep.
    expect(o.slice(mk + 1).filter(v => v === 'poll')).toHaveLength(0)
    await w.clock.advance(4000)
    expect(w.calls.slice(mk + 1).some(c => c[0] === 'poll')).toBe(true)
  })
})

describe('one NanoVNA, several Claude sessions', () => {
  test('another session holds the lease: this one never sweeps and shows what that one shares', async ($, on) => {
    const w = world(on)
    w.files.set(LEASE_FILE, JSON.stringify({ session: 'sOther', ppid: 1, until: (NOW + 8000) / 1000 }))
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE_RESONANT, at: NOW - 1000, by: 'sOther' }))
    await start($)
    await w.clock.advance(3100)
    expect(w.calls.filter(c => ['poll', 'live', 'status'].includes(c[0] ?? ''))).toHaveLength(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /Another Claude session is reading the NanoVNA/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Resonant at 917\.6 MHz/ })).toBeDefined()
    // Someone is looking at this session's tab: it says so for the lease holder to see.
    expect([...w.files.keys()].some(k => /\/Library\/Caches\/vna\/watch-s[0-9a-z]+$/.test(k))).toBe(true)
  })

  test('/vna answers from a fresh shared reading without touching the NanoVNA', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    await start($)
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE_RESONANT, at: NOW - 2000, by: 'sOther' }))
    const before = w.calls.length
    const r = await vna($, '')
    expect(r.text).toMatch(/Resonant at 917\.6 MHz/)
    expect(w.calls.slice(before).filter(c => c[0] === 'live')).toHaveLength(0)
  })

  test('a busy lock still produces a reply at once, with the last reading and how old it is', async ($, on) => {
    const w = world(on)
    const busy = () => ({ busy: true, say: 'NanoVNA busy: another session or command is talking to it.', lastAt: NOW - 120_000 })
    w.reply.poll = busy
    w.reply.live = busy
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE, at: NOW - 120_000, by: 'sOther' }))
    await start($)
    const r = await vna($, '')
    expect(r.text).toMatch(/^NanoVNA busy: another session or command is talking to it\. Last reading 2 min ago:/)
    expect(r.text).toMatch(/SWR 1\.\d\d at 906\.875 MHz \(Meshtastic\)/)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^NanoVNA busy: .* Showing the reading from 2 min ago\.$/ })).toBeDefined()
  })

  test('a NanoVNA that never answers still gets /vna a reply within its budget', async ($, on) => {
    const w = world(on)
    w.reply.poll = () => ({ idle: true })
    w.files.set(LIVE_FILE, JSON.stringify({ ...LIVE, at: NOW - 60_000, by: 'sOther' }))
    await start($)
    w.slow.live = 60_000
    const p = vna($, '')
    await w.clock.advance(8000)
    const r = await p
    expect(r.text).toMatch(/^NanoVNA busy or not answering\. Last reading 60 s ago:/)
  })

  test('a slow press answers its command in time and goes on in the tab', async ($, on) => {
    const w = world(on)
    await start($)
    await vna($, '')
    w.slow.save = 30_000
    const p = vna($, 'save Nag whip')
    await w.clock.advance(7600)
    const r = await p
    expect(r.text).toMatch(/^Working on it: Saving Nag whip: reading a sweep and writing the file/)
  })
})

describe('bands, slots and the power-on layout', () => {
  test('switching to a band and back recalls its slot, then slot 0; nothing is calibrated or saved', async ($, on) => {
    const w = world(on)
    w.reply.band = args =>
      args[1] === '2m'
        ? { ...LIVE_2M, ok: true, say: '2 m ham: slot 1 recalled, calibrated 2026-10-06.' }
        : args[1] === 'mesh'
          ? { ...LIVE, slot: 0, ok: true, say: 'Back to Meshtastic: slot 0 recalled, the power-on state (850-980 MHz with its calibration and layout, exactly as saved).' }
          : { ...LIVE_2M, ok: true, step: 'open', say: 'Unscrew the antenna and screw the OPEN plug onto PORT 1.' }
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'sec:bands' })
    expect(await ui.find({ type: 'Text', text: 'Power-on is always slot 0, the Meshtastic layout, unchanged.' })).toBeDefined()
    expect(String((await pic(ui, /^Bands: /))?.props.alt)).toMatch(/2 m ham slot 1 calibrated, 70 cm ham slot 2 uncalibrated/)
    expect((await pic(ui, /^Bands: /))?.props.isInteractive).toBe(true)
    // FM mapped to slot 0 in presets.json gets no slot, so no Calibrate button.
    expect(await ui.find({ key: 'bcal:fm' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /no slot · slot 0 is the Meshtastic power-on state/ })).toBeDefined()
    await ui.press({ key: 'band:2m' })
    await w.clock.advance(50)
    expect(w.calls.find(c => c[0] === 'band')?.slice(0, 2)).toEqual(['band', '2m'])
    expect(await ui.find({ type: 'Text', text: /^Calibrated for 2 m ham · slot 1 · 130–165 MHz/ })).toBeDefined()
    await ui.press({ key: 'sec:measure' })
    const hero = await pic(ui, /^SWR 1\.\d\d at 146\.52 MHz \(2 m calling\)/)
    expect(String(hero?.props.alt)).toMatch(/Great match for 2 m ham$/)
    expect(String(hero?.props.source)).toContain('2 M CALLING · 146.52 MHz')
    expect(String((await pic(ui, /^SWR chart/))?.props.source)).toContain('2 m 144–148')
    await ui.press({ key: 'sec:bands' })
    await ui.press({ key: 'band:mesh' })
    await w.clock.advance(50)
    expect(w.calls.filter(c => c[0] === 'band').map(c => c[1])).toEqual(['2m', 'mesh'])
    expect(await ui.find({ type: 'Text', text: /slot 0, the power-on state/ })).toBeDefined()
    // Pressing it again with slot 0 in use asks the NanoVNA nothing.
    await ui.press({ key: 'band:mesh' })
    expect(w.calls.filter(c => c[0] === 'band')).toHaveLength(2)
    expect(w.calls.some(c => ['cal', 'save', 'poweron'].includes(c[0] ?? '') || (c[0] === 'band' && c[1] === 'cal'))).toBe(false)
    // A band without a calibration offers one, into its own slot.
    await ui.press({ key: 'bcal:70cm' })
    await w.clock.advance(50)
    expect(w.calls.find(c => c[1] === 'cal')?.slice(0, 4)).toEqual(['band', 'cal', '70cm', 'begin'])
  })

  test('"Make this my power-on layout" refuses off the mesh band or without slot 0 in use, and asks before it saves', async ($, on) => {
    const w = world(on)
    w.reply.band = args => (args[1] === '2m' ? { ...LIVE_2M, ok: true, say: '2 m' } : { ...LIVE, slot: 0, traces: [{ n: 3, type: 'x', ch: 'S11' }], ok: true, say: 'Back to Meshtastic.' })
    w.reply.poweron = () => ({ ...LIVE, slot: 0, ok: true, trace3: 'x', say: 'Saved slot 0: the mesh calibration in use, 850-980 MHz at 201 points, traces SWR, Smith, LOGMAG and X.' })
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'sec:bands' })
    // The mesh sweep, but nothing says the calibration in use is slot 0's.
    await ui.press({ key: 'poweron-ask' })
    expect(await ui.find({ type: 'Text', text: /^Not saved: the calibration in use is not known to be slot 0's/ })).toBeDefined()
    expect(await ui.find({ key: 'poweron-yes' })).toBeUndefined()
    // Another band's sweep.
    await ui.press({ key: 'band:2m' })
    await w.clock.advance(50)
    await ui.press({ key: 'poweron-ask' })
    expect(await ui.find({ type: 'Text', text: /^Not saved: the NanoVNA is sweeping 130–165 MHz \/ 201 points, not the 850–980 MHz/ })).toBeDefined()
    expect(await ui.find({ key: 'poweron-yes' })).toBeUndefined()
    expect(w.calls.some(c => c[0] === 'poweron')).toBe(false)
    // Back to Meshtastic: slot 0 in use. The press asks first and names what it writes.
    await ui.press({ key: 'band:mesh' })
    await w.clock.advance(50)
    await ui.press({ key: 'poweron-ask' })
    expect(await ui.find({ type: 'Text', text: /^This writes slot 0, what the NanoVNA loads every time it is switched on: .*traces SWR · Smith · LOGMAG · X/ })).toBeDefined()
    expect(w.calls.some(c => c[0] === 'poweron')).toBe(false)
    await ui.press({ key: 'poweron-no' })
    expect(await ui.find({ key: 'poweron-yes' })).toBeUndefined()
    await ui.press({ key: 'poweron-ask' })
    await ui.press({ key: 'poweron-yes' })
    await w.clock.advance(50)
    const save = w.calls.filter(c => c[0] === 'poweron')
    expect(save).toHaveLength(1)
    expect(save[0]?.slice(0, 3)).toEqual(['poweron', 'save', '--confirm'])
  })

  test('/vna band lists the bands with their slots and the power-on rule', async ($, on) => {
    world(on)
    await start($)
    const r = await vna($, 'band')
    expect(r.text).toMatch(/Power-on is always slot 0, the Meshtastic layout, unchanged/)
    expect(r.text).toMatch(/2m +2 m ham +144–148 MHz +slot 1 · calibrated/)
    expect(r.text).toMatch(/fm +FM broadcast .*no slot: slot 0 is the Meshtastic power-on state/)
    expect(r.text).toMatch(/cb +CB 11 m/)
  })
})

describe('the trim assistant', () => {
  test('logs each change once it holds still, sees the target crossed with an undo hint, then on frequency', async ($, on) => {
    const w = world(on, whip(890))
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'sec:trim' })
    const step = async (f: number) => {
      w.live = whip(f)
      await w.clock.advance(3100)
      await ui.find({ key: 'snip' })
    }
    for (const f of [890, 890, 898, 898]) await step(f)
    expect(String((await pic(ui, /^Trim timeline/))?.props.alt)).toMatch(/^Trim timeline: #1 890\.\d+ MHz, #2 898\.\d+ MHz$/)
    let now = String((await pic(ui, /^Trim: /))?.props.alt)
    expect(now).toMatch(/resonant at 898\.\d MHz \(X = 0\), target 906\.875 MHz \(Meshtastic\) · closer… 8\.\d MHz low · cut a little/)
    // A cut too far: it now resonates above the target.
    for (const f of [913, 913]) await step(f)
    expect(String((await pic(ui, /^Trim timeline/))?.props.alt)).toMatch(/#3 913\.\d+ MHz \(passed\)$/)
    now = String((await pic(ui, /^Trim: /))?.props.alt)
    expect(now).toMatch(/You passed it · now 6\.\d MHz high · It went from 8\.\d MHz low to 6\.\d MHz high: that cut went too far\. Undo: lengthen a touch/)
    for (const f of [907.4, 907.4]) await step(f)
    expect(String((await pic(ui, /^Trim: /))?.props.alt)).toMatch(/On frequency ✓/)
    // MeshCore as the target instead: the same readings measured against 910.525, where the last
    // change (913 → 907.4) went past it.
    await ui.press({ key: 'tt:910.525' })
    expect(String((await pic(ui, /^Trim: /))?.props.alt)).toMatch(/target 910\.525 MHz \(MeshCore\) · You passed it · now 3\.\d MHz low · It went from 2\.\d MHz high to 3\.\d MHz low: that change added too much/)
    await ui.press({ key: 'snip' })
    expect(String((await pic(ui, /^Trim timeline/))?.props.alt)).toMatch(/#5 907\.\d+ MHz$/)
    const t = await vna($, 'trim')
    // Against MeshCore now: #3 is still past it, and #4 came back below it.
    expect(t.text).toMatch(/#3 .* 913\.\d MHz +\+2\.\d MHz +auto +← passed the target/)
    expect(t.text).toMatch(/#4 .* 907\.\d MHz +−3\.\d MHz +auto +← passed the target/)
  })
})

describe('own tabs and the export', () => {
  test('/vna tab opens a view in its own tab, drawn alone and readable on the phone', async ($, on) => {
    const w = world(on)
    await start($)
    await vna($, '')
    const r = await vna($, 'tab smith')
    expect(r.text).toMatch(/^Opened VNA Smith in its own tab/)
    expect(w.opened).toContain('vna-smith')
    const smith = await $.ui.mount({ ...PANE, requestId: 'vna-smith', surface: 'desktop' })
    const svgs = await smith.findAll({ type: 'Svg' })
    expect(svgs).toHaveLength(1)
    expect(String(svgs[0]?.props.alt)).toMatch(/^Smith chart/)
    const trim = await $.ui.mount({ ...PANE, requestId: 'vna-trim', surface: 'mobile' })
    for (const s of await trim.findAll({ type: 'Svg' })) expect(s.props.height).toBe(heightOf(String(s.props.source), 360))
    expect(await pic(trim, /^Trim: /)).toBeDefined()
    expect(await trim.find({ key: 'tab:trim' })).toBeUndefined()
    const bands = await $.ui.mount({ ...PANE, requestId: 'vna-bands', surface: 'desktop' })
    expect(await bands.find({ type: 'Text', text: 'Power-on is always slot 0, the Meshtastic layout, unchanged.' })).toBeDefined()
  })

  test('📸 Export draws one report card from the tab’s own pictures and hands it to vna.py', async ($, on) => {
    const w = world(on)
    w.reply.export = () => ({ ok: true, svg: '/Users/test/NanoVNA/exports/Nag-whip-20261006-2105.svg', png: '/Users/test/NanoVNA/exports/Nag-whip-20261006-2105.png', converter: 'chrome', say: 'Exported /Users/test/NanoVNA/exports/Nag-whip-20261006-2105.png (the SVG is beside it).' })
    await start($)
    await vna($, 'compare Muzi Works #1 Muzi Works #3')
    const r = await vna($, 'export Nag whip')
    expect(r.text).toBe('Exported /Users/test/NanoVNA/exports/Nag-whip-20261006-2105.png (the SVG is beside it).')
    const call = w.calls.find(c => c[0] === 'export') as string[]
    expect(call[1]).toBe('--svg')
    expect(call[2]).toMatch(/\/Library\/Application Support\/vna\/export-s[0-9a-z]+\.svg$/)
    expect(call.slice(3)).toEqual(['--name', 'Nag whip'])
    const svg = w.files.get(call[2] as string) as string
    expect(svg.length).toBeLessThan(2_000_000)
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* width="540" height="(\d+)"/)
    expect(Number(/height="(\d+)"/.exec(svg)?.[1])).toBeGreaterThan(1500)
    for (const s of ['ANTENNA REPORT', '>Nag whip<', 'NanoVNA-H4 · fw 1.2.44 · calibrated 850–980 MHz', 'MESHTASTIC · 906.875 MHz', '>GRADE<', 'Smith chart', 'THE NUMBERS', 'Under 2:1', 'A · Muzi Works #1', '>Wildcat RF<'])
      expect(svg).toContain(s)
    expect(svg).not.toMatch(/<script|onload=|onclick=/)
    // Every picture's gradients and filters keep their own names, and every reference finds one.
    const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(m[1])
  })

  test('an export whose PNG could not be made keeps the SVG and says so', async ($, on) => {
    const w = world(on)
    w.reply.export = () => ({ ok: true, svg: '/Users/test/NanoVNA/exports/Live-20261006-2105.svg', png: null, converter: null, say: 'Exported /Users/test/NanoVNA/exports/Live-20261006-2105.svg, but no PNG: chrome made no PNG. The SVG opens in any browser.' })
    await start($)
    await vna($, '')
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    await ui.press({ key: 'export' })
    await w.clock.advance(50)
    expect(w.calls.find(c => c[0] === 'export')?.slice(3)).toEqual(['--name', 'Live'])
    expect(await ui.find({ type: 'Text', text: /but no PNG: chrome made no PNG/ })).toBeDefined()
  })

  test('the guide says how the tab works and what this NanoVNA can do', async ($, on) => {
    world(on)
    await start($)
    const r = await vna($, 'guide')
    expect(r.text).toMatch(/^How the VNA tab works/)
    expect(r.text).toMatch(/Power-on is always slot 0, the Meshtastic layout, unchanged/)
    expect(r.text).toMatch(/What this NanoVNA can do/)
    expect(r.text).toMatch(/from under 1 kHz to 2\.7 GHz/)
    expect(r.text).toMatch(/Never connect a transmitting radio/)
    const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
    expect(String((await pic(ui, /^How the VNA tab works/))?.props.source)).toContain('WHAT THIS NANOVNA CAN DO')
  })
})

describe('the status line and the Herdr strip', () => {
  const HOME = '/home/test'
  const FILE = `${HOME}/.claude/mod-status/vna.json`
  const read = (w: World) => (w.files.has(FILE) ? JSON.parse(w.files.get(FILE) as string) : undefined)

  test('outside Herdr: the status line as before, and the file without the VNA prefix', async ($, on) => {
    const w = world(on, LIVE, { HOME })
    await start($)
    await w.clock.advance(1_000)
    expect(w.status[w.status.length - 1]).toBe('VNA · SWR 1.23 @907')
    expect(read(w)).toEqual({ mod: 'vna', text: 'SWR 1.23 @907', level: 'ok', at: expect.any(Number) })
    expect([...w.files.keys()].some(k => /\/\.claude\/mod-status\/\.vna\.\w+\.tmp$/.test(k))).toBe(false)
  })

  test('inside Herdr the status line is never set, and the file is still written', async ($, on) => {
    const w = world(on, LIVE, { HOME, HC_TERMINAL_ID: 'term-7' })
    await start($)
    await w.clock.advance(1_000)
    expect(w.status).toEqual([])
    expect(read(w)?.text).toBe('SWR 1.23 @907')
  })

  test('nothing while no NanoVNA is connected; unplugging it deletes the file', async ($, on) => {
    const w = world(on, { connected: false }, { HOME })
    await start($)
    await w.clock.advance(1_000)
    expect(w.status.every(t => t === undefined)).toBe(true)
    expect(read(w)).toBeUndefined()

    w.live = LIVE
    await w.clock.advance(20_000)
    expect(read(w)?.text).toBe('SWR 1.23 @907')

    w.live = { connected: false }
    await w.clock.advance(20_000)
    expect(read(w)).toBeUndefined()
    expect(w.status[w.status.length - 1]).toBeUndefined()
  })

  test('the level: SWR 2 warns, 3 alerts, nothing on PORT 1 warns', async ($, on) => {
    const m = (LIVE as any).metrics
    const at = (swr: number, best = swr) => ({ ...LIVE, metrics: { ...m, meshtastic: { ...m.meshtastic, swr }, best: { ...m.best, swr: best } } })
    const w = world(on, at(2.4), { HOME })
    await start($)
    await w.clock.advance(1_000)
    expect(read(w)).toMatchObject({ text: 'SWR 2.40 @907', level: 'warn' })

    w.live = at(3.5)
    await w.clock.advance(20_000)
    expect(read(w)).toMatchObject({ text: 'SWR 3.50 @907', level: 'alert' })

    w.live = at(40, 40)
    await w.clock.advance(20_000)
    expect(read(w)).toMatchObject({ text: 'nothing on PORT 1', level: 'warn' })
  })

  test('/vna hide deletes the file and is remembered; show brings both back', async ($, on) => {
    const w = world(on, LIVE, { HOME })
    await start($)
    await w.clock.advance(1_000)
    expect(read(w)).toBeDefined()

    const r = await vna($, 'hide')
    expect(r.text).toContain('hidden')
    await w.clock.advance(5_000)
    expect(read(w)).toBeUndefined()
    expect(w.status[w.status.length - 1]).toBeUndefined()
    expect(stored.get('statusOn')).toBe(false)

    await vna($, 'show')
    await w.clock.advance(1_000)
    expect(read(w)?.text).toBe('SWR 1.23 @907')
    expect(w.status[w.status.length - 1]).toBe('VNA · SWR 1.23 @907')
  })
})
