import type { Register } from 'claude-code'
import { KEEP_FRESH_MS, keepModStatusFresh, postModStatus, startModStatus, type Level } from './mod-status'
import { parseAction, registerTools } from './tools'

// The VNA tab: a NanoVNA on the Mac's USB (or the Wi-Fi bridge), driven
// through scripts/vna.py, built to teach antenna reading and to test units.
// Five places, one row of buttons at the top (0.5.0), each one also openable in
// its own tab (⤢, /vna tab <view>):
//   Measure    the hero (SWR at Meshtastic 906.875 and MeshCore 910.525 on
//              7-segment LCD digits, an SWR meter, a letter grade, a verdict),
//              the readings, the trimming drawing, and the chart: SWR (zones,
//              the 902–928 band, the dip, the stretch under 2:1), return loss,
//              R & X (resonance marked) or the Smith chart.
//   Trim       the live trim assistant: where the antenna resonates now (X = 0,
//              else the SWR dip) against a target, an arrow and a plain verdict,
//              a timeline of every change (seen when the curve moves, or Snip),
//              and "you passed it" with an undo hint.
//   Library    saved sweeps grouped by name, one card each in the antenna's own
//              colour (the same colour on every chart): overlay, compare two
//              (A/B, the better one shaded), or overlay a history.
//   QC         PASS/FAIL against a stored rule set as a stamp with a meter per
//              check; recording writes a CSV row, the sweep and a certificate.
//   Bands      band presets (2 m, 70 cm, 1090, 433, FM and Seth's own in
//              presets.json), each with its calibration in its own spare save
//              slot; Back to Meshtastic recalls slot 0, the power-on state, which
//              presets never write. The V4 dipole helper. The optional 4th trace
//              (X) and the guarded "Make this my power-on layout".
// Presses (0.5.0, the Radio tab's 0.3.4 pattern): every button's press is an
// intent, shown on the button at once and at the top ("Doing now", "Next"),
// queued behind one that runs (never dropped), the newest waiting one winning
// and the same one again joining it; presses run ahead of the polls; each one
// is timed into ~/Library/Application Support/vna/actions.jsonl.
// Every picture is an SVG in the Radio tab's instrument palette, drawn at 660 px
// on the desktop and 360 px on the phone, and handed to the surface with its
// height (svgHeight), so a refreshed picture never collapses the pane.
const PANE = 'vna'
// The home folder comes from the environment at session.start (setHome), never from the code.
let HOME = ''
const PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
const LIVE_MS = 3000
const IDLE_MS = 15_000
const MONO = 'Menlo,monospace'
const SANS = 'Helvetica,Arial,sans-serif'
const W_DESK = 660
const W_PHONE = 360
let ACTIONS_LOG = '' // set by setHome
const LOG_MAX = 1000
const POLL_LOG_MS = 300

// ---------------------------------------------------------------- palette
// The Radio tab's: dark glass, a teal LCD, amber peaks, turbo-like accents. Green,
// amber and red only ever mean the SWR zones (≤ 1.5, ≤ 2, above).
const BG = '#10161a'
const PLOT = '#0c1215'
const GRID = '#243238'
const GRID2 = '#1a252a'
const AXIS = '#7f9199'
const LABEL = '#c9d4da'
const BRIGHT = '#e6edf0'
const CYAN = '#4fd1e0'
const AMBER = '#f0c050'
const YELLOW = '#ffd84a'
const GREEN = '#7ad67a'
const MAGENTA = '#e07be0'
const ORANGE = '#f0a050'
const RED = '#ff6b6b'
const SKY = '#7fb8ff'
const VIOLET = '#a98bff'
const PINK = '#ff7eb6'
const TEAL = '#3fd0b0'
const LILAC = '#d0a8ff'
const ICE = '#d8f6ff'
const LCD = '#62f0dc'
// Each saved antenna's own colour, kept for good (cards, overlays, A/B, history): no green, amber
// or red, which mean the SWR zones, and no yellow, the live trace.
const ANT = [CYAN, MAGENTA, SKY, VIOLET, ICE, PINK, TEAL, LILAC]
const LIVE_COLOR = YELLOW
const MESH: [number, string][] = [
  [906.875, 'Meshtastic'],
  [910.525, 'MeshCore'],
]

type View = 'swr' | 'rl' | 'rx' | 'smith'
const VIEWS: [View, string][] = [
  ['swr', 'SWR'],
  ['rl', 'Return loss'],
  ['rx', 'R & X'],
  ['smith', 'Smith'],
]
const EXPLAIN: Record<View, string> = {
  swr: 'SWR (standing wave ratio) compares the wave sent out with the wave bouncing back. 1.0 is a perfect match; under 1.5 is excellent (4% or less comes back, green), under 2 good (11%, amber), over 3 poor (25% or more, red). The teal stripe is the US 902–928 MHz band, the bracket the stretch under 2:1, the ringed dot the lowest point. The scale is stretched toward 1, where the detail is.',
  rl: 'Return loss is how far below the outgoing wave the reflection is, in dB: the deeper the dip, the better. 10 dB means 10% of the power comes back (SWR 1.9), 14 dB is SWR 1.5, 20 dB is 1% (SWR 1.22). The NanoVNA’s LOGMAG trace is this same curve.',
  rx: 'An antenna looks like a resistance R (teal) in series with a reactance X (magenta). The goal is R = 50 Ω and X = 0. Where X crosses 0 the antenna resonates. X below 0 (blue) is capacitive: for a whip, electrically short. X above 0 (orange) is inductive: electrically long.',
  smith: 'The Smith chart folds R and X into one picture. The centre target is 50 Ω, a perfect match; the right edge is an open circuit, the left a short. The top half is inductive, the bottom capacitive. Inside the amber circle the SWR is under 2, inside the green one under 1.5. The trace runs blue at the low end of the sweep to red at the top; the bright stretch is 902–928 MHz.',
}

// The five places at the top of the tab, each with its colour.
type Section = 'measure' | 'trim' | 'library' | 'qc' | 'bands'
const SECTIONS: [Section, string, string, string][] = [
  ['measure', 'Measure', LCD, 'the live reading and the chart'],
  ['trim', 'Trim', YELLOW, 'cutting or bending an antenna: where it resonates now'],
  ['library', 'Library', MAGENTA, 'saved antennas, each in its own colour'],
  ['qc', 'QC', AMBER, 'PASS / FAIL for units you sell'],
  ['bands', 'Bands', SKY, 'other radios: each band its own calibration slot'],
]

// Views that open in their own tab (⤢, /vna tab <view>).
type TabView = 'reading' | 'chart' | 'smith' | 'trim' | 'library' | 'qc' | 'bands' | 'guide'
const TABS: Record<TabView, { id: string; title: string; about: string }> = {
  reading: { id: 'vna-reading', title: 'VNA reading', about: 'the hero readout and the readings' },
  chart: { id: 'vna-chart', title: 'VNA chart', about: 'the chart with its four views' },
  smith: { id: 'vna-smith', title: 'VNA Smith', about: 'the Smith chart alone' },
  trim: { id: 'vna-trim', title: 'VNA trim', about: 'the trim assistant' },
  library: { id: 'vna-library', title: 'VNA antennas', about: 'the antenna library' },
  qc: { id: 'vna-qc', title: 'VNA QC', about: 'QC mode' },
  bands: { id: 'vna-bands', title: 'VNA bands', about: 'band presets and the power-on layout' },
  guide: { id: 'vna-guide', title: 'VNA guide', about: 'how the VNA tab works' },
}

type Rules = { lo: number; hi: number; bandMax: number; spots: number[]; spotMax: number }
const DEFAULT_RULES: Rules = { lo: 902, hi: 928, bandMax: 2, spots: [906.875, 910.525], spotMax: 1.5 }

type Mark = {
  name?: string
  mhz: number
  swr: number
  rl?: number
  z?: [number, number]
  reflectedPct?: number
  mismatchDb?: number
  verdict?: string
  index?: number
}
type Resonance = {
  mhz: number | null
  r?: number
  swr?: number
  kind?: string
  trim?: 'long' | 'short' | 'on' | null
  offsetMhz?: number
  pct?: number
  hint: string
  caveat?: string
  xSign?: string
  closest?: { mhz: number; x: number }
}
type Metrics = { meshtastic?: Mark; meshcore?: Mark; mid?: Mark; best: Mark; under2: [number, number] | null; resonance?: Resonance | null }
type QcCheck = { id: string; label: string; pass: boolean; value?: number; mhz?: number; detail: string }
type Qc = { pass: boolean; rule: string; rules: Rules; checks: QcCheck[]; worst: { mhz: number; swr: number } | null; covered: boolean; failed: string[] }
type Sweep = { start: number; stop: number; points: number }
type Trace = { n: number; type: string; ch: string; scale?: number; refpos?: number }
type Live = {
  connected: boolean
  port?: string
  version?: string
  board?: string
  vbatMv?: number | null
  cal?: string
  calibrated?: boolean
  sweep?: Sweep | null
  metrics?: Metrics | null
  curve?: [number, number][]
  s11?: [number, number][]
  markers?: (Mark & { id: number })[]
  qc?: Qc
  via?: 'usb' | 'wifi'
  bridge?: { host?: string; ip?: string; state: string }
  error?: string
  // 0.5.0: which save slot's calibration is in use (null: unknown), how many slots, the traces, a calibration under way.
  slot?: number | null
  slots?: number
  traces?: Trace[]
  calStep?: string | null
  calBand?: string | null
}
// A band preset as vna.py presets describes it (built in, or Seth's own in presets.json).
type BandDef = {
  id: string
  name: string
  short: string
  start: number
  stop: number
  points: number
  band: [number, number]
  targets: [number, string][]
  for?: string
  slot: number | null
  slotWhy?: string | null
  cal?: { at?: string; loadRl?: number } | null
  calOk: boolean | null
  calOther?: string | null
  shares?: string[]
  powerOn?: boolean
  custom?: boolean
}
type Presets = { ok: boolean; file: string; slots: number; spare: number[]; bands: BandDef[]; powerOn?: { at: string; trace3: string } | null; warning?: string | null }
// The mesh band before vna.py presets has answered (and when it cannot).
const MESH_BAND: BandDef = {
  id: 'mesh',
  name: 'Meshtastic / MeshCore',
  short: 'Mesh',
  start: 850e6,
  stop: 980e6,
  points: 201,
  band: [902, 928],
  targets: MESH,
  for: 'LoRa node antennas: the power-on layout',
  slot: 0,
  calOk: null,
  powerOn: true,
}
type Item = { file: string; label: string; saved: string; metrics: Metrics | null; curve: [number, number][]; s11?: [number, number][] }
type Group = { label: string; items: Item[]; latest: Item }
type CalView = { step: string | null; say: string; ok: boolean; band: string }
type QcRecord = Record<string, string>
type QcLog = { log: string; dir: string; total: number; passed: number; failed: number; next: string; records: QcRecord[] }
type Series = {
  label: string
  color: string
  curve: [number, number][]
  s11?: [number, number][]
  width: number
  opacity: number
  metrics?: Metrics | null
  isLive?: boolean
}
// The drawing's width and whether it is the phone's stacked layout.
type Geo = { W: number; c: boolean }
type Grade = 'A' | 'B' | 'C' | 'F'
// The trim assistant: one reading of where the antenna resonates, and the changes logged.
type TrimRead = { f: number; method: 'X = 0' | 'SWR dip'; swrT?: number; swrMin: number; edge?: 'below' | 'above'; r?: number }
type TrimPoint = TrimRead & { n: number; at: number; how: 'start' | 'auto' | 'snip'; delta: number; target: number; passed?: boolean }

let live: Live | null = null
let wasConnected = false
let liveOn = true
// The status line (/vna hide|show, remembered), and its copy for the Herdr strip.
let statusOn = true
let lastCheck = 0
let polling = false
let lib: Item[] = []
let libDir = '' // set by setHome, then by the library's own answer
let overlays: string[] = []
let view: View = 'swr'
let section: Section = 'measure'
let guideOpen = false
let cmpA: string | null = null
let cmpB: string | null = null
let histLabel: string | null = null
let qcOn = false
let qcRules: Rules = DEFAULT_RULES
let qcLog: QcLog | null = null
let lastQc: { say: string; ok: boolean; cert?: string } | null = null
let cal: CalView | null = null
let shot: { path: string; b64: string } | null = null
let note = ''
let loaded = false
let presets: Presets | null = null
let antColors: Record<string, number> = {}
// The colours of the two antennas being compared (cmpSeries sets them).
let colA = CYAN
let colB = MAGENTA
let confirmPowerOn = false
let dipoleF = 1090
// The trim assistant's target per band, its timeline and its last readings.
let trimTargets: Record<string, number> = {}
let trimBand = 'mesh'
let trimPts: TrimPoint[] = []
let trimRecent: TrimRead[] = []
let trimLast: TrimRead | null = null
let trimLastAt = -1
// When each own tab was last drawn: QC and Trim do their work while someone is looking.
const drawnAt: Record<string, number> = {}
// ---------------------------------------------------------------- helpers

function verdict(swr: number | undefined): { text: string; color: string } {
  if (swr === undefined || swr === null) return { text: '', color: AXIS }
  if (swr < 1.5) return { text: 'excellent', color: GREEN }
  if (swr < 2) return { text: 'good', color: AMBER }
  if (swr < 3) return { text: 'so-so', color: ORANGE }
  return { text: 'poor', color: RED }
}

// The zone an SWR falls in: green to 1.5, amber to 2, red above.
function zone(swr: number): string {
  return swr <= 1.5 ? GREEN : swr <= 2 ? AMBER : RED
}

function grade(swr: number): Grade {
  return swr <= 1.5 ? 'A' : swr <= 2 ? 'B' : swr <= 3 ? 'C' : 'F'
}

const GRADE_COLOR: Record<Grade, string> = { A: GREEN, B: AMBER, C: ORANGE, F: RED }

// The grade of an antenna: the worse of its two mesh frequencies (the best point when neither is on the sweep).
function gradeOf(m: Metrics | null | undefined): Grade | null {
  if (!m) return null
  const v = [m.meshtastic?.swr, m.meshcore?.swr].filter((x): x is number => typeof x === 'number')
  return grade(v.length ? Math.max(...v) : m.best.swr)
}

function verdictLine(m: Metrics): string {
  const word: Record<Grade, string> = { A: 'Great', B: 'Good', C: 'So-so', F: 'Poor' }
  const g1 = m.meshtastic ? grade(m.meshtastic.swr) : null
  const g2 = m.meshcore ? grade(m.meshcore.swr) : null
  if (g1 && g2 && g1 !== g2) return `${word[g1]} for Meshtastic, ${word[g2].toLowerCase()} for MeshCore`
  const g = g1 ?? g2 ?? grade(m.best.swr)
  const who = g1 && g2 ? 'Meshtastic and MeshCore' : g1 ? 'Meshtastic' : g2 ? 'MeshCore' : 'the mesh band'
  if (g === 'A') return `Great match for ${who}`
  if (g === 'B') return `Good match for ${who}`
  if (g === 'C') return `So-so match for ${who}: worth a trim or a better antenna`
  return `Poor match for ${who}: check the plug, then the antenna`
}

function fmt(n: number | undefined | null, d = 2): string {
  return n === undefined || n === null ? '—' : n >= 9.9 ? '>9.9' : n.toFixed(d)
}

function meaning(swr: number): string {
  const g = (swr - 1) / (swr + 1)
  const pct = 100 * g * g
  return `${pct < 1 ? 'under 1%' : `about ${pct.toFixed(0)}%`} of the power bounces back`
}

function zText(z?: [number, number]): string {
  if (!z) return ''
  return `${z[0].toFixed(1)} ${z[1] >= 0 ? '+' : '−'} j${Math.abs(z[1]).toFixed(1)} Ω`
}

// "1.258" from the QC log as 1.26.
function n2(s: string | undefined): string {
  const n = Number(s)
  return s && Number.isFinite(n) ? n.toFixed(2) : '—'
}

function lim(v: number): string {
  return Number.isInteger(v * 10) ? v.toFixed(1) : String(v)
}

function day(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours()
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function clamp(v: number, a = 0, b = 1): number {
  return v < a ? a : v > b ? b : v
}

function rlOf(g: [number, number]): number {
  return -20 * Math.log10(Math.max(Math.hypot(g[0], g[1]), 1e-9))
}

// |Γ| of an SWR: 0 for a perfect match, 1 for none.
function gam(swr: number): number {
  return swr <= 1 ? 0 : (swr - 1) / (swr + 1)
}

// Z = 50 (1 + Γ) / (1 − Γ)
function zOfGamma(g: [number, number]): [number, number] {
  const [a, b] = g
  const d = (1 - a) ** 2 + b * b
  return d < 1e-12 ? [1e6, 0] : [(50 * (1 - a * a - b * b)) / d, (100 * b) / d]
}

// Γ = (Z − 50) / (Z + 50)
function gammaOfZ(z: [number, number]): [number, number] {
  const [r, x] = z
  const d = (r + 50) ** 2 + x * x
  return d < 1e-9 ? [1, 0] : [((r - 50) * (r + 50) + x * x) / d, (x * (r + 50) - (r - 50) * x) / d]
}

// A quarter-wave whip's length in mm at f MHz, with the usual end effect (as vna.py's hint).
function quarterWave(f: number): number {
  return (0.95 * 299792.458) / (4 * f)
}

// Saved sweeps grouped by name, oldest version first; best antenna first by SWR at 907.
function groups(): Group[] {
  const by = new Map<string, Item[]>()
  for (const i of lib) by.set(i.label, [...(by.get(i.label) ?? []), i])
  const out: Group[] = []
  for (const [label, items] of by) {
    const sorted = [...items].sort((a, b) => (a.saved < b.saved ? -1 : a.saved > b.saved ? 1 : a.file < b.file ? -1 : 1))
    out.push({ label, items: sorted, latest: sorted[sorted.length - 1] as Item })
  }
  const key = (g: Group) => g.latest.metrics?.meshtastic?.swr ?? g.latest.metrics?.best?.swr ?? 99
  return out.sort((a, b) => key(a) - key(b))
}

function findGroup(q: string): Group | undefined {
  const s = q.trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (!s) return undefined
  const gs = groups()
  return (
    gs.find(g => g.label.toLowerCase() === s) ??
    gs.find(g => g.items.some(i => i.file.toLowerCase() === s)) ??
    gs.find(g => g.label.toLowerCase().startsWith(s)) ??
    gs.find(g => g.label.toLowerCase().includes(s))
  )
}

// "Muzi Works #1 Muzi Works #2", "a vs b", "a | b", "a, b" or two quoted names.
function splitPair(arg: string): [string, string] | null {
  const q = arg.match(/^\s*"([^"]+)"\s+"([^"]+)"\s*$/)
  if (q) return [q[1] ?? '', q[2] ?? '']
  for (const sep of [' vs ', ' | ', '|', ', ', ',']) {
    const k = arg.indexOf(sep)
    if (k > 0) return [arg.slice(0, k), arg.slice(k + sep.length)]
  }
  const t = arg.trim().split(/\s+/)
  const exact = (s: string) => groups().find(g => g.label.toLowerCase() === s.toLowerCase())
  for (let i = 1; i < t.length; i++) {
    const a = t.slice(0, i).join(' ')
    const b = t.slice(i).join(' ')
    if (exact(a) && exact(b)) return [a, b]
  }
  for (let i = 1; i < t.length; i++) {
    const a = findGroup(t.slice(0, i).join(' '))
    const b = findGroup(t.slice(i).join(' '))
    if (a && b && a.label !== b.label) return [a.label, b.label]
  }
  return null
}

function trend(g: Group): string {
  const v = g.items.map(i => i.metrics?.meshtastic?.swr).filter((x): x is number => typeof x === 'number')
  if (v.length < 2) return ''
  return v.length > 3 ? `${fmt(v[0])} → … → ${fmt(v[v.length - 1])}` : v.map(x => fmt(x)).join(' → ')
}

// ---------------------------------------------------------------- antenna colours and bands

const HIST_MAX = 8
const MAX_OVERLAYS = 6

// Each antenna's colour index, kept in the store: a new antenna gets the colour fewest others
// have (oldest antennas first), so the library reads as a palette and a colour never moves.
function assignColors(): boolean {
  const firsts = groups()
    .map(g => ({ label: g.label, first: g.items[0]?.saved ?? '' }))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : a.label < b.label ? -1 : 1))
  const present = new Set(firsts.map(f => f.label))
  let changed = false
  for (const { label } of firsts) {
    if (typeof antColors[label] === 'number') continue
    const used = ANT.map((_, k) => Object.entries(antColors).filter(([l, v]) => v === k && present.has(l)).length)
    const least = Math.min(...used)
    antColors[label] = used.indexOf(least)
    changed = true
  }
  return changed
}

function hashLabel(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h
}

function antColor(label: string): string {
  const k = antColors[label]
  return ANT[(typeof k === 'number' ? k : hashLabel(label)) % ANT.length] as string
}

// A colour mixed toward the panel: t = 1 is the colour itself, 0 the background.
function shade(hex: string, t: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2].map(i => Math.round(c(BG, i) + (c(hex, i) - c(BG, i)) * clamp(t)).toString(16).padStart(2, '0')).join('')}`
}

function sameSweep(a: { start: number; stop: number; points: number } | null | undefined, b: { start: number; stop: number; points: number } | null | undefined): boolean {
  return !!a && !!b && Math.abs(a.start - b.start) < 1 && Math.abs(a.stop - b.stop) < 1 && a.points === b.points
}

function bandsAll(): BandDef[] {
  return presets?.bands?.length ? presets.bands : [MESH_BAND]
}

function bandById(id: string): BandDef | undefined {
  return bandsAll().find(b => b.id === id)
}

// The band the NanoVNA is sweeping now (by its exact range), or null for any other sweep.
function activeBand(): BandDef | null {
  const sw = live?.sweep
  if (!sw) return null
  return bandsAll().find(b => sameSweep(sw, b)) ?? null
}

function onMesh(): boolean {
  return !!live?.sweep && sameSweep(live.sweep, MESH_BAND)
}

// The band a chart of lo..hi MHz marks: the one being swept, else whichever band it covers.
function chartBand(lo: number, hi: number): BandDef | null {
  const a = activeBand()
  const fits = (b: BandDef) => b.band[1] > lo && b.band[0] < hi
  if (a && fits(a)) return a
  return [MESH_BAND, ...bandsAll()].find(fits) ?? null
}

function bandLabel(b: BandDef): string {
  return b.id === 'mesh' ? 'US 902–928' : `${b.short} ${Number(b.band[0].toFixed(2))}–${Number(b.band[1].toFixed(2))}`
}

// Whether the calibration in use is good for what is being swept, in plain words.
function calStatus(): { ok: boolean; tag: string; text: string; color: string } {
  if (!live?.connected) return { ok: false, tag: 'UNCAL', text: 'not connected', color: AXIS }
  const sw = live.sweep
  const b = activeBand()
  const range = sw ? `${sw.start / 1e6}–${sw.stop / 1e6} MHz, ${sw.points} points` : ''
  if (cal?.step || live.calStep) return { ok: false, tag: 'CAL…', text: 'a calibration is under way', color: AMBER }
  if (!b || b.id === 'mesh') {
    if (!live.calibrated) return { ok: false, tag: 'UNCAL', text: `Not calibrated for this sweep (${range}): press Calibrate before trusting the numbers.`, color: AMBER }
    if (b && typeof live.slot === 'number' && live.slot !== 0)
      return { ok: false, tag: 'UNCAL', text: `The mesh range with slot ${live.slot}'s calibration (another band's): press Back to Meshtastic in Bands.`, color: AMBER }
    return { ok: true, tag: 'CAL', text: `Calibrated · ${range}${b ? (live.slot === 0 ? ' · slot 0, the power-on state' : '') : ''}`, color: GREEN }
  }
  if (b.calOk && live.slot === b.slot && live.calibrated) return { ok: true, tag: 'CAL', text: `Calibrated for ${b.name} · slot ${b.slot} · ${range}`, color: GREEN }
  if (b.calOk) return { ok: false, tag: 'UNCAL', text: `${b.name}'s calibration is in slot ${b.slot} but not in use: press ${b.short} in Bands to recall it.`, color: AMBER }
  return { ok: false, tag: 'UNCAL', text: `UNCAL: ${b.name} has no calibration yet${b.slot ? `: Calibrate saves it to slot ${b.slot}` : ` (${b.slotWhy ?? 'no slot'})`}. The numbers are rough.`, color: AMBER }
}

// Readings at a band's targets, from the live curve and S11 (vna.py's own are for the mesh frequencies).
function markAt(f: number, name: string): Mark | undefined {
  const c = live?.curve ?? []
  const swr = at(c, f)
  if (swr === undefined) return undefined
  const s = live?.s11
  let z: [number, number] | undefined
  if (s && s.length === c.length) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1] as [number, number]
      const b = c[i] as [number, number]
      if (b[0] >= f) {
        const t = b[0] === a[0] ? 0 : (f - a[0]) / (b[0] - a[0])
        const ga = s[i - 1] as [number, number]
        const gb = s[i] as [number, number]
        z = zOfGamma([ga[0] + t * (gb[0] - ga[0]), ga[1] + t * (gb[1] - ga[1])])
        break
      }
    }
  }
  const g = gam(swr)
  return { name, mhz: f, swr, rl: -20 * Math.log10(Math.max(g, 1e-9)), z, reflectedPct: 100 * g * g, mismatchDb: Math.max(0, -10 * Math.log10(Math.max(1 - g * g, 1e-9))) }
}

// The hero's two readings: Meshtastic and MeshCore on the mesh band (vna.py's), else the band's targets.
function heroMarks(m: Metrics): { mt: Mark; mc?: Mark; names: [string, string]; who: string } | null {
  const b = activeBand()
  if (!b || b.id === 'mesh') return m.meshtastic ? { mt: m.meshtastic, mc: m.meshcore, names: ['MESHTASTIC', 'MESHCORE'], who: '' } : null
  const [t1, t2] = b.targets
  const mt = t1 ? markAt(t1[0], t1[1]) : undefined
  if (!mt || !t1) return null
  const mc = t2 ? markAt(t2[0], t2[1]) : undefined
  return { mt, mc, names: [t1[1].toUpperCase(), (t2?.[1] ?? '').toUpperCase()], who: b.name }
}

// ---------------------------------------------------------------- series

function liveSeries(): Series | null {
  if (!live?.connected || !live.curve?.length) return null
  return { label: 'Live', color: LIVE_COLOR, curve: live.curve, s11: live.s11, width: 2.4, opacity: 1, metrics: live.metrics, isLive: true }
}

function itemSeries(i: Item, color: string, label: string, opacity = 0.85): Series {
  return { label, color, curve: i.curve, s11: i.s11, width: 1.6, opacity, metrics: i.metrics }
}

function mainSeries(): Series[] {
  const out: Series[] = []
  if (histLabel) {
    const g = groups().find(x => x.label === histLabel)
    const vs = (g?.items ?? []).slice(-HIST_MAX)
    const n = g?.items.length ?? 0
    vs.forEach((i, k) => {
      out.push(itemSeries(i, histColor(histLabel ?? '', n - vs.length + k, n), `${day(i.saved)} · ${fmt(i.metrics?.meshtastic?.swr)}`, 0.55 + (0.45 * (k + 1)) / vs.length))
    })
  } else {
    lib
      .filter(i => overlays.includes(i.file))
      .slice(0, MAX_OVERLAYS)
      .forEach(i => out.push(itemSeries(i, antColor(i.label), i.label)))
  }
  const l = liveSeries()
  if (l) out.push(l)
  return out
}

// A history in the antenna's own colour: the oldest of the newest HIST_MAX versions dim, the newest bright.
function histColor(label: string, k: number, n: number): string {
  const shown = Math.min(n, HIST_MAX)
  const j = k - (n - shown)
  return shade(antColor(label), shown < 2 ? 1 : 0.35 + (0.65 * Math.max(0, j)) / (shown - 1))
}

function overlayColor(file: string): string | undefined {
  const i = lib.find(x => x.file === file)
  return i && overlays.includes(file) ? antColor(i.label) : undefined
}

// A and B in their own colours (B takes another when the two share one).
function cmpColors(): void {
  colA = cmpA ? antColor(cmpA) : CYAN
  colB = cmpB ? antColor(cmpB) : MAGENTA
  if (colA === colB) colB = ANT[(ANT.indexOf(colA) + 4) % ANT.length] as string
}

function cmpSeries(): Series[] {
  cmpColors()
  const a = cmpA ? groups().find(g => g.label === cmpA) : undefined
  const b = cmpB ? groups().find(g => g.label === cmpB) : undefined
  const out: Series[] = []
  if (a) out.push({ ...itemSeries(a.latest, colA, `A · ${a.label}`, 1), width: 2.2 })
  if (b) out.push({ ...itemSeries(b.latest, colB, `B · ${b.label}`, 1), width: 2.2 })
  return out
}

// ---------------------------------------------------------------- drawing basics
// Every picture is a dark instrument panel, so it reads the same on light and dark themes.

function n1(v: number): string {
  return v.toFixed(1)
}

type TxtOpts = { fill?: string; size?: number; anchor?: string; weight?: number; font?: string; opacity?: number; spacing?: number }
function txt(x: number, y: number, s: string, o: TxtOpts = {}): string {
  return `<text x="${n1(x)}" y="${n1(y)}" fill="${o.fill ?? AXIS}" font-size="${o.size ?? 10.5}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''} font-family="${o.font ?? MONO}">${esc(s)}</text>`
}

// How wide a string draws: Menlo is 0.6 em a character, Helvetica about 0.56 on average.
function tw(s: string, size: number, font = MONO): number {
  return [...s].length * size * (font === MONO ? 0.602 : 0.56)
}

function cut(s: string, n: number): string {
  return [...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s
}

// Splits a sentence into lines of at most n characters.
function wrapText(s: string, n: number): string[] {
  const out: string[] = []
  let line = ''
  for (const w of s.split(' ')) {
    if (line && (line + ' ' + w).length > n) {
      out.push(line)
      line = w
    } else line = line ? `${line} ${w}` : w
  }
  if (line) out.push(line)
  return out
}

// A label on a dark pill, so it reads over a trace. (x, y) is the text's baseline.
function pill(x: number, y: number, s: string, o: { fill: string; size?: number; anchor?: 'start' | 'middle' | 'end'; bg?: string }): string {
  const size = o.size ?? 10
  const w = tw(s, size) + 10
  const x0 = o.anchor === 'end' ? x - w : o.anchor === 'middle' ? x - w / 2 : x
  return (
    `<rect x="${n1(x0)}" y="${n1(y - size - 1.5)}" width="${n1(w)}" height="${n1(size + 6)}" rx="${n1((size + 6) / 2)}" fill="${o.bg ?? PLOT}" fill-opacity="0.92" stroke="${o.fill}" stroke-opacity="0.55"/>` +
    txt(x0 + w / 2, y, s, { fill: o.fill, size, anchor: 'middle', weight: 700 })
  )
}

// Labels that must not land on one another: each placed label's box, and the first free spot of several.
type Rect = [number, number, number, number]
function hits(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

function pillRect(x: number, y: number, s: string, size: number, anchor: 'start' | 'middle' | 'end'): Rect {
  const w = tw(s, size) + 10
  const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
  return [x0 - 2, y - size - 3.5, x0 + w + 2, y + 6.5]
}

type Spot = [number, number, 'start' | 'middle' | 'end']
// Draws a pill at the first spot that stays inside `bounds` and clear of `placed` (else the first
// spot), and records it.
function placePill(parts: string[], placed: Rect[], spots: Spot[], s: string, fill: string, bounds: Rect, size = 10): void {
  const fits = (r: Rect) => r[0] >= bounds[0] && r[2] <= bounds[2] && r[1] >= bounds[1] && r[3] <= bounds[3]
  const rects = spots.map(([x, y, a]) => pillRect(x, y, s, size, a))
  let k = rects.findIndex(r => fits(r) && !placed.some(p => hits(p, r)))
  if (k < 0) k = rects.findIndex(r => !placed.some(p => hits(p, r)))
  if (k < 0) k = 0
  const [x, y, a] = spots[k] as Spot
  placed.push(rects[k] as Rect)
  parts.push(pill(x, y, s, { fill, anchor: a, size }))
}

function svgDoc(W: number, H: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`
}

// Filters in user space: an object-box filter on a flat line has no height and draws nothing.
function glowDef(id: string, W: number, H: number, sd = 2.2): string {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${sd}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
}

function blurDef(id: string, W: number, H: number, sd = 4): string {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${sd}"/></filter>`
}

// A vertical gradient that colours by SWR zone: red above yRA, amber down to yAG, green below.
// ops are the stop opacities: red top and bottom, amber top and bottom, green top and bottom.
function zoneGrad(id: string, yTop: number, yBot: number, yRA: number, yAG: number, ops: number[] = [1, 1, 1, 1, 1, 1]): string {
  const span = yBot - yTop || 1
  const a = clamp((yRA - yTop) / span)
  const b = clamp((yAG - yTop) / span)
  const st = (o: number, c: string, op: number | undefined) => `<stop offset="${o.toFixed(4)}" stop-color="${c}" stop-opacity="${op ?? 1}"/>`
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${n1(yTop)}" y2="${n1(yBot)}">${st(0, RED, ops[0])}${st(a, RED, ops[1])}${st(a, AMBER, ops[2])}${st(b, AMBER, ops[3])}${st(b, GREEN, ops[4])}${st(1, GREEN, ops[5])}</linearGradient>`
}

// A horizontal gradient that colours each column by the zone of the trace above it, switching
// sharply where the trace crosses 1.5 or 2. pts are [MHz, SWR], low to high.
function zoneCols(id: string, x0: number, x1: number, pts: [number, number][], xOf: (f: number) => number): string {
  const cols = [GREEN, AMBER, RED]
  const th = [1.5, 2]
  const zi = (s: number) => (s <= 1.5 ? 0 : s <= 2 ? 1 : 2)
  const span = x1 - x0 || 1
  const st = (px: number, c: string) => `<stop offset="${clamp((px - x0) / span).toFixed(4)}" stop-color="${c}"/>`
  const stops: string[] = []
  let prev: [number, number] | undefined
  for (const p of pts) {
    if (!prev) {
      stops.push(st(x0, cols[zi(p[1])] as string))
      prev = p
      continue
    }
    const z0 = zi(prev[1])
    const z1 = zi(p[1])
    const ks = z1 > z0 ? [z0, z0 + 1].slice(0, z1 - z0) : [z0 - 1, z0 - 2].slice(0, z0 - z1)
    for (const k of ks) {
      const b = th[k] as number
      const t = (b - prev[1]) / (p[1] - prev[1] || 1)
      const fx = xOf(prev[0] + t * (p[0] - prev[0]))
      stops.push(st(fx, cols[z1 > z0 ? k : k + 1] as string), st(fx, cols[z1 > z0 ? k + 1 : k] as string))
    }
    prev = p
  }
  if (prev) stops.push(st(x1, cols[zi(prev[1])] as string))
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${n1(x0)}" x2="${n1(x1)}" y1="0" y2="0">${stops.join('')}</linearGradient>`
}

// A mask that fades a fill from opacity a at yTop to b at yBot.
function fadeMask(id: string, W: number, H: number, yTop: number, yBot: number, a: number, b: number): string {
  return (
    `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${n1(yTop)}" y2="${n1(yBot)}"><stop offset="0" stop-color="#fff" stop-opacity="${a}"/><stop offset="1" stop-color="#fff" stop-opacity="${b}"/></linearGradient>` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}g)"/></mask>`
  )
}

const BAND_DEF =`<linearGradient id="band" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${LCD}" stop-opacity="0.16"/><stop offset="1" stop-color="${LCD}" stop-opacity="0.035"/></linearGradient>`

function niceStep(span: number, target: number): number {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

// The value of a curve at f, between its points; undefined off the curve.
function at(curve: [number, number][], f: number): number | undefined {
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (!first || !last || f < first[0] || f > last[0]) return undefined
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1] as [number, number]
    const b = curve[i] as [number, number]
    if (b[0] >= f) return b[0] === a[0] ? b[1] : a[1] + ((f - a[0]) / (b[0] - a[0])) * (b[1] - a[1])
  }
  return last[1]
}

// ---------------------------------------------------------------- the line charts (SWR, return loss, R & X)

type Frame = { W: number; H: number; L: number; R: number; T: number; B: number; lo: number; hi: number; c: boolean; x: (f: number) => number }
type Badge = { text: string; color: string }

function frame(series: Series[], g: Geo, H: number, ab = false): Frame {
  const c = g.c
  const W = g.W
  const L = c ? 34 : 44
  const R = c ? 10 : 16
  // On the phone A and B's names take a row of their own above the mesh labels.
  const T = c ? (ab ? 70 : 54) : 58
  const B = c ? 24 : 28
  let lo = Infinity
  let hi = -Infinity
  for (const s of series) {
    const first = s.curve[0]
    const last = s.curve[s.curve.length - 1]
    if (!first || !last) continue
    lo = Math.min(lo, first[0])
    hi = Math.max(hi, last[0])
  }
  if (!Number.isFinite(lo) || hi <= lo) {
    lo = live?.sweep ? live.sweep.start / 1e6 : 850
    hi = live?.sweep ? live.sweep.stop / 1e6 : 980
  }
  return { W, H, L, R, T, B, lo, hi, c, x: (f: number) => L + ((f - lo) / (hi - lo)) * (W - L - R) }
}

function badgeOf(series: Series[], compare: boolean): Badge {
  if (compare) return { text: 'A/B', color: MAGENTA }
  if (series.some(s => s.isLive)) return liveOn ? { text: 'LIVE', color: LCD } : { text: 'PAUSED', color: AXIS }
  if (histLabel) return { text: 'HISTORY', color: SKY }
  return { text: 'SAVED', color: SKY }
}

