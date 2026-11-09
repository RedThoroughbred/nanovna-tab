// The guide cards, the strip words, the compare rows and the small view helpers. No state, no $.

import { AMBER, BG, BRIGHT, DEFAULT_RULES, GREEN, G_FULL, LABEL, LCD, MAGENTA, ORANGE, RED, SANS, SKY, VIOLET, YELLOW } from './constants'
import { day, drawnAt, fmt, gam, lim, meaning, verdict, zText } from './readings'
import { n1, svgDoc, txt, wrapText } from './svg-kit'
import type { Ctx, Geo, Group, Look, Mark, Metrics, Proc, Rules } from './types'
import type { Level } from './mod-status'

export const GUIDE: [string, string, string][] = [
  ['Measure', 'Screw the antenna onto PORT 1. The big number is the SWR at 906.875 MHz (Meshtastic): 1.0 is perfect, under 1.5 excellent (green), under 2 good (amber), above that poor (red). The grade is the worse of Meshtastic and MeshCore. The chart below has four views; each says what it shows under it.', LCD],
  ['Trim', 'For cutting or bending an antenna. The big number is where it resonates now (where X crosses zero, else the bottom of the SWR dip) against your target; the arrow says which way to go. Each change is logged when the dip moves and holds still, or press ✂ Snip. "You passed it" means the last change went past the target, with how to undo it.', YELLOW],
  ['Library', 'Save the antenna on PORT 1 by name; the same name again keeps a version. Every antenna keeps its own colour, the same on its card, on the chart, in A/B and in its history. ○ chart overlays it, A and B compare two, N versions shows how it changed.', MAGENTA],
  ['QC', 'For units you sell: PASS or FAIL against the rule (SWR ≤ 2 across 902–928 and ≤ 1.5 at both mesh channels), with a CSV row, the sweep and a printable certificate per unit. Refused while the NanoVNA is not calibrated.', AMBER],
  ['Bands', 'Other radios: 2 m and 70 cm (the UV-5R), 1090 ADS-B, 433 ISM, FM, and your own in presets.json. Each band keeps its calibration in its own save slot (1–6). Pressing a band recalls it; Back to Meshtastic recalls slot 0. Power-on is always slot 0, the Meshtastic layout, unchanged.', SKY],
  ['Calibrate', 'OPEN, SHORT, LOAD screwed onto PORT 1 (at the end of any cable you measure through), in that order; each step checks the right plug is on. A band you have not calibrated says UNCAL: its numbers are rough.', GREEN],
  ['Buttons', 'A press shows on its button at once and at the top ("Doing now"); a press while another runs waits as "Next", and the newest one wins. Three quick presses run once. ⤢ opens a view in its own tab.', ORANGE],
  ['Several sessions', 'With the tab open in more than one Claude session, one of them talks to the NanoVNA and the rest show what it read; nobody sweeps while no VNA tab is on screen. /vna answers from the latest reading.', VIOLET],
]

// Checked against DiSlord's firmware source (1.2.40 and 1.2.46 on either side of this H4's 1.2.44).
export const CAN_DO: [string, string][] = [
  ['Frequency range', 'The firmware sweeps from under 1 kHz to 2.7 GHz. Above 300 MHz it measures on its oscillator’s harmonics, so readings get weaker and noisier the higher you go: its dynamic range is best below about 300 MHz.'],
  ['Two measurements', 'S11 on PORT 1 (CH0): what reflects back, for antennas. S21 from PORT 1 to PORT 2 (CH1): what passes through, for filters, cables and attenuators. This tab reads S11.'],
  ['Cables and faults (TDR)', 'Its time-domain transform turns a sweep into distance along a cable: its length and where a fault is. The firmware also has cable, resonance and LC-match measure modes on its own screen.'],
  ['Points and slots', 'Up to 401 points a sweep (this tab uses 201). 7 save slots (0–6) on the H4, each a whole state: sweep, calibration, traces and markers.'],
  ['Accuracy is the calibration', 'Numbers are only as good as the OPEN, SHORT, LOAD done for the range you sweep, at the point you measure. Change the range or add a cable or adapter, and calibrate again.'],
  ['Never transmit into it', 'Never connect a transmitting radio, or a node’s antenna socket while it can transmit, to the NanoVNA: its ports are made for the tiny signal it sends itself, and a transmitter’s power can destroy them. Test antennas, not live outputs.'],
]

