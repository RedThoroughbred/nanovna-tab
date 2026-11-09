// Small SVG building blocks the pictures share: text, pills, gradients, the frame, the plot pieces. No state, no $.

import { AMBER, AXIS, BG, BRIGHT, GREEN, GRID, GRID2, LABEL, LCD, MONO, PLOT, RED, SANS } from './constants'
import { bg, clamp, esc } from './readings'
import type { Badge, Frame, Mark, Metrics, Rect, Series, Spot, TxtOpts } from './types'

export function n1(v: number): string {
  return v.toFixed(1)
}

export function txt(x: number, y: number, s: string, o: TxtOpts = {}): string {
  return `<text x="${n1(x)}" y="${n1(y)}" fill="${o.fill ?? AXIS}" font-size="${o.size ?? 10.5}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''}${o.spacing ? ` letter-spacing="${o.spacing}"` : ''} font-family="${o.font ?? MONO}">${esc(s)}</text>`
}

// How wide a string draws: Menlo is 0.6 em a character, Helvetica about 0.56 on average.
export function tw(s: string, size: number, font = MONO): number {
  return [...s].length * size * (font === MONO ? 0.602 : 0.56)
}

export function cut(s: string, n: number): string {
  return [...s].length > n ? `${[...s].slice(0, n - 1).join('')}…` : s
}