// The series drawn in the zone colours: the live one, or the only one.
function primaryOf(series: Series[], compare: boolean): Series | undefined {
  if (compare) return undefined
  return series.find(s => s.isLive) ?? (series.length === 1 ? series[0] : undefined)
}

function pathOf(fr: Frame, pts: [number, number][], y: (v: number) => number): string {
  return pts
    .filter(p => p[0] >= fr.lo && p[0] <= fr.hi)
    .map((p, i) => `${i ? 'L' : 'M'}${n1(fr.x(p[0]))},${n1(y(p[1]))}`)
    .join('')
}

// The trace closed onto a level (the floor of the SWR chart, the ceiling of return loss).
function areaOf(fr: Frame, pts: [number, number][], y: (v: number) => number, level: number): string {
  const p = pts.filter(q => q[0] >= fr.lo && q[0] <= fr.hi)
  const a = p[0]
  const b = p[p.length - 1]
  if (!a || !b) return ''
  return `${pathOf(fr, p, y)}L${n1(fr.x(b[0]))},${n1(level)}L${n1(fr.x(a[0]))},${n1(level)}Z`
}

// Card, title row, plot well and frequency axis. In A/B the two names stand in the title row.
function base(fr: Frame, parts: string[], title: string, sub: string, badge: Badge, ab?: [Series, Series]): void {
  const { W, H, L, R, T, B, lo, hi, x, c } = fr
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="${PLOT}"/>`)
  const bw = tw(badge.text, 10) + 26
  parts.push(`<rect x="12" y="9" width="${n1(bw)}" height="18" rx="9" fill="${badge.color}" fill-opacity="0.14" stroke="${badge.color}" stroke-opacity="0.7"/>`)
  parts.push(`<circle cx="22" cy="18" r="3.5" fill="${badge.color}"/>`)
  parts.push(txt(30, 22, badge.text, { fill: badge.color, size: 10, weight: 700, spacing: 0.5 }))
  const tx = 12 + bw + 10
  parts.push(txt(tx, 23, title, { fill: BRIGHT, size: c ? 13 : 14, weight: 700, font: SANS }))
  if (ab) {
    // A and B, right-aligned in the title row (under it on the phone).
    let ax = W - 14
    const ay = c ? 42 : 22
    for (const s of [ab[1], ab[0]]) {
      const name = cut(s.label, c ? 20 : 26)
      parts.push(txt(ax, ay, name, { anchor: 'end', size: 10, fill: s.color, weight: 700 }))
      ax -= tw(name, 10) + 6
      parts.push(`<path d="M${n1(ax - 14)},${ay - 3.5}h14" stroke="${s.color}" stroke-width="3" stroke-linecap="round"/>`)
      ax -= 28
    }
  } else if (!c && sub) parts.push(txt(W - 14, 22, sub, { anchor: 'end', size: 10 }))
  const step = niceStep(hi - lo, c ? 4 : 7)
  for (let f = Math.ceil(lo / step - 1e-9) * step; f <= hi + 1e-9; f += step) {
    const px = x(f)
    const last = f + step > hi + 1e-9
    parts.push(`<line x1="${n1(px)}" x2="${n1(px)}" y1="${T}" y2="${H - B}" stroke="${GRID2}"/>`)
    parts.push(txt(px, H - B + 16, `${Number(f.toFixed(1))}${last && !c ? ' MHz' : ''}`, { anchor: last ? 'end' : px < L + 14 ? 'start' : 'middle', size: c ? 9.5 : 10 }))
  }
}

// The band being measured as a teal stripe (the US 902–928 MHz band on the mesh sweep), labelled at
// its top right (on the phone the stripe alone).
function bandStripe(fr: Frame, parts: string[], placed: Rect[]): void {
  const { lo, hi, x, T, H, B, c } = fr
  const bd = chartBand(lo, hi)
  if (!bd) return
  const [blo, bhi] = bd.band
  const a = x(Math.max(blo, lo))
  const b = x(Math.min(bhi, hi))
  parts.push(`<rect x="${n1(a)}" y="${T}" width="${n1(Math.max(1, b - a))}" height="${H - T - B}" fill="url(#band)"/>`)
  parts.push(`<path d="M${n1(a)},${T}V${H - B}M${n1(b)},${T}V${H - B}" stroke="${LCD}" stroke-opacity="0.3" stroke-dasharray="2 3"/>`)
  if (c) return
  const label = bandLabel(bd)
  parts.push(txt(b - 4, T + 13, label, { anchor: 'end', size: 9, fill: LCD, opacity: 0.8, weight: 700 }))
  placed.push([b - 4 - tw(label, 9), T + 3, b, T + 16])
}

// The targets as labelled lines: Meshtastic and MeshCore on the mesh band, the band's own elsewhere.
function meshLines(fr: Frame, parts: string[]): void {
  const bd = chartBand(fr.lo, fr.hi)
  const targets: [number, string][] = !bd || bd.id === 'mesh' ? MESH : bd.targets
  targets.forEach(([f, name], k) => {
    if (f < fr.lo || f > fr.hi) return
    const px = fr.x(f)
    const left = k === 0 && targets.length > 1
    parts.push(`<line x1="${n1(px)}" x2="${n1(px)}" y1="${fr.T - 3}" y2="${fr.H - fr.B}" stroke="${LCD}" stroke-opacity="0.45" stroke-dasharray="3 3"/>`)
    parts.push(`<path d="M${n1(px - 4)},${fr.T - 10}h8l-4,6z" fill="${LCD}"/>`)
    parts.push(txt(px + (left ? -7 : 7), fr.T - 4, name.toUpperCase(), { anchor: left ? 'end' : 'start', size: fr.c ? 9 : 9.5, fill: LCD, weight: 700, spacing: 0.4 }))
  })
}

// The NanoVNA's own markers: a ring on the trace and a numbered flag at the floor, stacked when close.
function liveTags(fr: Frame, parts: string[], placed: Rect[], y: (m: Mark) => number): void {
  const fy = fr.H - fr.B
  const tags: Rect[] = []
  for (const mk of [...(live?.markers ?? [])].sort((a, b) => a.mhz - b.mhz)) {
    if (mk.mhz < fr.lo || mk.mhz > fr.hi) continue
    const mx = fr.x(mk.mhz)
    const my = y(mk)
    let ty = fy - 15
    while (tags.some(r => hits(r, [mx - 10, ty, mx + 10, ty + 12]))) ty -= 14
    tags.push([mx - 10, ty, mx + 10, ty + 12])
    parts.push(`<line x1="${n1(mx)}" x2="${n1(mx)}" y1="${n1(my + 4)}" y2="${ty}" stroke="${YELLOW}" stroke-opacity="0.35" stroke-dasharray="1 2"/>`)
    parts.push(`<circle cx="${n1(mx)}" cy="${n1(my)}" r="3.6" fill="none" stroke="${YELLOW}" stroke-width="1.4"/>`)
    parts.push(`<rect x="${n1(mx - 9)}" y="${ty}" width="18" height="12" rx="2.5" fill="${YELLOW}"/>`)
    parts.push(txt(mx, ty + 9.5, `M${mk.id}`, { fill: '#10161a', size: 8, anchor: 'middle', weight: 700 }))
  }
  placed.push(...tags)
}

function plotBounds(fr: Frame): Rect {
  return [fr.L + 2, fr.T + 2, fr.W - fr.R - 2, fr.H - fr.B - 2]
}

// The lowest point (or the deepest dip): a glowing ring and its value, labelled where there is room.
function dipMark(fr: Frame, parts: string[], placed: Rect[], f: number, py: number, col: string, label: string): void {
  if (f < fr.lo || f > fr.hi) return
  const px = fr.x(f)
  parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="13" fill="${col}" fill-opacity="0.4" filter="url(#soft)"/>`)
  parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="7" fill="none" stroke="${col}" stroke-width="1.7"/>`)
  parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="2.8" fill="${BRIGHT}"/>`)
  placed.push([px - 9, py - 9, px + 9, py + 9])
  placePill(
    parts,
    placed,
    [
      [px + 10, py + 21, 'start'],
      [px - 10, py + 21, 'end'],
      [px, py + 24, 'middle'],
      [px + 12, py - 12, 'start'],
      [px - 12, py - 12, 'end'],
      [px, py - 14, 'middle'],
      [px + 12, py + 4, 'start'],
      [px - 12, py + 4, 'end'],
    ],
    label,
    col,
    plotBounds(fr),
  )
}

// The mesh frequencies on the primary trace: a dot on the trace, the value tagged on its line.
function meshDots(fr: Frame, parts: string[], placed: Rect[], m: Metrics, val: (k: Mark) => number, y: (v: number) => number, col: (k: Mark) => string, show: (k: Mark) => string, py0 = fr.T + 34): void {
  for (const [key, left] of [
    ['meshtastic', true],
    ['meshcore', false],
  ] as [keyof Metrics, boolean][]) {
    const mk = m[key] as Mark | undefined
    if (!mk || mk.mhz < fr.lo || mk.mhz > fr.hi) continue
    const px = fr.x(mk.mhz)
    const py = y(val(mk))
    parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="4.8" fill="${col(mk)}" stroke="${PLOT}" stroke-width="1.5" filter="url(#glow)"/>`)
    placed.push([px - 6, py - 6, px + 6, py + 6])
    const s = show(mk)
    const tx = px + (left ? -6 : 6)
    placed.push(pillRect(tx, py0, s, 10, left ? 'end' : 'start'))
    parts.push(pill(tx, py0, s, { fill: col(mk), anchor: left ? 'end' : 'start' }))
  }
}

// The stretch under SWR 2 as a bracket on the 2:1 line, its width labelled where there is room.
function bracket(fr: Frame, parts: string[], placed: Rect[], u2: [number, number], yb: number): void {
  const a = Math.max(u2[0], fr.lo)
  const b = Math.min(u2[1], fr.hi)
  if (!(b > a)) return
  const xa = fr.x(a)
  const xb = fr.x(b)
  const openL = u2[0] <= fr.lo + 0.05
  const openR = u2[1] >= fr.hi - 0.05
  const end = (px: number, isOpen: boolean, dir: number) =>
    isOpen ? `M${n1(px + dir * 7)},${n1(yb - 4)}L${n1(px)},${n1(yb)}L${n1(px + dir * 7)},${n1(yb + 4)}` : `M${n1(px)},${n1(yb + 8)}V${n1(yb)}`
  parts.push(`<path d="M${n1(xa)},${n1(yb)}H${n1(xb)}${end(xa, openL, 1)}${end(xb, openR, -1)}" fill="none" stroke="${GREEN}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`)
  const wide = u2[1] - u2[0]
  const s = `${fr.c ? 'under 2:1' : `under 2:1 from ${Number(u2[0].toFixed(1))} to ${Number(u2[1].toFixed(1))}`} · ${wide.toFixed(wide >= 20 ? 0 : 1)}${openL || openR ? '+' : ''} MHz`
  const w = tw(s, 10) + 10
  const cands: Spot[] = [(xa + xb) / 2, xa + w / 2 + 8, xb - w / 2 - 8, (xa + fr.x(906.875) - 60) / 2, (xb + fr.x(910.525) + 60) / 2].flatMap(cx => [
    [cx, yb - 6, 'middle'] as Spot,
    [cx, yb + 18, 'middle'] as Spot,
  ])
  placePill(parts, placed, cands, s, GREEN, [Math.max(xa, fr.L) - 1, fr.T + 2, Math.min(xb, fr.W - fr.R) + 1, fr.H - fr.B - 2])
}

// Between two traces, shaded in the colour of whichever is better there.
function between(fr: Frame, parts: string[], a: [number, number][], b: [number, number][], y: (v: number) => number, aBetter: (va: number, vb: number) => boolean): void {
  const pts: [number, number, number][] = []
  for (const p of a) {
    if (p[0] < fr.lo || p[0] > fr.hi) continue
    const vb = at(b, p[0])
    if (vb !== undefined) pts.push([p[0], p[1], vb])
  }
  let run: [number, number, number][] = []
  let side: boolean | null = null
  const flush = () => {
    if (run.length < 2 || side === null) return
    const fwd = run.map((p, i) => `${i ? 'L' : 'M'}${n1(fr.x(p[0]))},${n1(y(p[1]))}`).join('')
    const back = [...run].reverse().map(p => `L${n1(fr.x(p[0]))},${n1(y(p[2]))}`).join('')
    parts.push(`<path d="${fwd}${back}Z" fill="${side ? colA : colB}" fill-opacity="0.24"/>`)
  }
  pts.forEach((p, i) => {
    const s = aBetter(p[1], p[2])
    if (side !== null && s !== side) {
      const q = pts[i - 1] as [number, number, number]
      const d0 = q[1] - q[2]
      const d1 = p[1] - p[2]
      const t = d0 === d1 ? 0.5 : d0 / (d0 - d1)
      const f = q[0] + t * (p[0] - q[0])
      const v = q[1] + t * (p[1] - q[1])
      run.push([f, v, v])
      flush()
      run = [[f, v, v]]
    }
    side = s
    run.push(p)
  })
  flush()
}

// A/B: both values at each mesh frequency and a badge naming the better one.
function winners(fr: Frame, parts: string[], placed: Rect[], A: Series, B: Series, val: (k: Mark) => number, y: (v: number) => number, low: boolean, show: (v: number) => string): void {
  for (const [key, left] of [
    ['meshtastic', true],
    ['meshcore', false],
  ] as [keyof Metrics, boolean][]) {
    const ma = A.metrics?.[key] as Mark | undefined
    const mb = B.metrics?.[key] as Mark | undefined
    if (!ma || !mb || ma.mhz < fr.lo || ma.mhz > fr.hi) continue
    const va = val(ma)
    const vb = val(mb)
    const px = fr.x(ma.mhz)
    for (const [v, col] of [
      [va, colA],
      [vb, colB],
    ] as [number, string][]) {
      parts.push(`<circle cx="${n1(px)}" cy="${n1(y(v))}" r="4.2" fill="${col}" stroke="${PLOT}" stroke-width="1.4" filter="url(#glow)"/>`)
    }
    const tie = Math.abs(va - vb) < 0.005
    const aWins = low ? va < vb : va > vb
    const col = tie ? AXIS : aWins ? colA : colB
    const s = tie ? `tie · ${show(va)}` : `★ ${aWins ? 'A' : 'B'} ${fr.c ? '' : 'wins '}· ${show(aWins ? va : vb)}`
    const tx = px + (left ? -6 : 6)
    placed.push(pillRect(tx, fr.T + 34, s, 10, left ? 'end' : 'start'))
    parts.push(pill(tx, fr.T + 34, s, { fill: col, anchor: left ? 'end' : 'start' }))
  }
}

function legend(fr: Frame, parts: string[], series: Series[], prim: Series | undefined, extra: [string, string, string][] = []): void {
  const rows: [string, string, string][] = [...extra, ...series.map(s => [s.label, s === prim ? 'zone' : s.color, ''] as [string, string, string])]
  if (rows.length < 2) return
  const x0 = fr.L + 8
  const y0 = fr.T + 8
  const w = Math.max(...rows.map(r => tw(r[0], 9.5))) + 34
  parts.push(`<rect x="${x0 - 5}" y="${y0}" width="${n1(w)}" height="${rows.length * 14 + 6}" rx="5" fill="${PLOT}" fill-opacity="0.88" stroke="${GRID}"/>`)
  rows.forEach(([label, col, dash], k) => {
    const ly = y0 + 12 + k * 14
    if (col === 'zone') {
      parts.push(`<path d="M${x0},${ly}h5" stroke="${GREEN}" stroke-width="2.6"/><path d="M${x0 + 5},${ly}h5" stroke="${AMBER}" stroke-width="2.6"/><path d="M${x0 + 10},${ly}h5" stroke="${RED}" stroke-width="2.6"/>`)
    } else parts.push(`<path d="M${x0},${ly}h15" stroke="${col}" stroke-width="2.4"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`)
    parts.push(txt(x0 + 21, ly + 3.5, label, { fill: LABEL, size: 9.5 }))
  })
}

// The primary trace's fill: each column in the zone colour of the trace above (or below) it.
function zoneFill(fr: Frame, parts: string[], area: string, swrPts: [number, number][]): void {
  const pts = swrPts.filter(p => p[0] >= fr.lo && p[0] <= fr.hi)
  parts.push(`<defs>${zoneCols('zc', fr.L, fr.W - fr.R, pts, fr.x)}</defs>`)
  parts.push(`<path d="${area}" fill="url(#zc)" mask="url(#fade)"/>`)
}

function swrChart(series: Series[], g: Geo, compare = false): string {
  const c = g.c
  const H = c ? 272 : 318
  const fr = frame(series, g, H, compare && series.length > 1)
  const { W, L, R, T, B } = fr
  let maxS = 1
  for (const s of series) for (const p of s.curve) if (p[0] >= fr.lo && p[0] <= fr.hi) maxS = Math.max(maxS, p[1])
  const cap = maxS <= 2.95 ? 3 : maxS <= 4.9 ? 5 : 10
  const gc = gam(cap)
  // The scale runs in |Γ|, as an SWR meter's does: the detail near 1 gets the room.
  const y = (s: number) => T + (1 - Math.min(gam(s), gc) / gc) * (H - T - B)
  const prim = primaryOf(series, compare)
  const [sA, sB] = series
  const ab = compare && sA && sB ? ([sA, sB] as [Series, Series]) : undefined
  const parts: string[] = []
  const placed: Rect[] = []
  parts.push(
    `<defs>${BAND_DEF}${glowDef('glow', W, H)}${blurDef('soft', W, H, 5)}${zoneGrad('zs', y(cap), y(1), y(2), y(1.5))}${fadeMask('fade', W, H, T, H - B, 0.62, 0.1)}` +
      `<clipPath id="plot"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>`,
  )
  base(fr, parts, 'SWR', `standing wave ratio · ${Number(fr.lo.toFixed(1))}–${Number(fr.hi.toFixed(1))} MHz`, badgeOf(series, compare), ab)
  const zr = (a: number, b: number, col: string, op: number) =>
    parts.push(`<rect x="${L}" y="${n1(y(b))}" width="${W - L - R}" height="${n1(y(a) - y(b))}" fill="${col}" fill-opacity="${op}"/>`)
  zr(2, cap, RED, 0.045)
  zr(1.5, 2, AMBER, 0.05)
  zr(1, 1.5, GREEN, 0.045)
  const ticks = cap === 3 ? [1, 1.2, 1.5, 2, 2.5, 3] : cap === 5 ? [1, 1.2, 1.5, 2, 3, 5] : [1, 1.5, 2, 3, 5, 10]
  for (const t of ticks) {
    const ty = n1(y(t))
    const special = t === 1.5 || t === 2
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" stroke="${t === 1.5 ? GREEN : t === 2 ? RED : GRID}" stroke-opacity="${special ? 0.55 : 1}"${special ? ` stroke-dasharray="${t === 2 ? '6 4' : '3 3'}"` : ''}/>`)
    parts.push(txt(L - 6, y(t) + 3.5, t === cap && maxS > cap ? `${t}+` : String(t), { anchor: 'end', size: c ? 9.5 : 10, fill: t === 1.5 ? GREEN : t === 2 ? AMBER : AXIS, weight: special ? 700 : undefined }))
  }
  bandStripe(fr, parts, placed)
  meshLines(fr, parts)
  parts.push('<g clip-path="url(#plot)">')
  if (ab) between(fr, parts, ab[0].curve, ab[1].curve, y, (va, vb) => va < vb)
  for (const s of series) {
    if (s === prim) continue
    parts.push(`<path d="${pathOf(fr, s.curve, y)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-opacity="${s.opacity}" stroke-linejoin="round"${compare ? ' filter="url(#glow)"' : ''}/>`)
  }
  if (prim) {
    zoneFill(fr, parts, areaOf(fr, prim.curve, y, y(1)), prim.curve)
    parts.push(`<path d="${pathOf(fr, prim.curve, y)}" fill="none" stroke="url(#zs)" stroke-width="${c ? 2.3 : 2.6}" stroke-linejoin="round" filter="url(#glow)"/>`)
  }
  parts.push('</g>')
  if (!ab) legend(fr, parts, series, prim)
  if (series.length > 1 && !ab) placed.push([L + 3, T + 8, L + 8 + Math.max(...series.map(s => tw(s.label, 9.5))) + 34, T + 14 + series.length * 14])
  if (ab) winners(fr, parts, placed, ab[0], ab[1], k => k.swr, y, true, v => fmt(v))
  else if (prim?.metrics) meshDots(fr, parts, placed, prim.metrics, k => k.swr, y, k => zone(k.swr), k => fmt(k.swr), fr.T + 34 + (c && series.length > 1 ? series.length * 14 + 4 : 0))
  if (prim?.isLive) liveTags(fr, parts, placed, m => y(m.swr))
  if (prim?.metrics?.under2) bracket(fr, parts, placed, prim.metrics.under2, y(2))
  if (prim?.metrics) {
    const best = prim.metrics.best
    dipMark(fr, parts, placed, best.mhz, y(best.swr), zone(best.swr), c ? `low ${fmt(best.swr)} · ${best.mhz.toFixed(1)}` : `lowest ${fmt(best.swr)} · ${best.mhz.toFixed(1)} MHz`)
  }
  return svgDoc(W, H, parts.join(''))
}

function rlPoints(s: Series): [number, number][] {
  const g = s.s11?.length === s.curve.length ? s.s11 : undefined
  return s.curve.map((p, i) => {
    const gi = g?.[i]
    return [p[0], gi ? rlOf(gi) : -20 * Math.log10(Math.max((p[1] - 1) / (p[1] + 1), 1e-9))]
  })
}

function swrOfRl(rl: number): number {
  const g = 10 ** (-rl / 20)
  return g >= 0.999 ? 99 : (1 + g) / (1 - g)
}

function rlChart(series: Series[], g: Geo, compare = false): string {
  const c = g.c
  const H = c ? 272 : 318
  const fr = frame(series, g, H, compare && series.length > 1)
  const { W, L, R, T, B } = fr
  const data = series.map(s => ({ s, pts: rlPoints(s) }))
  let deep = 0
  for (const { pts } of data) for (const p of pts) if (p[0] >= fr.lo && p[0] <= fr.hi) deep = Math.max(deep, p[1])
  const depth = deep > 38 ? 50 : deep > 28 ? 40 : 30
  const y = (rl: number) => T + (clamp(rl, 0, depth) / depth) * (H - T - B)
  const prim = primaryOf(series, compare)
  const [sA, sB] = series
  const ab = compare && sA && sB ? ([sA, sB] as [Series, Series]) : undefined
  const parts: string[] = []
  const placed: Rect[] = []
  parts.push(
    `<defs>${BAND_DEF}${glowDef('glow', W, H)}${blurDef('soft', W, H, 5)}${zoneGrad('zs', T, H - B, y(9.54), y(13.98))}${fadeMask('fade', W, H, T, H - B, 0.06, 0.6)}` +
      `<clipPath id="plot"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath></defs>`,
  )
  base(fr, parts, 'Return loss', 'S11 in dB · the deeper the dip, the better the match', badgeOf(series, compare), ab)
  const zr = (a: number, b: number, col: string, op: number) => parts.push(`<rect x="${L}" y="${n1(y(a))}" width="${W - L - R}" height="${n1(y(b) - y(a))}" fill="${col}" fill-opacity="${op}"/>`)
  zr(0, 9.54, RED, 0.04)
  zr(9.54, 13.98, AMBER, 0.05)
  zr(13.98, depth, GREEN, 0.045)
  for (let d = 5; d <= depth; d += 5) {
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y(d))}" y2="${n1(y(d))}" stroke="${GRID}"/>`)
    parts.push(txt(L - 6, y(d) + 3.5, `−${d}`, { anchor: 'end', size: c ? 9.5 : 10 }))
  }
  parts.push(txt(L - 6, y(0) + 3.5, '0', { anchor: 'end', size: c ? 9.5 : 10, fill: LABEL }))
  bandStripe(fr, parts, placed)
  meshLines(fr, parts)
  parts.push('<g clip-path="url(#plot)">')
  if (ab) {
    const [da, db] = data
    if (da && db) between(fr, parts, da.pts, db.pts, y, (va, vb) => va > vb)
  }
  for (const { s, pts } of data) {
    if (s === prim) continue
    parts.push(`<path d="${pathOf(fr, pts, y)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-opacity="${s.opacity}" stroke-linejoin="round"${compare ? ' filter="url(#glow)"' : ''}/>`)
  }
  const pp = data.find(d => d.s === prim)?.pts
  if (pp) {
    zoneFill(fr, parts, areaOf(fr, pp, y, T), pp.map(p => [p[0], swrOfRl(p[1])]))
    parts.push(`<path d="${pathOf(fr, pp, y)}" fill="none" stroke="url(#zs)" stroke-width="${c ? 2.3 : 2.6}" stroke-linejoin="round" filter="url(#glow)"/>`)
  }
  parts.push('</g>')
  for (const [rl, label, col, dash] of [
    [9.54, 'SWR 2 · −9.5 dB', RED, '6 4'],
    [13.98, 'SWR 1.5 · −14 dB', GREEN, '3 3'],
  ] as [number, string, string, string][]) {
    const s = c ? (label.split(' · ')[0] ?? label) : label
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y(rl))}" y2="${n1(y(rl))}" stroke="${col}" stroke-opacity="0.55" stroke-dasharray="${dash}"/>`)
    parts.push(`<rect x="${n1(W - R - 8 - tw(s, 9.5))}" y="${n1(y(rl) - 15)}" width="${n1(tw(s, 9.5) + 6)}" height="12" rx="2" fill="${PLOT}" fill-opacity="0.8"/>`)
    parts.push(txt(W - R - 5, y(rl) - 5, s, { anchor: 'end', size: 9.5, fill: col === RED ? AMBER : GREEN, weight: 700 }))
    placed.push([W - R - 10 - tw(s, 9.5), y(rl) - 16, W - R, y(rl) - 2])
  }
  // The 0 dB line: everything reflected.
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${T}" y2="${T}" stroke="#9fb3bb" stroke-width="1.5"/>`)
  const rlOfMark = (k: Mark) => k.rl ?? -20 * Math.log10(Math.max(gam(k.swr), 1e-9))
  if (!ab) legend(fr, parts, series, prim)
  if (series.length > 1 && !ab) placed.push([L + 3, T + 8, L + 8 + Math.max(...series.map(s => tw(s.label, 9.5))) + 34, T + 14 + series.length * 14])
  if (ab) winners(fr, parts, placed, ab[0], ab[1], rlOfMark, y, false, v => `−${v.toFixed(1)} dB`)
  else if (prim?.metrics) meshDots(fr, parts, placed, prim.metrics, rlOfMark, y, k => zone(k.swr), k => `−${rlOfMark(k).toFixed(1)} dB`, fr.T + 34 + (c && series.length > 1 ? series.length * 14 + 4 : 0))
  if (prim?.isLive) liveTags(fr, parts, placed, m => y(m.rl ?? 0))
  if (prim?.metrics && pp) {
    let d = pp[0] as [number, number]
    for (const p of pp) if (p[0] >= fr.lo && p[0] <= fr.hi && p[1] > d[1]) d = p
    dipMark(fr, parts, placed, d[0], y(d[1]), zone(swrOfRl(d[1])), c ? `−${d[1].toFixed(1)} dB · ${d[0].toFixed(1)}` : `deepest −${d[1].toFixed(1)} dB · ${d[0].toFixed(1)} MHz`)
  }
  return svgDoc(W, H, parts.join(''))
}

function rxChart(series: Series[], g: Geo, compare = false): string {
  const c = g.c
  const H = c ? 292 : 336
  const fr = frame(series, g, H, compare && series.length > 1)
  const { W, L, R, T, B } = fr
  const rx = series.map(s => ({
    s,
    pts: (s.s11?.length === s.curve.length ? s.s11.map((q, i) => [s.curve[i]?.[0] ?? 0, ...zOfGamma(q)]) : []) as [number, number, number][],
  }))
  let lo = -60
  let hi = 100
  for (const { pts } of rx) {
    for (const p of pts) {
      if (p[0] < fr.lo || p[0] > fr.hi) continue
      lo = Math.min(lo, p[2], p[1])
      hi = Math.max(hi, p[1], p[2])
    }
  }
  lo = Math.max(lo, -300)
  hi = Math.min(hi, 400)
  const span = hi - lo
  const step = span > 400 ? 100 : span > 200 ? 50 : 25
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const y = (v: number) => T + (1 - (Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (H - T - B)
  const y0 = y(0)
  const prim = primaryOf(series, compare)
  const [sA, sB] = series
  const ab = compare && sA && sB ? ([sA, sB] as [Series, Series]) : undefined
  const parts: string[] = []
  const placed: Rect[] = []
  parts.push(
    `<defs>${BAND_DEF}${glowDef('glow', W, H)}${blurDef('soft', W, H, 5)}` +
      `<linearGradient id="xup" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${T}" y2="${n1(y0)}"><stop offset="0" stop-color="${ORANGE}" stop-opacity="0.42"/><stop offset="1" stop-color="${ORANGE}" stop-opacity="0.08"/></linearGradient>` +
      `<linearGradient id="xdn" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${n1(y0)}" y2="${H - B}"><stop offset="0" stop-color="${SKY}" stop-opacity="0.08"/><stop offset="1" stop-color="${SKY}" stop-opacity="0.45"/></linearGradient>` +
      `<clipPath id="plot"><rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/></clipPath>` +
      `<clipPath id="up"><rect x="${L}" y="${T}" width="${W - L - R}" height="${n1(y0 - T)}"/></clipPath>` +
      `<clipPath id="dn"><rect x="${L}" y="${n1(y0)}" width="${W - L - R}" height="${n1(H - B - y0)}"/></clipPath></defs>`,
  )
  base(fr, parts, 'R & X', 'impedance R + jX in ohms · resonance where X crosses 0', badgeOf(series, compare), ab)
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${n1(y0 - T)}" fill="${ORANGE}" fill-opacity="0.035"/>`)
  parts.push(`<rect x="${L}" y="${n1(y0)}" width="${W - L - R}" height="${n1(H - B - y0)}" fill="${SKY}" fill-opacity="0.04"/>`)
  for (let v = lo; v <= hi; v += step) {
    if (v !== 0) parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y(v))}" y2="${n1(y(v))}" stroke="${GRID}"/>`)
    parts.push(txt(L - 6, y(v) + 3.5, v < 0 ? `−${-v}` : String(v), { anchor: 'end', size: c ? 9.5 : 10, fill: v === 0 ? LABEL : AXIS }))
  }
  // R near 50 Ω: SWR under 1.25 with X at 0.
  parts.push(`<rect x="${L}" y="${n1(y(62.5))}" width="${W - L - R}" height="${n1(y(40) - y(62.5))}" fill="${GREEN}" fill-opacity="0.07"/>`)
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y(50))}" y2="${n1(y(50))}" stroke="${GREEN}" stroke-opacity="0.6" stroke-dasharray="5 4"/>`)
  bandStripe(fr, parts, placed)
  meshLines(fr, parts)
  parts.push('<g clip-path="url(#plot)">')
  for (const { s, pts } of rx) {
    if (!pts.length || s === prim) continue
    parts.push(`<path d="${pathOf(fr, pts.map(p => [p[0], p[1]]), y)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-opacity="${s.opacity}"${compare ? ' filter="url(#glow)"' : ''}/>`)
    parts.push(`<path d="${pathOf(fr, pts.map(p => [p[0], p[2]]), y)}" fill="none" stroke="${s.color}" stroke-width="${s.width}" stroke-opacity="${s.opacity}" stroke-dasharray="6 4"/>`)
  }
  const pp = rx.find(d => d.s === prim)?.pts ?? []
  if (pp.length) {
    const xs = pp.map(p => [p[0], p[2]] as [number, number])
    const area = areaOf(fr, xs, y, y0)
    parts.push(`<path d="${area}" fill="url(#xup)" clip-path="url(#up)"/>`)
    parts.push(`<path d="${area}" fill="url(#xdn)" clip-path="url(#dn)"/>`)
    parts.push(`<path d="${pathOf(fr, pp.map(p => [p[0], p[1]]), y)}" fill="none" stroke="${LCD}" stroke-width="${c ? 2.2 : 2.5}" stroke-linejoin="round" filter="url(#glow)"/>`)
    parts.push(`<path d="${pathOf(fr, xs, y)}" fill="none" stroke="${MAGENTA}" stroke-width="${c ? 2.2 : 2.5}" stroke-linejoin="round" filter="url(#glow)"/>`)
  }
  parts.push('</g>')
  // X = 0: where the antenna resonates.
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y0)}" y2="${n1(y0)}" stroke="#9fb3bb" stroke-width="1.5"/>`)
  const sideLabel = (yy: number, s: string, col: string) => {
    parts.push(`<rect x="${n1(W - R - 8 - tw(s, 9.5))}" y="${n1(yy - 10)}" width="${n1(tw(s, 9.5) + 6)}" height="13" rx="2" fill="${PLOT}" fill-opacity="0.8"/>`)
    parts.push(txt(W - R - 5, yy, s, { anchor: 'end', size: 9.5, fill: col, weight: 700 }))
    placed.push([W - R - 10 - tw(s, 9.5), yy - 11, W - R, yy + 4])
  }
  sideLabel(y(50) - 5, 'R target 50 Ω', GREEN)
  sideLabel(y0 - 5, c ? 'X > 0 inductive ↑' : 'X > 0 inductive (long) ↑', ORANGE)
  sideLabel(y0 + 14, c ? 'X < 0 capacitive ↓' : 'X < 0 capacitive (short) ↓', SKY)
  const extra: [string, string, string][] = prim
    ? [
        ['R resistance', LCD, ''],
        ['X reactance', MAGENTA, ''],
      ]
    : [
        ['R resistance (solid)', AXIS, ''],
        ['X reactance (dashed)', AXIS, '5 3'],
      ]
  const others = ab ? [] : series.filter(s => s !== prim)
  legend(fr, parts, others, undefined, extra)
  const labels = [...extra.map(e => e[0]), ...others.map(s => s.label)]
  placed.push([L + 3, T + 8, L + 8 + Math.max(...labels.map(s => tw(s, 9.5))) + 34, T + 14 + labels.length * 14])
  // Z at the mesh frequencies, tagged on their lines.
  if (prim?.metrics) {
    for (const [key, left] of [
      ['meshtastic', true],
      ['meshcore', false],
    ] as [keyof Metrics, boolean][]) {
      const mk = prim.metrics[key] as Mark | undefined
      if (!mk?.z || mk.mhz < fr.lo || mk.mhz > fr.hi) continue
      const px = fr.x(mk.mhz)
      parts.push(`<circle cx="${n1(px)}" cy="${n1(y(mk.z[0]))}" r="4" fill="${LCD}" stroke="${PLOT}" stroke-width="1.3"/>`)
      parts.push(`<circle cx="${n1(px)}" cy="${n1(y(mk.z[1]))}" r="4" fill="${MAGENTA}" stroke="${PLOT}" stroke-width="1.3"/>`)
      const s = c ? `${mk.z[0].toFixed(0)}${mk.z[1] >= 0 ? '+' : '−'}j${Math.abs(mk.z[1]).toFixed(0)}` : zText(mk.z)
      const tx = px + (left ? -6 : 6)
      placed.push(pillRect(tx, T + 34, s, 10, left ? 'end' : 'start'))
      parts.push(pill(tx, T + 34, s, { fill: LABEL, anchor: left ? 'end' : 'start' }))
    }
  }
  // Resonance: where X crosses zero (or where it comes closest).
  for (const s of series) {
    const res = s.metrics?.resonance
    const isP = s === prim
    if (res?.mhz && res.mhz >= fr.lo && res.mhz <= fr.hi) {
      const px = fr.x(res.mhz)
      const col = isP ? YELLOW : s.color
      parts.push(`<line x1="${n1(px)}" x2="${n1(px)}" y1="${T}" y2="${H - B}" stroke="${col}" stroke-opacity="0.5" stroke-dasharray="2 3"/>`)
      if (isP) parts.push(`<circle cx="${n1(px)}" cy="${n1(y0)}" r="12" fill="${YELLOW}" fill-opacity="0.45" filter="url(#soft)"/>`)
      parts.push(`<circle cx="${n1(px)}" cy="${n1(y0)}" r="${isP ? 5 : 4}" fill="${col}" stroke="${PLOT}" stroke-width="1.4"/>`)
      placed.push([px - 7, y0 - 7, px + 7, y0 + 7])
      const s2 = `${res.kind && res.kind !== 'series' ? 'anti-resonance' : 'resonance'} ${res.mhz.toFixed(1)}${c ? '' : ' MHz'}`
      const yb = H - B - 10
      placePill(parts, placed, [[px + 9, yb, 'start'], [px - 9, yb, 'end'], [px + 9, yb - 18, 'start'], [px - 9, yb - 18, 'end'], [px + 9, yb - 36, 'start'], [px - 9, yb - 36, 'end']], s2, col, plotBounds(fr))
    } else if (isP && res?.closest && res.closest.mhz >= fr.lo && res.closest.mhz <= fr.hi) {
      const px = fr.x(res.closest.mhz)
      const py = y(res.closest.x)
      parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="7" fill="none" stroke="${YELLOW}" stroke-width="1.5" stroke-dasharray="2 2"/>`)
      placed.push([px - 8, py - 8, px + 8, py + 8])
      const s2 = c ? `no X = 0 · closest ${res.closest.x.toFixed(0)} Ω` : `no X = 0 in this sweep · closest ${res.closest.x > 0 ? '+' : '−'}${Math.abs(res.closest.x).toFixed(1)} Ω at ${res.closest.mhz.toFixed(1)} MHz`
      const yb = H - B - 10
      placePill(parts, placed, [[px + 10, yb, 'start'], [px - 10, yb, 'end'], [px, yb, 'middle'], [px + 10, yb - 18, 'start'], [px - 10, yb - 18, 'end']], s2, YELLOW, plotBounds(fr))
    }
  }
  return svgDoc(W, H, parts.join(''))
}

// ---------------------------------------------------------------- the Smith chart

// Frequency along the trace: blue at the bottom of the sweep, magenta, red at the top.
const FREQ_STOPS: [number, [number, number, number]][] = [
  [0, [64, 140, 255]],
  [0.35, [139, 107, 255]],
  [0.68, [230, 85, 224]],
  [1, [255, 77, 77]],
]
function fcol(t: number): string {
  t = clamp(t)
  for (let i = 1; i < FREQ_STOPS.length; i++) {
    const [t1, c1] = FREQ_STOPS[i] as [number, [number, number, number]]
    const [t0, c0] = FREQ_STOPS[i - 1] as [number, [number, number, number]]
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0)
      return `#${c0.map((v, k) => Math.round(v + ((c1[k] ?? v) - v) * u).toString(16).padStart(2, '0')).join('')}`
    }
  }
  return '#ff4d4d'
}