export function guideSvg(g: Geo): string {
  const c = g.c
  const W = g.W
  const cols = c ? 1 : 2
  const gap = 12
  const cw = (W - 28 - gap * (cols - 1)) / cols
  const chars = Math.floor((cw - 50) / 6.1)
  const cards = GUIDE.map(([t, s, col]) => ({ t, col, lines: wrapText(s, chars) }))
  const can = CAN_DO.map(([t, s]) => ({ t, lines: wrapText(s, c ? chars + 4 : Math.floor((W - 70) / 6.1)) }))
  const cardH = (k: { lines: string[] }) => 36 + k.lines.length * 14
  const parts: string[] = []
  let y = 46
  const rows: number[] = []
  for (let i = 0; i < cards.length; i += cols) {
    const h = Math.max(...cards.slice(i, i + cols).map(cardH))
    rows.push(h)
  }
  const gH = rows.reduce((a, b) => a + b + gap, 0)
  const canH = 40 + can.reduce((a, k) => a + 22 + k.lines.length * 14, 0)
  const H = y + gH + 20 + canH + 14
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(txt(14, 28, 'How the VNA tab works', { size: c ? 17 : 19, weight: 800, fill: BRIGHT, font: SANS }))
  cards.forEach((k, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = 14 + col * (cw + gap)
    const cy = y + rows.slice(0, row).reduce((a, b) => a + b + gap, 0)
    const h = rows[row] ?? cardH(k)
    parts.push(`<rect x="${n1(cx)}" y="${n1(cy)}" width="${n1(cw)}" height="${n1(h)}" rx="10" fill="#0f161a" stroke="${k.col}" stroke-opacity="0.45"/>`)
    parts.push(`<rect x="${n1(cx)}" y="${n1(cy + 10)}" width="4" height="${n1(h - 20)}" rx="2" fill="${k.col}"/>`)
    parts.push(`<circle cx="${n1(cx + 24)}" cy="${n1(cy + 20)}" r="11" fill="${k.col}" fill-opacity="0.16" stroke="${k.col}"/>`)
    parts.push(txt(cx + 24, cy + 24.5, String(i + 1), { anchor: 'middle', size: 11, weight: 800, fill: k.col }))
    parts.push(txt(cx + 42, cy + 25, k.t, { size: 13, weight: 700, fill: k.col, font: SANS }))
    k.lines.forEach((l, j) => parts.push(txt(cx + 16, cy + 46 + j * 14, l, { size: 10.5, fill: LABEL, font: SANS })))
  })
  y += gH + 14
  parts.push(`<rect x="14" y="${y}" width="${W - 28}" height="${canH}" rx="10" fill="#0d1c1f" stroke="${LCD}" stroke-opacity="0.35"/>`)
  parts.push(txt(28, y + 24, 'WHAT THIS NANOVNA CAN DO', { size: 10.5, fill: LCD, weight: 700, spacing: 1.5 }))
  let yy = y + 46
  can.forEach((k, i) => {
    const col = i === can.length - 1 ? RED : LCD
    parts.push(`<circle cx="32" cy="${yy - 4}" r="3.5" fill="${col}"/>`)
    parts.push(txt(44, yy, k.t, { size: 12, weight: 700, fill: i === can.length - 1 ? RED : BRIGHT, font: SANS }))
    yy += 16
    k.lines.forEach(l => {
      parts.push(txt(44, yy, l, { size: 10.5, fill: LABEL, font: SANS }))
      yy += 14
    })
    yy += 6
  })
  return svgDoc(W, H, parts.join(''))
}