// Splits a sentence into lines of at most n characters.
export function wrapText(s: string, n: number): string[] {
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
export function pill(x: number, y: number, s: string, o: { fill: string; size?: number; anchor?: 'start' | 'middle' | 'end'; bg?: string }): string {
  const size = o.size ?? 10
  const w = tw(s, size) + 10
  const x0 = o.anchor === 'end' ? x - w : o.anchor === 'middle' ? x - w / 2 : x
  return (
    `<rect x="${n1(x0)}" y="${n1(y - size - 1.5)}" width="${n1(w)}" height="${n1(size + 6)}" rx="${n1((size + 6) / 2)}" fill="${o.bg ?? PLOT}" fill-opacity="0.92" stroke="${o.fill}" stroke-opacity="0.55"/>` +
    txt(x0 + w / 2, y, s, { fill: o.fill, size, anchor: 'middle', weight: 700 })
  )
}

export function hits(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

export function pillRect(x: number, y: number, s: string, size: number, anchor: 'start' | 'middle' | 'end'): Rect {
  const w = tw(s, size) + 10
  const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
  return [x0 - 2, y - size - 3.5, x0 + w + 2, y + 6.5]
}

// Draws a pill at the first spot that stays inside `bounds` and clear of `placed` (else the first
// spot), and records it.
export function placePill(parts: string[], placed: Rect[], spots: Spot[], s: string, fill: string, bounds: Rect, size = 10): void {
  const fits = (r: Rect) => r[0] >= bounds[0] && r[2] <= bounds[2] && r[1] >= bounds[1] && r[3] <= bounds[3]
  const rects = spots.map(([x, y, a]) => pillRect(x, y, s, size, a))
  let k = rects.findIndex(r => fits(r) && !placed.some(p => hits(p, r)))
  if (k < 0) k = rects.findIndex(r => !placed.some(p => hits(p, r)))
  if (k < 0) k = 0
  const [x, y, a] = spots[k] as Spot
  placed.push(rects[k] as Rect)
  parts.push(pill(x, y, s, { fill, anchor: a, size }))
}

export function svgDoc(W: number, H: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`
}

// Filters in user space: an object-box filter on a flat line has no height and draws nothing.
export function glowDef(id: string, W: number, H: number, sd = 2.2): string {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${sd}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
}

export function blurDef(id: string, W: number, H: number, sd = 4): string {
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${-W}" y="${-H}" width="${3 * W}" height="${3 * H}"><feGaussianBlur stdDeviation="${sd}"/></filter>`
}

// A vertical gradient that colours by SWR zone: red above yRA, amber down to yAG, green below.
// ops are the stop opacities: red top and bottom, amber top and bottom, green top and bottom.
export function zoneGrad(id: string, yTop: number, yBot: number, yRA: number, yAG: number, ops: number[] = [1, 1, 1, 1, 1, 1]): string {
  const span = yBot - yTop || 1
  const a = clamp((yRA - yTop) / span)
  const b = clamp((yAG - yTop) / span)
  const st = (o: number, c: string, op: number | undefined) => `<stop offset="${o.toFixed(4)}" stop-color="${c}" stop-opacity="${op ?? 1}"/>`
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${n1(yTop)}" y2="${n1(yBot)}">${st(0, RED, ops[0])}${st(a, RED, ops[1])}${st(a, AMBER, ops[2])}${st(b, AMBER, ops[3])}${st(b, GREEN, ops[4])}${st(1, GREEN, ops[5])}</linearGradient>`
}

// A horizontal gradient that colours each column by the zone of the trace above it, switching
// sharply where the trace crosses 1.5 or 2. pts are [MHz, SWR], low to high.
export function zoneCols(id: string, x0: number, x1: number, pts: [number, number][], xOf: (f: number) => number): string {
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
export function fadeMask(id: string, W: number, H: number, yTop: number, yBot: number, a: number, b: number): string {
  return (
    `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${n1(yTop)}" y2="${n1(yBot)}"><stop offset="0" stop-color="#fff" stop-opacity="${a}"/><stop offset="1" stop-color="#fff" stop-opacity="${b}"/></linearGradient>` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="url(#${id}g)"/></mask>`
  )
}

export const BAND_DEF =`<linearGradient id="band" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${LCD}" stop-opacity="0.16"/><stop offset="1" stop-color="${LCD}" stop-opacity="0.035"/></linearGradient>`

export function niceStep(span: number, target: number): number {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

// The value of a curve at f, between its points; undefined off the curve.
export function at(curve: [number, number][], f: number): number | undefined {
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

// The series drawn in the zone colours: the live one, or the only one.
export function primaryOf(series: Series[], compare: boolean): Series | undefined {
  if (compare) return undefined
  return series.find(s => s.isLive) ?? (series.length === 1 ? series[0] : undefined)
}

export function pathOf(fr: Frame, pts: [number, number][], y: (v: number) => number): string {
  return pts
    .filter(p => p[0] >= fr.lo && p[0] <= fr.hi)
    .map((p, i) => `${i ? 'L' : 'M'}${n1(fr.x(p[0]))},${n1(y(p[1]))}`)
    .join('')
}

// The trace closed onto a level (the floor of the SWR chart, the ceiling of return loss).
export function areaOf(fr: Frame, pts: [number, number][], y: (v: number) => number, level: number): string {
  const p = pts.filter(q => q[0] >= fr.lo && q[0] <= fr.hi)
  const a = p[0]
  const b = p[p.length - 1]
  if (!a || !b) return ''
  return `${pathOf(fr, p, y)}L${n1(fr.x(b[0]))},${n1(level)}L${n1(fr.x(a[0]))},${n1(level)}Z`
}

// Card, title row, plot well and frequency axis. In A/B the two names stand in the title row.
export function base(fr: Frame, parts: string[], title: string, sub: string, badge: Badge, ab?: [Series, Series]): void {
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

export function plotBounds(fr: Frame): Rect {
  return [fr.L + 2, fr.T + 2, fr.W - fr.R - 2, fr.H - fr.B - 2]
}

// The lowest point (or the deepest dip): a glowing ring and its value, labelled where there is room.
export function dipMark(fr: Frame, parts: string[], placed: Rect[], f: number, py: number, col: string, label: string): void {
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
export function meshDots(fr: Frame, parts: string[], placed: Rect[], m: Metrics, val: (k: Mark) => number, y: (v: number) => number, col: (k: Mark) => string, show: (k: Mark) => string, py0 = fr.T + 34): void {
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
export function bracket(fr: Frame, parts: string[], placed: Rect[], u2: [number, number], yb: number): void {
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

export function legend(fr: Frame, parts: string[], series: Series[], prim: Series | undefined, extra: [string, string, string][] = []): void {
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
export function zoneFill(fr: Frame, parts: string[], area: string, swrPts: [number, number][]): void {
  const pts = swrPts.filter(p => p[0] >= fr.lo && p[0] <= fr.hi)
  parts.push(`<defs>${zoneCols('zc', fr.L, fr.W - fr.R, pts, fr.x)}</defs>`)
  parts.push(`<path d="${area}" fill="url(#zc)" mask="url(#fade)"/>`)
}
