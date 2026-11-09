// The shapes the tab passes around (types only; nothing here runs).


export type View = 'swr' | 'rl' | 'rx' | 'smith'

// The five places at the top of the tab, each with its colour.
export type Section = 'measure' | 'trim' | 'library' | 'qc' | 'bands'

// Views that open in their own tab (⤢, /vna tab <view>).
export type TabView = 'reading' | 'chart' | 'smith' | 'trim' | 'library' | 'qc' | 'bands' | 'guide'

export type Rules = { lo: number; hi: number; bandMax: number; spots: number[]; spotMax: number }

export type Mark = {
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

export type Resonance = {
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

export type Metrics = { meshtastic?: Mark; meshcore?: Mark; mid?: Mark; best: Mark; under2: [number, number] | null; resonance?: Resonance | null }

export type QcCheck = { id: string; label: string; pass: boolean; value?: number; mhz?: number; detail: string }

export type Qc = { pass: boolean; rule: string; rules: Rules; checks: QcCheck[]; worst: { mhz: number; swr: number } | null; covered: boolean; failed: string[] }

export type Sweep = { start: number; stop: number; points: number }

export type Trace = { n: number; type: string; ch: string; scale?: number; refpos?: number }

export type Live = {
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
export type BandDef = {
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

export type Presets = { ok: boolean; file: string; slots: number; spare: number[]; bands: BandDef[]; powerOn?: { at: string; trace3: string } | null; warning?: string | null }

export type Item = { file: string; label: string; saved: string; metrics: Metrics | null; curve: [number, number][]; s11?: [number, number][] }

export type Group = { label: string; items: Item[]; latest: Item }

export type CalView = { step: string | null; say: string; ok: boolean; band: string }

export type QcRecord = Record<string, string>

export type QcLog = { log: string; dir: string; total: number; passed: number; failed: number; next: string; records: QcRecord[] }

export type Series = {
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
export type Geo = { W: number; c: boolean }

export type Grade = 'A' | 'B' | 'C' | 'F'

// The trim assistant: one reading of where the antenna resonates, and the changes logged.
export type TrimRead = { f: number; method: 'X = 0' | 'SWR dip'; swrT?: number; swrMin: number; edge?: 'below' | 'above'; r?: number }

export type TrimPoint = TrimRead & { n: number; at: number; how: 'start' | 'auto' | 'snip'; delta: number; target: number; passed?: boolean }

export type TxtOpts = { fill?: string; size?: number; anchor?: string; weight?: number; font?: string; opacity?: number; spacing?: number }

// Labels that must not land on one another: each placed label's box, and the first free spot of several.
export type Rect = [number, number, number, number]

export type Spot = [number, number, 'start' | 'middle' | 'end']

export type Frame = { W: number; H: number; L: number; R: number; T: number; B: number; lo: number; hi: number; c: boolean; x: (f: number) => number }

export type Badge = { text: string; color: string }

export type Trim = { kind: 'cut' | 'add' | 'on' | 'anti' | 'short' | 'long'; head: string; sub: string; col: string; f: number | null; target: number | null; off: number | null }

export type TrimWords = { head: string; sub: string; undo: string; col: string; arrow: 'up' | 'down' | 'on' | 'none'; passed: boolean }

// Processes run in lanes. The device lane runs one process at a time: a press's first ('action'),
// the polls after it ('poll': only while no press runs or waits, and never two of a kind queued).
// Reads that never touch the device (library, presets, the QC log, /vna's quick read) run in the
// free lane beside it, so a press never waits behind them.
export type Lane = 'action' | 'poll' | 'free'

export type Proc = { lane: 'action' | 'poll'; id: string; argv: string[]; timeoutMs: number; resolve: (v: any) => void; reject: (e: unknown) => void; promise: Promise<any>; waitedOn: boolean }

export type ActEnd = 'ran' | 'joined' | 'superseded'

export type Plan = { step: string; ms: number; id?: string }

export type ActOpts = { key?: string; plan?: () => Plan }

export type Intent = {
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

export type Look = { label: string; variant?: 'primary'; dimColor?: boolean }

// What every view draws with: the surface's elements, its width, and which pane it is in.
export type Ctx = { els: any; surface: string; narrow: boolean; geo: Geo; Svg: any; Input: any; pane: string; now: number }