export function guideText(): string {
  return [
    'How the VNA tab works',
    ...GUIDE.map(([t, s], i) => `${i + 1}. ${t}: ${s}`),
    '',
    'What this NanoVNA can do',
    ...CAN_DO.map(([t, s]) => `• ${t}: ${s}`),
  ].join('\n')
}

// PASS / FAIL in block letters for the terminal, which draws no SVG.
export const GLYPHS: Record<string, string[]> = {
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  F: ['█████', '█    ', '████ ', '█    ', '█    '],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
}

export function blocks(word: string): string[] {
  return [0, 1, 2, 3, 4].map(r => word.split('').map(ch => GLYPHS[ch]?.[r] ?? '').join('  '))
}

// A text meter for the terminal: the SWR on a |Γ| scale to 4, as the hero's needle.
export function meterBar(swr: number, n = 24): string {
  const k = Math.round((Math.min(gam(swr), G_FULL) / G_FULL) * n)
  return `${'█'.repeat(k)}${'░'.repeat(Math.max(0, n - k))}`
}

export function heroLine(mt: Mark): string {
  return `SWR ${fmt(mt.swr)} at 906.875 MHz (Meshtastic) · ${verdict(mt.swr).text}: ${meaning(mt.swr)}, ${fmt(mt.mismatchDb, 2)} dB mismatch loss`
}

export function compareRows(a: Group, b: Group): [string, string, string, number][] {
  // [metric, A, B, winner: -1 A, 1 B, 0 none]
  const ma = a.latest.metrics
  const mb = b.latest.metrics
  const low = (x?: number, y?: number) => (x === undefined || y === undefined || Math.abs(x - y) < 0.005 ? 0 : x < y ? -1 : 1)
  const w = (m: Metrics | null) => (m?.under2 ? m.under2[1] - m.under2[0] : 0)
  const rd = (m: Metrics | null) => (m?.resonance?.mhz ? Math.abs(m.resonance.mhz - 908.7) : undefined)
  const rows: [string, string, string, number][] = [
    ['SWR @906.875', fmt(ma?.meshtastic?.swr), fmt(mb?.meshtastic?.swr), low(ma?.meshtastic?.swr, mb?.meshtastic?.swr)],
    ['SWR @910.525', fmt(ma?.meshcore?.swr), fmt(mb?.meshcore?.swr), low(ma?.meshcore?.swr, mb?.meshcore?.swr)],
    ['SWR @915', fmt(ma?.mid?.swr), fmt(mb?.mid?.swr), low(ma?.mid?.swr, mb?.mid?.swr)],
    ['Best', ma ? `${fmt(ma.best.swr)} @${ma.best.mhz.toFixed(1)}` : '—', mb ? `${fmt(mb.best.swr)} @${mb.best.mhz.toFixed(1)}` : '—', low(ma?.best.swr, mb?.best.swr)],
    [
      'Under SWR 2',
      ma?.under2 ? `${ma.under2[0]}–${ma.under2[1]}` : 'never',
      mb?.under2 ? `${mb.under2[0]}–${mb.under2[1]}` : 'never',
      Math.abs(w(ma) - w(mb)) < 0.5 ? 0 : w(ma) > w(mb) ? -1 : 1,
    ],
    ['Resonance', ma?.resonance?.mhz ? `${ma.resonance.mhz.toFixed(1)} MHz` : 'none', mb?.resonance?.mhz ? `${mb.resonance.mhz.toFixed(1)} MHz` : 'none', low(rd(ma), rd(mb))],
  ]
  return rows
}

