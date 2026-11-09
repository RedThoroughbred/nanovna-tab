// Plain-word helpers: grades, verdicts, number formats and the SWR / return-loss / impedance maths. No state, no $.

import { AMBER, AXIS, BG, GREEN, ORANGE, RED } from './constants'
import type { BandDef, Grade, Group, Item, Metrics, Series } from './types'

// When each own tab was last drawn: QC and Trim do their work while someone is looking.
export const drawnAt: Record<string, number> = {}

export function verdict(swr: number | undefined): { text: string; color: string } {
  if (swr === undefined || swr === null) return { text: '', color: AXIS }
  if (swr < 1.5) return { text: 'excellent', color: GREEN }
  if (swr < 2) return { text: 'good', color: AMBER }
  if (swr < 3) return { text: 'so-so', color: ORANGE }
  return { text: 'poor', color: RED }
}

// The zone an SWR falls in: green to 1.5, amber to 2, red above.
export function zone(swr: number): string {
  return swr <= 1.5 ? GREEN : swr <= 2 ? AMBER : RED
}

export function grade(swr: number): Grade {
  return swr <= 1.5 ? 'A' : swr <= 2 ? 'B' : swr <= 3 ? 'C' : 'F'
}

export const GRADE_COLOR: Record<Grade, string> = { A: GREEN, B: AMBER, C: ORANGE, F: RED }

// The grade of an antenna: the worse of its two mesh frequencies (the best point when neither is on the sweep).
export function gradeOf(m: Metrics | null | undefined): Grade | null {
  if (!m) return null
  const v = [m.meshtastic?.swr, m.meshcore?.swr].filter((x): x is number => typeof x === 'number')
  return grade(v.length ? Math.max(...v) : m.best.swr)
}

export function verdictLine(m: Metrics): string {
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

export function fmt(n: number | undefined | null, d = 2): string {
  return n === undefined || n === null ? '—' : n >= 9.9 ? '>9.9' : n.toFixed(d)
}

export function meaning(swr: number): string {
  const g = (swr - 1) / (swr + 1)
  const pct = 100 * g * g
  return `${pct < 1 ? 'under 1%' : `about ${pct.toFixed(0)}%`} of the power bounces back`
}

export function zText(z?: [number, number]): string {
  if (!z) return ''
  return `${z[0].toFixed(1)} ${z[1] >= 0 ? '+' : '−'} j${Math.abs(z[1]).toFixed(1)} Ω`
}

// "1.258" from the QC log as 1.26.
export function n2(s: string | undefined): string {
  const n = Number(s)
  return s && Number.isFinite(n) ? n.toFixed(2) : '—'
}

export function lim(v: number): string {
  return Number.isInteger(v * 10) ? v.toFixed(1) : String(v)
}

export function day(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const h = d.getHours()
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()} ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function clamp(v: number, a = 0, b = 1): number {
  return v < a ? a : v > b ? b : v
}

export function rlOf(g: [number, number]): number {
  return -20 * Math.log10(Math.max(Math.hypot(g[0], g[1]), 1e-9))
}

// |Γ| of an SWR: 0 for a perfect match, 1 for none.
export function gam(swr: number): number {
  return swr <= 1 ? 0 : (swr - 1) / (swr + 1)
}

// Z = 50 (1 + Γ) / (1 − Γ)
export function zOfGamma(g: [number, number]): [number, number] {
  const [a, b] = g
  const d = (1 - a) ** 2 + b * b
  return d < 1e-12 ? [1e6, 0] : [(50 * (1 - a * a - b * b)) / d, (100 * b) / d]
}

// Γ = (Z − 50) / (Z + 50)
export function gammaOfZ(z: [number, number]): [number, number] {
  const [r, x] = z
  const d = (r + 50) ** 2 + x * x
  return d < 1e-9 ? [1, 0] : [((r - 50) * (r + 50) + x * x) / d, (x * (r + 50) - (r - 50) * x) / d]
}

// A quarter-wave whip's length in mm at f MHz, with the usual end effect (as vna.py's hint).
export function quarterWave(f: number): number {
  return (0.95 * 299792.458) / (4 * f)
}

export function trend(g: Group): string {
  const v = g.items.map(i => i.metrics?.meshtastic?.swr).filter((x): x is number => typeof x === 'number')
  if (v.length < 2) return ''
  return v.length > 3 ? `${fmt(v[0])} → … → ${fmt(v[v.length - 1])}` : v.map(x => fmt(x)).join(' → ')
}

export const HIST_MAX = 8

export const MAX_OVERLAYS = 6

export function hashLabel(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return h
}

// A colour mixed toward the panel: t = 1 is the colour itself, 0 the background.
export function shade(hex: string, t: number): string {
  const c = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16)
  return `#${[0, 1, 2].map(i => Math.round(c(BG, i) + (c(hex, i) - c(BG, i)) * clamp(t)).toString(16).padStart(2, '0')).join('')}`
}

export function sameSweep(a: { start: number; stop: number; points: number } | null | undefined, b: { start: number; stop: number; points: number } | null | undefined): boolean {
  return !!a && !!b && Math.abs(a.start - b.start) < 1 && Math.abs(a.stop - b.stop) < 1 && a.points === b.points
}

export function bandLabel(b: BandDef): string {
  return b.id === 'mesh' ? 'US 902–928' : `${b.short} ${Number(b.band[0].toFixed(2))}–${Number(b.band[1].toFixed(2))}`
}

export function itemSeries(i: Item, color: string, label: string, opacity = 0.85): Series {
  return { label, color, curve: i.curve, s11: i.s11, width: 1.6, opacity, metrics: i.metrics }
}

// Background work never rejects into the void (a reload or a test ending under it).
export function bg(p: Promise<unknown>): void {
  p.catch(() => undefined)
}

export function iso(t: number): string {
  try {
    return new Date(t).toISOString()
  } catch {
    return String(t)
  }
}

export const r1 = (n: number | undefined | null, d = 2): number | null => (typeof n === 'number' && Number.isFinite(n) ? Number(n.toFixed(d)) : null)