function smithChart(series: Series[], g: Geo, compare = false): string {
  const c = g.c
  const W = g.W
  const rad = c ? 148 : 184
  const cx = c ? W / 2 : 214
  const cy = c ? 60 + rad : 224
  const px = (u: number) => cx + u * rad
  const py = (v: number) => cy - v * rad
  const prim = primaryOf(series, compare)
  const fr = frame(series, { W, c }, 600)
  const tOf = (f: number) => (f - fr.lo) / (fr.hi - fr.lo || 1)
  const grad = FREQ_STOPS.map(([t, rgb]) => `<stop offset="${t}" stop-color="rgb(${rgb.join(',')})"/>`).join('')
  // Filters are sized generously, so the height can be settled after the panel is laid out.
  const HF = 900
  const parts: string[] = []
  parts.push(
    `<defs><radialGradient id="face" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#0c2725"/><stop offset="0.72" stop-color="#071816"/><stop offset="1" stop-color="#030a09"/></radialGradient>` +
      `<radialGradient id="vig" cx="50%" cy="50%" r="50%"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>` +
      `<linearGradient id="fq" x1="0" x2="1" y1="0" y2="0">${grad}</linearGradient>` +
      `${glowDef('glow', W, HF, 2.4)}${blurDef('soft', W, HF, 5)}${blurDef('halo', W, HF, 3)}` +
      `<clipPath id="unit"><circle cx="${cx}" cy="${cy}" r="${rad}"/></clipPath></defs>`,
  )
  const card = parts.length
  parts.push('')
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${rad + 4}" fill="none" stroke="#3bb29d" stroke-opacity="0.2" stroke-width="10" filter="url(#soft)"/>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="url(#face)"/>`)
  // Zones: inside the amber circle SWR is under 2, inside the green one under 1.5.
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${n1(rad / 3)}" fill="${AMBER}" fill-opacity="0.08"/>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${n1(rad * 0.2)}" fill="${GREEN}" fill-opacity="0.12"/>`)
  const grid: string[] = []
  for (const r of [0.2, 0.5, 1, 2, 5]) {
    grid.push(`<circle cx="${n1(px(r / (1 + r)))}" cy="${cy}" r="${n1(rad / (1 + r))}" fill="none" stroke="${r === 1 ? '#2f8273' : '#1d5a51'}" stroke-opacity="${r === 1 ? 0.9 : 0.6}"/>`)
  }
  for (const x of [0.2, 0.5, 1, 2, 5]) {
    for (const sgn of [1, -1]) {
      grid.push(`<circle cx="${n1(px(1))}" cy="${n1(py(sgn / x))}" r="${n1(rad / x)}" fill="none" stroke="${x === 1 ? '#2f8273' : '#1d5a51'}" stroke-opacity="${x === 1 ? 0.9 : 0.55}"/>`)
    }
  }
  grid.push(`<line x1="${px(-1)}" x2="${px(1)}" y1="${cy}" y2="${cy}" stroke="#2f8273"/>`)
  parts.push(`<g clip-path="url(#unit)">${grid.join('')}</g>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${n1(rad / 3)}" fill="none" stroke="${AMBER}" stroke-opacity="0.7" stroke-width="1.2" stroke-dasharray="5 4"/>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${n1(rad * 0.2)}" fill="none" stroke="${GREEN}" stroke-opacity="0.8" stroke-width="1.2" stroke-dasharray="3 3"/>`)
  // Rim: |Γ| = 1, with phase ticks every 10°.
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="url(#vig)"/>`)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${rad}" fill="none" stroke="#3bb29d" stroke-width="1.6"/>`)
  const ticks: string[] = []
  for (let a = 0; a < 360; a += 10) {
    const r1 = rad + (a % 30 === 0 ? 6 : 3.5)
    const ca = Math.cos((a * Math.PI) / 180)
    const sa2 = Math.sin((a * Math.PI) / 180)
    ticks.push(`M${n1(cx + rad * ca)},${n1(cy - rad * sa2)}L${n1(cx + r1 * ca)},${n1(cy - r1 * sa2)}`)
  }
  parts.push(`<path d="${ticks.join('')}" stroke="#3a8f80" stroke-width="1"/>`)
  for (const r of [0.2, 0.5, 1, 2, 5]) parts.push(txt(px((r - 1) / (r + 1)) + 2, cy + 11, `${r * 50}`, { size: 9, fill: '#69c9b6' }))
  for (const x of [0.5, 1, 2]) {
    for (const sgn of [1, -1]) {
      const xx = sgn * x
      const u = (xx * xx - 1) / (xx * xx + 1)
      const v = (2 * xx) / (xx * xx + 1)
      parts.push(txt(px(u * 1.09), py(v * 1.09) + 3, `${sgn > 0 ? '+' : '−'}j${x * 50}`, { size: 9, fill: '#69c9b6', anchor: u < -0.1 ? 'end' : u > 0.1 ? 'start' : 'middle' }))
    }
  }
  parts.push(txt(px(-1) + 6, cy - 6, 'short', { size: 9.5, fill: '#69c9b6' }))
  parts.push(txt(px(1) - 6, cy - 6, 'open', { anchor: 'end', size: 9.5, fill: '#69c9b6' }))
  // The 50 Ω target.
  parts.push(
    `<g stroke="${BRIGHT}" fill="none"><circle cx="${cx}" cy="${cy}" r="9" stroke-opacity="0.45"/><circle cx="${cx}" cy="${cy}" r="4.5" stroke-opacity="0.8"/>` +
      `<path d="M${cx - 15},${cy}h7M${cx + 8},${cy}h7M${cx},${cy - 15}v7M${cx},${cy + 8}v7" stroke-opacity="0.9" stroke-width="1.3"/></g><circle cx="${cx}" cy="${cy}" r="1.8" fill="${BRIGHT}"/>`,
  )
  // The traces: the primary in frequency colours, the rest in their own.
  const sb = chartBand(fr.lo, fr.hi)
  const [blo, bhi] = sb ? sb.band : [902, 928]
  const inBand = (f: number) => f >= blo && f <= bhi
  const dots: [number, number][] = []
  for (const s of series) {
    if (!s.s11?.length || s.s11.length !== s.curve.length) continue
    const xy = (i: number): [number, number] => {
      const q = s.s11?.[i] as [number, number]
      return [px(q[0]), py(q[1])]
    }
    const pt = (i: number) => xy(i).map(n1).join(',')
    s.s11.forEach((_, i) => dots.push(xy(i)))
    if (s === prim) {
      const segs: string[] = []
      const band: string[] = []
      for (let i = 1; i < s.s11.length; i++) {
        const f = s.curve[i]?.[0] ?? 0
        const seg = `<path d="M${pt(i - 1)}L${pt(i)}" stroke="${fcol(tOf(f))}"/>`
        segs.push(seg)
        if (inBand(f) && inBand(s.curve[i - 1]?.[0] ?? 0)) band.push(seg)
      }
      parts.push(`<g clip-path="url(#unit)"><g fill="none" stroke-width="2.3" stroke-linecap="round" opacity="0.85" filter="url(#glow)">${segs.join('')}</g>`)
      if (band.length) {
        parts.push(`<g fill="none" stroke-width="10" stroke-linecap="round" opacity="0.4" filter="url(#halo)">${band.join('')}</g>`)
        parts.push(`<g fill="none" stroke-width="4.6" stroke-linecap="round">${band.join('')}</g>`)
      }
      parts.push('</g>')
    } else {
      const all = s.s11.map((_, i) => `${i ? 'L' : 'M'}${pt(i)}`).join('')
      parts.push(`<path d="${all}" fill="none" stroke="${s.color}" stroke-width="${compare ? 1.8 : 1.3}" stroke-opacity="${s.opacity * 0.8}" clip-path="url(#unit)"${compare ? ' filter="url(#glow)"' : ''}/>`)
      const idx = s.curve.map((p, i) => (inBand(p[0]) ? i : -1)).filter(i => i >= 0)
      if (idx.length > 1) parts.push(`<path d="${idx.map((i, k) => `${k ? 'L' : 'M'}${pt(i)}`).join('')}" fill="none" stroke="${s.color}" stroke-width="${compare ? 4 : 3}" stroke-opacity="${s.opacity}" stroke-linecap="round"/>`)
    }
  }
  // Labels go where they cover no other label and as little trace as possible.
  const d45 = Math.SQRT1_2
  const placed: Rect[] = [
    [cx - 16, cy - 16, cx + 16, cy + 16],
    [px(-1), cy - 18, px(-1) + 40, cy - 2],
    [px(1) - 36, cy - 18, px(1), cy - 2],
    [cx - 44, cy + 10, cx - 10, cy + 24],
    [cx + (rad / 3) * d45, cy - (rad / 3) * d45 - 14, cx + (rad / 3) * d45 + 26, cy - (rad / 3) * d45],
    [cx + rad * 0.2 * d45, cy - rad * 0.2 * d45 - 14, cx + rad * 0.2 * d45 + 38, cy - rad * 0.2 * d45],
    ...[0.2, 0.5, 1, 2, 5].map(r => [px((r - 1) / (r + 1)) + 1, cy + 2, px((r - 1) / (r + 1)) + 4 + tw(`${r * 50}`, 9), cy + 14] as Rect),
  ]
  const label = (x: number, y: number, s: string, col: string, asPill: boolean, size = 10, dists = [16, 30, 46]) => {
    const dirs: [number, number][] = [
      [-1, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [0, -1.3],
      [0, 1.5],
      [-1.4, 0.2],
      [1.4, 0.2],
    ]
    const w = tw(s, size) + (asPill ? 10 : 2)
    let best: { r: Rect; x: number; y: number; a: 'start' | 'middle' | 'end'; cost: number } | null = null
    dirs.forEach(([dx, dy], k) => {
      for (const d of dists) {
        const a: 'start' | 'middle' | 'end' = dx < -0.2 ? 'end' : dx > 0.2 ? 'start' : 'middle'
        const lx = x + dx * d
        const ly = y + dy * d + size * 0.4
        const r: Rect = a === 'end' ? [lx - w, ly - size - 2, lx, ly + 5] : a === 'start' ? [lx, ly - size - 2, lx + w, ly + 5] : [lx - w / 2, ly - size - 2, lx + w / 2, ly + 5]
        const over = placed.filter(p => hits(p, r)).length
        const onTrace = dots.filter(([qx, qy]) => qx > r[0] - 2 && qx < r[2] + 2 && qy > r[1] - 2 && qy < r[3] + 2).length
        const out = r[0] < 4 || r[2] > (c ? W - 4 : 428) || r[1] < 30 || r[3] > cy + rad + 24 ? 1 : 0
        const cost = over * 1000 + out * 500 + onTrace * 25 + k * 2 + d * 0.4
        if (!best || cost < best.cost) best = { r, x: lx, y: ly, a, cost }
      }
    })
    const b = best as unknown as { r: Rect; x: number; y: number; a: 'start' | 'middle' | 'end' }
    placed.push(b.r)
    if (asPill) {
      parts.push(`<path d="M${n1(x)},${n1(y)}L${n1(b.a === 'end' ? b.r[2] : b.a === 'start' ? b.r[0] : b.x)},${n1((b.r[1] + b.r[3]) / 2)}" stroke="${BRIGHT}" stroke-opacity="0.55"/>`)
      parts.push(pill(b.x, b.y, s, { fill: col, anchor: b.a, size }))
    } else parts.push(txt(b.x, b.y, s, { size, fill: col, weight: 700, anchor: b.a }))
  }
  // The mesh frequencies first, then where the sweep starts and ends, then the zone names.
  const marks = (compare ? series : prim ? [prim] : []).flatMap(s =>
    (['meshtastic', 'meshcore'] as (keyof Metrics)[]).map(k => ({ s, key: k, mk: s.metrics?.[k] as Mark | undefined })),
  )
  const spots: [number, number, string, string][] = []
  for (const { s, key, mk } of marks) {
    if (!mk?.z) continue
    const q = gammaOfZ(mk.z)
    const qx = px(q[0])
    const qy = py(q[1])
    parts.push(`<circle cx="${n1(qx)}" cy="${n1(qy)}" r="5" fill="${compare ? s.color : fcol(tOf(mk.mhz))}" stroke="${BRIGHT}" stroke-width="1.6"/>`)
    placed.push([qx - 6, qy - 6, qx + 6, qy + 6])
    if (!compare) spots.push([qx, qy, `${key === 'meshtastic' ? 'Meshtastic' : 'MeshCore'} ${fmt(mk.swr)}`, zone(mk.swr)])
  }
  for (const [x, y, s, col] of spots) label(x, y, s, col, true)
  const ends = prim ?? series[0]
  if (ends?.s11?.length && ends.s11.length === ends.curve.length) {
    for (const [i, t] of [
      [0, 0],
      [ends.s11.length - 1, 1],
    ] as [number, number][]) {
      const q = ends.s11[i] as [number, number]
      const col = prim ? fcol(t) : ends.color
      parts.push(`<circle cx="${n1(px(q[0]))}" cy="${n1(py(q[1]))}" r="3.6" fill="${t ? col : PLOT}" stroke="${col}" stroke-width="1.5"/>`)
      label(px(q[0]), py(q[1]), `${Number((ends.curve[i]?.[0] ?? 0).toFixed(1))}`, col, false, 9.5, [9, 14])
    }
  }
  parts.push(txt(cx + (rad / 3) * d45 + 3, cy - (rad / 3) * d45 - 3, '2:1', { fill: AMBER, size: 9.5, weight: 700 }))
  parts.push(txt(cx + rad * 0.2 * d45 + 3, cy - rad * 0.2 * d45 - 3, '1.5:1', { fill: GREEN, size: 9.5, weight: 700 }))
  parts.push(txt(cx - 12, cy + 21, '50 Ω', { size: 9.5, fill: BRIGHT, anchor: 'end', weight: 700 }))
  // The panel: what the colours mean and the reading at the mesh frequencies.
  const x0 = c ? 18 : 440
  const pw = c ? W - 36 : W - x0 - 16
  let y = c ? cy + rad + 34 : 16
  const badge = badgeOf(series, compare)
  const bw = tw(badge.text, 10) + 26
  const bx = c ? 12 : x0
  const by = c ? 9 : y
  parts.push(`<rect x="${bx}" y="${by}" width="${n1(bw)}" height="18" rx="9" fill="${badge.color}" fill-opacity="0.14" stroke="${badge.color}" stroke-opacity="0.7"/>`)
  parts.push(`<circle cx="${bx + 10}" cy="${by + 9}" r="3.5" fill="${badge.color}"/>`)
  parts.push(txt(bx + 18, by + 13, badge.text, { fill: badge.color, size: 10, weight: 700, spacing: 0.5 }))
  if (c) {
    parts.push(txt(12 + bw + 10, 23, 'Smith chart', { fill: BRIGHT, size: 13, weight: 700, font: SANS }))
    parts.push(txt(W - 12, 22, 'inductive ↑', { anchor: 'end', size: 9.5, fill: ORANGE, weight: 700 }))
    parts.push(txt(W - 12, cy + rad + 18, 'capacitive ↓', { anchor: 'end', size: 9.5, fill: SKY, weight: 700 }))
  } else {
    parts.push(txt(x0, (y += 52), 'Smith chart', { fill: BRIGHT, size: 16, weight: 700, font: SANS }))
    parts.push(txt(x0, (y += 17), `impedance · ${Number(fr.lo.toFixed(1))}–${Number(fr.hi.toFixed(1))} MHz`, { size: 10 }))
    parts.push(txt(14, 24, '▲ inductive (+jX)', { size: 9.5, fill: ORANGE, weight: 700 }))
    y += 12
  }
  const reading = (mk: Mark | undefined, title: string, big: boolean, col = LCD) => {
    if (!mk?.z) return
    const q = gammaOfZ(mk.z)
    parts.push(txt(x0, (y += big ? 30 : 26), title, { size: 9.5, fill: col, weight: 700, spacing: 0.6 }))
    parts.push(txt(x0, (y += big ? 22 : 18), zText(mk.z), { size: big ? 16 : 13, fill: BRIGHT, weight: 700 }))
    y += 17
    parts.push(txt(x0, y, `SWR ${fmt(mk.swr)}`, { size: 10.5, fill: zone(mk.swr), weight: 700 }))
    parts.push(txt(x0 + 78, y, `RL ${(mk.rl ?? 0).toFixed(1)} dB  |Γ| ${Math.hypot(q[0], q[1]).toFixed(3)}`, { size: 10, fill: LABEL }))
  }
  if (prim) {
    // Frequency colour bar with the band's stretch boxed (902–928 on the mesh sweep).
    parts.push(txt(x0, (y += 14), 'FREQUENCY', { size: 9, spacing: 1.5, weight: 700 }))
    const fx = (f: number) => x0 + tOf(f) * pw
    y += 7
    parts.push(`<rect x="${x0}" y="${y}" width="${pw}" height="8" rx="4" fill="url(#fq)"/>`)
    if (sb && fr.hi > blo && fr.lo < bhi) {
      const a = fx(Math.max(blo, fr.lo))
      const b = fx(Math.min(bhi, fr.hi))
      parts.push(`<rect x="${n1(a)}" y="${y - 3}" width="${n1(Math.max(2, b - a))}" height="14" rx="3" fill="none" stroke="${BRIGHT}" stroke-width="1.3"/>`)
      parts.push(txt((a + b) / 2, y - 6, `${Number(blo.toFixed(2))}–${Number(bhi.toFixed(2))}`, { anchor: 'middle', size: 8.5, fill: BRIGHT, weight: 700 }))
    }
    y += 22
    parts.push(txt(x0, y, `${Number(fr.lo.toFixed(1))}`, { size: 9.5 }))
    parts.push(txt(x0 + pw, y, `${Number(fr.hi.toFixed(1))} MHz`, { size: 9.5, anchor: 'end' }))
    const m = prim.metrics
    const hm = prim.isLive && m ? heroMarks(m) : null
    if (hm && hm.who) {
      reading(hm.mt, `${hm.names[0]} · ${hm.mt.mhz} MHz`, true)
      if (hm.mc) reading(hm.mc, `${hm.names[1]} · ${hm.mc.mhz} MHz`, false)
    } else if (m) {
      reading(m.meshtastic, `MESHTASTIC · ${m.meshtastic?.mhz ?? 906.875} MHz`, true)
      reading(m.meshcore, `MESHCORE · ${m.meshcore?.mhz ?? 910.525} MHz`, false)
    }
  } else {
    // A/B or overlays: each one's impedance at 906.875.
    for (const s of series.slice(0, 4)) reading(s.metrics?.meshtastic, `${cut(s.label, c ? 34 : 24).toUpperCase()} · 906.875`, false, s.color)
  }
  // What the circles mean.
  y = c ? y + 28 : Math.max(y + 28, 336)
  const key: [string, string][] = [
    [`<circle r="6" fill="${GREEN}" fill-opacity="0.25" stroke="${GREEN}" stroke-dasharray="2 2"/>`, 'inside green: SWR under 1.5'],
    [`<circle r="6" fill="${AMBER}" fill-opacity="0.18" stroke="${AMBER}" stroke-dasharray="3 2"/>`, 'inside amber: SWR under 2'],
    [`<circle r="5" fill="none" stroke="${BRIGHT}"/><circle r="1.6" fill="${BRIGHT}"/>`, 'centre: 50 Ω, a perfect match'],
  ]
  for (const [icon, lab] of key) {
    parts.push(`<g transform="translate(${x0 + 6},${y - 3.5})">${icon}</g>`)
    parts.push(txt(x0 + 18, y, lab, { size: 9.5, fill: LABEL }))
    y += 17
  }
  if (series.length > 1 && prim) {
    y += 6
    for (const s of series) {
      if (s === prim) parts.push(`<rect x="${x0}" y="${y - 5}" width="14" height="3" rx="1.5" fill="url(#fq)"/>`)
      else parts.push(`<path d="M${x0},${y - 3.5}h14" stroke="${s.color}" stroke-width="2.6"/>`)
      parts.push(txt(x0 + 20, y, cut(s.label, c ? 40 : 26), { size: 9.5, fill: LABEL }))
      y += 15
    }
  }
  const H = c ? y + 8 : Math.max(448, y + 10)
  parts[card] = `<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`
  if (!c) parts.push(txt(14, H - 14, '▼ capacitive (−jX)', { size: 9.5, fill: SKY, weight: 700 }))
  return svgDoc(W, H, parts.join(''))
}

function chart(v: View, series: Series[], g: Geo, compare = false): string {
  return v === 'rl' ? rlChart(series, g, compare) : v === 'rx' ? rxChart(series, g, compare) : v === 'smith' ? smithChart(series, g, compare) : swrChart(series, g, compare)
}

// ---------------------------------------------------------------- the hero: an LCD and an SWR meter

const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' }

function segPolys(x: number, y: number, w: number, h: number, t: number): Record<string, string> {
  const g = t * 0.2
  const P = (pts: number[][]) => pts.map(([a, b]) => `${n1(a ?? 0)},${n1(b ?? 0)}`).join(' ')
  const hs = (yy: number, x0: number, x1: number) =>
    P([
      [x0 + t / 2 + g, yy],
      [x0 + t + g, yy - t / 2],
      [x1 - t - g, yy - t / 2],
      [x1 - t / 2 - g, yy],
      [x1 - t - g, yy + t / 2],
      [x0 + t + g, yy + t / 2],
    ])
  const vs = (xx: number, y0: number, y1: number) =>
    P([
      [xx, y0 + t / 2 + g],
      [xx + t / 2, y0 + t + g],
      [xx + t / 2, y1 - t - g],
      [xx, y1 - t / 2 - g],
      [xx - t / 2, y1 - t - g],
      [xx - t / 2, y0 + t + g],
    ])
  return {
    a: hs(y + t / 2, x, x + w),
    g: hs(y + h / 2, x, x + w),
    d: hs(y + h - t / 2, x, x + w),
    f: vs(x + t / 2, y, y + h / 2),
    b: vs(x + w - t / 2, y, y + h / 2),
    e: vs(x + t / 2, y + h / 2, y + h),
    c: vs(x + w - t / 2, y + h / 2, y + h),
  }
}

// A number on 7-segment digits: every segment a faint ghost, as a real LCD shows, the lit ones glowing.
// Returns where the digits end.
function lcdNumber(parts: string[], text: string, x: number, y: number, w: number, h: number, gap: number, col: string): number {
  const lit: string[] = []
  const ghost: string[] = []
  let dx = x
  for (const ch of text) {
    if (ch === '.') {
      const ds = Math.max(4.5, w * 0.17)
      lit.push(`<rect x="${n1(dx - gap * 0.3)}" y="${n1(y + h - ds)}" width="${n1(ds)}" height="${n1(ds)}" rx="1.2"/>`)
      dx += ds + gap * 0.3
      continue
    }
    const t = Math.max(3, w * 0.19)
    const segs = segPolys(dx, y, w, h, t)
    const on = SEG[ch] ?? ''
    for (const [k, pts] of Object.entries(segs)) {
      ghost.push(`<polygon points="${pts}"/>`)
      if (on.includes(k)) lit.push(`<polygon points="${pts}"/>`)
    }
    dx += w + gap
  }
  const skew = `transform="translate(${n1((y + h / 2) * 0.105)},0) skewX(-6)"`
  parts.push(`<g ${skew} fill="${LCD}" fill-opacity="0.07">${ghost.join('')}</g>`)
  parts.push(`<g ${skew} fill="${col}" filter="url(#seg)">${lit.join('')}</g>`)
  return dx
}

// "1.36" with a ghost tens digit, as an LCD pads it.
function lcdText(swr: number | undefined): string {
  if (swr === undefined) return ' -.--'
  return swr >= 9.995 ? ' 9.99' : ` ${swr.toFixed(2)}`
}

// The meter's scale runs in |Γ| to SWR 4, as a real SWR meter's does.
const G_FULL = 0.6
function needleAngle(swr: number): number {
  return Math.PI * (1 - Math.min(gam(swr), G_FULL) / G_FULL)
}

function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M${n1(x0)},${n1(y0)}A${r},${r} 0 ${Math.abs(a0 - a1) > Math.PI ? 1 : 0} 1 ${n1(x1)},${n1(y1)}`
}

function meter(parts: string[], cx: number, cy: number, r: number, mt: Mark, mc: Mark | undefined): void {
  parts.push(`<path d="${arc(cx, cy, r, Math.PI, 0)}" fill="none" stroke="#132026" stroke-width="20" stroke-linecap="round"/>`)
  for (const [s0, s1, col] of [
    [1, 1.5, GREEN],
    [1.5, 2, AMBER],
    [2, 4, RED],
  ] as [number, number, string][]) {
    parts.push(`<path d="${arc(cx, cy, r, needleAngle(s0), needleAngle(s1))}" fill="none" stroke="${col}" stroke-width="9" stroke-opacity="0.9" filter="url(#glow)"/>`)
  }
  const ticks: string[] = []
  for (const s of [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5, 2.75, 3, 3.5, 4]) {
    const major = [1, 1.2, 1.5, 2, 2.5, 3, 4].includes(s)
    const a = needleAngle(s)
    const [x1, y1] = polar(cx, cy, r - 8, a)
    const [x2, y2] = polar(cx, cy, r - (major ? 19 : 14), a)
    ticks.push(`M${n1(x1)},${n1(y1)}L${n1(x2)},${n1(y2)}`)
    if (major) {
      const [lx, ly] = polar(cx, cy, r + 17, a)
      parts.push(txt(lx, ly + 4, String(s), { anchor: 'middle', size: 10, fill: s === 1.5 ? GREEN : s === 2 ? AMBER : AXIS, weight: s === 1.5 || s === 2 ? 700 : undefined }))
    }
  }
  parts.push(`<path d="${ticks.join('')}" stroke="${LABEL}" stroke-opacity="0.55" stroke-width="1.2"/>`)
  parts.push(txt(cx, cy - r * 0.42, 'SWR', { anchor: 'middle', size: 10, spacing: 2, fill: AXIS, weight: 700 }))
  // MeshCore: a thin teal needle; Meshtastic: the bright one.
  const needle = (swr: number, len: number, wid: number, col: string, op: number) => {
    const a = needleAngle(swr)
    const [tx, ty] = polar(cx, cy, len, a)
    const [l1, l2] = polar(cx, cy, wid, a + Math.PI / 2)
    const [r1, r2] = polar(cx, cy, wid, a - Math.PI / 2)
    const [bx, by] = polar(cx, cy, 14, a + Math.PI)
    parts.push(`<path d="M${n1(tx)},${n1(ty)}L${n1(l1)},${n1(l2)}L${n1(bx)},${n1(by)}L${n1(r1)},${n1(r2)}Z" fill="${col}" fill-opacity="${op}" filter="url(#glow)"/>`)
  }
  if (mc) needle(mc.swr, r - 26, 2.2, LCD, 0.75)
  needle(mt.swr, r - 6, 3.2, BRIGHT, 1)
  parts.push(`<circle cx="${cx}" cy="${cy}" r="8" fill="#1b2a30" stroke="${LCD}" stroke-opacity="0.6"/><circle cx="${cx}" cy="${cy}" r="2.6" fill="${BRIGHT}"/>`)
  const lg = mc ? [`▬ ${mt.name ?? 'Meshtastic'}`, `▬ ${mc.name ?? 'MeshCore'}`] : [`▬ ${mt.name ?? 'Meshtastic'}`]
  parts.push(txt(cx - (mc ? 6 : 0), cy + 22, lg[0] ?? '', { anchor: mc ? 'end' : 'middle', size: 9.5, fill: BRIGHT }))
  if (mc) parts.push(txt(cx + 6, cy + 22, lg[1] ?? '', { anchor: 'start', size: 9.5, fill: LCD }))
}

function annunciators(parts: string[], x: number, y: number, maxX: number, c: boolean): void {
  const cs = calStatus()
  const bd = activeBand()
  const ann: [string, boolean, string][] = [
    ['LIVE', !!live?.connected && liveOn, GREEN],
    [cs.tag, true, cs.ok ? LCD : AMBER],
    [live?.via === 'wifi' ? 'WIFI' : 'USB', !!live?.connected, LCD],
    [bd && bd.id !== 'mesh' ? `${bd.short.toUpperCase()}${typeof live?.slot === 'number' ? ` S${live.slot}` : ''}` : '902–928', true, LCD],
    ['QC', qcOn, AMBER],
  ]
  let ax = x
  for (const [s, on, col] of ann) {
    const w = tw(s, 10) + 12
    if (ax + w > maxX) break
    parts.push(`<rect x="${n1(ax)}" y="${y}" width="${n1(w)}" height="16" rx="3" fill="${on ? col : 'none'}" fill-opacity="${on ? 0.12 : 0}" stroke="${col}" stroke-opacity="${on ? 0.75 : 0.14}"/>`)
    parts.push(txt(ax + w / 2, y + 12, s, { anchor: 'middle', size: 10, weight: 700, fill: col, opacity: on ? 1 : 0.18 }))
    ax += w + 6
  }
  void c
}

// The words for a band's grade: "Great match for 2 m ham".
function bandVerdict(swr: number, who: string): string {
  const g = grade(swr)
  return g === 'A' ? `Great match for ${who}` : g === 'B' ? `Good match for ${who}` : g === 'C' ? `So-so match for ${who}: worth a trim or a better antenna` : `Poor match for ${who}: check the plug, then the antenna`
}

function heroSvg(m: Metrics, g: Geo): string {
  const c = g.c
  const W = g.W
  const hm = heroMarks(m) ?? { mt: m.meshtastic as Mark, mc: m.meshcore, names: ['MESHTASTIC', 'MESHCORE'] as [string, string], who: '' }
  const mt = hm.mt
  const mc = hm.mc
  const worst = Math.max(mt.swr, mc?.swr ?? 0)
  const gr = hm.who ? grade(worst) : gradeOf(m) ?? 'F'
  const gcol = GRADE_COLOR[gr]
  const vline = hm.who ? bandVerdict(worst, hm.who) : verdictLine(m)
  const detail = `${meaning(mt.swr)} · ${fmt(mt.mismatchDb, 2)} dB mismatch loss · return loss ${(mt.rl ?? 0).toFixed(1)} dB · Z ${zText(mt.z)}`
  const vl = c ? wrapText(vline, 40) : [vline]
  const dl = c ? wrapText(detail, 54) : [detail]
  const H = c ? 412 + vl.length * 19 + dl.length * 15 : 300
  const parts: string[] = []
  parts.push(
    `<defs><linearGradient id="glass" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0d1c1f"/><stop offset="0.55" stop-color="#081214"/><stop offset="1" stop-color="#060d0f"/></linearGradient>` +
      `${glowDef('seg', W, H, 2.4)}${glowDef('glow', W, H, 1.8)}${glowDef('big', W, H, 4)}</defs>`,
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="#0b1012"/>`)
  parts.push(`<rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="10" fill="url(#glass)" stroke="#1f3a40" stroke-width="1.2"/>`)
  parts.push(`<rect x="9" y="9" width="${W - 18}" height="${n1((H - 18) * 0.36)}" rx="9" fill="#ffffff" fill-opacity="0.022"/>`)
  annunciators(parts, 20, 18, c ? W - 16 : W - 210, c)
  if (!c) parts.push(txt(W - 22, 30, `${(live?.board ?? 'NanoVNA').toUpperCase()} · ${live?.version ?? ''}`.trim(), { anchor: 'end', size: 9.5, fill: LCD, opacity: 0.55, weight: 700, spacing: 0.6 }))
  // The Meshtastic reading, big; MeshCore under it.
  const big = c ? { y: 72, w: 33, h: 62, gap: 8 } : { y: 74, w: 44, h: 80, gap: 10 }
  parts.push(txt(22, big.y - 10, `${hm.names[0]} · ${mt.mhz} MHz`, { size: c ? 10 : 10.5, fill: LCD, weight: 700, spacing: 1, opacity: 0.85 }))
  let ex = lcdNumber(parts, lcdText(mt.swr), 22, big.y, big.w, big.h, big.gap, zone(mt.swr))
  parts.push(txt(ex + 4, big.y + big.h - 2, ':1', { size: c ? 16 : 18, weight: 700, fill: zone(mt.swr), opacity: 0.85 }))
  const sy = big.y + big.h + (c ? 34 : 36)
  if (mc) {
    parts.push(txt(22, sy - 9, `${hm.names[1]} · ${mc.mhz} MHz`, { size: 10, fill: LCD, weight: 700, spacing: 1, opacity: 0.7 }))
    ex = lcdNumber(parts, lcdText(mc.swr), 22, sy, c ? 16 : 18, c ? 30 : 33, c ? 5 : 6, zone(mc.swr))
    parts.push(txt(ex + 3, sy + (c ? 29 : 32), ':1', { size: 12, weight: 700, fill: zone(mc.swr), opacity: 0.85 }))
    parts.push(txt(ex + 26, sy + (c ? 13 : 14), `RL ${(mc.rl ?? 0).toFixed(1)} dB`, { size: 10, fill: LABEL }))
    parts.push(txt(ex + 26, sy + (c ? 28 : 30), zText(mc.z), { size: 10, fill: AXIS }))
  }
  // The grade.
  const gx = c ? W - 92 : W - 98
  const gy = c ? 58 : 56
  parts.push(`<rect x="${gx}" y="${gy}" width="72" height="80" rx="14" fill="${gcol}" fill-opacity="0.12" stroke="${gcol}" stroke-opacity="0.8" stroke-width="1.6"/>`)
  parts.push(`<g filter="url(#big)">${txt(gx + 36, gy + 62, gr, { anchor: 'middle', size: 58, weight: 800, fill: gcol, font: SANS })}</g>`)
  parts.push(txt(gx + 36, gy + 98, 'GRADE', { anchor: 'middle', size: 10, spacing: 2.5, fill: AXIS, weight: 700 }))
  // The meter.
  if (c) meter(parts, W / 2, 344, 112, mt, mc)
  else meter(parts, 452, 206, 100, mt, mc)
  // The verdict.
  const dy = c ? 382 : H - 60
  parts.push(`<line x1="22" x2="${W - 22}" y1="${dy}" y2="${dy}" stroke="#1f3a40"/>`)
  let ty = dy + (c ? 24 : 26)
  parts.push(`<circle cx="28" cy="${ty - 5}" r="5" fill="${gcol}" filter="url(#glow)"/>`)
  for (const l of vl) {
    parts.push(txt(42, ty, l, { size: c ? 14 : 15.5, weight: 700, fill: gcol, font: SANS }))
    ty += 19
  }
  ty += c ? -2 : 0
  for (const l of dl) {
    parts.push(txt(22, ty, l, { size: 11, fill: LABEL, font: SANS, opacity: 0.85 }))
    ty += 15
  }
  return svgDoc(W, H, parts.join(''))
}

// ---------------------------------------------------------------- the trimming drawing

type Trim = { kind: 'cut' | 'add' | 'on' | 'anti' | 'short' | 'long'; head: string; sub: string; col: string; f: number | null; target: number | null; off: number | null }

function trimOf(res: Resonance, lo: number, hi: number): Trim {
  if (!res.mhz) {
    const short = res.xSign === 'negative'
    const cl = res.closest
    return {
      kind: short ? 'short' : 'long',
      head: short ? `Reads short: no resonance up to ${hi} MHz` : `Reads long: no resonance down to ${lo} MHz`,
      sub: `X stays ${short ? 'capacitive' : 'inductive'}${cl ? ` (closest to 0: ${cl.x >= 0 ? '+' : '−'}${Math.abs(cl.x).toFixed(1)} Ω at ${cl.mhz.toFixed(1)} MHz)` : ''}. A plain whip reading this way is ${short ? 'too short' : 'too long'}; a matched antenna often does and is fine.`,
      col: AMBER,
      f: null,
      target: null,
      off: null,
    }
  }
  if (res.kind && res.kind !== 'series') {
    return { kind: 'anti', head: `Anti-resonance at ${res.mhz.toFixed(1)} MHz`, sub: 'R peaks there: not the series resonance a whip has, so there is no trimming hint.', col: AXIS, f: res.mhz, target: null, off: null }
  }
  if (res.trim === 'on' || (res.mhz >= 905.875 && res.mhz <= 911.525)) {
    return { kind: 'on', head: `On frequency: resonant at ${res.mhz.toFixed(1)} MHz`, sub: 'Right on the mesh channels (906.875 and 910.525). Leave the length alone.', col: GREEN, f: res.mhz, target: null, off: 0 }
  }
  const below = res.mhz < 906.875
  const target = below ? 906.875 : 910.525
  const pct = Math.abs(1 - res.mhz / target) * 100
  const qw = quarterWave(target)
  const mm = (pct / 100) * qw
  const size = pct < 3 ? 'Slightly' : 'Noticeably'
  return below
    ? {
        kind: 'cut',
        head: `${size} long: cut ~${mm.toFixed(1)} mm`,
        sub: `Resonant at ${res.mhz.toFixed(1)} MHz, ${(target - res.mhz).toFixed(1)} MHz below ${target}: about ${pct.toFixed(1)}% shorter (≈${mm.toFixed(1)} mm on a ${qw.toFixed(0)} mm quarter-wave whip) moves it up to ${target}.`,
        col: AMBER,
        f: res.mhz,
        target,
        off: res.mhz - target,
      }
    : {
        kind: 'add',
        head: `${size} short by ~${mm.toFixed(1)} mm`,
        sub: `Resonant at ${res.mhz.toFixed(1)} MHz, ${(res.mhz - target).toFixed(1)} MHz above ${target}: about ${pct.toFixed(1)}% longer (≈${mm.toFixed(1)} mm on a ${qw.toFixed(0)} mm quarter-wave whip) moves it down to ${target}.`,
        col: AMBER,
        f: res.mhz,
        target,
        off: res.mhz - target,
      }
}

// A whip on its SMA plug, drawn bigger than life, with what to do to it.
function whip(parts: string[], x: number, base: number, t: Trim, k: number): void {
  const ideal = base - 92 * k
  const tip = t.kind === 'cut' || t.kind === 'long' ? ideal - 20 * k : t.kind === 'add' || t.kind === 'short' ? ideal + 22 * k : ideal
  // Waves off the tip.
  for (const r of [9, 15, 21]) {
    const op = (0.55 - r / 50).toFixed(2)
    parts.push(`<path d="${arc(x, tip + 3, r * k, Math.PI * 0.28, -Math.PI * 0.28)}${arc(x, tip + 3, r * k, Math.PI * 1.28, Math.PI * 0.72)}" fill="none" stroke="${LCD}" stroke-opacity="${op}" stroke-width="1.3" stroke-linecap="round"/>`)
  }
  // Plug, boot and whip.
  parts.push(`<rect x="${n1(x - 15 * k)}" y="${n1(base - 14 * k)}" width="${n1(30 * k)}" height="${n1(14 * k)}" rx="2" fill="url(#nut)" stroke="#6f8790" stroke-width="0.8"/>`)
  parts.push(`<path d="M${n1(x - 9 * k)},${n1(base - 14 * k)}V${n1(base - 36 * k)}Q${n1(x - 9 * k)},${n1(base - 44 * k)} ${n1(x - 3 * k)},${n1(base - 46 * k)}H${n1(x + 3 * k)}Q${n1(x + 9 * k)},${n1(base - 44 * k)} ${n1(x + 9 * k)},${n1(base - 36 * k)}V${n1(base - 14 * k)}Z" fill="#26343a" stroke="#3c4f56"/>`)
  parts.push(`<rect x="${n1(x - 3 * k)}" y="${n1(tip)}" width="${n1(6 * k)}" height="${n1(base - 46 * k - tip)}" rx="${n1(3 * k)}" fill="url(#rod)"/>`)
  if (t.kind === 'cut' || t.kind === 'long') {
    parts.push(`<rect x="${n1(x - 3.6 * k)}" y="${n1(tip - 1)}" width="${n1(7.2 * k)}" height="${n1(ideal - tip + 1)}" rx="${n1(3 * k)}" fill="${t.col}" fill-opacity="0.85" filter="url(#glow)"/>`)
    parts.push(`<line x1="${n1(x - 20 * k)}" x2="${n1(x + 20 * k)}" y1="${n1(ideal)}" y2="${n1(ideal)}" stroke="${t.col}" stroke-width="1.6" stroke-dasharray="4 3"/>`)
    parts.push(txt(x + 23 * k, ideal + 5, t.kind === 'cut' ? '✂' : '?', { size: 15 * k, fill: t.col, font: SANS, weight: 700 }))
    parts.push(`<path d="M${n1(x - 26 * k)},${n1(tip + 2)}V${n1(ideal - 6)}m-4,-6l4,6l4,-6" fill="none" stroke="${t.col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
  } else if (t.kind === 'add' || t.kind === 'short') {
    parts.push(`<rect x="${n1(x - 3 * k)}" y="${n1(ideal)}" width="${n1(6 * k)}" height="${n1(tip - ideal)}" rx="${n1(3 * k)}" fill="none" stroke="${t.col}" stroke-width="1.4" stroke-dasharray="3 2.5"/>`)
    parts.push(`<path d="M${n1(x - 24 * k)},${n1(tip + 4)}V${n1(ideal + 4)}m-4,6l4,-6l4,6" fill="none" stroke="${t.col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
    parts.push(txt(x + 10 * k, ideal + 8, t.kind === 'add' ? '+' : '?', { size: 15 * k, fill: t.col, font: SANS, weight: 700 }))
  } else if (t.kind === 'on') {
    parts.push(`<circle cx="${x}" cy="${n1(tip - 12 * k)}" r="${n1(8 * k)}" fill="${GREEN}" fill-opacity="0.18" stroke="${GREEN}" filter="url(#glow)"/>`)
    parts.push(`<path d="M${n1(x - 4 * k)},${n1(tip - 12 * k)}l${n1(3 * k)},${n1(3 * k)}l${n1(5 * k)},${n1(-6 * k)}" fill="none" stroke="${GREEN}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`)
  }
}