export function compareTextOf(a: Group, b: Group): string {
  const rows = compareRows(a, b)
  const out = [`Compare  A: ${a.label} (${day(a.latest.saved)})   B: ${b.label} (${day(b.latest.saved)})`]
  for (const [k, va, vb, win] of rows) out.push(`${k.padEnd(13)} ${va.padEnd(16)} ${vb.padEnd(16)} ${win < 0 ? '← A' : win > 0 ? '← B' : ''}`)
  return out.join('\n')
}

export const SESSION = `s${Math.random().toString(36).slice(2, 10)}`

// A shared reading younger than this answers /vna without touching the device.
export const FRESH_MS = 10_000

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}

export const actionQ: Proc[] = []

export const pollQ: Proc[] = []

export function procId(argv: string[]): string {
  return argv
    .filter(a => a !== 'python3' && !a.startsWith('--') && !/^s[0-9a-z]{4,}$/.test(a) && !a.startsWith('{'))
    .map(a => (a.includes('/') ? a.split('/').pop() ?? a : a))
    .slice(0, 3)
    .join(' ')
}

// How long each kind of press took this session (the "about N s" after the first time).
export const learned = new Map<string, number>()

export function lookProps(l: Look): { label: string; variant?: 'primary'; dimColor?: boolean } {
  return { label: l.label, ...(l.variant ? { variant: l.variant } : {}), ...(l.dimColor ? { dimColor: true } : {}) }
}

export const pollLogged = new Map<string, number>()

export function isRules(v: unknown): v is Rules {
  const r = v as Rules
  return !!r && typeof r === 'object' && [r.lo, r.hi, r.bandMax, r.spotMax].every(n => typeof n === 'number' && n > 0) && Array.isArray(r.spots) && r.hi > r.lo
}

// The SWR a reading's level goes by: ok under 2, warn to 3, alert from 3.
export function swrLevel(swr: number | undefined): Level {
  return swr === undefined || !Number.isFinite(swr) ? 'ok' : swr >= 3 ? 'alert' : swr >= 2 ? 'warn' : 'ok'
}

export function wanted(id: string, now: number): boolean {
  return now - (drawnAt[id] ?? 0) < 15_000
}

// A press's answer from vna.py: a reading to show, or why not.
export function deviceTrouble(r: any): string {
  if (!r) return 'no answer from vna.py'
  if (r.busy) return String(r.say ?? 'NanoVNA busy')
  if (r.connected === false) return 'NanoVNA not connected.'
  if (r.error) return String(r.error)
  return ''
}

export function parseRules(arg: string): Rules | string {
  if (/^default/i.test(arg.trim())) return DEFAULT_RULES
  const r: Rules = { ...qcRules, spots: [...qcRules.spots] }
  for (const tok of arg.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(band|spot|lo|hi|spots|range)=(.+)$/i)
    if (!m) return `Not understood: ${tok}. Use band=2.0 spot=1.5 range=902-928 spots=906.875,910.525, or default.`
    const k = (m[1] ?? '').toLowerCase()
    const v = m[2] ?? ''
    if (k === 'spots') r.spots = v.split(',').map(Number).filter(n => n > 0)
    else if (k === 'range') {
      const [a = 0, b = 0] = v.split(/[-–]/).map(Number)
      if (!(a > 0 && b > a)) return `Bad range ${v}.`
      r.lo = a
      r.hi = b
    } else {
      const n = Number(v)
      if (!(n > 0)) return `Bad number ${v}.`
      if (k === 'band') r.bandMax = n
      if (k === 'spot') r.spotMax = n
      if (k === 'lo') r.lo = n
      if (k === 'hi') r.hi = n
    }
  }
  return isRules(r) ? r : 'Those rules do not add up (the range must run low to high).'
}

export function ruleText(r: Rules): string {
  return `PASS when SWR ≤ ${lim(r.bandMax)} at every point ${r.lo}–${r.hi} MHz${r.spots.length ? ` and SWR ≤ ${lim(r.spotMax)} at ${r.spots.join(' and ')} MHz` : ''}`
}