// Where the resonance sits against the mesh channels, on a ruler.
function ruler(parts: string[], x0: number, x1: number, y: number, t: Trim, lo: number, hi: number, c: boolean): void {
  const f = t.f
  let a = Math.min(906.875, f ?? 906.875) - 7
  let b = Math.max(910.525, f ?? 910.525) + 7
  if (!f && t.kind === 'short') b = Math.max(b, 930)
  if (!f && t.kind === 'long') a = Math.min(a, 888)
  if (b - a < 34) {
    const m = (a + b) / 2
    a = m - 17
    b = m + 17
  }
  const x = (v: number) => x0 + ((v - a) / (b - a)) * (x1 - x0)
  parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#2c3d44" stroke-width="2" stroke-linecap="round"/>`)
  const step = niceStep(b - a, c ? 4 : 7)
  for (let v = Math.ceil(a / step) * step; v <= b; v += step) {
    parts.push(`<line x1="${n1(x(v))}" x2="${n1(x(v))}" y1="${y - 3}" y2="${y + 3}" stroke="#3c5058"/>`)
    parts.push(txt(x(v), y + 15, `${Number(v.toFixed(1))}`, { anchor: 'middle', size: 9 }))
  }
  parts.push(`<rect x="${n1(x(906.875))}" y="${y - 5}" width="${n1(x(910.525) - x(906.875))}" height="10" rx="2" fill="${GREEN}" fill-opacity="0.3" stroke="${GREEN}" stroke-opacity="0.8"/>`)
  parts.push(txt((x(906.875) + x(910.525)) / 2, y - 9, 'mesh', { anchor: 'middle', size: 9, fill: GREEN, weight: 700 }))
  const col = t.kind === 'on' ? GREEN : t.kind === 'anti' ? AXIS : YELLOW
  if (f) {
    const fx = x(f)
    parts.push(`<path d="M${n1(fx)},${y - 7}l6,7l-6,7l-6,-7z" fill="${col}" filter="url(#glow)"/>`)
    if (t.kind !== 'on') parts.push(txt(fx, y - 12, `${f.toFixed(1)}`, { anchor: 'middle', size: 10, fill: col, weight: 700 }))
    if (t.target && t.off) {
      const tx = x(t.target)
      const dir = tx > fx ? 1 : -1
      const ay = y - 26
      parts.push(`<path d="M${n1(fx)},${ay}H${n1(tx - dir * 2)}m${-dir * 6},-4l${dir * 6},4l${-dir * 6},4" fill="none" stroke="${t.col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
      parts.push(txt((fx + tx) / 2, ay - 5, `${Math.abs(t.off).toFixed(1)} MHz`, { anchor: 'middle', size: 9.5, fill: t.col, weight: 700 }))
    }
  } else {
    const edge = t.kind === 'short' ? x1 : x0
    const dir = t.kind === 'short' ? 1 : -1
    parts.push(`<path d="M${n1(edge - dir * 40)},${y - 22}H${n1(edge)}m${-dir * 6},-4l${dir * 6},4l${-dir * 6},4" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
    parts.push(txt(edge - dir * 4, y - 30, t.kind === 'short' ? `above ${hi}?` : `below ${lo}?`, { anchor: t.kind === 'short' ? 'end' : 'start', size: 9.5, fill: col, weight: 700 }))
  }
}

function trimSvg(res: Resonance, g: Geo): string {
  const c = g.c
  const W = g.W
  const lo = live?.sweep ? live.sweep.start / 1e6 : 850
  const hi = live?.sweep ? live.sweep.stop / 1e6 : 980
  const t = trimOf(res, lo, hi)
  const tx = c ? 84 : 140
  const sub = wrapText(t.sub, c ? 40 : 82)
  const head = c ? wrapText(t.head, 30) : [t.head]
  const textEnd = 30 + head.length * 19 + sub.length * 15
  const H = c ? Math.max(textEnd + 70, 196) : Math.max(146, textEnd + 52)
  const parts: string[] = []
  parts.push(
    `<defs>${glowDef('glow', W, H, 2)}<linearGradient id="rod" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#7f9199"/><stop offset="0.45" stop-color="#e6edf0"/><stop offset="1" stop-color="#5d6f77"/></linearGradient>` +
      `<linearGradient id="nut" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#8a6a2c"/><stop offset="0.5" stop-color="#e3c26a"/><stop offset="1" stop-color="#8a6a2c"/></linearGradient></defs>`,
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(`<rect x="0" y="12" width="4" height="${H - 24}" rx="2" fill="${t.col}"/>`)
  whip(parts, c ? 44 : 70, c ? 150 : H - 12, t, c ? 0.95 : 1)
  let y = 30
  for (const l of head) {
    parts.push(txt(tx, y, l, { size: c ? 14.5 : 16, weight: 700, fill: t.col, font: SANS }))
    y += 19
  }
  y += 1
  for (const l of sub) {
    parts.push(txt(tx, y, l, { size: 11, fill: LABEL, font: SANS, opacity: 0.9 }))
    y += 15
  }
  ruler(parts, c ? 22 : tx + 6, W - 24, H - 26, t, lo, hi, c)
  if (!c) parts.push(txt(W - 16, 22, 'TRIM · SIMPLE WHIP', { anchor: 'end', size: 9, spacing: 1.5, fill: AXIS, weight: 700 }))
  return svgDoc(W, H, parts.join(''))
}

function trimAlt(res: Resonance): string {
  const t = trimOf(res, live?.sweep ? live.sweep.start / 1e6 : 850, live?.sweep ? live.sweep.stop / 1e6 : 980)
  return `Trimming hint: ${t.head}. ${t.sub}`
}

// ---------------------------------------------------------------- antenna cards

// Where an antenna resonates against 915 MHz, and what that means for the mesh channels.
function resWords(m: Metrics | null): { text: string; color: string } {
  const r = m?.resonance
  if (!r) return { text: 'no reactance in this sweep', color: AXIS }
  if (!r.mhz) return { text: `no resonance in the sweep · reads ${r.xSign === 'negative' ? 'short' : 'long'}`, color: AMBER }
  if (r.kind && r.kind !== 'series') return { text: `anti-resonance at ${r.mhz.toFixed(1)} MHz`, color: AXIS }
  const d = r.mhz - 915
  const where = Math.abs(d) < 0.5 ? 'resonant on 915' : `resonant ${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0)} MHz ${d < 0 ? 'low' : 'high'}`
  if (r.mhz >= 905.875 && r.mhz <= 911.525) return { text: `${where} · on the mesh channels`, color: GREEN }
  const target = r.mhz < 906.875 ? 906.875 : 910.525
  const mm = Math.abs(1 - r.mhz / target) * quarterWave(target)
  return { text: `${where} · ${r.mhz < target ? `trim ~${mm.toFixed(1)} mm` : `~${mm.toFixed(1)} mm short`}`, color: AMBER }
}

// The band a saved sweep was taken on (by its range), for the card's subtitle.
function itemBand(i: Item): BandDef | null {
  const lo = i.curve[0]?.[0]
  const hi = i.curve[i.curve.length - 1]?.[0]
  if (lo === undefined || hi === undefined) return null
  return bandsAll().find(b => Math.abs(b.start / 1e6 - lo) < 0.01 && Math.abs(b.stop / 1e6 - hi) < 0.01) ?? null
}

// One antenna as a card in its own colour (the colour its trace has on every chart): a tinted
// header, a colour bar on the left and its swatch by the name; the grade and the sparkline keep
// the zone colours. on: drawn on the chart now, or its history shown.
function cardSvg(gr: Group, g: Geo, on?: 'chart' | 'history'): string {
  const W = g.c ? W_PHONE : 322
  const H = 134
  const i = gr.latest
  const m = i.metrics
  const grd = gradeOf(m) ?? 'F'
  const gc = GRADE_COLOR[grd]
  const ac = antColor(gr.label)
  const sx0 = 14
  const sx1 = W - 118
  const sy0 = 62
  const sy1 = 104
  const cap = 3
  const curve = i.curve
  const lo = curve[0]?.[0] ?? 850
  const hi = curve[curve.length - 1]?.[0] ?? 980
  const x = (f: number) => sx0 + ((f - lo) / (hi - lo || 1)) * (sx1 - sx0)
  const y = (s: number) => sy0 + (1 - Math.min(gam(s), gam(cap)) / gam(cap)) * (sy1 - sy0)
  const parts: string[] = []
  parts.push(
    `<defs>${glowDef('glow', W, H, 1.6)}${zoneGrad('zs', sy0, sy1, y(2), y(1.5))}${zoneCols('zf', sx0, sx1, curve, x)}${fadeMask('fade', W, H, sy0, sy1, 0.7, 0.1)}<clipPath id="sp"><rect x="${sx0}" y="${sy0}" width="${sx1 - sx0}" height="${sy1 - sy0}" rx="4"/></clipPath>` +
      `<linearGradient id="tint" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${ac}" stop-opacity="${on ? 0.3 : 0.2}"/><stop offset="1" stop-color="${ac}" stop-opacity="0"/></linearGradient></defs>`,
  )
  parts.push(`<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="12" fill="#0f161a"/>`)
  parts.push(`<rect x="0.75" y="0.75" width="${W - 1.5}" height="58" rx="12" fill="url(#tint)"/>`)
  parts.push(`<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="12" fill="none" stroke="${ac}" stroke-opacity="${on ? 1 : 0.45}" stroke-width="${on ? 2.2 : 1.2}"/>`)
  parts.push(`<rect x="0.75" y="14" width="4" height="${H - 28}" rx="2" fill="${ac}"/>`)
  parts.push(`<circle cx="34" cy="34" r="19" fill="${gc}" fill-opacity="0.14" stroke="${gc}" stroke-width="1.6"/>`)
  parts.push(`<g filter="url(#glow)">${txt(34, 42, grd, { anchor: 'middle', size: 22, weight: 800, fill: gc, font: SANS })}</g>`)
  const tr = gr.items.map(it => it.metrics?.meshtastic?.swr).filter((v): v is number => typeof v === 'number')
  const t0 = tr[0]
  const t1 = tr[tr.length - 1]
  const better = t0 !== undefined && t1 !== undefined && t1 < t0 - 0.02
  const worse = t0 !== undefined && t1 !== undefined && t1 > t0 + 0.02
  const trendS = tr.length > 1 && t0 !== undefined && t1 !== undefined ? `${fmt(t0)} → ${fmt(t1)} ${better ? '▼' : worse ? '▲' : '≈'}` : ''
  const nameMax = Math.floor((W - 64 - 14 - (trendS ? tw(trendS, 10) + 14 : 0)) / 7.9)
  parts.push(txt(62, 31, cut(gr.label, nameMax), { size: 14, weight: 700, fill: ac, font: SANS }))
  const ib = itemBand(i)
  const sub = `${gr.items.length > 1 ? `${gr.items.length} versions` : '1 sweep'} · ${day(i.saved)}${ib && ib.id !== 'mesh' ? ` · ${ib.short}` : ''}`
  parts.push(`<path d="M62,${44.5}h14" stroke="${ac}" stroke-width="3" stroke-linecap="round"/>`)
  parts.push(txt(82, 48, on === 'chart' ? `${sub} · on chart` : on === 'history' ? `${sub} · history shown` : sub, { size: 10, fill: on ? ac : AXIS }))
  if (trendS) parts.push(pill(W - 12, 30, trendS, { fill: better ? GREEN : worse ? RED : AXIS, anchor: 'end' }))
  // The sparkline: the whole sweep, the band shaded, coloured by zone.
  parts.push(`<rect x="${sx0}" y="${sy0}" width="${sx1 - sx0}" height="${sy1 - sy0}" rx="4" fill="${PLOT}"/>`)
  const cb = ib ?? chartBand(lo, hi)
  if (cb && hi > cb.band[0] && lo < cb.band[1]) parts.push(`<rect x="${n1(x(Math.max(cb.band[0], lo)))}" y="${sy0}" width="${n1(Math.max(1.5, x(Math.min(cb.band[1], hi)) - x(Math.max(cb.band[0], lo))))}" height="${sy1 - sy0}" fill="${LCD}" fill-opacity="0.1"/>`)
  parts.push(`<line x1="${sx0}" x2="${sx1}" y1="${n1(y(2))}" y2="${n1(y(2))}" stroke="${RED}" stroke-opacity="0.35" stroke-dasharray="3 3"/>`)
  const pts = curve.map((p, k) => `${k ? 'L' : 'M'}${n1(x(p[0]))},${n1(y(p[1]))}`).join('')
  parts.push(`<g clip-path="url(#sp)"><path d="${pts}L${n1(x(hi))},${sy1}L${n1(x(lo))},${sy1}Z" fill="url(#zf)" mask="url(#fade)"/><path d="${pts}" fill="none" stroke="url(#zs)" stroke-width="1.8" stroke-linejoin="round" filter="url(#glow)"/></g>`)
  const mt = m?.meshtastic
  if (mt && mt.mhz >= lo && mt.mhz <= hi) {
    parts.push(`<line x1="${n1(x(mt.mhz))}" x2="${n1(x(mt.mhz))}" y1="${sy0}" y2="${sy1}" stroke="${LCD}" stroke-opacity="0.45" stroke-dasharray="2 2"/>`)
    parts.push(`<circle cx="${n1(x(mt.mhz))}" cy="${n1(y(mt.swr))}" r="3.2" fill="${zone(mt.swr)}" stroke="${PLOT}"/>`)
  }
  parts.push(txt(sx0 + 4, sy1 - 4, `${Number(lo.toFixed(0))}`, { size: 8, fill: AXIS, opacity: 0.8 }))
  parts.push(txt(sx1 - 4, sy1 - 4, `${Number(hi.toFixed(0))}`, { size: 8, fill: AXIS, opacity: 0.8, anchor: 'end' }))
  // The numbers.
  const nx = W - 104
  const row = (yy: number, label: string, v: number | undefined, extra = '') => {
    parts.push(txt(nx, yy, label, { size: 9.5 }))
    parts.push(txt(W - 14, yy, v === undefined ? '—' : `${fmt(v)}${extra}`, { anchor: 'end', size: 11, weight: 700, fill: v === undefined ? AXIS : zone(v) }))
  }
  row(72, '907', m?.meshtastic?.swr)
  row(87, '910.5', m?.meshcore?.swr)
  row(102, 'best', m?.best.swr, m ? ` @${m.best.mhz.toFixed(0)}` : '')
  const rw = resWords(m)
  parts.push(`<path d="M${sx0 + 4},${121}l4,-4l4,4l-4,4z" fill="${rw.color}"/>`)
  parts.push(txt(sx0 + 15, 124.5, cut(rw.text, Math.floor((W - sx0 - 28) / 6.1)), { size: 10, fill: rw.color }))
  return svgDoc(W, H, parts.join(''))
}

function cardAlt(gr: Group): string {
  const m = gr.latest.metrics
  return `${gr.label}: grade ${gradeOf(m) ?? '—'}, SWR ${fmt(m?.meshtastic?.swr)} at 906.875 and ${fmt(m?.meshcore?.swr)} at 910.525, best ${fmt(m?.best.swr)} at ${m?.best.mhz ?? '?'} MHz, ${resWords(m).text}${gr.items.length > 1 ? `, ${gr.items.length} versions (${trend(gr)})` : ''}`
}

// ---------------------------------------------------------------- QC: a stamp and a meter per check

function qcSvg(q: Qc, g: Geo): string {
  const c = g.c
  const W = g.W
  const col = q.pass ? GREEN : RED
  const ROW = 44
  const n = q.checks.filter(k => k.pass).length
  const top = c ? 152 : 34
  const H = c ? top + q.checks.length * ROW + 40 : Math.max(204, top + q.checks.length * ROW + 44)
  const parts: string[] = []
  parts.push(
    `<defs>${glowDef('glow', W, H, 1.8)}${blurDef('soft', W, H, 9)}` +
      `<filter id="grit" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="11" result="n"/>` +
      `<feColorMatrix in="n" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -3.2 2.25" result="m"/><feComposite in="SourceGraphic" in2="m" operator="in"/></filter></defs>`,
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(`<rect x="0" y="12" width="4" height="${H - 24}" rx="2" fill="${col}"/>`)
  // The stamp.
  const sx = c ? W / 2 : 140
  const sy = c ? 80 : H / 2 - 4
  const sw = 222
  const sh = 100
  parts.push(`<g transform="translate(${n1(sx)},${n1(sy)}) rotate(-7)">`)
  parts.push(`<rect x="${-sw / 2 - 4}" y="${-sh / 2 - 4}" width="${sw + 8}" height="${sh + 8}" rx="16" fill="${col}" fill-opacity="0.22" filter="url(#soft)"/>`)
  const ink =
    `<rect x="${-sw / 2}" y="${-sh / 2}" width="${sw}" height="${sh}" rx="13" fill="${col}" fill-opacity="0.1" stroke="${col}" stroke-width="5"/>` +
    `<rect x="${-sw / 2 + 9}" y="${-sh / 2 + 9}" width="${sw - 18}" height="${sh - 18}" rx="8" fill="none" stroke="${col}" stroke-width="1.6"/>` +
    txt(0, 24, q.pass ? 'PASS' : 'FAIL', { anchor: 'middle', size: 60, weight: 900, fill: col, font: SANS, spacing: 7 })
  parts.push(`<g opacity="0.45">${ink}</g><g filter="url(#grit)">${ink}</g>`)
  parts.push(txt(0, -29, 'QC · LIVE VERDICT', { anchor: 'middle', size: 10, weight: 700, fill: col, spacing: 2.5 }))
  parts.push(txt(0, 41, `${n} OF ${q.checks.length} CHECKS`, { anchor: 'middle', size: 9.5, weight: 700, fill: col, spacing: 2 }))
  parts.push('</g>')
  // The checks.
  const x0 = c ? 20 : 286
  if (!c) parts.push(txt(x0, 24, 'CHECKS', { size: 9.5, spacing: 2, weight: 700 }))
  q.checks.forEach((k, j) => {
    const ry = top + j * ROW
    const kc = k.pass ? GREEN : RED
    parts.push(`<circle cx="${x0 + 10}" cy="${ry + 15}" r="10" fill="${kc}" fill-opacity="0.16" stroke="${kc}" stroke-width="1.4"/>`)
    parts.push(
      k.pass
        ? `<path d="M${x0 + 5},${ry + 15}l3.5,3.5l6.5,-7" fill="none" stroke="${kc}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="M${x0 + 6},${ry + 11}l8,8m0,-8l-8,8" fill="none" stroke="${kc}" stroke-width="2" stroke-linecap="round"/>`,
    )
    const band = k.id === 'band'
    const limit = band ? q.rules.bandMax : q.rules.spotMax
    const name = band ? `${q.rules.lo}–${q.rules.hi} MHz band` : `${k.mhz} MHz`
    const who = k.mhz === 906.875 ? 'Meshtastic' : k.mhz === 910.525 ? 'MeshCore' : 'spot check'
    parts.push(txt(x0 + 28, ry + 12, name, { size: 12, weight: 700, fill: BRIGHT, font: SANS }))
    parts.push(txt(x0 + 28, ry + 27, band ? (k.value !== undefined ? `worst at ${k.mhz?.toFixed(1)} MHz` : 'not covered by the sweep') : `${who} · SWR ≤ ${lim(limit)}`, { size: 9.5 }))
    // The meter: SWR 1 at the left, the limit about 60% across.
    const bx0 = c ? x0 + 176 : x0 + 196
    const bx1 = W - 62
    const vmax = limit + (limit - 1) * 0.65
    const bx = (v: number) => bx0 + clamp((v - 1) / (vmax - 1)) * (bx1 - bx0)
    parts.push(`<rect x="${bx0}" y="${ry + 9}" width="${bx1 - bx0}" height="9" rx="4.5" fill="#1a262c"/>`)
    if (k.value !== undefined) {
      const vc = k.pass ? zone(k.value) : RED
      parts.push(`<rect x="${bx0}" y="${ry + 9}" width="${n1(Math.max(9, bx(k.value) - bx0))}" height="9" rx="4.5" fill="${vc}" filter="url(#glow)"/>`)
    }
    parts.push(`<line x1="${n1(bx(limit))}" x2="${n1(bx(limit))}" y1="${ry + 4}" y2="${ry + 23}" stroke="${BRIGHT}" stroke-width="1.6"/>`)
    parts.push(txt(bx(limit), ry + 34, `≤${lim(limit)}`, { anchor: 'middle', size: 8.5, fill: AXIS }))
    parts.push(txt(W - 16, ry + 19, k.value !== undefined ? fmt(k.value) : 'off', { anchor: 'end', size: 14, weight: 700, fill: k.value !== undefined ? (k.pass ? zone(k.value) : RED) : AXIS }))
  })
  // The log so far.
  const fy = H - 14
  const l = qcLog
  parts.push(`<line x1="${c ? 16 : x0}" x2="${W - 16}" y1="${fy - 16}" y2="${fy - 16}" stroke="${GRID}"/>`)
  if (l && l.total) {
    const bw = c ? 80 : 70
    const bxx = c ? 16 : x0
    const pw = (bw * l.passed) / l.total
    parts.push(`<rect x="${bxx}" y="${fy - 8}" width="${bw}" height="7" rx="3.5" fill="${RED}" fill-opacity="0.75"/>`)
    parts.push(`<rect x="${bxx}" y="${fy - 8}" width="${n1(pw)}" height="7" rx="3.5" fill="${GREEN}"/>`)
    parts.push(txt(bxx + bw + 8, fy, `${l.total} tested · ${l.passed} pass · ${l.failed} fail`, { size: 9.5, fill: LABEL }))
  } else parts.push(txt(c ? 16 : x0, fy, 'no units recorded yet', { size: 9.5 }))
  parts.push(txt(W - 16, fy, `next: ${l?.next ?? 'Unit 1'}`, { anchor: 'end', size: 9.5, fill: LCD, weight: 700 }))
  return svgDoc(W, H, parts.join(''))
}

function qcAlt(q: Qc): string {
  return `QC ${q.pass ? 'PASS' : 'FAIL'}: ${q.checks.map(k => `${k.label} ${k.pass ? '✓' : '✗'} (${k.detail})`).join('; ')}`
}


// ---------------------------------------------------------------- QC, worked out in the tab
// The same rule vna.py's qc_eval applies, from the live curve: every session gets its verdict
// from the one shared reading, whatever its own rules.

function qcEvalTs(curve: [number, number][], r: Rules): Qc | undefined {
  if (!curve.length) return undefined
  const first = curve[0] as [number, number]
  const last = curve[curve.length - 1] as [number, number]
  const covered = first[0] <= r.lo + 1e-6 && last[0] >= r.hi - 1e-6
  const checks: QcCheck[] = []
  let worst: { mhz: number; swr: number } | null = null
  const label = `SWR ≤ ${lim(r.bandMax)} across ${r.lo}–${r.hi} MHz`
  if (covered) {
    const band: [number, number][] = curve.filter(p => p[0] >= r.lo && p[0] <= r.hi)
    for (const e of [r.lo, r.hi]) {
      const v = at(curve, e)
      if (v !== undefined) band.push([e, v])
    }
    const w = band.reduce((a, b) => (b[1] > a[1] ? b : a), band[0] as [number, number])
    worst = { mhz: Math.round(w[0] * 100) / 100, swr: Math.round(Math.min(w[1], 99) * 1000) / 1000 }
    const ok = worst.swr <= r.bandMax
    checks.push({ id: 'band', label, pass: ok, value: worst.swr, mhz: worst.mhz, detail: `worst ${worst.swr.toFixed(2)} at ${worst.mhz.toFixed(1)} MHz${ok ? '' : `, over ${lim(r.bandMax)}`}` })
  } else checks.push({ id: 'band', label, pass: false, detail: `the sweep does not cover ${r.lo}–${r.hi} MHz` })
  for (const s of r.spots) {
    const v = at(curve, s)
    const sl = `SWR ≤ ${lim(r.spotMax)} at ${s} MHz`
    if (v === undefined) {
      checks.push({ id: `spot-${s}`, label: sl, pass: false, mhz: s, detail: 'off this sweep' })
      continue
    }
    const val = Math.round(Math.min(v, 99) * 1000) / 1000
    const ok = val <= r.spotMax
    checks.push({ id: `spot-${s}`, label: sl, pass: ok, value: val, mhz: s, detail: `${val.toFixed(2)}${ok ? '' : `, over ${lim(r.spotMax)}`}` })
  }
  const failed = checks.filter(c => !c.pass).map(c => `${c.label}: ${c.detail}`)
  return { pass: !failed.length, rule: ruleText(r), rules: r, checks, worst, covered, failed }
}

// ---------------------------------------------------------------- the trim assistant

// The target the trim assistant aims for on the band being swept: the one picked for this band, else its first.
function trimTarget(): { f: number; name: string } {
  const b = activeBand() ?? MESH_BAND
  const t = b.targets
  const f = trimTargets[b.id] ?? (t[0]?.[0] as number)
  const named = t.find(x => Math.abs(x[0] - f) < 1e-6)
  return { f, name: named ? named[1] : 'your target' }
}

function sweepStep(): number {
  const sw = live?.sweep
  return sw && sw.points > 1 ? (sw.stop - sw.start) / (sw.points - 1) / 1e6 : 0.65
}

// How close counts: on frequency within 0.25% (2.3 MHz at 907) or a sweep step; a reading is steady
// when two in a row agree within 0.15%; a change is logged when the resonance moved 0.4% (3.6 MHz).
function trimTols(f: number): { on: number; steady: number; move: number } {
  const st = sweepStep()
  return { on: Math.max(0.0025 * f, st), steady: Math.max(0.0015 * f, 1.5 * st), move: Math.max(0.004 * f, 3 * st) }
}

// Where the antenna resonates: where X crosses zero going up (a series resonance, the one a whip
// has; the nearest the target when there are several), else the middle of the SWR dip's floor.
function resonanceOf(curve: [number, number][], s11: [number, number][] | undefined, target: number): TrimRead | null {
  const n = curve.length
  if (n < 3) return null
  let k = 0
  for (let i = 1; i < n; i++) if ((curve[i] as [number, number])[1] < (curve[k] as [number, number])[1]) k = i
  const swrMin = (curve[k] as [number, number])[1]
  if (swrMin > 15) return null
  const swrT = at(curve, target)
  if (s11 && s11.length === n) {
    const z = s11.map(g => zOfGamma(g))
    let best: { f: number; r: number } | null = null
    for (let i = 1; i < n; i++) {
      const [r0, x0] = z[i - 1] as [number, number]
      const [r1, x1] = z[i] as [number, number]
      if (!(x0 < 0 && x1 >= 0) || Math.max(Math.abs(x0), Math.abs(x1)) > 2000) continue
      const t = x0 / (x0 - x1)
      const f0 = (curve[i - 1] as [number, number])[0]
      const f1 = (curve[i] as [number, number])[0]
      const f = f0 + t * (f1 - f0)
      if (!best || Math.abs(f - target) < Math.abs(best.f - target)) best = { f, r: r0 + t * (r1 - r0) }
    }
    if (best) return { f: best.f, method: 'X = 0', swrT, swrMin, r: best.r }
  }
  // The dip's floor: the run around the lowest point within a little of it, and its middle.
  const floor = swrMin + Math.max(0.03, 0.1 * (swrMin - 1))
  let a = k
  let b = k
  while (a > 0 && (curve[a - 1] as [number, number])[1] <= floor) a--
  while (b < n - 1 && (curve[b + 1] as [number, number])[1] <= floor) b++
  const f = ((curve[a] as [number, number])[0] + (curve[b] as [number, number])[0]) / 2
  const edge = a === 0 && b < n - 1 ? 'below' : b === n - 1 && a > 0 ? 'above' : undefined
  return { f, method: 'SWR dip', swrT, swrMin, ...(edge ? { edge } : {}) }
}

// Crossed the target: from beyond it on one side to beyond it on the other.
function crossed(d0: number, d1: number, on: number): boolean {
  return (d0 < -on && d1 > on) || (d0 > on && d1 < -on)
}

function trimPush(r: TrimRead, how: TrimPoint['how'], now: number): TrimPoint {
  const t = trimTarget()
  const delta = r.f - t.f
  const last = trimPts[trimPts.length - 1]
  const p: TrimPoint = { ...r, n: (last?.n ?? 0) + 1, at: now, how, delta, target: t.f, ...(last && crossed(last.delta, delta, trimTols(t.f).on) ? { passed: true } : {}) }
  trimPts = [...trimPts, p].slice(-40)
  return p
}

// Each new reading while Trim is looked at: a steady one that moved logs a change.
function trimFeed(now: number): TrimPoint | null {
  const b = activeBand()?.id ?? 'other'
  if (b !== trimBand) {
    trimBand = b
    trimPts = []
    trimRecent = []
  }
  const t = trimTarget()
  const r = live?.connected && live.curve?.length ? resonanceOf(live.curve, live.s11, t.f) : null
  trimLast = r
  trimLastAt = liveAt
  if (!r) {
    trimRecent = []
    return null
  }
  trimRecent = [...trimRecent, r].slice(-3)
  const tol = trimTols(t.f)
  const [p, q] = trimRecent.slice(-2)
  if (!p || !q || Math.abs(p.f - q.f) > tol.steady) return null
  const last = trimPts[trimPts.length - 1]
  if (!last) return trimPush(r, 'start', now)
  if (Math.abs(r.f - last.f) >= tol.move) return trimPush(r, 'auto', now)
  return null
}

function fmtOff(d: number): string {
  const a = Math.abs(d)
  return a >= 10 ? `${a.toFixed(0)} MHz` : a >= 1 ? `${a.toFixed(1)} MHz` : `${Math.round(a * 1000)} kHz`
}

function fmtF(f: number): string {
  return f >= 1000 ? f.toFixed(1) : f >= 200 ? f.toFixed(1) : f.toFixed(2)
}

type TrimWords = { head: string; sub: string; undo: string; col: string; arrow: 'up' | 'down' | 'on' | 'none'; passed: boolean }

// What to do, in plain words: "12 MHz low · cut a little", "closer…", "on frequency ✓", "you passed it".
// The reading Trim shows: the last one fed, else worked out now (a Trim tab drawn before a tick).
function trimNow(): TrimRead | null {
  if (trimLastAt === liveAt && trimLast) return trimLast
  trimLastAt = liveAt
  trimLast = live?.connected && live.curve?.length ? resonanceOf(live.curve, live.s11, trimTarget().f) : null
  return trimLast
}

function trimWords(): TrimWords {
  const t = trimTarget()
  const r = trimNow()
  if (!live?.connected) return { head: 'NanoVNA not connected', sub: 'Plug it in and screw the antenna onto PORT 1.', undo: '', col: AXIS, arrow: 'none', passed: false }
  if (!r) return { head: 'Nothing on PORT 1', sub: 'PORT 1 reads open: screw the antenna on (an RP-SMA antenna needs an adapter).', undo: '', col: AMBER, arrow: 'none', passed: false }
  const tol = trimTols(t.f)
  const d = r.f - t.f
  const low = d < 0
  if (r.edge) {
    return {
      head: r.edge === 'below' ? `Resonates below ${fmtF(live.sweep ? live.sweep.start / 1e6 : r.f)} MHz · much too long` : `Resonates above ${fmtF(live.sweep ? live.sweep.stop / 1e6 : r.f)} MHz · much too short`,
      sub: `The dip is off the edge of the sweep, so the number is only where the sweep ends. ${r.edge === 'below' ? 'Cut in small steps until the dip comes into view.' : 'It needs more length (or a different antenna).'}`,
      undo: '',
      col: RED,
      arrow: r.edge === 'below' ? 'up' : 'down',
      passed: false,
    }
  }
  const swr = r.swrT !== undefined ? ` SWR at ${t.f} is ${fmt(r.swrT)}.` : ''
  if (Math.abs(d) <= tol.on) return { head: 'On frequency ✓', sub: `Resonant ${fmtOff(d)} ${low ? 'below' : 'above'} ${t.f}, inside ±${fmtOff(tol.on)}. Leave it.${swr}`, undo: '', col: GREEN, arrow: 'on', passed: false }
  const pct = (Math.abs(d) / t.f) * 100
  const what = low ? (pct < 0.6 ? 'trim a hair' : pct < 3 ? 'cut a little' : 'cut more') : pct < 0.6 ? 'a hair longer' : pct < 3 ? 'add a little length' : 'add length'
  const last = trimPts[trimPts.length - 1]
  const prev = trimPts[trimPts.length - 2]
  const passed = !!last?.passed && Math.sign(last.delta) === Math.sign(d)
  const closer = !!last && !!prev && !last.passed && Math.abs(last.delta) < Math.abs(prev.delta) - tol.on / 2
  const why = low ? 'Below the target means electrically long: shortening raises it.' : 'Above the target means electrically short: more length lowers it.'
  let head = `${fmtOff(d)} ${low ? 'low' : 'high'} · ${what}`
  let undo = ''
  if (passed && prev) {
    head = `You passed it · now ${fmtOff(d)} ${low ? 'low' : 'high'}`
    undo = low
      ? `It went from ${fmtOff(prev.delta)} high to ${fmtOff(d)} low: that change added too much. Undo: take some back (shorten a touch, or bend it back part way).`
      : `It went from ${fmtOff(prev.delta)} low to ${fmtOff(d)} high: that cut went too far. Undo: lengthen a touch (straighten a bend, solder a short extension or slide a sleeve on the tip), or stop here if the SWR is fine.`
  } else if (closer) head = `closer… ${head}`
  return { head, sub: `${why}${swr}`, undo, col: passed ? RED : pct < 1 ? AMBER : ORANGE, arrow: low ? 'up' : 'down', passed }
}

// A ruler around the target: the on-frequency stretch in green, the logged changes as a trail
// of dots, the reading now as a diamond with an arrow to the target.
function trimRuler(parts: string[], x0: number, x1: number, y: number, c: boolean): void {
  const t = trimTarget()
  const r = trimNow()
  const tol = trimTols(t.f)
  const fs = [t.f, ...(r && !r.edge ? [r.f] : []), ...trimPts.slice(-8).map(p => p.f)]
  let span = Math.max(...fs.map(f => Math.abs(f - t.f))) * 1.25
  span = Math.max(span, tol.on * 4)
  const a = t.f - span
  const b = t.f + span
  const x = (f: number) => x0 + ((f - a) / (b - a)) * (x1 - x0)
  parts.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="#2c3d44" stroke-width="2" stroke-linecap="round"/>`)
  const step = niceStep(b - a, c ? 4 : 8)
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9; v += step) {
    parts.push(`<line x1="${n1(x(v))}" x2="${n1(x(v))}" y1="${y - 3}" y2="${y + 3}" stroke="#3c5058"/>`)
    parts.push(txt(x(v), y + 15, `${Number(v.toFixed(step < 1 ? 2 : 1))}`, { anchor: 'middle', size: 9 }))
  }
  parts.push(`<rect x="${n1(x(t.f - tol.on))}" y="${y - 6}" width="${n1(x(t.f + tol.on) - x(t.f - tol.on))}" height="12" rx="3" fill="${GREEN}" fill-opacity="0.28" stroke="${GREEN}" stroke-opacity="0.8"/>`)
  parts.push(`<line x1="${n1(x(t.f))}" x2="${n1(x(t.f))}" y1="${y - 12}" y2="${y + 6}" stroke="${GREEN}" stroke-width="2"/>`)
  parts.push(txt(x(t.f), y - 16, `target ${t.f}`, { anchor: 'middle', size: 9.5, fill: GREEN, weight: 700 }))
  trimPts.slice(-8).forEach((p, k, all) => {
    const op = 0.25 + (0.5 * (k + 1)) / all.length
    parts.push(`<circle cx="${n1(x(p.f))}" cy="${y}" r="3.2" fill="${p.passed ? RED : SKY}" fill-opacity="${op.toFixed(2)}"/>`)
  })
  if (r && !r.edge) {
    const fx = x(r.f)
    const col = Math.abs(r.f - t.f) <= tol.on ? GREEN : YELLOW
    parts.push(`<path d="M${n1(fx)},${y - 8}l7,8l-7,8l-7,-8z" fill="${col}" filter="url(#glow)"/>`)
    if (Math.abs(r.f - t.f) > tol.on) {
      const tx = x(t.f)
      const dir = tx > fx ? 1 : -1
      const ay = y + 26
      parts.push(`<path d="M${n1(fx)},${ay}H${n1(tx - dir * 2)}m${-dir * 6},-4l${dir * 6},4l${-dir * 6},4" fill="none" stroke="${col}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
  }
}

// An arrow saying which way the resonance has to go, and what that means for the antenna.
function trimArrow(parts: string[], cx: number, cy: number, w: TrimWords, k: number): void {
  if (w.arrow === 'on') {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${34 * k}" fill="${GREEN}" fill-opacity="0.14" stroke="${GREEN}" stroke-width="2.4" filter="url(#glow)"/>`)
    parts.push(`<path d="M${n1(cx - 15 * k)},${cy}l${n1(10 * k)},${n1(11 * k)}l${n1(21 * k)},${n1(-24 * k)}" fill="none" stroke="${GREEN}" stroke-width="${n1(5 * k)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    parts.push(txt(cx, cy + 52 * k, 'ON FREQUENCY', { anchor: 'middle', size: 10, weight: 700, fill: GREEN, spacing: 1.5 }))
    return
  }
  if (w.arrow === 'none') return
  const up = w.arrow === 'up'
  const s = up ? -1 : 1
  const pts = [
    [0, s * 36],
    [24, s * 6],
    [10, s * 6],
    [10, s * -30],
    [-10, s * -30],
    [-10, s * 6],
    [-24, s * 6],
  ]
    .map(([px, py]) => `${n1(cx + (px ?? 0) * k)},${n1(cy - (py ?? 0) * k)}`)
    .join(' ')
  parts.push(`<polygon points="${pts}" fill="${w.col}" fill-opacity="0.85" filter="url(#glow)"/>`)
  parts.push(txt(cx, cy + 54 * k, up ? 'RAISE IT · CUT' : 'LOWER IT · LENGTHEN', { anchor: 'middle', size: 10, weight: 700, fill: w.col, spacing: 1.2 }))
}

// The big live readout: the resonance on LCD digits against the target, the arrow and the verdict.
function trimLiveSvg(g: Geo): string {
  const c = g.c
  const W = g.W
  const t = trimTarget()
  const r = trimNow()
  const w = trimWords()
  const head = wrapText(w.head, c ? 30 : 50)
  const sub = wrapText(w.sub, c ? 50 : 92)
  const undo = w.undo ? wrapText(w.undo, c ? 50 : 92) : []
  const lcdY = c ? 46 : 52
  const dig = c ? { w: 28, h: 54, gap: 6 } : { w: 44, h: 80, gap: 10 }
  const textY = lcdY + dig.h + 24 + 17 + 40
  const H = textY + head.length * 22 + sub.length * 15 + (undo.length ? undo.length * 15 + 8 : 0) + 64
  const parts: string[] = []
  parts.push(
    `<defs><linearGradient id="glass" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0d1c1f"/><stop offset="0.55" stop-color="#081214"/><stop offset="1" stop-color="#060d0f"/></linearGradient>` +
      `${glowDef('seg', W, H, 2.4)}${glowDef('glow', W, H, 1.8)}</defs>`,
  )
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="14" fill="#0b1012"/>`)
  parts.push(`<rect x="7" y="7" width="${W - 14}" height="${H - 14}" rx="10" fill="url(#glass)" stroke="#1f3a40" stroke-width="1.2"/>`)
  parts.push(`<rect x="7" y="7" width="4" height="${H - 14}" rx="2" fill="${w.col}"/>`)
  const method = r ? (r.method === 'X = 0' ? 'WHERE X = 0' : 'THE SWR DIP') : '—'
  parts.push(txt(24, lcdY - 14, `RESONANCE · ${method}`, { size: 10.5, fill: LCD, weight: 700, spacing: 1, opacity: 0.85 }))
  const txtF = r && !r.edge ? fmtF(r.f) : '---.-'
  const on = !!r && !r.edge && Math.abs(r.f - t.f) <= trimTols(t.f).on
  const ex = lcdNumber(parts, txtF.padStart(6, ' '), 22, lcdY, dig.w, dig.h, dig.gap, on ? GREEN : r ? YELLOW : AXIS)
  parts.push(txt(ex + 4, lcdY + dig.h - 2, 'MHz', { size: c ? 14 : 16, weight: 700, fill: on ? GREEN : YELLOW, opacity: 0.85 }))
  const ty = lcdY + dig.h + 24
  const d = r && !r.edge ? r.f - t.f : null
  parts.push(txt(24, ty, `target ${t.f} MHz · ${t.name}`, { size: 11.5, fill: GREEN, weight: 700 }))
  if (d !== null) parts.push(txt(24, ty + 17, `${d >= 0 ? '+' : '−'}${fmtOff(d)} (${((Math.abs(d) / t.f) * 100).toFixed(2)}%) · lowest SWR ${fmt(r?.swrMin)}${r?.swrT !== undefined ? ` · at target ${fmt(r.swrT)}` : ''}`, { size: 10.5, fill: LABEL }))
  if (c) trimArrow(parts, W - 46, lcdY + 22, w, 0.62)
  else trimArrow(parts, W - 92, lcdY + 44, w, 1)
  let y = textY
  parts.push(`<line x1="22" x2="${W - 22}" y1="${y - 24}" y2="${y - 24}" stroke="#1f3a40"/>`)
  for (const l of head) {
    parts.push(txt(24, y, l, { size: c ? 17 : 20, weight: 800, fill: w.col, font: SANS }))
    y += 22
  }
  y -= 2
  for (const l of sub) {
    parts.push(txt(24, y, l, { size: 11, fill: LABEL, font: SANS, opacity: 0.9 }))
    y += 15
  }
  if (undo.length) {
    y += 6
    for (const l of undo) {
      parts.push(txt(24, y, l, { size: 11, fill: RED, font: SANS, weight: 700 }))
      y += 15
    }
  }
  trimRuler(parts, 30, W - 30, H - 42, c)
  return svgDoc(W, H, parts.join(''))
}

function trimLiveAlt(): string {
  const t = trimTarget()
  const r = trimNow()
  const w = trimWords()
  return `Trim: ${r && !r.edge ? `resonant at ${fmtF(r.f)} MHz (${r.method})` : 'no resonance in view'}, target ${t.f} MHz (${t.name}) · ${w.head}${w.undo ? ` · ${w.undo}` : ''}`
}

// Every change logged: how far from the target after each one, above (high) or below (low) the line.
function trimTimelineSvg(g: Geo): string {
  const c = g.c
  const W = g.W
  const t = trimTarget()
  const tol = trimTols(t.f)
  const pts = trimPts
  const H = c ? 236 : 214
  const L = c ? 44 : 56
  const R = 16
  const T = 40
  const B = 34
  const parts: string[] = []
  parts.push(`<defs>${glowDef('glow', W, H, 1.8)}</defs>`)
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(txt(14, 23, `CHANGES · ${pts.length}`, { size: 10.5, fill: YELLOW, weight: 700, spacing: 1.5 }))
  parts.push(txt(W - 14, 23, c ? `target ${t.f}` : `distance from the target, ${t.f} MHz, after each change`, { anchor: 'end', size: 10 }))
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="${PLOT}"/>`)
  if (!pts.length) {
    const lines = wrapText('Make a change and it shows here: a step is logged whenever the dip moves and holds still, or press ✂ Snip after each cut.', c ? 44 : 80)
    lines.forEach((l, k) => parts.push(txt(W / 2, T + 40 + k * 16, l, { anchor: 'middle', size: 11, fill: LABEL, font: SANS })))
    return svgDoc(W, H, parts.join(''))
  }
  const m = Math.max(tol.on * 2.2, ...pts.map(p => Math.abs(p.delta))) * 1.4
  const n = Math.max(pts.length, c ? 5 : 8)
  const x = (k: number) => L + ((k + 0.5) / n) * (W - L - R)
  const y = (d: number) => T + (1 - (clamp(d, -m, m) + m) / (2 * m)) * (H - T - B)
  parts.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${n1(y(tol.on) - T)}" fill="${ORANGE}" fill-opacity="0.04"/>`)
  parts.push(`<rect x="${L}" y="${n1(y(-tol.on))}" width="${W - L - R}" height="${n1(H - B - y(-tol.on))}" fill="${SKY}" fill-opacity="0.05"/>`)
  parts.push(`<rect x="${L}" y="${n1(y(tol.on))}" width="${W - L - R}" height="${n1(y(-tol.on) - y(tol.on))}" fill="${GREEN}" fill-opacity="0.16"/>`)
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${n1(y(0))}" y2="${n1(y(0))}" stroke="${GREEN}" stroke-width="1.4" stroke-dasharray="5 4"/>`)
  parts.push(txt(L - 6, y(0) + 3.5, '0', { anchor: 'end', size: 9.5, fill: GREEN, weight: 700 }))
  const yStep = niceStep(m, 2)
  for (let v = yStep; v < m; v += yStep) {
    parts.push(txt(L - 6, y(v) + 3.5, `+${Number(v.toFixed(2))}`, { anchor: 'end', size: 9 }))
    parts.push(txt(L - 6, y(-v) + 3.5, `−${Number(v.toFixed(2))}`, { anchor: 'end', size: 9 }))
  }
  parts.push(txt(W - R - 6, T + 13, c ? 'high · short' : 'high: electrically short, add length', { anchor: 'end', size: 9, fill: ORANGE, weight: 700 }))
  parts.push(txt(W - R - 6, H - B - 6, c ? 'low · long' : 'low: electrically long, cut', { anchor: 'end', size: 9, fill: SKY, weight: 700 }))
  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${n1(x(k))},${n1(y(p.delta))}`).join('')
  parts.push(`<path d="${path}" fill="none" stroke="${LABEL}" stroke-opacity="0.45" stroke-width="1.6"/>`)
  const every = pts.length > (c ? 6 : 12) ? 2 : 1
  pts.forEach((p, k) => {
    const px = x(k)
    const py = y(p.delta)
    const col = Math.abs(p.delta) <= tol.on ? GREEN : p.delta < 0 ? SKY : ORANGE
    if (p.how === 'snip') parts.push(`<rect x="${n1(px - 5)}" y="${n1(py - 5)}" width="10" height="10" rx="2" fill="${col}" filter="url(#glow)"/>`)
    else if (p.how === 'start') parts.push(`<path d="M${n1(px)},${n1(py - 6.5)}l6.5,6.5l-6.5,6.5l-6.5,-6.5z" fill="${col}" filter="url(#glow)"/>`)
    else parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="5" fill="${col}" filter="url(#glow)"/>`)
    // The value on the far side from the line, "passed" on the near side.
    const up = p.delta >= 0
    if (p.passed) {
      parts.push(`<circle cx="${n1(px)}" cy="${n1(py)}" r="10" fill="none" stroke="${RED}" stroke-width="2"/>`)
      parts.push(pill(px, up ? py + 28 : py - 18, 'passed', { fill: RED, anchor: 'middle', size: 9 }))
    }
    if (k % every === 0 || k === pts.length - 1) parts.push(txt(px, up ? py - 13 : py + 21, fmtF(p.f), { anchor: 'middle', size: 9, fill: BRIGHT }))
    parts.push(txt(px, H - B + 14, `#${p.n}`, { anchor: 'middle', size: 9 }))
  })
  parts.push(txt(W - 14, H - 8, c ? '◆ start ● seen ■ snip' : '◆ first reading · ● a change seen · ■ ✂ Snip · ○ red: passed the target', { anchor: 'end', size: 9 }))
  return svgDoc(W, H, parts.join(''))
}

function trimTimelineAlt(): string {
  if (!trimPts.length) return 'Trim timeline: no changes logged yet'
  return `Trim timeline: ${trimPts.map(p => `#${p.n} ${fmtF(p.f)} MHz${p.passed ? ' (passed)' : ''}`).join(', ')}`
}

// ---------------------------------------------------------------- band presets

const BAND_COLORS: Record<string, string> = { mesh: LCD, '2m': SKY, '70cm': VIOLET, adsb: PINK, ism433: TEAL, fm: CYAN }
function bandColor(b: BandDef): string {
  return BAND_COLORS[b.id] ?? (ANT[hashLabel(b.id) % ANT.length] as string)
}

function bandTip(b: BandDef): string {
  const cal = b.id === 'mesh' ? 'slot 0, the power-on state' : b.calOk ? `slot ${b.slot}, calibrated ${b.cal?.at ? day(b.cal.at) : ''}` : b.slot ? `slot ${b.slot}, not calibrated yet` : b.slotWhy ?? 'no slot'
  return `${b.name} · sweep ${b.start / 1e6}–${b.stop / 1e6} MHz, band ${b.band[0]}–${b.band[1]} · ${cal}${b.for ? ` · for ${b.for}` : ''}`
}

// The bands on a log-frequency map (desktop), or as rows (phone): each in its colour, its slot, CAL or UNCAL,
// the one being swept glowing; mesh marked as the power-on state.
function bandsSvg(g: Geo): string {
  const c = g.c
  const W = g.W
  const bands = bandsAll()
  const act = activeBand()
  const parts: string[] = []
  const chip = (x: number, y: number, s: string, col: string, solid = false) => {
    const w = tw(s, 9) + 10
    parts.push(`<rect x="${n1(x)}" y="${n1(y - 10)}" width="${n1(w)}" height="14" rx="7" fill="${col}" fill-opacity="${solid ? 0.85 : 0.14}" stroke="${col}" stroke-opacity="0.8"/>`)
    parts.push(txt(x + w / 2, y + 0.5, s, { anchor: 'middle', size: 9, weight: 700, fill: solid ? '#0b1012' : col }))
    return w
  }
  const status = (b: BandDef): [string, string] => (b.id === 'mesh' ? ['POWER-ON · S0', LCD] : b.calOk ? [`S${b.slot} · CAL`, GREEN] : b.slot ? [`S${b.slot} · UNCAL`, AMBER] : ['NO SLOT', RED])
  if (c) {
    const rowH = 46
    const H = 34 + bands.length * rowH + 8
    parts.push(`<defs>${glowDef('glow', W, H, 2)}</defs>`)
    parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
    parts.push(txt(14, 22, 'BANDS · SAVE SLOTS', { size: 10.5, fill: SKY, weight: 700, spacing: 1.5 }))
    bands.forEach((b, k) => {
      const y = 34 + k * rowH
      const col = bandColor(b)
      const now = act?.id === b.id
      parts.push(`<g><title>${esc(bandTip(b))}</title><rect x="10" y="${y}" width="${W - 20}" height="${rowH - 6}" rx="8" fill="${col}" fill-opacity="${now ? 0.16 : 0.06}" stroke="${col}" stroke-opacity="${now ? 0.9 : 0.3}" stroke-width="${now ? 1.8 : 1}"/></g>`)
      parts.push(`<rect x="10" y="${y + 6}" width="4" height="${rowH - 18}" rx="2" fill="${col}"/>`)
      parts.push(txt(22, y + 17, `${now ? '● ' : ''}${b.name}`, { size: 12.5, weight: 700, fill: col, font: SANS }))
      parts.push(txt(22, y + 32, `${b.band[0]}–${b.band[1]} MHz · sweep ${b.start / 1e6}–${b.stop / 1e6}`, { size: 9.5 }))
      const [s, sc] = status(b)
      chip(W - 20 - tw(s, 9) - 10, y + 20, s, sc, b.id === 'mesh')
    })
    return svgDoc(W, H, parts.join(''))
  }
  // A log-frequency axis from 60 MHz (or below the lowest band) to 1.3 GHz (or past the highest), bands in
  // lanes so none covers another.
  const lo = Math.log10(Math.min(60, ...bands.map(b => (b.start / 1e6) * 0.8)))
  const hi = Math.log10(Math.max(1300, ...bands.map(b => (b.stop / 1e6) * 1.1)))
  const L = 24
  const R = 24
  const x = (f: number) => L + ((Math.log10(Math.max(f, 1)) - lo) / (hi - lo)) * (W - L - R)
  const lanes: number[][] = []
  const laneOf = bands.map(b => {
    const a = x(b.start / 1e6) - 4
    const z = Math.max(x(b.stop / 1e6), a + tw(b.short, 11) + 20) + 4
    let k = lanes.findIndex(l => l.every((v, i) => (i % 2 === 0 ? !(a < (l[i + 1] as number) && v < z) : true)))
    if (k < 0) {
      lanes.push([])
      k = lanes.length - 1
    }
    ;(lanes[k] as number[]).push(a, z)
    return k
  })
  const laneH = 66
  const top = 44
  const H = top + lanes.length * laneH + 40
  parts.push(`<defs>${glowDef('glow', W, H, 2.2)}</defs>`)
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(txt(14, 23, 'BANDS · SAVE SLOTS', { size: 10.5, fill: SKY, weight: 700, spacing: 1.5 }))
  parts.push(txt(W - 14, 23, `slot 0 is the power-on state · ${presets?.slots ?? 7} slots (0–${(presets?.slots ?? 7) - 1})`, { anchor: 'end', size: 10 }))
  const ay = H - 30
  parts.push(`<line x1="${L}" x2="${W - R}" y1="${ay}" y2="${ay}" stroke="${GRID}" stroke-width="1.5"/>`)
  for (const f of [1, 2, 5, 10, 20, 30, 50, 70, 100, 150, 200, 300, 400, 500, 700, 1000, 1500, 2000].filter(v => Math.log10(v) > lo + 0.02 && Math.log10(v) < hi - 0.02)) {
    parts.push(`<line x1="${n1(x(f))}" x2="${n1(x(f))}" y1="${ay - 3}" y2="${ay + 3}" stroke="${AXIS}"/>`)
    parts.push(txt(x(f), ay + 15, f >= 1000 ? `${f / 1000} GHz` : `${f}`, { anchor: 'middle', size: 9 }))
  }
  parts.push(txt(W - R, ay + 15, 'MHz', { anchor: 'end', size: 9 }))
  bands.forEach((b, k) => {
    const lane = laneOf[k] ?? 0
    const y = top + lane * laneH
    const col = bandColor(b)
    const now = act?.id === b.id
    const xs = x(b.start / 1e6)
    const xe = x(b.stop / 1e6)
    const bs = x(b.band[0])
    const be = Math.max(x(b.band[1]), bs + 2)
    const g1 = `<g><title>${esc(bandTip(b))}</title>`
    parts.push(g1)
    if (now) parts.push(`<rect x="${n1(xs - 3)}" y="${y + 14}" width="${n1(xe - xs + 6)}" height="20" rx="6" fill="${col}" fill-opacity="0.35" filter="url(#glow)"/>`)
    parts.push(`<rect x="${n1(xs)}" y="${y + 18}" width="${n1(Math.max(4, xe - xs))}" height="12" rx="4" fill="${col}" fill-opacity="${now ? 0.4 : 0.18}" stroke="${col}" stroke-opacity="0.7"/>`)
    parts.push(`<rect x="${n1(bs)}" y="${y + 15}" width="${n1(be - bs)}" height="18" rx="3" fill="${col}" fill-opacity="0.9"/>`)
    parts.push(txt(xs, y + 9, `${now ? '● ' : ''}${b.short}`, { size: 11, weight: 700, fill: col, font: SANS }))
    const [s, sc] = status(b)
    chip(xs, y + 47, s, sc, b.id === 'mesh')
    parts.push('</g>')
    parts.push(`<line x1="${n1((bs + be) / 2)}" x2="${n1((bs + be) / 2)}" y1="${y + 33}" y2="${ay}" stroke="${col}" stroke-opacity="0.18" stroke-dasharray="2 3"/>`)
  })
  return svgDoc(W, H, parts.join(''))
}

function bandsAlt(): string {
  return `Bands: ${bandsAll()
    .map(b => `${b.name} ${b.id === 'mesh' ? 'slot 0 (power-on)' : b.calOk ? `slot ${b.slot} calibrated` : b.slot ? `slot ${b.slot} uncalibrated` : 'no slot'}`)
    .join(', ')}${activeBand() ? `; sweeping ${activeBand()?.name} now` : ''}`
}

// The V4 dipole helper: the RTL-SDR Blog V4 kit's dipole, each element ≈ 7150 / MHz cm.
const DIPOLE_TARGETS: [number, string, string][] = [
  [98, 'FM broadcast', 'fm'],
  [146.52, '2 m', '2m'],
  [433.92, '433 ISM', 'ism433'],
  [446, '70 cm', '70cm'],
  [915, 'LoRa 915', 'mesh'],
  [1090, 'ADS-B', 'adsb'],
]

function dipoleCm(f: number): number {
  return 7150 / f
}

function dipoleSvg(f: number, g: Geo): string {
  const c = g.c
  const W = g.W
  const cm = dipoleCm(f)
  const name = DIPOLE_TARGETS.find(t => t[0] === f)?.[1] ?? `${f} MHz`
  const lines = wrapText(`Each element ≈ 7150 / ${f} = ${cm.toFixed(1)} cm from the base to the tip, both the same, ${(2 * cm).toFixed(1)} cm tip to tip. Stand it vertical for most signals (ADS-B, LoRa, ham), horizontal for FM. Then Sweep it: the dip should land near ${f} MHz.`, c ? 54 : 100)
  const ty0 = c ? 140 : 132
  const H = ty0 + lines.length * 14 + 6
  const parts: string[] = []
  parts.push(`<defs>${glowDef('glow', W, H, 1.6)}<linearGradient id="rod" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e6edf0"/><stop offset="1" stop-color="#7f9199"/></linearGradient></defs>`)
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  parts.push(txt(14, 23, `V4 DIPOLE · ${name.toUpperCase()} · ${f} MHz`, { size: 10.5, fill: PINK, weight: 700, spacing: 1.2 }))
  const cx = W / 2
  const y = c ? 72 : 66
  const half = Math.min(W / 2 - 40, 60 + cm * (c ? 1.6 : 2.4))
  parts.push(`<rect x="${n1(cx - half)}" y="${y - 3}" width="${n1(half - 12)}" height="6" rx="3" fill="url(#rod)"/>`)
  parts.push(`<rect x="${n1(cx + 12)}" y="${y - 3}" width="${n1(half - 12)}" height="6" rx="3" fill="url(#rod)"/>`)
  parts.push(`<rect x="${cx - 12}" y="${y - 10}" width="24" height="20" rx="4" fill="#26343a" stroke="#3c4f56"/>`)
  parts.push(`<path d="M${cx},${y + 10}V${y + 34}" stroke="#56666d" stroke-width="3"/>`)
  parts.push(txt(cx, y + 46, 'coax to PORT 1', { anchor: 'middle', size: 9.5 }))
  for (const s of [-1, 1]) {
    const a = cx + s * 12
    const b = cx + s * half
    parts.push(`<path d="M${n1(a)},${y - 18}H${n1(b)}M${n1(a)},${y - 22}v8M${n1(b)},${y - 22}v8" stroke="${PINK}" stroke-width="1.4" fill="none"/>`)
    parts.push(txt((a + b) / 2, y - 25, `${cm.toFixed(1)} cm`, { anchor: 'middle', size: 13, weight: 800, fill: PINK, font: SANS }))
  }
  lines.forEach((l, k) => parts.push(txt(14, ty0 + k * 14, l, { size: 10.5, fill: LABEL, font: SANS })))
  return svgDoc(W, H, parts.join(''))
}

// ---------------------------------------------------------------- the "?" guide

const GUIDE: [string, string, string][] = [
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
const CAN_DO: [string, string][] = [
  ['Frequency range', 'The firmware sweeps from under 1 kHz to 2.7 GHz. Above 300 MHz it measures on its oscillator’s harmonics, so readings get weaker and noisier the higher you go: its dynamic range is best below about 300 MHz.'],
  ['Two measurements', 'S11 on PORT 1 (CH0): what reflects back, for antennas. S21 from PORT 1 to PORT 2 (CH1): what passes through, for filters, cables and attenuators. This tab reads S11.'],
  ['Cables and faults (TDR)', 'Its time-domain transform turns a sweep into distance along a cable: its length and where a fault is. The firmware also has cable, resonance and LC-match measure modes on its own screen.'],
  ['Points and slots', 'Up to 401 points a sweep (this tab uses 201). 7 save slots (0–6) on the H4, each a whole state: sweep, calibration, traces and markers.'],
  ['Accuracy is the calibration', 'Numbers are only as good as the OPEN, SHORT, LOAD done for the range you sweep, at the point you measure. Change the range or add a cable or adapter, and calibrate again.'],
  ['Never transmit into it', 'Never connect a transmitting radio, or a node’s antenna socket while it can transmit, to the NanoVNA: its ports are made for the tiny signal it sends itself, and a transmitter’s power can destroy them. Test antennas, not live outputs.'],
]

function guideSvg(g: Geo): string {
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

function guideText(): string {
  return [
    'How the VNA tab works',
    ...GUIDE.map(([t, s], i) => `${i + 1}. ${t}: ${s}`),
    '',
    'What this NanoVNA can do',
    ...CAN_DO.map(([t, s]) => `• ${t}: ${s}`),
  ].join('\n')
}
// ---------------------------------------------------------------- text

// PASS / FAIL in block letters for the terminal, which draws no SVG.
const GLYPHS: Record<string, string[]> = {
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  A: [' ███ ', '█   █', '█████', '█   █', '█   █'],
  S: [' ████', '█    ', ' ███ ', '    █', '████ '],
  F: ['█████', '█    ', '████ ', '█    ', '█    '],
  I: ['███', ' █ ', ' █ ', ' █ ', '███'],
  L: ['█    ', '█    ', '█    ', '█    ', '█████'],
}
function blocks(word: string): string[] {
  return [0, 1, 2, 3, 4].map(r => word.split('').map(ch => GLYPHS[ch]?.[r] ?? '').join('  '))
}

// A one-line SWR strip for the terminal.
function strip(): string {
  const c = live?.curve ?? []
  if (!c.length) return ''
  const bars = '▁▂▃▄▅▆▇█'
  const n = 48
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const p = c[Math.floor((i / n) * c.length)] ?? [0, 1]
    const v = Math.min(Math.max(p[1], 1), 4)
    out.push(bars[Math.round(((v - 1) / 3) * (bars.length - 1))] ?? '')
  }
  return out.join('')
}

// The strip's characters in runs of one zone colour, for the terminal's coloured strip.
function stripRuns(): [string, string][] {
  const c = live?.curve ?? []
  const s = strip()
  const out: [string, string][] = []
  ;[...s].forEach((ch, i) => {
    const p = c[Math.floor((i / s.length) * c.length)] ?? [0, 1]
    const col = zone(p[1])
    const last = out[out.length - 1]
    if (last && last[1] === col) last[0] += ch
    else out.push([ch, col])
  })
  return out
}

// A text meter for the terminal: the SWR on a |Γ| scale to 4, as the hero's needle.
function meterBar(swr: number, n = 24): string {
  const k = Math.round((Math.min(gam(swr), G_FULL) / G_FULL) * n)
  return `${'█'.repeat(k)}${'░'.repeat(Math.max(0, n - k))}`
}

function heroLine(mt: Mark): string {
  return `SWR ${fmt(mt.swr)} at 906.875 MHz (Meshtastic) · ${verdict(mt.swr).text}: ${meaning(mt.swr)}, ${fmt(mt.mismatchDb, 2)} dB mismatch loss`
}

function compareRows(a: Group, b: Group): [string, string, string, number][] {
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

// The whole reading as text: what /vna answers, so a phone or terminal gets the picture without the tab.
function report(): string {
  if (!live?.connected) {
    const b = live?.bridge
    return `NanoVNA not connected${b ? ` · Wi-Fi bridge ${b.host}: ${b.state}` : ''}. Switch it on and plug it into the Mac with a USB-A to USB-C cable.`
  }
  const m = live.metrics
  const lines: string[] = []
  const sw = live.sweep
  const bd = activeBand()
  const cs = calStatus()
  lines.push(`NanoVNA ${live.via === 'wifi' ? 'over Wi-Fi' : 'on USB'} · ${cs.ok ? 'calibrated' : 'NOT calibrated'}${sw ? ` · ${sw.start / 1e6}–${sw.stop / 1e6} MHz` : ''}${bd ? ` · ${bd.name}${typeof live.slot === 'number' ? ` (slot ${live.slot})` : ''}` : ''}`)
  if (!cs.ok && bd && bd.id !== 'mesh') lines.push(cs.text)
  if (!m) return lines.join('\n')
  if (m.best.swr > 15) {
    lines.push('PORT 1 reads open: no antenna, a loose plug, or an RP-SMA antenna (hole in the middle instead of a pin).')
    return lines.join('\n')
  }
  const q = qcOn && live.curve && onMesh() ? qcEvalTs(live.curve, qcRules) : undefined
  if (q) {
    lines.push(`QC ${q.pass ? 'PASS' : 'FAIL'}${q.pass ? '' : `: ${q.failed.join('; ')}`}`)
    lines.push(`  rule: ${q.rule}`)
    if (!live.calibrated) lines.push('  not calibrated: QC records are refused until it is')
    else lines.push(`  record it: /vna qc save ${qcLog?.next ?? '<unit id>'}`)
  }
  const hm = heroMarks(m)
  if (bd && bd.id !== 'mesh' && hm) {
    const worst = Math.max(hm.mt.swr, hm.mc?.swr ?? 0)
    lines.push(`SWR ${fmt(hm.mt.swr)} at ${hm.mt.mhz} MHz (${hm.mt.name}) · ${verdict(hm.mt.swr).text}: ${meaning(hm.mt.swr)}`)
    lines.push(`Grade ${grade(worst)} · ${bandVerdict(worst, bd.name)}`)
    const row = (k?: Mark) => (k ? `${(k.name ?? '').padEnd(14)} ${k.mhz.toFixed(3).padStart(8)} MHz  SWR ${fmt(k.swr)}  ${verdict(k.swr).text.padEnd(9)}  Z ${zText(k.z)}` : '')
    lines.push(row(hm.mt))
    if (hm.mc) lines.push(row(hm.mc))
    lines.push(`Best ${fmt(m.best.swr)} at ${m.best.mhz} MHz · ${m.under2 ? `under 2 from ${m.under2[0]} to ${m.under2[1]} MHz` : 'never under 2'}`)
  } else {
    if (m.meshtastic) lines.push(heroLine(m.meshtastic))
    lines.push(`Grade ${gradeOf(m) ?? '—'} · ${verdictLine(m)}`)
    const row = (name: string, k?: Mark) =>
      k ? `${name.padEnd(11)} ${k.mhz.toFixed(3).padStart(7)} MHz  SWR ${fmt(k.swr)}  ${verdict(k.swr).text.padEnd(9)}  Z ${zText(k.z)}` : `${name.padEnd(11)} off this sweep`
    lines.push(row('Meshtastic', m.meshtastic), row('MeshCore', m.meshcore), row('915', m.mid))
    lines.push(`Best ${fmt(m.best.swr)} at ${m.best.mhz} MHz · ${m.under2 ? `under 2 from ${m.under2[0]} to ${m.under2[1]} MHz` : 'never under 2'}`)
    if (m.resonance) lines.push(m.resonance.hint)
  }
  const s = strip()
  if (s) lines.push(`${sw ? sw.start / 1e6 : ''} ${s} ${sw ? sw.stop / 1e6 : ''}  (SWR, low is good)`)
  const mk = live.markers ?? []
  if (mk.length) lines.push('Markers: ' + mk.map(x => `M${x.id} ${x.mhz} → ${fmt(x.swr)}`).join(' · '))
  const top = groups().slice(0, 4)
  if (top.length && !qcOn) lines.push('Saved: ' + top.map(g => `${g.label} ${fmt(g.latest.metrics?.meshtastic?.swr)}${g.items.length > 1 ? ` (×${g.items.length})` : ''}`).join(' · ') + ' (SWR at 907)')
  return lines.join('\n')
}

// The trim assistant as text.
function trimText(): string {
  const t = trimTarget()
  const w = trimWords()
  const r = trimNow()
  const lines = [`Trim · target ${t.f} MHz (${t.name})`, r && !r.edge ? `Resonant at ${fmtF(r.f)} MHz (${r.method}) · ${w.head}` : w.head, w.sub]
  if (w.undo) lines.push(w.undo)
  if (trimPts.length) {
    lines.push(`Changes (${trimPts.length}):`)
    for (const p of trimPts.slice(-12)) lines.push(`  #${String(p.n).padEnd(3)} ${day(new Date(p.at).toISOString()).padEnd(14)} ${fmtF(p.f).padStart(7)} MHz  ${p.delta >= 0 ? '+' : '−'}${fmtOff(p.delta).padEnd(8)} ${p.how}${p.passed ? '  ← passed the target' : ''}`)
  } else lines.push('No changes logged yet: they log themselves when the dip moves and holds still, or /vna trim snip.')
  return lines.join('\n')
}

// The bands as text.
function bandsText(): string {
  const a = activeBand()
  const lines = ['Bands (Power-on is always slot 0, the Meshtastic layout, unchanged):']
  for (const b of bandsAll()) {
    const st = b.id === 'mesh' ? 'slot 0 · power-on' : b.calOk ? `slot ${b.slot} · calibrated ${b.cal?.at ? day(b.cal.at) : ''}` : b.slot ? `slot ${b.slot} · UNCAL (not calibrated yet)` : `no slot: ${b.slotWhy ?? ''}`
    lines.push(`${a?.id === b.id ? '●' : ' '} ${b.id.padEnd(7)} ${b.name.padEnd(22)} ${`${b.band[0]}–${b.band[1]} MHz`.padEnd(18)} ${st}`)
  }
  lines.push('/vna band <id> switches (recalls its slot), /vna band mesh goes back to Meshtastic (recall 0), /vna band cal <id> calibrates a band into its slot.')
  if (presets?.file) lines.push(`Your own bands and the slot map: ${presets.file}`)
  return lines.join('\n')
}

function compareText(): string {
  const a = cmpA ? groups().find(g => g.label === cmpA) : undefined
  const b = cmpB ? groups().find(g => g.label === cmpB) : undefined
  if (!a || !b) return 'Pick two saved antennas: /vna compare <a> <b>, or the A and B buttons in the tab.'
  return compareTextOf(a, b)
}

function compareTextOf(a: Group, b: Group): string {
  const rows = compareRows(a, b)
  const out = [`Compare  A: ${a.label} (${day(a.latest.saved)})   B: ${b.label} (${day(b.latest.saved)})`]
  for (const [k, va, vb, win] of rows) out.push(`${k.padEnd(13)} ${va.padEnd(16)} ${vb.padEnd(16)} ${win < 0 ? '← A' : win > 0 ? '← B' : ''}`)
  return out.join('\n')
}

// ---------------------------------------------------------------- one NanoVNA, several Claude sessions
// Every session with this plugin loaded runs this module. One of them holds vna.py's polling lease
// and sweeps (only while some session's VNA tab is on screen); the rest read the reading it shares
// in live.json and never touch the device. A press from any session goes to the device directly
// (vna.py waits a bounded time for nanovna.lock and answers "busy" past it).

const SESSION = `s${Math.random().toString(36).slice(2, 10)}`
let LEASE_FILE = ''
let WATCH_FILE = ''
let LIVE_FILE = ''

// Every path under the home folder, set at session.start once HOME is known.
function setHome(home: string): void {
  HOME = home
  ACTIONS_LOG = `${HOME}/Library/Application Support/vna/actions.jsonl`
  libDir = `${HOME}/NanoVNA/sweeps`
  const cacheDir = `${HOME}/Library/Caches/vna`
  LEASE_FILE = `${cacheDir}/lease.json`
  WATCH_FILE = `${cacheDir}/watch-${SESSION}`
  LIVE_FILE = `${HOME}/Library/Application Support/vna/live.json`
}
// A shared reading younger than this answers /vna without touching the device.
const FRESH_MS = 10_000
let liveAt = 0
let lastBeat = 0
let shareNote = ''
let busyNote = ''

// Background work never rejects into the void (a reload or a test ending under it).
function bg(p: Promise<unknown>): void {
  p.catch(() => undefined)
}

async function readJsonFile($: any, path: string): Promise<any> {
  try {
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null
  }
}

// Resolves p's value, or null after ms: a command always answers within its budget.
function within<T>($: any, p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise(resolve => {
    let done = false
    let t: { cancel?: () => void } | null = null
    const finish = (v: T | null) => {
      if (done) return
      done = true
      try {
        t?.cancel?.()
      } catch {}
      resolve(v)
    }
    try {
      t = $.clock.after(ms, () => finish(null))
    } catch {}
    p.then(finish, () => finish(null))
  })
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`
}

// ---------------------------------------------------------------- the script: lanes, presses, the timing log

// Processes run in lanes. The device lane runs one process at a time: a press's first ('action'),
// the polls after it ('poll': only while no press runs or waits, and never two of a kind queued).
// Reads that never touch the device (library, presets, the QC log, /vna's quick read) run in the
// free lane beside it, so a press never waits behind them.
type Lane = 'action' | 'poll' | 'free'
type Proc = { lane: 'action' | 'poll'; id: string; argv: string[]; timeoutMs: number; resolve: (v: any) => void; reject: (e: unknown) => void; promise: Promise<any>; waitedOn: boolean }
const actionQ: Proc[] = []
const pollQ: Proc[] = []
let procNow: Proc | null = null

function procId(argv: string[]): string {
  return argv
    .filter(a => a !== 'python3' && !a.startsWith('--') && !/^s[0-9a-z]{4,}$/.test(a) && !a.startsWith('{'))
    .map(a => (a.includes('/') ? a.split('/').pop() ?? a : a))
    .slice(0, 3)
    .join(' ')
}

async function spawnJson($: any, argv: string[], timeoutMs: number): Promise<any> {
  try {
    const r = await $.process.run(argv, { env: { PATH, HOME }, timeoutMs })
    try {
      return JSON.parse(r.stdout)
    } catch {
      return { error: (r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split('\n').slice(-1)[0] || 'no answer' }
    }
  } catch (err: any) {
    return { error: String(err?.message ?? err) }
  }
}

function runJson($: any, argv: string[], timeoutMs: number, lane: Lane): Promise<any> {
  const id = procId(argv)
  if (lane === 'free') {
    const t0 = Date.now()
    return spawnJson($, argv, timeoutMs).finally(() => notePoll($, id, Date.now() - t0, 'free', false))
  }
  if (lane === 'poll') {
    const same = pollQ.find(q => q.id === id) ?? (procNow?.lane === 'poll' && procNow.id === id ? procNow : undefined)
    if (same) return same.promise
  }
  let resolve: (v: any) => void = () => undefined
  let reject: (e: unknown) => void = () => undefined
  const promise = new Promise<any>((a, b) => {
    resolve = a
    reject = b
  })
  const job: Proc = { lane, id, argv, timeoutMs, resolve, reject, promise, waitedOn: false }
  if (lane === 'action') {
    actionQ.push(job)
    if (procNow?.lane === 'poll') procNow.waitedOn = true
  } else pollQ.push(job)
  pump($)
  return promise
}

// The next process on the device lane: a press's before any poll, and no poll while a press runs or waits.
function pump($: any): void {
  if (procNow) return
  const job = actionQ.shift() ?? (current || pending ? undefined : pollQ.shift())
  if (!job) return
  procNow = job
  const t0 = Date.now()
  spawnJson($, job.argv, job.timeoutMs)
    .then(job.resolve, job.reject)
    .finally(() => {
      procNow = null
      if (job.lane === 'poll') notePoll($, job.id, Date.now() - t0, 'device', job.waitedOn)
      pump($)
    })
}

async function script($: any, args: string[], timeoutMs = 20_000, lane: Lane = 'action'): Promise<any> {
  return runJson($, ['python3', `${$.plugin.root}/scripts/vna.py`, ...args], timeoutMs, lane)
}

// ---- presses: one press is one intent. One runs at a time; one more waits, and the newest press
// replaces it (the last click wins); the same press again joins the one running or waiting. The
// button shows it at once ("Saving…", "Queued: …") and the top says what it is doing.

type ActEnd = 'ran' | 'joined' | 'superseded'
type Plan = { step: string; ms: number; id?: string }
type ActOpts = { key?: string; plan?: () => Plan }
type Intent = {
  key: string
  label: string
  job: () => Promise<unknown>
  plan?: () => Plan
  pressedAt: number
  startedAt: number
  step: string
  expectMs: number
  planId: string
  queued: boolean
  coalesced: number
  failed: string
  done: Promise<ActEnd>
  end: (r: ActEnd) => void
}
let current: Intent | null = null
let pending: Intent | null = null
// How long each kind of press took this session (the "about N s" after the first time).
const learned = new Map<string, number>()

function intent($: any, label: string, job: () => Promise<unknown>, opts: ActOpts = {}): Promise<ActEnd> {
  const key = opts.key ?? label
  if (current?.key === key) {
    current.coalesced++
    return current.done.then(() => 'joined' as const)
  }
  if (pending?.key === key) {
    pending.coalesced++
    return pending.done.then(r => (r === 'ran' ? 'joined' : r))
  }
  let end: (r: ActEnd) => void = () => undefined
  const done = new Promise<ActEnd>(r => (end = r))
  const it: Intent = { key, label, job, plan: opts.plan, pressedAt: Date.now(), startedAt: 0, step: '', expectMs: 0, planId: key, queued: false, coalesced: 0, failed: '', done, end }
  if (current) {
    if (pending) supersede($, pending, it)
    it.queued = true
    pending = it
    $.ui.invalidate('ui.render')
    return done
  }
  begin($, it)
  return done
}

function supersede($: any, it: Intent, by: Intent): void {
  const now = Date.now()
  logLine($, { at: iso(it.pressedAt), action: it.label, key: it.key, pressedAt: it.pressedAt, startedAt: null, finishedAt: now, waitMs: now - it.pressedAt, queued: true, coalesced: it.coalesced, ok: null, superseded: true, by: by.label })
  it.end('superseded')
}

function begin($: any, it: Intent): void {
  current = it
  it.startedAt = Date.now()
  let p: Plan = { step: 'working on it', ms: 2000 }
  try {
    p = it.plan?.() ?? p
  } catch {}
  it.step = p.step
  it.planId = p.id ?? it.key
  it.expectMs = learned.get(it.planId) ?? p.ms
  $.ui.invalidate('ui.render')
  bg(runIntent($, it))
}

async function runIntent($: any, it: Intent): Promise<void> {
  let ok = true
  try {
    if ((await it.job()) === false || it.failed) ok = false
  } catch (err: any) {
    ok = false
    it.failed = String(err?.message ?? err)
    note = `${it.label} failed: ${it.failed}`
  }
  const end = Date.now()
  const runMs = end - it.startedAt
  if (ok) learned.set(it.planId, Math.round(learned.has(it.planId) ? ((learned.get(it.planId) ?? runMs) + runMs) / 2 : runMs))
  logLine($, { at: iso(it.pressedAt), action: it.label, key: it.key, pressedAt: it.pressedAt, startedAt: it.startedAt, finishedAt: end, waitMs: it.startedAt - it.pressedAt, runMs, expectMs: it.expectMs, step: it.step, queued: it.queued, coalesced: it.coalesced, ok, ...(it.failed ? { failed: it.failed.slice(0, 200) } : {}) })
  if (!ok) $.ui.toast(`${it.label}: ${it.failed || 'it did not work'}`, { timeoutMs: 6000 })
  current = null
  it.end('ran')
  const next = pending
  pending = null
  if (next) begin($, next)
  else pump($)
  lastCheck = 0
  $.ui.invalidate('ui.render')
}

// A job's way to say its press did not work (its note says why): the press ends with a toast.
function failed(text: string): false {
  if (current) current.failed = text || 'it did not work'
  return false
}

// "Saving Nag whip: reading a sweep and writing the file (about 3 s)"
function doingLine(): string {
  return current ? `${current.label}: ${current.step} (about ${Math.max(1, Math.round(current.expectMs / 1000))} s)` : ''
}

function queuedLine(): string {
  return pending ? `Queued: ${pending.label}, runs next${pending.coalesced ? ` (pressed ${pending.coalesced + 1}×, runs once)` : ''}` : ''
}

// What a press asks for: the same key at the button (to show it) and in the action (to run it).
const K = {
  save: (label: string) => `save ${label}`,
  qcSave: 'qc save',
  cal: (band: string, step: string) => `cal ${band} ${step}`,
  shot: 'shot',
  layout: 'layout',
  markers: (mode: string) => `markers ${mode}`,
  band: (id: string) => `band ${id}`,
  xtrace: (on: boolean) => `xtrace ${on ? 'on' : 'off'}`,
  powerOn: 'poweron save',
  remove: (file: string) => `delete ${file}`,
  export: 'export',
}

type Look = { label: string; variant?: 'primary'; dimColor?: boolean }
// A button for the press it makes: primary "<doing>…" while that runs, dim "Queued: …" while it waits.
function look(keys: string | string[], idle: string, doing?: string, queued?: string): Look {
  const ks = typeof keys === 'string' ? [keys] : keys
  if (current && ks.includes(current.key)) return { label: doing ?? `${current.label}…`, variant: 'primary' }
  if (pending && ks.includes(pending.key)) return { label: queued ?? `Queued: ${pending.label}`, dimColor: true }
  return { label: idle }
}

function lookProps(l: Look): { label: string; variant?: 'primary'; dimColor?: boolean } {
  return { label: l.label, ...(l.variant ? { variant: l.variant } : {}), ...(l.dimColor ? { dimColor: true } : {}) }
}

// What a command says about its press once it has been made.
function endText(end: ActEnd | null, text: string, label: string): string {
  if (end === null) return `Working on it: ${doingLine() || label}. The tab shows the result when it is done.`
  if (end === 'superseded') return `${label}: replaced by a newer press before it ran.`
  if (end === 'joined') return text || `${label}: already under way; it runs once.`
  return text
}

// ---- the timing log: one JSON line per press (and per slow poll) in actions.jsonl, the last 1000

let logLines: string[] | null = null
let logLoad: Promise<void> | null = null
let logFlush: { cancel: () => void } | null = null
const pollLogged = new Map<string, number>()

function iso(t: number): string {
  try {
    return new Date(t).toISOString()
  } catch {
    return String(t)
  }
}

function logLine($: any, rec: Record<string, unknown>): void {
  bg(
    (async () => {
      if (!logLines) {
        logLoad ??= (async () => {
          let text = ''
          try {
            text = String(await $.fs.read(ACTIONS_LOG))
          } catch {}
          logLines = text.split('\n').filter(Boolean).slice(-LOG_MAX)
        })()
        await logLoad
      }
      const lines = logLines ?? []
      lines.push(JSON.stringify(rec))
      if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX)
      logLines = lines
      if (!logFlush) logFlush = $.clock.after(1000, () => bg(flushLog($)))
    })(),
  )
}

async function flushLog($: any): Promise<void> {
  logFlush = null
  if (logLines) await $.fs.write(ACTIONS_LOG, `${logLines.join('\n')}\n`)
}

// A poll over 300 ms: always when a press waited behind it, else at most once in 10 min per kind.
function notePoll($: any, id: string, ms: number, lane: string, blocked: boolean): void {
  if (ms < POLL_LOG_MS) return
  const now = Date.now()
  if (!blocked && now - (pollLogged.get(id) ?? 0) < 600_000) return
  pollLogged.set(id, now)
  logLine($, { at: iso(now), poll: id, ms, lane, ...(blocked ? { delayedAPress: true } : {}) })
}

// ---------------------------------------------------------------- the store

function isRules(v: unknown): v is Rules {
  const r = v as Rules
  return !!r && typeof r === 'object' && [r.lo, r.hi, r.bandMax, r.spotMax].every(n => typeof n === 'number' && n > 0) && Array.isArray(r.spots) && r.hi > r.lo
}

async function loadStore($: any): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const o = await $.store.get('overlays')
    if (Array.isArray(o)) overlays = o as string[]
    const l = await $.store.get('liveOn')
    if (typeof l === 'boolean') liveOn = l
    const v = await $.store.get('view')
    if (VIEWS.some(([k]) => k === v)) view = v as View
    const sec = await $.store.get('section')
    if (SECTIONS.some(([k]) => k === sec)) section = sec as Section
    const a = await $.store.get('cmpA')
    cmpA = typeof a === 'string' ? a : null
    const b = await $.store.get('cmpB')
    cmpB = typeof b === 'string' ? b : null
    const h = await $.store.get('histLabel')
    histLabel = typeof h === 'string' ? h : null
    // 0.4.0 kept QC as a mode of its own; it is the QC place now.
    const q = await $.store.get('qcOn')
    if (q === true && sec === undefined) section = 'qc'
    qcOn = section === 'qc'
    const r = await $.store.get('qcRules')
    if (isRules(r)) qcRules = r
    const c = await $.store.get('antColors')
    if (c && typeof c === 'object') antColors = { ...(c as Record<string, number>) }
    const tt = await $.store.get('trimTargets')
    if (tt && typeof tt === 'object') trimTargets = { ...(tt as Record<string, number>) }
    const tp = await $.store.get('trim')
    if (tp && typeof tp === 'object' && Array.isArray((tp as any).points)) {
      trimBand = String((tp as any).band ?? 'mesh')
      trimPts = (tp as any).points as TrimPoint[]
    }
    const d = await $.store.get('dipoleF')
    if (typeof d === 'number' && d > 0) dipoleF = d
    const so = await $.store.get('statusOn')
    if (typeof so === 'boolean') statusOn = so
  } catch {}
}

async function saveStore($: any): Promise<void> {
  try {
    await $.store.set('overlays', overlays)
    await $.store.set('liveOn', liveOn)
    await $.store.set('view', view)
    await $.store.set('section', section)
    await $.store.set('cmpA', cmpA)
    await $.store.set('cmpB', cmpB)
    await $.store.set('histLabel', histLabel)
    await $.store.set('qcOn', qcOn)
    await $.store.set('qcRules', qcRules)
    await $.store.set('antColors', antColors)
    await $.store.set('trimTargets', trimTargets)
    await $.store.set('trim', { band: trimBand, points: trimPts })
    await $.store.set('dipoleF', dipoleF)
  } catch {}
}

// ---------------------------------------------------------------- readings in

// The SWR a reading's level goes by: ok under 2, warn to 3, alert from 3.
function swrLevel(swr: number | undefined): Level {
  return swr === undefined || !Number.isFinite(swr) ? 'ok' : swr >= 3 ? 'alert' : swr >= 2 ? 'warn' : 'ok'
}

// The status line, only while a NanoVNA is connected, and the same line without 'VNA · ' in
// ~/.claude/mod-status/vna.json for the Herdr strip: warn with nothing on PORT 1, alert on a QC FAIL,
// else by the SWR. Nothing (and no file) while none is connected or after /vna hide.
function pushStatus($: any): void {
  const b = activeBand()
  const open = live?.connected && (live.metrics?.best?.swr ?? 0) > 15
  const qc = qcOn && live?.curve && onMesh() ? qcEvalTs(live.curve, qcRules) : undefined
  let text: string | undefined
  let level: Level = 'ok'
  if (open) {
    text = 'VNA · nothing on PORT 1'
    level = 'warn'
  } else if (live?.connected && b && b.id !== 'mesh') {
    const mk = b.targets[0] ? markAt(b.targets[0][0], b.targets[0][1]) : undefined
    text = mk ? `VNA · ${b.short} · SWR ${fmt(mk.swr)} @${Number(mk.mhz.toFixed(2))}` : `VNA · ${b.short}`
    level = swrLevel(mk?.swr)
  } else {
    const m = live?.connected ? live.metrics?.meshtastic : undefined
    text = m ? `VNA · SWR ${fmt(m.swr)} @907${qc ? ` · QC ${qc.pass ? 'PASS' : 'FAIL'}` : ''}` : undefined
    level = qc && !qc.pass ? 'alert' : swrLevel(m?.swr)
  }
  if (!statusOn) text = undefined
  void postModStatus($, text, text ? { text: text.replace(/^VNA · /, ''), level } : undefined)
}

// Whether someone is looking at a VNA tab in this session now (the engine's record of its panes;
// else a drawing in the last 10 s).
async function isWatched($: any, now: number): Promise<boolean> {
  if (!liveOn) return false
  try {
    const ps = await $.ui.panes()
    if (Array.isArray(ps)) return ps.some((p: any) => (p.id === PANE || String(p.id).startsWith('vna-')) && p.isShown && p.isPlaced !== false)
  } catch {}
  return Object.values(drawnAt).some(t => now - t < 10_000)
}

function wanted(id: string, now: number): boolean {
  return now - (drawnAt[id] ?? 0) < 15_000
}

// A reading from anywhere (this session's poll, another's live.json, a press): kept when it is newer
// than the one shown. A busy answer keeps the reading and says why.
function applyLive($: any, r: any, now: number): boolean {
  if (!r || typeof r !== 'object') return false
  if (r.busy) {
    busyNote = String(r.say ?? 'NanoVNA busy')
    $.ui.invalidate('ui.render')
    return false
  }
  if (typeof r.connected !== 'boolean') return false
  const at = typeof r.at === 'number' ? r.at : now
  if (at < liveAt) return false
  busyNote = ''
  const prev = live
  // Paused: the chart keeps the last curve; the rest (connection, battery, calibration) stays current.
  live = r.connected && !liveOn && prev?.curve ? { ...r, curve: prev.curve, s11: prev.s11, metrics: prev.metrics, markers: prev.markers } : (r as Live)
  liveAt = at
  qcOn = section === 'qc' || wanted(TABS.qc.id, now)
  if (r.connected && !wasConnected) {
    $.ui.toast(`NanoVNA connected (${r.board ?? 'NanoVNA'} ${r.version ?? ''})`.trim(), { timeoutMs: 5000 })
    if (!shareNote) void $.ui.open({ id: PANE, title: 'VNA' })
  }
  if (!r.connected && wasConnected) $.ui.toast('NanoVNA disconnected', { timeoutMs: 5000 })
  wasConnected = !!r.connected
  if (r.calStep === null && cal?.step && !current) cal = null
  if ((section === 'trim' && wanted(PANE, now)) || wanted(TABS.trim.id, now)) {
    const p = trimFeed(now)
    if (p) bg(saveStore($))
  }
  pushStatus($)
  $.ui.invalidate('ui.render')
  return true
}

async function tick($: any, force = false): Promise<void> {
  if (current || pending || polling) return
  const now = await $.clock.now()
  const due = live?.connected && liveOn ? LIVE_MS : IDLE_MS
  if (!force && now - lastCheck < due - 200) return
  lastCheck = now
  polling = true
  try {
    if ((await isWatched($, now)) && now - lastBeat > 2000) {
      lastBeat = now
      try {
        await $.fs.write(WATCH_FILE, String(now))
      } catch {}
    }
    // Another session holds the lease: show what it shared, and never touch the device.
    const lease = await readJsonFile($, LEASE_FILE)
    if (lease && lease.session && lease.session !== SESSION && Number(lease.until) * 1000 > now) {
      shareNote = 'Another Claude session is reading the NanoVNA; this tab shows what it shares.'
      const shared = await readJsonFile($, LIVE_FILE)
      if (shared) applyLive($, shared, now)
      return
    }
    const r = await script($, ['poll', '--session', SESSION], 15_000, 'poll')
    shareNote = r?.shared ? 'Another Claude session is reading the NanoVNA; this tab shows what it shares.' : ''
    if (r?.idle && !r.connected) return
    applyLive($, r, now)
  } finally {
    polling = false
  }
}

async function refreshLibrary($: any): Promise<void> {
  const r = await script($, ['library'], 10_000, 'free')
  if (r && Array.isArray(r.items)) {
    lib = r.items
    libDir = r.dir ?? libDir
    overlays = overlays.filter(f => lib.some(i => i.file === f))
    const labels = new Set(lib.map(i => i.label))
    if (cmpA && !labels.has(cmpA)) cmpA = null
    if (cmpB && !labels.has(cmpB)) cmpB = null
    if (histLabel && !labels.has(histLabel)) histLabel = null
    if (assignColors()) await saveStore($)
  }
  $.ui.invalidate('ui.render')
}

async function refreshPresets($: any): Promise<void> {
  const r = await script($, ['presets'], 8000, 'free')
  if (r && Array.isArray(r.bands) && r.bands.length) presets = r as Presets
  $.ui.invalidate('ui.render')
}

async function loadQcLog($: any): Promise<void> {
  const r = await script($, ['qc', 'log'], 8000, 'free')
  if (r && Array.isArray(r.records)) qcLog = r as QcLog
  $.ui.invalidate('ui.render')
}

// ---------------------------------------------------------------- presses

// A press's answer from vna.py: a reading to show, or why not.
function deviceTrouble(r: any): string {
  if (!r) return 'no answer from vna.py'
  if (r.busy) return String(r.say ?? 'NanoVNA busy')
  if (r.connected === false) return 'NanoVNA not connected.'
  if (r.error) return String(r.error)
  return ''
}

async function saveAntenna($: any, name: string): Promise<string> {
  const label = name.trim() || `Antenna ${groups().length + 1}`
  let text = ''
  const end = await intent(
    $,
    `Saving ${label}`,
    async () => {
      const r = await script($, ['save', label, '--session', SESSION], 25_000)
      const bad = deviceTrouble(r)
      if (bad || !r.saved) {
        text = `Not saved: ${bad || 'unknown error'}`
        note = text
        return failed(bad || 'unknown error')
      }
      applyLive($, r, await $.clock.now())
      const m = r.metrics as Metrics | null
      const file = String(r.saved).split('/').pop() as string
      await refreshLibrary($)
      const g = groups().find(x => x.label === label)
      const n = g?.items.length ?? 1
      text = `Saved ${label}${n > 1 ? ` (version ${n}, ${trend(g as Group)} at 907)` : ''}: SWR ${fmt(m?.meshtastic?.swr)} at 906.875, ${fmt(m?.meshcore?.swr)} at 910.525, best ${fmt(m?.best?.swr)} at ${m?.best?.mhz ?? '?'} MHz.`
      // Show the new version in place of the older ones of the same antenna.
      const older = new Set((g?.items ?? []).map(i => i.file))
      overlays = [file, ...overlays.filter(f => !older.has(f))].slice(0, MAX_OVERLAYS)
      await saveStore($)
      note = text
      $.ui.toast(text, { timeoutMs: 8000 })
      return true
    },
    { key: K.save(label), plan: () => ({ step: 'reading a sweep and writing the file', ms: 2500, id: 'save' }) },
  )
  return endText(end, text, `Saving ${label}`)
}

// Calibration: the mesh band's (slot 0) or a band's own (its spare slot).
async function calStep($: any, band: string, step: string): Promise<string> {
  const bd = bandById(band)
  const who = band === 'mesh' ? '' : `${bd?.short ?? band} `
  const label = step === 'begin' ? `Starting the ${who}calibration` : step === 'cancel' ? 'Cancelling the calibration' : `Capturing ${step.toUpperCase()}`
  let text = ''
  const end = await intent(
    $,
    label,
    async () => {
      const r = await script($, band === 'mesh' ? ['cal', step, '--session', SESSION] : ['band', 'cal', band, step, '--session', SESSION], 50_000)
      const bad = deviceTrouble(r)
      if (bad) {
        text = bad
        note = text
        return failed(bad)
      }
      text = r.say ?? r.error ?? ''
      cal = r.step ? { step: r.step, say: text, ok: !!r.ok, band } : null
      if (live) live = { ...live, slot: r.slot ?? live.slot, calStep: r.calStep ?? r.step ?? null, sweep: r.sweep ?? live.sweep, calibrated: r.calibrated ?? live.calibrated }
      if (!r.step && r.ok) {
        note = text
        $.ui.toast(text, { timeoutMs: 8000 })
        if (band !== 'mesh') await refreshPresets($)
      }
      if (!r.ok && !r.step) note = text
      return r.ok !== false || !!r.step
    },
    { key: K.cal(band, step), plan: () => ({ step: step === 'begin' ? 'setting the sweep and showing the first step' : step === 'cancel' ? 'recalling the saved slot' : `measuring the ${step.toUpperCase()} plug`, ms: step === 'load' ? 5000 : 3000, id: `cal ${step}` }) },
  )
  return endText(end, text, label)
}

async function takeShot($: any): Promise<string> {
  let text = ''
  const end = await intent(
    $,
    'Screenshot',
    async () => {
      const r = await script($, ['shot', '--session', SESSION], 60_000)
      if (r?.png) {
        let b64 = ''
        try {
          const read = await $.fs.read(r.png, { as: 'bytes' })
          b64 = typeof read === 'object' && read && 'base64' in read ? String((read as any).base64) : ''
        } catch {}
        shot = { path: r.png, b64 }
        text = `Screenshot saved: ${r.png}`
        note = text
        return true
      }
      text = `Screenshot failed: ${deviceTrouble(r) || 'unknown error'}`
      note = text
      return failed(text)
    },
    { key: K.shot, plan: () => ({ step: "reading the NanoVNA's screen", ms: 8000, id: 'shot' }) },
  )
  return endText(end, text, 'Screenshot')
}

async function layout($: any): Promise<string> {
  let text = ''
  const end = await intent(
    $,
    'Setting the mesh layout',
    async () => {
      const r = await script($, ['preset', '--session', SESSION], 30_000)
      const bad = deviceTrouble(r)
      text = bad || 'Mesh layout set (850–980 MHz, SWR / Smith / dB, markers at 907, 910.5, 915), not saved. Back to Meshtastic in Bands recalls slot 0 with its calibration.'
      note = text
      return bad ? failed(bad) : true
    },
    { key: K.layout, plan: () => ({ step: 'setting the sweep, traces and markers', ms: 2500, id: 'layout' }) },
  )
  return endText(end, text, 'Mesh layout')
}

async function setMarkers($: any, mode: 'mesh' | 'best'): Promise<string> {
  let text = ''
  const label = mode === 'best' ? 'Moving M1 to the best point' : 'Placing markers'
  const end = await intent(
    $,
    label,
    async () => {
      const r = await script($, ['markers', mode, '--session', SESSION], 20_000)
      const bad = deviceTrouble(r)
      if (bad) {
        text = bad
        note = text
        return failed(bad)
      }
      text = r.say ?? r.error ?? ''
      applyLive($, r, await $.clock.now())
      note = text
      return true
    },
    { key: K.markers(mode), plan: () => ({ step: 'reading the sweep and moving the markers', ms: 1500, id: 'markers' }) },
  )
  return endText(end, text, label)
}

async function qcSave($: any, unit: string): Promise<string> {
  let text = ''
  const end = await intent(
    $,
    'Recording QC',
    async () => {
      const r = await script($, ['qc', 'save', ...(unit.trim() ? [unit.trim()] : []), '--rules', JSON.stringify(qcRules), '--session', SESSION], 40_000)
      const bad = deviceTrouble(r)
      if (bad) {
        text = `Not recorded: ${bad}`
        lastQc = { say: text, ok: false }
        note = text
        return failed(bad)
      }
      text = r.say ?? r.error ?? 'QC failed'
      lastQc = { say: text, ok: !!r.ok, cert: r.certificate }
      if (r.ok) {
        $.ui.toast(text, { timeoutMs: 8000 })
        await loadQcLog($)
      }
      note = text
      return true
    },
    { key: K.qcSave, plan: () => ({ step: 'reading a sweep, writing the log row, the sweep and the certificate', ms: 3000, id: 'qc save' }) },
  )
  return endText(end, text, 'Recording QC')
}

// Switch the NanoVNA to a band: its calibration slot recalled (slot 0 for Meshtastic), or its range uncalibrated.
async function switchBand($: any, id: string): Promise<string> {
  const b = bandById(id) ?? (id === 'mesh' ? MESH_BAND : undefined)
  if (!b) return `No band ${id}. Bands: ${bandsAll().map(x => x.id).join(', ')}.`
  const a = activeBand()
  if (a?.id === b.id && typeof live?.slot === 'number' && live.slot === b.slot && !cal?.step) {
    note = b.id === 'mesh' ? 'Already on Meshtastic: slot 0, the power-on state, is in use.' : `Already on ${b.name} (slot ${b.slot}).`
    $.ui.invalidate('ui.render')
    return note
  }
  const label = b.id === 'mesh' ? 'Back to Meshtastic' : `Switching to ${b.short}`
  let text = ''
  const end = await intent(
    $,
    label,
    async () => {
      const r = await script($, ['band', b.id, '--session', SESSION], 30_000)
      const bad = deviceTrouble(r)
      if (bad) {
        text = bad
        note = text
        return failed(bad)
      }
      applyLive($, r, await $.clock.now())
      text = r.say ?? ''
      note = text
      if (section === 'trim') trimRecent = []
      return r.ok === false ? failed(text) : true
    },
    { key: K.band(b.id), plan: () => ({ step: b.id === 'mesh' ? 'recalling slot 0' : b.calOk ? `recalling slot ${b.slot}` : 'sweeping its range, uncalibrated', ms: 2500, id: 'band' }) },
  )
  return endText(end, text, label)
}

function xOn(): boolean {
  return !!live?.traces?.some(t => t.n === 3 && t.type === 'x')
}

// The 4th trace: reactance X, on the NanoVNA's screen now; nothing saved.
async function setXTrace($: any, on: boolean): Promise<string> {
  if (live?.traces && xOn() === on) {
    note = on ? 'Trace 4 already shows X.' : 'Trace 4 is already off.'
    $.ui.invalidate('ui.render')
    return note
  }
  let text = ''
  const label = on ? 'Showing X on trace 4' : 'Hiding trace 4'
  const end = await intent(
    $,
    label,
    async () => {
      const r = await script($, ['xtrace', on ? 'on' : 'off', '--session', SESSION], 15_000)
      const bad = deviceTrouble(r)
      if (bad) {
        text = bad
        note = text
        return failed(bad)
      }
      if (live && Array.isArray(r.traces)) live = { ...live, traces: r.traces }
      text = r.say ?? ''
      note = text
      return r.ok === false ? failed(text) : true
    },
    { key: K.xtrace(on), plan: () => ({ step: 'setting trace 4', ms: 1200, id: 'xtrace' }) },
  )
  return endText(end, text, label)
}

// Why "Make this my power-on layout" must not save now (the same rules vna.py checks again), or null.
function powerOnRefusal(): string | null {
  if (!live?.connected) return 'Not saved: the NanoVNA is not connected.'
  if (cal?.step || live.calStep) return 'Not saved: a calibration is under way. Finish or cancel it first.'
  const sw = live.sweep
  if (!onMesh()) return `Not saved: the NanoVNA is sweeping ${sw ? `${sw.start / 1e6}–${sw.stop / 1e6} MHz / ${sw.points} points` : 'an unknown range'}, not the 850–980 MHz / 201-point mesh band. Press Back to Meshtastic first.`
  if (!live.calibrated) return 'Not saved: the NanoVNA reports no calibration in use.'
  if (live.slot !== 0) return "Not saved: the calibration in use is not known to be slot 0's (a band was recalled, a calibration was reset, or the NanoVNA was changed on its own screen). Press Back to Meshtastic (recall 0) first, then try again."
  return null
}

// What a save of slot 0 would hold, named before it happens.
function powerOnWhat(): string {
  return `This writes slot 0, what the NanoVNA loads every time it is switched on: the mesh calibration in use now (slot 0's), 850–980 MHz at 201 points, traces SWR · Smith · LOGMAG${xOn() ? ' · X' : ' (trace 4 off)'}, markers M1 907.2 / M2 910.45 / M3 915. The layout it starts with today is replaced. To go back later, set trace 4 the old way and save again.`
}

// The first press only asks: a refusal says why, else the confirmation box shows what would be saved.
function powerOnAsk($: any): string {
  const why = powerOnRefusal()
  confirmPowerOn = !why
  note = why ?? ''
  $.ui.invalidate('ui.render')
  return why ?? `Confirm in the tab: ${powerOnWhat()}`
}

async function powerOnSave($: any): Promise<string> {
  const why = powerOnRefusal()
  if (why) {
    confirmPowerOn = false
    note = why
    $.ui.invalidate('ui.render')
    return why
  }
  let text = ''
  const end = await intent(
    $,
    'Saving the power-on layout',
    async () => {
      const r = await script($, ['poweron', 'save', '--confirm', '--session', SESSION], 30_000)
      confirmPowerOn = false
      const bad = deviceTrouble(r)
      if (bad) {
        text = bad
        note = text
        return failed(bad)
      }
      text = r.say ?? ''
      note = text
      if (r.ok) {
        if (live) live = { ...live, slot: 0, traces: r.traces ?? live.traces }
        $.ui.toast(text, { timeoutMs: 9000 })
        await refreshPresets($)
        return true
      }
      return failed(text)
    },
    { key: K.powerOn, plan: () => ({ step: 'setting the mesh layout and saving slot 0', ms: 2500, id: 'poweron' }) },
  )
  return endText(end, text, 'Saving the power-on layout')
}

async function deleteNewest($: any, g: Group): Promise<string> {
  let text = ''
  const end = await intent(
    $,
    `Deleting ${g.label}'s newest sweep`,
    async () => {
      await script($, ['delete', g.latest.file], 8000, 'free')
      await refreshLibrary($)
      const left = g.items.length - 1
      text = `Deleted the newest sweep of ${g.label}${left ? ` (${left} older kept)` : ''}.`
      note = text
      return true
    },
    { key: K.remove(g.latest.file), plan: () => ({ step: 'removing the file', ms: 400, id: 'delete' }) },
  )
  return endText(end, text, 'Delete')
}

// ---- local presses: state in the tab, at once. Each says what it wants (from the drawing), so a
// second press from a drawing a moment old asks for the same thing rather than undoing it.

async function setSection($: any, s: Section): Promise<void> {
  section = s
  qcOn = s === 'qc'
  if (s === 'qc' && !qcLog) bg(loadQcLog($))
  if (s === 'bands') bg(refreshPresets($))
  await saveStore($)
  pushStatus($)
  $.ui.invalidate('ui.render')
}

async function setView($: any, v: View): Promise<void> {
  view = v
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function setLive($: any, want: boolean): Promise<void> {
  if (liveOn === want) return
  liveOn = want
  await saveStore($)
  lastCheck = 0
  bg(tick($, true))
  $.ui.invalidate('ui.render')
}

async function setOverlay($: any, file: string, want: boolean): Promise<void> {
  const has = overlays.includes(file)
  if (want && !has) overlays = [file, ...overlays].slice(0, MAX_OVERLAYS)
  if (!want && has) overlays = overlays.filter(f => f !== file)
  histLabel = null
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function pick($: any, slot: 'A' | 'B', label: string | null): Promise<void> {
  if (slot === 'A') {
    cmpA = label
    if (cmpA && cmpB === cmpA) cmpB = null
  } else {
    cmpB = label
    if (cmpB && cmpA === cmpB) cmpA = null
  }
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function showHistory($: any, label: string | null): Promise<void> {
  histLabel = label
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function setTrimTarget($: any, f: number): Promise<void> {
  const b = activeBand() ?? MESH_BAND
  trimTargets = { ...trimTargets, [b.id]: f }
  // The timeline measured against the new target: each change's distance, and which ones passed it.
  const on = trimTols(f).on
  trimPts = trimPts.map((p, k) => {
    const delta = p.f - f
    const prev = trimPts[k - 1]
    const { passed: _, ...rest } = p
    return { ...rest, delta, target: f, ...(prev && crossed(prev.f - f, delta, on) ? { passed: true } : {}) }
  })
  trimRecent = []
  if (live) trimFeed(await $.clock.now())
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function trimSnip($: any): Promise<string> {
  const now = await $.clock.now()
  const t = trimTarget()
  const r = live?.connected && live.curve?.length ? resonanceOf(live.curve, live.s11, t.f) : null
  if (!r) {
    note = 'Nothing to log: no reading of the antenna on PORT 1.'
    $.ui.invalidate('ui.render')
    return note
  }
  trimLast = r
  trimLastAt = liveAt
  const p = trimPush(r, 'snip', now)
  await saveStore($)
  note = `Logged #${p.n}: resonant at ${fmtF(p.f)} MHz (${p.delta >= 0 ? '+' : '−'}${fmtOff(p.delta)})${p.passed ? ' · you passed the target' : ''}.`
  $.ui.invalidate('ui.render')
  return note
}

async function trimReset($: any): Promise<void> {
  trimPts = []
  trimRecent = []
  await saveStore($)
  note = 'Trim timeline cleared.'
  $.ui.invalidate('ui.render')
}

async function setDipole($: any, f: number): Promise<void> {
  dipoleF = f
  await saveStore($)
  $.ui.invalidate('ui.render')
}

async function openTab($: any, v: TabView): Promise<string> {
  const t = TABS[v]
  await $.ui.open({ id: t.id, title: t.title })
  return `Opened ${t.title} in its own tab: ${t.about}.`
}

async function openFile($: any, path: string): Promise<void> {
  try {
    await $.process.run(['/usr/bin/open', path], { env: { PATH }, timeoutMs: 10_000 })
  } catch {}
}

function parseRules(arg: string): Rules | string {
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

function ruleText(r: Rules): string {
  return `PASS when SWR ≤ ${lim(r.bandMax)} at every point ${r.lo}–${r.hi} MHz${r.spots.length ? ` and SWR ≤ ${lim(r.spotMax)} at ${r.spots.join(' and ')} MHz` : ''}`
}

// ---------------------------------------------------------------- steady pictures

// The height an SVG takes at the width the pane gives it (its own width, at most maxW). Given as
// the Svg's height, the box keeps its size while a refreshed picture loads, so the pane never
// shrinks for a moment and the scroll position stays where the person put it.
function svgHeight(source: string, maxW: number): number | undefined {
  const head = source.slice(0, 800)
  const vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(head)
  const wa = /<svg[^>]*\swidth="([\d.]+)"/.exec(head)
  const w = vb ? Number(vb[1]) : NaN
  const h = vb ? Number(vb[2]) : NaN
  if (!(w > 0 && h > 0)) return undefined
  const drawn = Math.min(wa ? Number(wa[1]) : w, maxW)
  return Math.round((drawn * h) / w)
}
// ---------------------------------------------------------------- 📸 Export: one report card
// A tall portrait image of the reading, built from the same pictures the tab draws (their phone
// layouts, drawn 500 px wide on a 540 px card): a header, the hero, the SWR chart, an A/B compare
// when one is set, the Smith chart, the numbers and a footer. vna.py writes it to
// ~/NanoVNA/exports/<name>-<yyyymmdd-hhmm>.svg and .png (2x: 1080 px wide).

const EXPORT_W = 540
const EXPORT_PIECE = 500
let lastExport: { ok: boolean; say: string; png?: string | null; svg?: string } | null = null

// One picture placed inside the card, its ids renamed so no two pictures share a gradient or a filter.
function nestSvg(src: string, x: number, y: number, w: number, prefix: string): { svg: string; h: number } {
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

// The numbers: SWR, return loss, reflected power, mismatch loss and Z at each frequency, then the
// best point, the stretch under 2:1, resonance and the trim hint.
function numbersSvg(g: Geo): string {
  const W = g.W
  const m = live?.metrics
  const bd = activeBand()
  const mesh = !bd || bd.id === 'mesh'
  const rows: Mark[] = mesh
    ? ([m?.meshtastic, m?.meshcore, m?.mid].filter(Boolean) as Mark[])
    : (bd?.targets ?? []).map(([f, n]) => markAt(f, n)).filter((x): x is Mark => !!x)
  const res = m?.resonance
  const tw0 = trimNow()
  const notes: [string, string][] = []
  if (m) {
    notes.push(['Best', `SWR ${fmt(m.best.swr)} at ${m.best.mhz.toFixed(2)} MHz`])
    notes.push(['Under 2:1', m.under2 ? `${m.under2[0]}–${m.under2[1]} MHz (${(m.under2[1] - m.under2[0]).toFixed(1)} MHz wide)` : 'nowhere in the sweep'])
  }
  if (mesh && res) notes.push(['Resonance', res.mhz ? `X = 0 at ${res.mhz.toFixed(1)} MHz` : `none in the sweep (X stays ${res.xSign === 'negative' ? 'capacitive' : 'inductive'})`])
  else if (tw0) notes.push(['Resonance', `${fmtF(tw0.f)} MHz (${tw0.method})`])
  const hint = mesh && res ? trimOf(res, live?.sweep ? live.sweep.start / 1e6 : 850, live?.sweep ? live.sweep.stop / 1e6 : 980).head : tw0 ? trimWords().head : ''
  const hintLines = hint ? wrapText(`Trim: ${hint}`, 52) : []
  const H = 52 + rows.length * 34 + notes.length * 17 + hintLines.length * 15 + 26
  const p: string[] = []
  p.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="12" fill="${BG}"/>`)
  p.push(txt(14, 22, 'THE NUMBERS', { size: 10.5, fill: LCD, weight: 700, spacing: 1.5 }))
  const cols: [string, number][] = [['SWR', 92], ['RL dB', 140], ['refl %', 194], ['loss dB', 246], ['Z Ω', 300]]
  for (const [h, x] of cols) p.push(txt(x, 40, h, { size: 8.5, anchor: 'middle', fill: AXIS, weight: 700 }))
  rows.forEach((k, i) => {
    const y = 60 + i * 34
    p.push(`<rect x="10" y="${y - 14}" width="${W - 20}" height="28" rx="6" fill="#0f1a1e"/>`)
    p.push(txt(16, y - 1, (k.name ?? `${k.mhz}`).slice(0, 11), { size: 9.5, fill: BRIGHT, weight: 700 }))
    p.push(txt(16, y + 10, `${k.mhz} MHz`, { size: 8, fill: AXIS }))
    p.push(txt(92, y + 4, fmt(k.swr), { size: 12, anchor: 'middle', weight: 800, fill: zone(k.swr) }))
    p.push(txt(140, y + 4, (k.rl ?? 0).toFixed(1), { size: 10, anchor: 'middle', fill: LABEL }))
    p.push(txt(194, y + 4, (k.reflectedPct ?? 100 * gam(k.swr) ** 2).toFixed(1), { size: 10, anchor: 'middle', fill: LABEL }))
    p.push(txt(246, y + 4, fmt(k.mismatchDb, 2), { size: 10, anchor: 'middle', fill: LABEL }))
    p.push(txt(W - 14, y + 4, k.z ? `${k.z[0].toFixed(1)}${k.z[1] >= 0 ? '+' : '−'}j${Math.abs(k.z[1]).toFixed(1)}` : '—', { size: 9.5, anchor: 'end', fill: LABEL }))
  })
  let y = 60 + rows.length * 34 + 6
  for (const [k, v] of notes) {
    p.push(txt(16, y, k, { size: 9.5, fill: AXIS, weight: 700 }))
    p.push(txt(96, y, v, { size: 9.5, fill: BRIGHT }))
    y += 17
  }
  for (const l of hintLines) {
    p.push(txt(16, y + 2, l, { size: 10, fill: AMBER, font: SANS, weight: 700 }))
    y += 15
  }
  return svgDoc(W, H, p.join(''))
}

function stamp(t: number): string {
  const d = new Date(t)
  const h = d.getHours()
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

// The whole card. Every piece is the tab's own picture, so the card matches the tab exactly.
function exportSvg(name: string, now: number): string {
  const g: Geo = { W: W_PHONE, c: true }
  const m = live?.metrics as Metrics
  const sw = live?.sweep
  const cs = calStatus()
  const bd = activeBand()
  const x0 = (EXPORT_W - EXPORT_PIECE) / 2
  const parts: string[] = []
  let y = 0
  // The header: the antenna, when, and the instrument.
  const board = (live?.board ?? 'NanoVNA').replace(/NanoVNA-H 4/, 'NanoVNA-H4')
  const inst = `${board} · fw ${live?.version ?? '?'} · ${cs.ok && sw ? `calibrated ${sw.start / 1e6}–${sw.stop / 1e6} MHz` : 'NOT calibrated'}`
  parts.push(
    `<defs><linearGradient id="hd" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#0b1215"/><stop offset="1" stop-color="#10262a"/></linearGradient></defs>`,
  )
  parts.push(`<rect x="0" y="0" width="${EXPORT_W}" height="128" fill="url(#hd)"/>`)
  parts.push(`<rect x="0" y="128" width="${EXPORT_W}" height="3" fill="${LCD}"/>`)
  parts.push(
    `<g transform="translate(44,62)" fill="none" stroke="${LCD}" stroke-width="2.2" stroke-linecap="round"><path d="M0,24 V-16"/><circle cx="0" cy="-20" r="3.2" fill="${LCD}" stroke="none"/>` +
      `<path d="M-11,-31 A15,15 0 0 0 -11,-9 M11,-31 A15,15 0 0 1 11,-9" stroke-opacity="0.8"/><path d="M-19,-38 A25,25 0 0 0 -19,-2 M19,-38 A25,25 0 0 1 19,-2" stroke-opacity="0.45"/><path d="M-9,24 H9" stroke-width="3"/></g>`,
  )
  parts.push(txt(80, 42, 'ANTENNA REPORT', { size: 10.5, fill: LCD, weight: 700, spacing: 2.5 }))
  parts.push(txt(80, 72, cut(name, 26), { size: 26, fill: BRIGHT, weight: 800, font: SANS }))
  parts.push(txt(80, 94, `${stamp(now)}${bd ? ` · ${bd.name}` : ''}`, { size: 11.5, fill: LABEL, font: SANS }))
  parts.push(txt(80, 113, inst, { size: 10.5, fill: cs.ok ? '#9fb3bb' : AMBER, font: MONO }))
  y = 148
  const add = (src: string, k: string) => {
    const n = nestSvg(src, x0, y, EXPORT_PIECE, `${k}-`)
    parts.push(n.svg)
    y += n.h + 14
  }
  if (m) add(heroSvg(m, g), 'hero')
  const series = mainSeries()
  if (series.length) add(swrChart(series, g), 'swr')
  if (cmpA && cmpB && groups().some(x => x.label === cmpA) && groups().some(x => x.label === cmpB)) add(swrChart(cmpSeries(), g, true), 'cmp')
  if (series.length) add(smithChart(series, g), 'smith')
  if (m) add(numbersSvg(g), 'num')
  // The footer.
  parts.push(`<line x1="${x0}" x2="${EXPORT_W - x0}" y1="${y + 4}" y2="${y + 4}" stroke="#1f3a40"/>`)
  parts.push(txt(x0, y + 28, 'Wildcat RF', { size: 15, fill: LCD, weight: 800, font: SANS, spacing: 1 }))
  parts.push(txt(EXPORT_W - x0, y + 28, 'S11 · 50 Ω · NanoVNA tab', { size: 10, fill: AXIS, anchor: 'end' }))
  const H = y + 46
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${EXPORT_W}" height="${H}" viewBox="0 0 ${EXPORT_W} ${H}"><rect x="0" y="0" width="${EXPORT_W}" height="${H}" fill="#0b1012"/>${parts.join('')}</svg>`
}

async function exportCard($: any, name: string): Promise<string> {
  if (!live?.curve?.length || !live.metrics) {
    note = 'Nothing to export yet: no reading from the NanoVNA.'
    $.ui.invalidate('ui.render')
    return note
  }
  const label = name.trim() || 'Live'
  let text = ''
  const end = await intent(
    $,
    'Exporting the report card',
    async () => {
      const now = await $.clock.now()
      const svg = exportSvg(label, now)
      const tmp = `${HOME}/Library/Application Support/vna/export-${SESSION}.svg`
      await $.fs.write(tmp, svg)
      const r = await script($, ['export', '--svg', tmp, '--name', label], 60_000, 'free')
      if (!r?.svg) {
        text = `Export failed: ${r?.error ?? r?.say ?? 'no answer from vna.py'}`
        lastExport = { ok: false, say: text }
        return failed(text)
      }
      text = String(r.say ?? `Exported ${r.png ?? r.svg}`)
      lastExport = { ok: !!r.png, say: text, png: r.png ?? null, svg: r.svg }
      $.ui.toast(text, { timeoutMs: 9000 })
      return true
    },
    { key: K.export, plan: () => ({ step: 'drawing the card and making the PNG', ms: 4000, id: 'export' }) },
  )
  return endText(end, text, 'Export')
}
// ---------------------------------------------------------------- drawing the tab

// What every view draws with: the surface's elements, its width, and which pane it is in.
type Ctx = { els: any; surface: string; narrow: boolean; geo: Geo; Svg: any; Input: any; pane: string; now: number }

function ctxOf($: any, e: any, pane: string, now: number): Ctx {
  const els = $.ui.resolve(e) as any
  const surface = String(e.surface)
  const narrow = surface === 'mobile'
  // Every table names every element, an absent one drawing nothing, so pick by surface: the
  // terminal draws no Svg, the phone no Input.
  return { els, surface, narrow, geo: { W: narrow ? W_PHONE : W_DESK, c: narrow }, Svg: surface === 'terminal' ? null : els.Svg, Input: narrow ? null : els.Input, pane, now }
}

// A picture with its height from its markup (svgHeight), so a refreshed picture never drops to no
// height while it loads. hover: drawn interactive on the desktop, where its <title> tooltips work.
function Pic(ctx: Ctx, source: string, alt: string, hover = false): unknown {
  const S = ctx.Svg
  if (!S) return null
  return <S source={source} alt={alt} height={svgHeight(source, ctx.geo.W)} {...(hover && ctx.surface === 'desktop' ? { isInteractive: true } : {})} />
}

// A section's title row, marked like the Radio tab's: a coloured bar, the title, a dim hint, and
// ⤢ to open it in its own tab (not in that tab itself).
function Head($: any, ctx: Ctx, p: { k: string; title: string; hint?: string; color?: string; tab?: TabView; extra?: unknown }): unknown {
  const { Box, Text, Button } = ctx.els
  const tab = p.tab && ctx.pane !== TABS[p.tab].id ? p.tab : undefined
  return (
    <Box key={p.k} flexWrap="wrap" paddingTop={1}>
      <Text color={p.color ?? LCD}>{'▍'}</Text>
      <Text bold>{p.title}</Text>
      {p.hint ? <Text dimColor wrap="wrap">{`   ${p.hint}`}</Text> : null}
      {p.extra || tab ? <Text>{'   '}</Text> : null}
      {p.extra ?? null}
      {p.extra && tab ? <Text> </Text> : null}
      {tab ? <Button key={`tab:${tab}`} plain dimColor label={ctx.narrow ? '⤢' : '⤢ own tab'} onPress={() => void openTab($, tab)} /> : null}
    </Box>
  )
}

function Btn(ctx: Ctx, key: string, l: Look | string, press: () => void, primary = false, plain = false): unknown {
  const { Box, Button } = ctx.els
  const lk = typeof l === 'string' ? { label: l } : l
  return (
    <Box key={`bx:${key}`} paddingRight={1}>
      <Button key={key} label={lk.label} {...(primary || lk.variant ? { variant: 'primary' } : {})} {...(lk.dimColor ? { dimColor: true } : {})} {...(plain ? { plain: true } : {})} onPress={press} />
    </Box>
  )
}

// The top of every pane: the NanoVNA, the band and its calibration, what a press is doing and what waits.
function topRows($: any, ctx: Ctx, full: boolean): unknown {
  const { Box, Text } = ctx.els
  const connected = !!live?.connected
  const cs = calStatus()
  const bd = activeBand()
  const doing = doingLine()
  const queued = queuedLine()
  const lw = ctx.narrow ? 7 : 11
  return (
    <Box key="top" flexDirection="column">
      <Box key="hdr" flexWrap="wrap">
        <Text color={connected ? LCD : AXIS}>{connected ? '● ' : '○ '}</Text>
        <Text bold>NanoVNA</Text>
        <Text dimColor>
          {'   '}
          {connected
            ? `${live?.board ?? ''} · ${live?.via === 'wifi' ? 'over Wi-Fi' : 'USB'} · firmware ${live?.version ?? '?'}${live?.vbatMv && full ? ` · battery ${(live.vbatMv / 1000).toFixed(2)} V` : ''} · ${liveOn ? 'live, every 3 s' : 'paused'}`
            : 'not connected'}
        </Text>
      </Box>
      {!connected && live?.bridge && full ? (
        <Text key="bridge" color={live.bridge.state === 'offline' ? undefined : AMBER} dimColor={live.bridge.state === 'offline'} wrap="wrap">
          {`Wi-Fi bridge ${live.bridge.host}${live.bridge.ip ? ` (${live.bridge.ip})` : ''}: ${live.bridge.state}.`}
        </Text>
      ) : null}
      {!connected && full ? (
        <Text key="plug" dimColor wrap="wrap">
          Switch it on and plug it into the Mac with a USB-A to USB-C cable (many NanoVNA-H4s don't connect over C-to-C), or wire it to the Wi-Fi bridge. The tab checks every 15 s.
        </Text>
      ) : null}
      {connected ? (
        <Box key="band" flexWrap="wrap">
          <Text color={bd ? bandColor(bd) : AXIS}>{bd ? `${bd.name}` : 'Custom sweep'}</Text>
          <Text dimColor>{bd ? (bd.id === 'mesh' ? ' · slot 0 is the power-on state' : bd.slot ? ` · slot ${bd.slot}` : '') : ''}</Text>
          <Text>{'   '}</Text>
          <Text color={cs.color} wrap="wrap">{cs.text}</Text>
        </Box>
      ) : null}
      {shareNote ? <Text key="share" dimColor wrap="wrap">{shareNote}</Text> : null}
      {busyNote ? <Text key="busy" color={AMBER} wrap="wrap">{`${busyNote}${liveAt ? ` Showing the reading from ${ago(ctx.now - liveAt)} ago.` : ''}`}</Text> : null}
      {doing ? (
        <Box key="doing" flexWrap="wrap">
          <Box width={lw}>
            <Text dimColor>{ctx.narrow ? 'Doing' : 'Doing now'}</Text>
          </Box>
          <Text color={CYAN} wrap="wrap">{doing}</Text>
        </Box>
      ) : null}
      {queued ? (
        <Box key="queued" flexWrap="wrap">
          <Box width={lw}>
            <Text dimColor>Next</Text>
          </Box>
          <Text dimColor wrap="wrap">{queued}</Text>
        </Box>
      ) : null}
    </Box>
  )
}

// Measure · Trim · Library · QC · Bands, then ? and 📸 Export.
function navRow($: any, ctx: Ctx): unknown {
  const { Box } = ctx.els
  return (
    <Box key="nav" flexWrap="wrap" paddingTop={1}>
      {SECTIONS.map(([k, name]) => Btn(ctx, `sec:${k}`, name, () => void setSection($, k), section === k))}
      {Btn(ctx, 'guide', guideOpen ? '? close guide' : '?', () => {
        guideOpen = !guideOpen
        $.ui.invalidate('ui.render')
      }, guideOpen)}
      {Btn(ctx, 'export', look(K.export, '📸 Export', 'Exporting…', 'Queued: Export'), () => void exportCard($, ''))}
    </Box>
  )
}

function Row(ctx: Ctx, p: { name: string; mark?: Mark; k?: string }): unknown {
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

// The guided calibration, wherever it is under way.
function calBox($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  if (!cal?.step) return null
  const bd = bandById(cal.band)
  const n = cal.step === 'open' ? '1' : cal.step === 'short' ? '2' : '3'
  return (
    <Box key="calbox" flexDirection="column" paddingTop={1}>
      <Text bold color={AMBER}>{`Calibration${cal.band === 'mesh' ? '' : ` · ${bd?.name ?? cal.band} → slot ${bd?.slot ?? '?'}`} · ${n} of 3`}</Text>
      <Text color={cal.ok ? undefined : RED} wrap="wrap">{cal.say}</Text>
      <Box paddingTop={1} flexWrap="wrap">
        {Btn(ctx, 'cal-next', look(K.cal(cal.band, cal.step), `${cal.step.toUpperCase()} is on`, `Capturing ${cal.step.toUpperCase()}…`), () => void calStep($, cal?.band ?? 'mesh', cal?.step ?? 'begin'), true)}
        {Btn(ctx, 'cal-cancel', look(K.cal(cal.band, 'cancel'), 'Cancel', 'Cancelling…'), () => void calStep($, cal?.band ?? 'mesh', 'cancel'))}
      </Box>
    </Box>
  )
}

// ---- Measure: the reading, the readings, the trimming drawing, the chart, save and tools

function readingView($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  const m = live?.metrics ?? null
  const connected = !!live?.connected
  const portOpen = !!(connected && m && m.best.swr > 15)
  const reading = connected && m && !portOpen
  const hm = m ? heroMarks(m) : null
  const bd = activeBand()
  const mesh = !bd || bd.id === 'mesh'
  const res = m?.resonance
  const gr = hm?.who ? grade(Math.max(hm.mt.swr, hm.mc?.swr ?? 0)) : gradeOf(m)
  const vline = m ? (hm?.who ? bandVerdict(Math.max(hm.mt.swr, hm.mc?.swr ?? 0), hm.who) : verdictLine(m)) : ''
  return (
    <Box key="reading" flexDirection="column">
      {portOpen ? (
        <Box key="open" flexDirection="column" paddingTop={1}>
          <Text bold color={AMBER}>PORT 1 reads open: nothing is connecting.</Text>
          <Text dimColor wrap="wrap">
            No antenna, a loose connector, or an RP-SMA antenna. RP-SMA has the same threads as SMA but a hole in the middle instead of a pin, so on the NanoVNA's SMA port nothing touches. Look inside the antenna's plug: a pin is SMA, a hole is RP-SMA and needs an RP-SMA to SMA adapter.
          </Text>
        </Box>
      ) : null}
      {reading && m && hm ? (
        <Box key="hero" flexDirection="column">
          {Head($, ctx, { k: 'hero-head', title: 'Reading', hint: ctx.narrow ? '' : mesh ? 'SWR at the two mesh channels, the grade and what it means' : `SWR at ${bd?.name}'s target`, tab: 'reading' })}
          {ctx.Svg ? (
            Pic(ctx, heroSvg(m, ctx.geo), `${mesh ? heroLine(hm.mt) : `SWR ${fmt(hm.mt.swr)} at ${hm.mt.mhz} MHz (${hm.mt.name}) · ${verdict(hm.mt.swr).text}`} · grade ${gr ?? '—'}: ${vline}`)
          ) : (
            <Box flexDirection="column">
              <Text bold color={verdict(hm.mt.swr).color}>
                {`SWR ${fmt(hm.mt.swr)} at ${hm.mt.mhz} MHz · ${verdict(hm.mt.swr).text}`}
              </Text>
              <Box flexWrap="wrap">
                <Text color={zone(hm.mt.swr)}>{meterBar(hm.mt.swr)}</Text>
                <Text dimColor>{'  1 ─ 1.5 ─ 2 ─ 4'}</Text>
              </Box>
              <Text bold color={GRADE_COLOR[gr ?? 'F']}>{`Grade ${gr ?? '—'} · ${vline}`}</Text>
              <Text wrap="wrap">
                {meaning(hm.mt.swr)} · {fmt(hm.mt.mismatchDb, 2)} dB mismatch loss · return loss {(hm.mt.rl ?? 0).toFixed(1)} dB
              </Text>
            </Box>
          )}
        </Box>
      ) : null}
      {reading && m ? (
        <Box key="rows" flexDirection="column" paddingTop={1}>
          {mesh
            ? [Row(ctx, { name: 'Meshtastic', mark: m.meshtastic }), Row(ctx, { name: 'MeshCore', mark: m.meshcore }), Row(ctx, { name: '915', mark: m.mid })]
            : (bd?.targets ?? []).map(([f, n]) => Row(ctx, { name: n, mark: markAt(f, n), k: `t:${f}` }))}
          {(live?.markers ?? []).length ? (
            <Box key="mks" flexDirection="column" paddingTop={1}>
              <Text dimColor>Markers on the NanoVNA</Text>
              {(live?.markers ?? []).map(mk => Row(ctx, { name: `M${mk.id}`, mark: mk, k: `mk${mk.id}` }))}
            </Box>
          ) : null}
          <Text dimColor wrap="wrap">
            Best SWR {fmt(m.best.swr)} at {m.best.mhz} MHz · {m.under2 ? `under 2 from ${m.under2[0]} to ${m.under2[1]} MHz` : 'never under 2 in this sweep'}
          </Text>
          {res && mesh ? (
            <Box key="res" flexDirection="column" paddingTop={1}>
              {ctx.Svg ? Pic(ctx, trimSvg(res, ctx.geo), trimAlt(res)) : null}
              <Text bold={!ctx.Svg} dimColor={!!ctx.Svg} color={ctx.Svg ? undefined : res.trim === 'on' ? GREEN : undefined} wrap="wrap">
                {res.hint}
              </Text>
              {res.caveat ? <Text dimColor wrap="wrap">{res.caveat}</Text> : null}
            </Box>
          ) : null}
          {!mesh ? <Text key="trimhint" dimColor wrap="wrap">{`Cutting or bending an antenna for ${bd?.name ?? 'this band'}? Trim shows where it resonates against ${trimTarget().f} MHz as you go.`}</Text> : null}
          <Box key="mkrow" paddingTop={1} flexWrap="wrap">
            {mesh ? Btn(ctx, 'mk-mesh', look(K.markers('mesh'), 'Markers on 907 / 910.5 / 915', 'Placing…'), () => void setMarkers($, 'mesh')) : null}
            {Btn(ctx, 'mk-best', look(K.markers('best'), 'Markers to best', 'Moving…'), () => void setMarkers($, 'best'))}
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

function viewButtons($: any, ctx: Ctx, prefix: string): unknown {
  const { Box } = ctx.els
  return (
    <Box key={`${prefix}vbtns`} flexWrap="wrap">
      {VIEWS.map(([k, name]) => Btn(ctx, `${prefix}${k}`, name, () => void setView($, k), view === k))}
    </Box>
  )
}

function chartView($: any, ctx: Ctx, only?: View): unknown {
  const { Box, Text } = ctx.els
  const series = mainSeries()
  const hist = histLabel ? groups().find(g => g.label === histLabel) : undefined
  if (ctx.Svg && series.length) {
    const v = only ?? view
    return (
      <Box key="chart" flexDirection="column">
        {Head($, ctx, { k: 'chart-head', title: only === 'smith' ? 'Smith chart' : 'Chart', hint: ctx.narrow ? '' : only === 'smith' ? 'impedance as one picture' : 'four ways to see the same sweep', tab: only === 'smith' ? undefined : 'chart', extra: only === 'smith' || ctx.pane === TABS.smith.id ? null : ctx.els.Button ? <ctx.els.Button key="tab:smith" plain dimColor label={ctx.narrow ? '⤢ Smith' : '⤢ Smith alone'} onPress={() => void openTab($, 'smith')} /> : null })}
        {only ? null : viewButtons($, ctx, 'view:')}
        {hist ? <Text dimColor>{`Showing every sweep of ${hist.label}, oldest dim, newest bright, in its own colour.`}</Text> : null}
        <Box paddingTop={1}>{Pic(ctx, chart(v, series, ctx.geo), `${VIEWS.find(([k]) => k === v)?.[1]} chart of ${series.map(s => s.label).join(', ')}`)}</Box>
        <Text dimColor wrap="wrap">{explainFor(v)}</Text>
      </Box>
    )
  }
  if (!ctx.Svg && live?.curve?.length) {
    return (
      <Box key="strip" flexDirection="column" paddingTop={1}>
        <Box>
          {stripRuns().map(([s, col], k) => (
            <Text key={`st${k}`} color={col}>{s}</Text>
          ))}
        </Box>
        <Text dimColor>{`${live.sweep ? live.sweep.start / 1e6 : ''} MHz … ${live.sweep ? live.sweep.stop / 1e6 : ''} MHz · SWR, low is good: green under 1.5, amber under 2, red above · charts draw on the desktop and phone`}</Text>
      </Box>
    )
  }
  return null
}

// A view's explanation, about the band being swept (the mesh band's words on the mesh sweep).
function explainFor(v: View): string {
  const b = activeBand()
  if (!b || b.id === 'mesh') return EXPLAIN[v]
  const r = `${Number(b.band[0].toFixed(2))}–${Number(b.band[1].toFixed(2))} MHz`
  return EXPLAIN[v].replace('the US 902–928 MHz band', `the ${b.name} band, ${r}`).replace('the bright stretch is 902–928 MHz', `the bright stretch is ${r}`)
}

function toolsRows($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  const n = groups().length + 1
  const bd = activeBand()
  const calBand = bd && bd.id !== 'mesh' ? bd.id : 'mesh'
  const x = xOn()
  return (
    <Box key="tools" flexDirection="column">
      <Box key="tools-row" paddingTop={1} flexWrap="wrap">
        {Btn(ctx, 'live', liveOn ? 'Pause live' : 'Resume live', () => void setLive($, !liveOn))}
        {ctx.Input ? null : Btn(ctx, 'save-quick', look(K.save(`Antenna ${n}`), `Save as Antenna ${n}`, 'Saving…'), () => void saveAntenna($, `Antenna ${n}`), true)}
        {cal?.step ? null : Btn(ctx, 'cal', look(K.cal(calBand, 'begin'), calBand === 'mesh' ? 'Calibrate' : `Calibrate ${bd?.short}`, 'Starting…'), () => void calStep($, calBand, 'begin'))}
        {Btn(ctx, 'shot', look(K.shot, 'Screenshot', 'Capturing…'), () => void takeShot($))}
        {Btn(ctx, 'xtrace', look(K.xtrace(!x), x ? 'Trace 4: X ✓' : 'Trace 4: X', x ? 'Hiding…' : 'Showing X…'), () => void setXTrace($, !x))}
        {Btn(ctx, 'layout', look(K.layout, 'Mesh layout', 'Setting…'), () => void layout($), false, true)}
      </Box>
      <Text key="tools-hint" dimColor wrap="wrap">
        {`Calibrate: OPEN, SHORT, LOAD on PORT 1${calBand === 'mesh' ? ', saved to slot 0' : `, saved to ${bd?.short}'s slot ${bd?.slot ?? '?'}`}. Screenshot: the NanoVNA's own screen. Trace 4: X (reactance) on the NanoVNA's screen, not saved: X crosses zero where the antenna resonates; it tells you longer or shorter.`}
      </Text>
      {ctx.Input ? (
        <Box key="save-in" paddingTop={1}>
          <ctx.Input key="save-name" label="Save this antenna" placeholder="Name it, e.g. Nag stock whip (same name = new version)" submitLabel="Save" onSubmit={(v: string) => void saveAntenna($, v)} />
        </Box>
      ) : null}
    </Box>
  )
}

function measureView($: any, ctx: Ctx): unknown {
  const { Box } = ctx.els
  return (
    <Box key="measure" flexDirection="column">
      {readingView($, ctx)}
      {chartView($, ctx)}
      {toolsRows($, ctx)}
    </Box>
  )
}

// ---- Trim

function trimView($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  const bd = activeBand() ?? MESH_BAND
  const t = trimTarget()
  const cs = calStatus()
  const w = trimWords()
  return (
    <Box key="trim" flexDirection="column">
      {Head($, ctx, { k: 'trim-head', title: 'Trim assistant', color: YELLOW, hint: ctx.narrow ? '' : 'for cutting or bending: where it resonates now, and every change you make', tab: 'trim' })}
      <Box key="targets" flexWrap="wrap">
        {bd.targets.map(([f, n]) => Btn(ctx, `tt:${f}`, `${n} ${f}`, () => void setTrimTarget($, f), Math.abs(t.f - f) < 1e-6))}
      </Box>
      {!cs.ok && live?.connected ? <Text key="uncal" color={AMBER} wrap="wrap">{`${cs.tag}: ${cs.text} Where it resonates still moves the right way as you trim.`}</Text> : null}
      {ctx.Svg ? (
        <Box key="trim-pics" flexDirection="column" paddingTop={1}>
          {Pic(ctx, trimLiveSvg(ctx.geo), trimLiveAlt())}
          <Box paddingTop={1}>{Pic(ctx, trimTimelineSvg(ctx.geo), trimTimelineAlt())}</Box>
        </Box>
      ) : (
        <Box key="trim-text" flexDirection="column" paddingTop={1}>
          <Text bold color={w.col} wrap="wrap">{trimNow() && !trimNow()?.edge ? `Resonant at ${fmtF(trimNow()?.f ?? 0)} MHz · ${w.head}` : w.head}</Text>
          <Text dimColor wrap="wrap">{w.sub}</Text>
          {w.undo ? <Text color={RED} wrap="wrap">{w.undo}</Text> : null}
          {trimPts.slice(-10).map(p => (
            <Text key={`tp:${p.n}`} color={p.passed ? RED : Math.abs(p.delta) <= trimTols(t.f).on ? GREEN : undefined}>{`#${String(p.n).padEnd(3)} ${fmtF(p.f).padStart(7)} MHz  ${p.delta >= 0 ? '+' : '−'}${fmtOff(p.delta).padEnd(8)} ${p.how}${p.passed ? '  passed' : ''}`}</Text>
          ))}
        </Box>
      )}
      <Box key="trim-btns" paddingTop={1} flexWrap="wrap">
        {Btn(ctx, 'snip', '✂ Snip', () => void trimSnip($), true)}
        {Btn(ctx, 'trim-reset', 'New timeline', () => void trimReset($))}
      </Box>
      <Text key="trim-help" dimColor wrap="wrap">
        {`Cut a little, let go of the antenna, and the tab logs the change once the dip holds still (or press ✂ Snip). Below the target means electrically long: shorten it. Above means short: add length or straighten a bend. It uses the live sweep and changes nothing on the NanoVNA. Resonance is where X crosses zero; a matched antenna with no crossing uses the bottom of the SWR dip.`}
      </Text>
    </Box>
  )
}

// ---- Library

function libraryView($: any, ctx: Ctx): unknown {
  const { Box, Text, Button } = ctx.els
  const gs = groups()
  const cmpGroups = [cmpA, cmpB].map(l => (l ? gs.find(g => g.label === l) : undefined))
  const hist = histLabel ? gs.find(g => g.label === histLabel) : undefined
  cmpColors()
  return (
    <Box key="library" flexDirection="column">
      {cmpA || cmpB ? (
        <Box key="cmp" flexDirection="column">
          {Head($, ctx, {
            k: 'cmp-head',
            title: 'Compare',
            color: MAGENTA,
            hint: cmpGroups[0] && cmpGroups[1] ? 'latest sweep of each · the better one is starred and shades the chart' : 'pick A and B on the antennas below',
            extra: <Button key="cmp-clear" plain label="clear" onPress={() => void (async () => {
              cmpA = cmpB = null
              await saveStore($)
              $.ui.invalidate('ui.render')
            })()} />,
          })}
          <Box>
            <Box width={14}>
              <Text dimColor> </Text>
            </Box>
            <Box width={18}>
              <Text bold color={colA}>{`A · ${cmpA ?? '—'}`}</Text>
            </Box>
            <Box width={18}>
              <Text bold color={colB}>{`B · ${cmpB ?? '—'}`}</Text>
            </Box>
          </Box>
          {cmpGroups[0] && cmpGroups[1]
            ? compareRows(cmpGroups[0], cmpGroups[1]).map(([k, va, vb, win]) => (
                <Box key={`cmp:${k}`}>
                  <Box width={14}>
                    <Text dimColor>{k}</Text>
                  </Box>
                  <Box width={18}>
                    <Text bold={win < 0} color={win < 0 ? GREEN : undefined}>{`${va}${win < 0 ? ' ★' : ''}`}</Text>
                  </Box>
                  <Box width={18}>
                    <Text bold={win > 0} color={win > 0 ? GREEN : undefined}>{`${vb}${win > 0 ? ' ★' : ''}`}</Text>
                  </Box>
                </Box>
              ))
            : null}
          {ctx.Svg && cmpGroups[0] && cmpGroups[1] ? (
            <Box key="cmp-pic" flexDirection="column" paddingTop={1}>
              {viewButtons($, ctx, 'cview:')}
              {Pic(ctx, chart(view, cmpSeries(), ctx.geo, true), `${cmpA} against ${cmpB}`)}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {hist ? (
        <Box key="hist" flexDirection="column">
          {Head($, ctx, {
            k: 'hist-head',
            title: `History · ${hist.label}`,
            color: antColor(hist.label),
            hint: `${hist.items.length} sweeps${hist.items.length > 1 ? ` · SWR at 907 ${trend(hist)}` : ''} · on the Measure chart`,
            extra: <Button key="hist-close" plain label="close" onPress={() => void showHistory($, null)} />,
          })}
          {hist.items.map((i, k) => (
            <Box key={`hv:${i.file}`}>
              <Box width={4}>
                <Text color={histColor(hist.label, k, hist.items.length)}>{`v${k + 1}`}</Text>
              </Box>
              <Box width={16}>
                <Text dimColor>{day(i.saved)}</Text>
              </Box>
              <Box width={10}>
                <Text color={verdict(i.metrics?.meshtastic?.swr).color}>{fmt(i.metrics?.meshtastic?.swr)}</Text>
              </Box>
              <Box width={18}>
                <Text dimColor>{i.metrics ? `best ${fmt(i.metrics.best.swr)} @${i.metrics.best.mhz.toFixed(0)}` : ''}</Text>
              </Box>
              <Text dimColor>{i.metrics?.resonance?.mhz ? `res ${i.metrics.resonance.mhz.toFixed(1)}` : ''}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {Head($, ctx, {
        k: 'lib-head',
        title: 'Antennas',
        color: MAGENTA,
        hint: gs.length ? `${gs.length} saved, best first by SWR at 907, each in its own colour · ${ctx.Svg ? '○ chart overlays it on Measure, A/B compares, versions shows its history' : '◉ shows it on the chart, A/B compares, versions overlays its history'}` : 'none saved yet: Save on Measure',
        tab: 'library',
      })}
      {ctx.Svg ? (
        <Box key="cards" flexWrap="wrap">
          {gs.map(g => {
            const i = g.latest
            const shown = overlays.includes(i.file) && !histLabel
            return (
              <Box key={`card:${g.label}`} flexDirection="column" paddingRight={ctx.narrow ? 0 : 1} paddingBottom={1}>
                {Pic(ctx, cardSvg(g, ctx.geo, shown ? 'chart' : histLabel === g.label ? 'history' : undefined), cardAlt(g))}
                <Box flexWrap="wrap">
                  {Btn(ctx, `ov:${i.file}`, shown ? '◉ on chart' : '○ chart', () => void setOverlay($, i.file, !shown), shown)}
                  {Btn(ctx, `a:${g.label}`, 'A', () => void pick($, 'A', cmpA === g.label ? null : g.label), cmpA === g.label)}
                  {Btn(ctx, `b:${g.label}`, 'B', () => void pick($, 'B', cmpB === g.label ? null : g.label), cmpB === g.label)}
                  {g.items.length > 1 ? Btn(ctx, `h:${g.label}`, `${g.items.length} versions`, () => void showHistory($, histLabel === g.label ? null : g.label), histLabel === g.label) : null}
                </Box>
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box key="lib-rows" flexDirection="column">
          {gs.length ? (
            <Box>
              <Box width={30}>
                <Text dimColor> </Text>
              </Box>
              <Box width={8}>
                <Text dimColor>@907</Text>
              </Box>
              <Box width={8}>
                <Text dimColor>@910.5</Text>
              </Box>
              <Box width={20}>
                <Text dimColor>trend</Text>
              </Box>
            </Box>
          ) : null}
          {gs.map(g => {
            const i = g.latest
            const shown = overlays.includes(i.file) && !histLabel
            const gg = gradeOf(i.metrics)
            return (
              <Box key={`g:${g.label}`} flexWrap="wrap">
                <Box width={4}>
                  <Button key={`ov:${i.file}`} plain label={shown ? '◉' : '○'} onPress={() => void setOverlay($, i.file, !shown)} />
                </Box>
                <Box width={4}>
                  <Text bold color={gg ? GRADE_COLOR[gg] : undefined}>{gg ?? ' '}</Text>
                </Box>
                <Box width={22}>
                  <Text bold color={antColor(g.label)}>{g.label}</Text>
                </Box>
                <Box width={8}>
                  <Text color={verdict(i.metrics?.meshtastic?.swr).color}>{fmt(i.metrics?.meshtastic?.swr)}</Text>
                </Box>
                <Box width={8}>
                  <Text color={verdict(i.metrics?.meshcore?.swr).color}>{fmt(i.metrics?.meshcore?.swr)}</Text>
                </Box>
                <Box width={20}>
                  <Text dimColor>{trend(g)}</Text>
                </Box>
                {Btn(ctx, `a:${g.label}`, 'A', () => void pick($, 'A', cmpA === g.label ? null : g.label), cmpA === g.label)}
                {Btn(ctx, `b:${g.label}`, 'B', () => void pick($, 'B', cmpB === g.label ? null : g.label), cmpB === g.label)}
                {g.items.length > 1 ? Btn(ctx, `h:${g.label}`, `${g.items.length} versions`, () => void showHistory($, histLabel === g.label ? null : g.label), histLabel === g.label, true) : null}
                <Text dimColor>{day(i.saved)}</Text>
              </Box>
            )
          })}
        </Box>
      )}
      <Text key="lib-files" dimColor wrap="wrap">{`Sweeps are Touchstone files in ${libDir}. /vna save <name>, /vna compare <a> <b>, /vna history <name>, /vna delete <name>.`}</Text>
    </Box>
  )
}

// ---- QC

function qcView($: any, ctx: Ctx): unknown {
  const { Box, Text, Button } = ctx.els
  const connected = !!live?.connected
  const m = live?.metrics
  const reading = connected && m && m.best.swr <= 15
  const q = live?.curve && onMesh() ? qcEvalTs(live.curve, qcRules) : undefined
  return (
    <Box key="qc" flexDirection="column">
      {Head($, ctx, { k: 'qc-head', title: 'QC mode', color: AMBER, hint: qcLog ? `${qcLog.total} tested · ${qcLog.passed} pass · ${qcLog.failed} fail` : undefined, tab: 'qc' })}
      {connected && !onMesh() ? <Text key="qc-band" color={AMBER} wrap="wrap">QC tests mesh units on the 850–980 MHz sweep: press Back to Meshtastic in Bands first.</Text> : null}
      {q && reading ? (
        ctx.Svg ? (
          Pic(ctx, qcSvg(q, ctx.geo), qcAlt(q))
        ) : (
          <Box flexDirection="column">
            {blocks(q.pass ? 'PASS' : 'FAIL').map((l, k) => (
              <Text key={`blk${k}`} bold color={q.pass ? GREEN : RED}>{l}</Text>
            ))}
            {q.checks.map(c => (
              <Box key={`qc:${c.id}`} flexWrap="wrap">
                <Box width={3}>
                  <Text bold color={c.pass ? GREEN : RED}>{c.pass ? '✓' : '✗'}</Text>
                </Box>
                <Text color={c.pass ? undefined : RED}>{c.label}</Text>
                <Text dimColor>{'  '}{c.detail}</Text>
              </Box>
            ))}
          </Box>
        )
      ) : (
        <Text dimColor>{connected ? 'Waiting for a reading…' : 'Connect the NanoVNA to test.'}</Text>
      )}
      <Text dimColor wrap="wrap">Rule: {ruleText(qcRules)}. Change it with /vna qc rules.</Text>
      {connected && !live?.calibrated ? (
        <Text color={AMBER} wrap="wrap">Not calibrated: QC records are refused until the NanoVNA is calibrated, since the numbers could be far off.</Text>
      ) : null}
      <Box paddingTop={1} flexWrap="wrap">
        {Btn(ctx, 'qc-save', look(K.qcSave, `Save as ${qcLog?.next ?? 'Unit 1'}`, 'Recording…', 'Queued: Recording QC'), () => void qcSave($, qcLog?.next ?? ''), true)}
        {qcLog ? <Button key="qc-log" plain label="open log" onPress={() => void openFile($, qcLog?.log ?? '')} /> : null}
        {qcLog ? <Text> </Text> : null}
        {qcLog ? <Button key="qc-dir" plain label="open folder" onPress={() => void openFile($, qcLog?.dir ?? '')} /> : null}
      </Box>
      {ctx.Input ? (
        <Box paddingTop={1}>
          <ctx.Input key="qc-unit" label="Record with a unit id" placeholder="e.g. WC-0042" submitLabel="Record" onSubmit={(v: string) => void qcSave($, v)} />
        </Box>
      ) : null}
      {lastQc ? (
        <Box flexWrap="wrap">
          <Text color={lastQc.ok ? undefined : AMBER} wrap="wrap">{lastQc.say}</Text>
          {lastQc.cert ? <Text> </Text> : null}
          {lastQc.cert ? <Button key="qc-cert" plain label="open certificate" onPress={() => void openFile($, lastQc?.cert ?? '')} /> : null}
        </Box>
      ) : null}
      {(qcLog?.records ?? []).slice(0, 5).map(r => (
        <Box key={`rec:${r.timestamp}:${r.unit}`} flexWrap="wrap">
          <Box width={14}>
            <Text>{r.unit}</Text>
          </Box>
          <Box width={6}>
            <Text bold color={r.result === 'PASS' ? GREEN : RED}>{r.result}</Text>
          </Box>
          <Box width={22}>
            <Text dimColor>{`SWR ${n2(r.swr_906_875)} / ${n2(r.swr_910_525)}`}</Text>
          </Box>
          <Box width={16}>
            <Text dimColor>{day(r.timestamp ?? '')}</Text>
          </Box>
          {r.certificate ? <Button key={`cert:${r.timestamp}:${r.unit}`} plain dimColor label="certificate" onPress={() => void openFile($, r.certificate ?? '')} /> : null}
        </Box>
      ))}
    </Box>
  )
}

// ---- Bands

function bandsView($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  const act = activeBand()
  const x = xOn()
  const bands = bandsAll()
  const dip = DIPOLE_TARGETS.find(d => d[0] === dipoleF) ?? DIPOLE_TARGETS[5] ?? [1090, 'ADS-B', 'adsb']
  return (
    <Box key="bands" flexDirection="column">
      {Head($, ctx, { k: 'bands-head', title: 'Bands', color: SKY, hint: ctx.narrow ? '' : 'your other radios: each band keeps its calibration in its own save slot', tab: 'bands' })}
      <Text key="poweron-line" bold color={LCD} wrap="wrap">Power-on is always slot 0, the Meshtastic layout, unchanged.</Text>
      {ctx.Svg ? Pic(ctx, bandsSvg(ctx.geo), bandsAlt(), true) : null}
      {bands.map(b => {
        const col = bandColor(b)
        const now = act?.id === b.id
        const st = b.id === 'mesh' ? 'slot 0 · power-on' : b.calOk ? `slot ${b.slot} · CAL ${b.cal?.at ? day(b.cal.at) : ''}` : b.slot ? `slot ${b.slot} · UNCAL` : `no slot · ${b.slotWhy ?? ''}`
        return (
          <Box key={`brow:${b.id}`} flexDirection="column" paddingTop={1}>
            <Box flexWrap="wrap">
              <Text color={col}>{now ? '● ' : '○ '}</Text>
              <Text bold color={col}>{b.name}</Text>
              <Text dimColor>{`   ${b.band[0]}–${b.band[1]} MHz · sweep ${b.start / 1e6}–${b.stop / 1e6} · `}</Text>
              <Text color={b.id === 'mesh' ? LCD : b.calOk ? GREEN : b.slot ? AMBER : RED}>{st}</Text>
            </Box>
            {b.for && !ctx.narrow ? <Text dimColor wrap="wrap">{`For ${b.for}.${b.shares?.length ? ` Shares slot ${b.slot} with ${b.shares.join(', ')}: calibrating one replaces the other's.` : ''}${b.calOther ? ` Slot ${b.slot} holds ${b.calOther}'s calibration now.` : ''}`}</Text> : null}
            <Box flexWrap="wrap">
              {b.id === 'mesh'
                ? Btn(ctx, 'band:mesh', look(K.band('mesh'), 'Back to Meshtastic', 'Recalling slot 0…', 'Queued: Back to Meshtastic'), () => void switchBand($, 'mesh'), !now)
                : Btn(ctx, `band:${b.id}`, look(K.band(b.id), now ? `On ${b.short}` : `Switch to ${b.short}`, b.calOk ? `Recalling slot ${b.slot}…` : 'Sweeping…'), () => void switchBand($, b.id), false)}
              {b.id !== 'mesh' && b.slot ? Btn(ctx, `bcal:${b.id}`, look(K.cal(b.id, 'begin'), b.calOk ? `Recalibrate → slot ${b.slot}` : `Calibrate → slot ${b.slot}`, 'Starting…'), () => void calStep($, b.id, 'begin'), !b.calOk && now) : null}
            </Box>
          </Box>
        )
      })}
      {calBox($, ctx)}

      {Head($, ctx, { k: 'screen-head', title: 'NanoVNA screen', color: LCD, hint: ctx.narrow ? '' : 'the optional 4th trace, and what the NanoVNA starts with' })}
      <Box key="xrow" flexWrap="wrap">
        {Btn(ctx, 'xtrace', look(K.xtrace(!x), x ? 'Trace 4: X ✓ (hide)' : 'Show X on trace 4', x ? 'Hiding…' : 'Showing X…'), () => void setXTrace($, !x), x)}
        {Btn(ctx, 'poweron-ask', look(K.powerOn, 'Make this my power-on layout…', 'Saving slot 0…'), () => void powerOnAsk($))}
      </Box>
      <Text key="xtip" dimColor wrap="wrap">
        {`Trace 4 = X, the reactance: X crosses zero where the antenna resonates; it tells you longer or shorter (below zero: electrically short, above: long). The toggle changes the NanoVNA's screen now and saves nothing: switched off and on, it starts as before. Power-on today: ${presets?.powerOn ? `saved by the tab ${day(presets.powerOn.at)}, trace 4 ${presets.powerOn.trace3 === 'x' ? 'X' : 'off'}` : 'SWR · Smith · LOGMAG, trace 4 off'}.`}
      </Text>
      {confirmPowerOn ? (
        <Box key="confirm" flexDirection="column" paddingTop={1}>
          <Text bold color={AMBER}>Save slot 0?</Text>
          <Text color={AMBER} wrap="wrap">{powerOnWhat()}</Text>
          <Box flexWrap="wrap">
            {Btn(ctx, 'poweron-yes', look(K.powerOn, 'Yes, save slot 0', 'Saving slot 0…'), () => void powerOnSave($), true)}
            {Btn(ctx, 'poweron-no', 'Cancel', () => {
              confirmPowerOn = false
              $.ui.invalidate('ui.render')
            })}
          </Box>
        </Box>
      ) : null}

      {Head($, ctx, { k: 'dip-head', title: 'V4 dipole helper', color: PINK, hint: ctx.narrow ? '' : 'the RTL-SDR Blog V4 kit dipole: how long each element should be' })}
      <Box key="dip-row" flexWrap="wrap">
        {DIPOLE_TARGETS.map(([f, n]) => Btn(ctx, `dip:${f}`, `${n}`, () => void setDipole($, f), dipoleF === f))}
      </Box>
      {ctx.Svg ? Pic(ctx, dipoleSvg(dip[0], ctx.geo), `V4 dipole for ${dip[1]} at ${dip[0]} MHz: each element ${dipoleCm(dip[0]).toFixed(1)} cm`) : <Text>{`Each element ≈ 7150 / ${dip[0]} = ${dipoleCm(dip[0]).toFixed(1)} cm (${(2 * dipoleCm(dip[0])).toFixed(1)} cm tip to tip).`}</Text>}
      <Box key="dip-go" flexWrap="wrap">
        {Btn(ctx, 'dip-sweep', look(K.band(dip[2]), `Sweep it: ${bandById(dip[2])?.short ?? dip[2]}, then Trim`, 'Switching…'), () => void (async () => {
          await switchBand($, dip[2])
          await setTrimTarget($, dip[0])
          await setSection($, 'trim')
        })())}
      </Box>

      <Text key="bands-files" dimColor wrap="wrap">
        {`Your own bands and the band → slot map are in ${presets?.file ?? '~/Library/Application Support/vna/presets.json'} (slots 1–${(presets?.slots ?? 7) - 1}; 0 is never used there). A band you have not calibrated sweeps UNCAL until Calibrate saves its slot. If the NanoVNA's own Backup setting is on (it is off unless you turned it on), it starts in the last band used: press Back to Meshtastic before switching it off.`}
      </Text>
      {presets?.warning ? <Text key="bands-warn" color={RED} wrap="wrap">{presets.warning}</Text> : null}
    </Box>
  )
}

// ---- the "?" guide

function guideView($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  return (
    <Box key="guide" flexDirection="column">
      {Head($, ctx, { k: 'guide-head', title: 'How the VNA tab works', color: VIOLET, tab: 'guide', extra: ctx.pane === PANE ? Btn(ctx, 'guide-close', 'close', () => {
        guideOpen = false
        $.ui.invalidate('ui.render')
      }, false, true) : null })}
      {ctx.Svg ? Pic(ctx, guideSvg(ctx.geo), guideText()) : <Text wrap="wrap">{guideText()}</Text>}
    </Box>
  )
}

function shotView($: any, ctx: Ctx): unknown {
  const { Box, Text, Button } = ctx.els
  if (!shot) return null
  return (
    <Box key="shot" flexDirection="column" paddingTop={1}>
      <Box>
        <Text bold>Screenshot</Text>
        <Text dimColor>{'   '}{shot.path.split('/').pop()}{'   '}</Text>
        <Button key="shot-open" plain label="open" onPress={() => void openFile($, shot?.path ?? '')} />
        <Text> </Text>
        <Button key="shot-clear" plain label="hide" onPress={() => {
          shot = null
          $.ui.invalidate('ui.render')
        }} />
      </Box>
      {ctx.Svg && shot.b64
        ? Pic(
            ctx,
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="480" height="320" viewBox="0 0 480 320"><image width="480" height="320" href="data:image/png;base64,${shot.b64}" xlink:href="data:image/png;base64,${shot.b64}"/></svg>`,
            "Screenshot of the NanoVNA's screen",
          )
        : null}
    </Box>
  )
}

function sectionView($: any, ctx: Ctx, s: Section): unknown {
  return s === 'trim' ? trimView($, ctx) : s === 'library' ? libraryView($, ctx) : s === 'qc' ? qcView($, ctx) : s === 'bands' ? bandsView($, ctx) : measureView($, ctx)
}

function mainPane($: any, ctx: Ctx): unknown {
  const { Box, Text } = ctx.els
  return (
    <Box flexDirection="column">
      {topRows($, ctx, true)}
      {navRow($, ctx)}
      {guideOpen ? guideView($, ctx) : null}
      {cal?.step && section !== 'bands' ? calBox($, ctx) : null}
      <Box key={`sec:${section}`} flexDirection="column">{sectionView($, ctx, section)}</Box>
      {note ? <Text key="note" dimColor wrap="wrap">{note}</Text> : null}
      {lastExport ? <Text key="export-note" color={lastExport.ok ? undefined : AMBER} dimColor={lastExport.ok} wrap="wrap">{lastExport.say}</Text> : null}
      {shotView($, ctx)}
      <Box key="footer" flexDirection="column">
        <Text> </Text>
        <Text dimColor wrap="wrap">
          {'Under 1.5 is excellent, under 2 good, above 3 poor. Unscrew an antenna from a node only while the node is off, and never connect a transmitter to the NanoVNA. '}
          {'/vna, /vna save <name>, /vna compare <a> <b>, /vna trim, /vna band <id>, /vna qc, /vna tab <view>, /vna export, /vna guide, /vna hide|show (the status line).'}
        </Text>
      </Box>
    </Box>
  )
}

// One view on its own tab: the top rows, then that view alone.
function tabPane($: any, ctx: Ctx, v: TabView): unknown {
  const { Box } = ctx.els
  const body =
    v === 'reading'
      ? readingView($, ctx)
      : v === 'chart'
        ? chartView($, ctx)
        : v === 'smith'
          ? chartView($, ctx, 'smith')
          : v === 'trim'
            ? trimView($, ctx)
            : v === 'library'
              ? libraryView($, ctx)
              : v === 'qc'
                ? qcView($, ctx)
                : v === 'bands'
                  ? bandsView($, ctx)
                  : guideView($, ctx)
  return (
    <Box flexDirection="column">
      {topRows($, ctx, false)}
      {cal?.step && v !== 'bands' ? calBox($, ctx) : null}
      <Box key={`body:${v}`} flexDirection="column">{body}</Box>
      {note ? <ctx.els.Text key="note" dimColor wrap="wrap">{note}</ctx.els.Text> : null}
    </Box>
  )
}

// ---------------------------------------------------------------- commands

// A command waits for its press at most this long: past it the press goes on and the reply says so.
const CMD_WAIT_MS = 7000

async function answer($: any, p: Promise<string>): Promise<{ text: string }> {
  const t = await within($, p, CMD_WAIT_MS)
  return { text: t ?? endText(null, '', 'it') }
}

// The freshest reading we can get: the shared one when it is under FRESH_MS old (unless force), else at
// most one short sweep. When neither works the last reading stays and `why` says so.
async function ensureReading($: any, force = false): Promise<{ fresh: boolean; why: string; now: number }> {
  const now = await $.clock.now()
  if (!force) {
    const shared = await readJsonFile($, LIVE_FILE)
    if (shared) applyLive($, shared, now)
    if (live && now - liveAt < FRESH_MS) return { fresh: true, why: '', now }
  }
  const r = await within($, script($, ['live', '--session', SESSION, '--wait', '2'], 7000, 'free'), 7500)
  if (r && !r.busy && typeof r.connected === 'boolean') {
    applyLive($, r, await $.clock.now())
    return { fresh: true, why: '', now }
  }
  const why = r?.busy ? String(r.say ?? 'NanoVNA busy.') : `NanoVNA busy or not answering${r?.error ? ` (${r.error})` : ''}.`
  if (r?.busy) busyNote = why
  return { fresh: false, why, now }
}

// /vna with nothing after it: the freshest shared reading, else at most one short sweep, else what we had.
async function quickReport($: any): Promise<string> {
  const g = await ensureReading($)
  if (g.fresh) return report()
  if (!liveAt) return `${g.why} No reading yet.`
  return `${g.why} Last reading ${ago(g.now - liveAt)} ago:\n${report()}`
}

// ---------------------------------------------------------------- the tools Claude can call (hooks/tools.ts)

// A tool's press waits this long for the queue; past it the press goes on and the answer says so.
const TOOL_WAIT_MS = 30_000
const COLOR_NAMES = ['cyan', 'magenta', 'sky blue', 'violet', 'ice', 'pink', 'teal', 'lilac']

const r1 = (n: number | undefined | null, d = 2): number | null => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null)

// The numbers behind report(), for the vna_reading tool.
function readingData(): Record<string, unknown> {
  if (!live?.connected) return { connected: false }
  const m = live.metrics
  const bd = activeBand()
  const cs = calStatus()
  const out: Record<string, unknown> = {
    connected: true,
    via: live.via ?? 'usb',
    band: bd ? { id: bd.id, name: bd.name, mhz: bd.band } : null,
    sweepMhz: live.sweep ? [live.sweep.start / 1e6, live.sweep.stop / 1e6] : null,
    calibrated: cs.ok,
    calibration: cs.text,
    slot: typeof live.slot === 'number' ? live.slot : null,
  }
  if (!m) return out
  if (m.best.swr > 15) return { ...out, portOpen: true, say: 'PORT 1 reads open: no antenna, a loose plug, or an RP-SMA antenna (hole in the middle instead of a pin).' }
  const mark = (k?: Mark) =>
    k
      ? { name: k.name ?? null, mhz: k.mhz, swr: r1(k.swr), returnLossDb: r1(k.rl, 1), resistanceOhm: k.z ? r1(k.z[0], 1) : null, reactanceOhm: k.z ? r1(k.z[1], 1) : null, word: verdict(k.swr).text }
      : null
  const hm = heroMarks(m)
  const onMeshBand = !bd || bd.id === 'mesh'
  const marks = onMeshBand ? [m.meshtastic ? { ...mark(m.meshtastic), name: 'Meshtastic' } : null, m.meshcore ? { ...mark(m.meshcore), name: 'MeshCore' } : null, m.mid ? { ...mark(m.mid), name: '915' } : null] : [mark(hm?.mt), mark(hm?.mc)]
  const worst = hm ? Math.max(hm.mt.swr, hm.mc?.swr ?? 0) : m.best.swr
  const g = onMeshBand ? gradeOf(m) : grade(worst)
  const w = trimWords()
  const t = trimTarget()
  return {
    ...out,
    marks: marks.filter(Boolean),
    grade: g,
    verdict: onMeshBand ? verdictLine(m) : bandVerdict(worst, bd?.name ?? ''),
    best: { mhz: m.best.mhz, swr: r1(m.best.swr) },
    under2Mhz: m.under2 ?? null,
    resonance: m.resonance ? { mhz: r1(m.resonance.mhz, 1), hint: m.resonance.hint } : null,
    trim: { targetMhz: t.f, targetName: t.name, say: w.head, why: w.sub, undo: w.undo || null, onFrequency: w.arrow === 'on', passed: w.passed, resonantMhz: r1(trimNow()?.f ?? null, 2) },
  }
}

async function toolReading($: any, fresh: boolean): Promise<string> {
  {
    await loadStore($)
    if (!presets) await refreshPresets($)
    const g = await ensureReading($, fresh)
    const age = liveAt ? Math.max(0, Math.round(((await $.clock.now()) - liveAt) / 1000)) : null
    const head = g.fresh ? '' : `${g.why} ${liveAt ? `Showing the last reading, ${ago((await $.clock.now()) - liveAt)} old.` : 'No reading yet.'}\n`
    const data = { ...readingData(), ageSeconds: age, fresh: g.fresh }
    return `${head}${report()}\n\nNumbers:\n${JSON.stringify(data)}`
  }
}

async function toolAntennas($: any, q: { name?: string; a?: string; b?: string }): Promise<string> {
  {
    await loadStore($)
    await refreshLibrary($)
    if (q.a || q.b) {
      const a = q.a ? findGroup(q.a) : undefined
      const b = q.b ? findGroup(q.b) : undefined
      if (!a || !b) return `Could not find two saved antennas for "${q.a ?? ''}" and "${q.b ?? ''}". Saved: ${groups().map(g => g.label).join(', ') || 'none'}.`
      return compareTextOf(a, b)
    }
    if (q.name) {
      const g = findGroup(q.name)
      if (!g) return `No saved antenna called "${q.name}". Saved: ${groups().map(x => x.label).join(', ') || 'none'}.`
      return [
        `${g.label}: ${g.items.length} sweep${g.items.length > 1 ? 's' : ''}${g.items.length > 1 ? `, SWR at 907 ${trend(g)}` : ''}`,
        ...g.items.map(i => `  ${day(i.saved).padEnd(15)} SWR ${fmt(i.metrics?.meshtastic?.swr)} at 906.875, ${fmt(i.metrics?.meshcore?.swr)} at 910.525  best ${fmt(i.metrics?.best?.swr)} @${i.metrics?.best?.mhz ?? '?'} MHz`),
      ].join('\n')
    }
    const gs = groups()
    if (!gs.length) return 'No saved antennas yet. Save the one on the NanoVNA with vna_action save <name>.'
    return [
      `${gs.length} saved antenna${gs.length > 1 ? 's' : ''}, best SWR at 907 first:`,
      ...gs.map(g => {
        const m = g.latest.metrics
        const c = COLOR_NAMES[ANT.indexOf(antColor(g.label))] ?? 'colour'
        return `  ${g.label} · ${c} · ${g.items.length} version${g.items.length > 1 ? 's' : ''} · SWR ${fmt(m?.meshtastic?.swr)} at 907, best ${fmt(m?.best?.swr)} at ${m?.best?.mhz ?? '?'} MHz · saved ${day(g.latest.saved)}`
      }),
    ].join('\n')
  }
}

async function toolAct($: any, verb: string, arg: string): Promise<string> {
  {
    await loadStore($)
    const wait = async (p: Promise<string>) => (await within($, p, TOOL_WAIT_MS)) ?? endText(null, '', verb)
    switch (verb) {
      case 'save':
        return wait(saveAntenna($, arg))
      case 'markers':
        return wait(setMarkers($, arg === 'best' ? 'best' : 'mesh'))
      case 'band':
        await refreshPresets($)
        return wait(switchBand($, arg))
      case 'export':
        await ensureReading($)
        return wait(exportCard($, arg))
      case 'trim': {
        if (arg === 'reset') {
          await trimReset($)
          return 'Trim timeline cleared.'
        }
        await ensureReading($)
        if (arg === 'snip') return `${await trimSnip($)}\n${trimText()}`
        if (arg === 'meshtastic') await setTrimTarget($, 906.875)
        else if (arg === 'meshcore') await setTrimTarget($, 910.525)
        else await setTrimTarget($, Number(arg))
        return trimText()
      }
      default:
        return 'Not available as a tool.'
    }
  }
}

export const register: Register = on => {
  // The three tools (registered at session.start by registerTools): each answers a failure in words.
  on('tool.call', { tool: 'mcp__vna__vna_reading' }, async ($, e) => {
    try {
      return { result: await toolReading($, (e as any).fresh === true) }
    } catch (err: any) {
      return { result: `The VNA tool failed: ${String(err?.message ?? err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__vna__vna_antennas' }, async ($, e) => {
    const q = e as any
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
    try {
      return { result: await toolAntennas($, { name: s(q.name), a: s(q.a), b: s(q.b) }) }
    } catch (err: any) {
      return { result: `The VNA tool failed: ${String(err?.message ?? err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__vna__vna_action' }, async ($, e) => {
    const p = parseAction(e)
    if (!p.ok) return { result: p.say }
    try {
      return { result: await toolAct($, p.verb, p.arg) }
    } catch (err: any) {
      return { result: `The VNA tool failed: ${String(err?.message ?? err)}` }
    }
  })

  on('session.start', async ($, e, next) => {
    // Paths first: everything below reads or writes under the home folder.
    setHome((await $.env.get('HOME')) || '')
    // The three tools Claude can call (hooks/tools.ts); a failure here never stops the tab.
    try {
      await registerTools($)
    } catch {}
    await $.command.register({
      name: 'vna',
      description: 'Open the VNA tab: live SWR from the NanoVNA with a plain-language verdict, the trim assistant, saved antennas, compare, QC, band presets and calibration',
      argumentHint: '[save <name> | trim [snip|reset|<MHz>] | band <id>|cal <id> | compare <a> <b> | qc [on|off|save <unit>|rules|log] | view swr|rl|rx|smith | tab <view> | export [name] | guide | cal | shot | x on|off | hide | show]',
    })
    await loadStore($)
    // The status line, and the same line in ~/.claude/mod-status/vna.json for the Herdr strip.
    await startModStatus($, 'vna')
    $.clock.every(KEEP_FRESH_MS, () => void keepModStatusFresh($))
    bg(refreshLibrary($))
    bg(refreshPresets($))
    if (section === 'qc') bg(loadQcLog($))
    bg(tick($, true))
    $.clock.every(LIVE_MS, () => bg(tick($)))
    return next(e)
  })

  on('command.run', { command: 'vna' }, async ($, e) => {
    const raw = String((e as any).args ?? '').trim()
    const [verb, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ')
    await loadStore($)
    const v0 = (verb ?? '').toLowerCase()
    // hide|show: the status line and the Herdr strip's entry, remembered; the tab stays as it is.
    if (v0 === 'hide' || v0 === 'show') {
      statusOn = v0 === 'show'
      try {
        await $.store.set('statusOn', statusOn)
      } catch {}
      pushStatus($)
      return {
        text: statusOn
          ? `VNA line shown again while a NanoVNA is connected (the status bar, or the Herdr strip inside Herdr).${live?.connected ? '' : ' None is connected now.'}`
          : 'VNA line hidden (the status bar and the Herdr strip). /vna show brings it back.',
      }
    }
    await $.ui.open({ id: PANE, title: 'VNA' })
    switch (v0) {
      case 'save':
        return answer($, saveAntenna($, arg))
      case 'cal':
      case 'calibrate': {
        const step = ['open', 'short', 'load', 'cancel'].includes(arg.toLowerCase()) ? arg.toLowerCase() : 'begin'
        const b = activeBand()
        return answer($, calStep($, cal?.band ?? (b && b.id !== 'mesh' ? b.id : 'mesh'), step))
      }
      case 'shot':
      case 'screenshot':
        return answer($, takeShot($))
      case 'layout':
        return answer($, layout($))
      case 'msg': {
        const r = await script($, ['msg', arg || 'Hello from Claude', 'Claude', '--wait', '3'], 7000, 'free')
        return { text: r?.ok ? 'Shown on the NanoVNA.' : deviceTrouble(r) || 'NanoVNA not connected.' }
      }
      case 'live': {
        await setLive($, arg.toLowerCase() !== 'off')
        return { text: `Live readings ${liveOn ? 'on' : 'paused'}.` }
      }
      case 'view': {
        const v = VIEWS.find(([k, name]) => k === arg.toLowerCase() || name.toLowerCase() === arg.toLowerCase())
        if (!v) return { text: 'Views: swr, rl (return loss), rx (R & X), smith.' }
        await setView($, v[0])
        return { text: `Chart: ${v[1]}. ${EXPLAIN[v[0]]}` }
      }
      case 'markers':
      case 'marker':
        return answer($, setMarkers($, arg.toLowerCase().startsWith('best') ? 'best' : 'mesh'))
      case 'compare': {
        await refreshLibrary($)
        if (/^(off|clear|none)$/i.test(arg)) {
          cmpA = cmpB = null
          await saveStore($)
          return { text: 'Compare cleared.' }
        }
        if (arg) {
          const pair = splitPair(arg)
          const a = pair ? findGroup(pair[0]) : undefined
          const b = pair ? findGroup(pair[1]) : undefined
          if (!a || !b) return { text: `Could not find two saved antennas in "${arg}". Saved: ${groups().map(g => g.label).join(', ') || 'none'}.` }
          cmpA = a.label
          cmpB = b.label
          await setSection($, 'library')
        }
        return { text: compareText() }
      }
      case 'history': {
        await refreshLibrary($)
        if (/^(off|clear|none)$/i.test(arg)) {
          await showHistory($, null)
          return { text: 'History overlay off.' }
        }
        const g = findGroup(arg)
        if (!g) return { text: `No saved antenna called "${arg}".` }
        histLabel = g.label
        await setSection($, 'library')
        return {
          text: [`${g.label}: ${g.items.length} sweep${g.items.length > 1 ? 's' : ''}${g.items.length > 1 ? `, SWR at 907 ${trend(g)}` : ''}`, ...g.items.map(i => `  ${day(i.saved).padEnd(15)} SWR ${fmt(i.metrics?.meshtastic?.swr)}  best ${fmt(i.metrics?.best?.swr)} @${i.metrics?.best?.mhz ?? '?'}`)].join('\n'),
        }
      }
      case 'qc':
        return answer($, qcCommand($, arg))
      case 'delete': {
        const g = findGroup(arg)
        if (!g) return { text: `No saved antenna called "${arg}".` }
        return answer($, deleteNewest($, g))
      }
      case 'trim': {
        await setSection($, 'trim')
        const a = arg.toLowerCase()
        if (a === 'snip') return { text: await trimSnip($) }
        if (a === 'reset' || a === 'new') {
          await trimReset($)
          return { text: 'Trim timeline cleared.' }
        }
        const f = Number(a.replace(/mhz$/, ''))
        if (a === 'meshtastic' || a === 'meshcore') await setTrimTarget($, a === 'meshtastic' ? 906.875 : 910.525)
        else if (f > 0) await setTrimTarget($, f)
        if (live) trimFeed(await $.clock.now())
        return { text: trimText() }
      }
      case 'band':
      case 'bands': {
        await refreshPresets($)
        const [a = '', b = '', c = ''] = arg.split(/\s+/)
        if (!a || verb === 'bands') {
          await setSection($, 'bands')
          return { text: bandsText() }
        }
        if (a === 'cal' || a === 'calibrate') {
          const id = b === 'mesh' ? 'mesh' : b
          if (!bandById(id)) return { text: `No band ${b}. ${bandsText()}` }
          await setSection($, 'bands')
          return answer($, calStep($, id, ['open', 'short', 'load', 'cancel'].includes(c) ? c : 'begin'))
        }
        const id = /^(back|mesh|meshtastic|home)$/i.test(a) ? 'mesh' : a.toLowerCase()
        return answer($, switchBand($, id))
      }
      case 'back':
        return answer($, switchBand($, 'mesh'))
      case 'x':
      case 'xtrace':
        return answer($, setXTrace($, !/^off/i.test(arg)))
      case 'poweron':
        await setSection($, 'bands')
        return { text: `${powerOnAsk($)}${powerOnRefusal() ? '' : ' Press "Yes, save slot 0" in the Bands tab to save it; nothing is written until then.'}` }
      case 'tab': {
        const v = (Object.keys(TABS) as TabView[]).find(k => k === arg.toLowerCase() || TABS[k].title.toLowerCase() === arg.toLowerCase())
        if (!v) return { text: `Views with their own tab: ${Object.keys(TABS).join(', ')}.` }
        return { text: await openTab($, v) }
      }
      case 'export':
        return answer($, exportCard($, arg))
      case 'guide':
      case 'help':
        guideOpen = true
        $.ui.invalidate('ui.render')
        return { text: guideText() }
      default:
        return { text: await quickReport($) }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const now = await $.clock.now()
    drawnAt[PANE] = now
    return mainPane($, ctxOf($, e, PANE, now)) as any
  })

  // Each view in its own tab (⤢ or /vna tab <view>).
  for (const v of Object.keys(TABS) as TabView[]) {
    const id = TABS[v].id
    on('ui.render', { component: 'Pane', requestId: id }, async ($, e) => {
      const now = await $.clock.now()
      drawnAt[id] = now
      return tabPane($, ctxOf($, e, id, now), v) as any
    })
  }
}

async function qcCommand($: any, arg: string): Promise<string> {
  const [sub, ...more] = arg.trim().split(/\s+/)
  const rest = more.join(' ')
  switch ((sub ?? '').toLowerCase()) {
    case 'off':
      await setSection($, 'measure')
      return 'QC mode off.'
    case 'save':
    case 'record': {
      if (section !== 'qc') await setSection($, 'qc')
      if (!qcLog) await loadQcLog($)
      return qcSave($, rest)
    }
    case 'rules': {
      if (!rest) return `QC rule: ${ruleText(qcRules)}. Change it with /vna qc rules band=2.0 spot=1.5 range=902-928 spots=906.875,910.525, or /vna qc rules default.`
      const r = parseRules(rest)
      if (typeof r === 'string') return r
      qcRules = r
      await saveStore($)
      pushStatus($)
      $.ui.invalidate('ui.render')
      return `QC rule now: ${ruleText(qcRules)}.`
    }
    case 'log': {
      await loadQcLog($)
      const l = qcLog
      if (!l?.records.length) return `No QC records yet (${l?.log ?? '~/NanoVNA/qc-log.csv'}).`
      return [
        `${l.total} QC records · ${l.passed} pass · ${l.failed} fail · ${l.log}`,
        ...l.records.slice(0, 10).map(r => `${(r.unit ?? '').padEnd(12)} ${r.result}  SWR ${n2(r.swr_906_875)} / ${n2(r.swr_910_525)}  worst ${n2(r.worst_swr)} @${r.worst_mhz}  ${day(r.timestamp ?? '')}`),
      ].join('\n')
    }
    default: {
      await setSection($, 'qc')
      await loadQcLog($)
      return `QC mode on.\n${await quickReport($)}`
    }
  }
}