// The height an SVG takes at the width the pane gives it (its own width, at most maxW). Given as
// the Svg's height, the box keeps its size while a refreshed picture loads, so the pane never
// shrinks for a moment and the scroll position stays where the person put it.
export function svgHeight(source: string, maxW: number): number | undefined {
  const head = source.slice(0, 800)
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head)
  const wa = /<svg[^>]*\swidth="([\d.]+)"/.exec(head)
  const w = vb ? Number(vb[1]) : NaN
  const h = vb ? Number(vb[2]) : NaN
  if (!(w > 0 && h > 0)) return undefined
  const drawn = Math.min(wa ? Number(wa[1]) : w, maxW)
  return Math.round((drawn * h) / w)
}

export const EXPORT_W = 540

export const EXPORT_PIECE = 500

// One picture placed inside the card, its ids renamed so no two pictures share a gradient or a filter.
export function nestSvg(src: string, x: number, y: number, w: number, prefix: string): { svg: string; h: number } {
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(src.slice(0, 800))
  const W = Number(vb?.[1] ?? 360)
  const H = Number(vb?.[2] ?? 200)
  const h = Math.round((w * H) / W)
  const body = src
    .replace(/^<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/\sid="([^"]+)"/g, ` id="${prefix}$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
    .replace(/href="#([^"]+)"/g, `href="#${prefix}$1"`)
  return { svg: `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${W} ${H}" overflow="hidden">${body}</svg>`, h }
}

export function stamp(t: number): string {
  const d = new Date(t)
  const h = d.getHours()
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

// A picture with its height from its markup (svgHeight), so a refreshed picture never drops to no
// height while it loads. hover: drawn interactive on the desktop, where its <title> tooltips work.
export function Pic(ctx: Ctx, source: string, alt: string, hover = false): unknown {
  const S = ctx.Svg
  if (!S) return null
  return <S source={source} alt={alt} height={svgHeight(source, ctx.geo.W)} {...(hover && ctx.surface === 'desktop' ? { isInteractive: true } : {})} />
}

export function Btn(ctx: Ctx, key: string, l: Look | string, press: () => void, primary = false, plain = false): unknown {
  const { Box, Button } = ctx.els
  const lk = typeof l === 'string' ? { label: l } : l
  return (
    <Box key={`bx:${key}`} paddingRight={1}>
      <Button key={key} label={lk.label} {...(primary || lk.variant ? { variant: 'primary' } : {})} {...(lk.dimColor ? { dimColor: true } : {})} {...(plain ? { plain: true } : {})} onPress={press} />
    </Box>
  )
}

export function Row(ctx: Ctx, p: { name: string; mark?: Mark; k?: string }): unknown {
  const { Box, Text } = ctx.els
  const v = verdict(p.mark?.swr)
  return (
    <Box key={p.k ?? p.name} flexWrap="wrap">
      <Box width={ctx.narrow ? 11 : 14}>
        <Text bold>{p.name}</Text>
      </Box>
      <Box width={13}>
        <Text dimColor>{p.mark ? `${p.mark.mhz.toFixed(3)} MHz` : 'off sweep'}</Text>
      </Box>
      <Box width={10}>
        <Text bold color={v.color}>{p.mark ? `SWR ${fmt(p.mark.swr)}` : ''}</Text>
      </Box>
      <Box width={11}>
        <Text color={v.color}>{v.text}</Text>
      </Box>
      <Text dimColor>{p.mark?.z ? zText(p.mark.z) : ''}</Text>
    </Box>
  )
}

// A command waits for its press at most this long: past it the press goes on and the reply says so.
export const CMD_WAIT_MS = 7000

// A tool's press waits this long for the queue; past it the press goes on and the answer says so.
export const TOOL_WAIT_MS = 30_000

export const COLOR_NAMES = ['cyan', 'magenta', 'sky blue', 'violet', 'ice', 'pink', 'teal', 'lilac']
