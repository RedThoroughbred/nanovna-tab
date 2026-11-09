// The instrument pictures that depend on no tab state: the LCD digits, the SWR meter, the trim drawings, the bands map and the V4 dipole. No $.

import { AMBER, ANT, AXIS, BG, BRIGHT, CYAN, GREEN, G_FULL, LABEL, LCD, PINK, RED, SANS, SKY, TEAL, VIOLET, YELLOW } from './constants'
import { clamp, fmt, gam, grade, gradeOf, hashLabel, quarterWave, r1, rlOf, trend, zOfGamma } from './readings'
import { at, base, glowDef, n1, niceStep, svgDoc, txt, wrapText } from './svg-kit'
import type { BandDef, Geo, Group, Mark, Metrics, Qc, Resonance, Series, Trim, TrimRead, TrimWords } from './types'

export function rlPoints(s: Series): [number, number][] {
  const g = s.s11?.length === s.curve.length ? s.s11 : undefined
  return s.curve.map((p, i) => {
    const gi = g?.[i]
    return [p[0], gi ? rlOf(gi) : -20 * Math.log10(Math.max((p[1] - 1) / (p[1] + 1), 1e-9))]
  })
}

export function swrOfRl(rl: number): number {
  const g = 10 ** (-rl / 20)
  return g >= 0.999 ? 99 : (1 + g) / (1 - g)
}

// Frequency along the trace: blue at the bottom of the sweep, magenta, red at the top.
export const FREQ_STOPS: [number, [number, number, number]][] = [
  [0, [64, 140, 255]],
  [0.35, [139, 107, 255]],
  [0.68, [230, 85, 224]],
  [1, [255, 77, 77]],
]

export function fcol(t: number): string {
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

export const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '' }

export function segPolys(x: number, y: number, w: number, h: number, t: number): Record<string, string> {
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
export function lcdNumber(parts: string[], text: string, x: number, y: number, w: number, h: number, gap: number, col: string): number {
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
    const litKeys = SEG[ch] ?? ''
    for (const [k, pts] of Object.entries(segs)) {
      ghost.push(`<polygon points="${pts}"/>`)
      if (litKeys.includes(k)) lit.push(`<polygon points="${pts}"/>`)
    }
    dx += w + gap
  }
  const skew = `transform="translate(${n1((y + h / 2) * 0.105)},0) skewX(-6)"`
  parts.push(`<g ${skew} fill="${LCD}" fill-opacity="0.07">${ghost.join('')}</g>`)
  parts.push(`<g ${skew} fill="${col}" filter="url(#seg)">${lit.join('')}</g>`)
  return dx
}

// "1.36" with a ghost tens digit, as an LCD pads it.
export function lcdText(swr: number | undefined): string {
  if (swr === undefined) return ' -.--'
  return swr >= 9.995 ? ' 9.99' : ` ${swr.toFixed(2)}`
}

export function needleAngle(swr: number): number {
  return Math.PI * (1 - Math.min(gam(swr), G_FULL) / G_FULL)
}

export function polar(cx: number, cy: number, r: number, a: number): [number, number] {
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}

export function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M${n1(x0)},${n1(y0)}A${r},${r} 0 ${Math.abs(a0 - a1) > Math.PI ? 1 : 0} 1 ${n1(x1)},${n1(y1)}`
}

export function meter(parts: string[], cx: number, cy: number, r: number, mt: Mark, mc: Mark | undefined): void {
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

// The words for a band's grade: "Great match for 2 m ham".
export function bandVerdict(swr: number, who: string): string {
  const g = grade(swr)
  return g === 'A' ? `Great match for ${who}` : g === 'B' ? `Good match for ${who}` : g === 'C' ? `So-so match for ${who}: worth a trim or a better antenna` : `Poor match for ${who}: check the plug, then the antenna`
}

export function trimOf(res: Resonance, lo: number, hi: number): Trim {
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
export function whip(parts: string[], x: number, base: number, t: Trim, k: number): void {
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
export function ruler(parts: string[], x0: number, x1: number, y: number, t: Trim, lo: number, hi: number, c: boolean): void {
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

// Where an antenna resonates against 915 MHz, and what that means for the mesh channels.
export function resWords(m: Metrics | null): { text: string; color: string } {
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

export function cardAlt(gr: Group): string {
  const m = gr.latest.metrics
  return `${gr.label}: grade ${gradeOf(m) ?? '—'}, SWR ${fmt(m?.meshtastic?.swr)} at 906.875 and ${fmt(m?.meshcore?.swr)} at 910.525, best ${fmt(m?.best.swr)} at ${m?.best.mhz ?? '?'} MHz, ${resWords(m).text}${gr.items.length > 1 ? `, ${gr.items.length} versions (${trend(gr)})` : ''}`
}

export function qcAlt(q: Qc): string {
  return `QC ${q.pass ? 'PASS' : 'FAIL'}: ${q.checks.map(k => `${k.label} ${k.pass ? '✓' : '✗'} (${k.detail})`).join('; ')}`
}

// Where the antenna resonates: where X crosses zero going up (a series resonance, the one a whip
// has; the nearest the target when there are several), else the middle of the SWR dip's floor.
export function resonanceOf(curve: [number, number][], s11: [number, number][] | undefined, target: number): TrimRead | null {
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
export function crossed(d0: number, d1: number, tol: number): boolean {
  return (d0 < -tol && d1 > tol) || (d0 > tol && d1 < -tol)
}

export function fmtOff(d: number): string {
  const a = Math.abs(d)
  return a >= 10 ? `${a.toFixed(0)} MHz` : a >= 1 ? `${a.toFixed(1)} MHz` : `${Math.round(a * 1000)} kHz`
}

export function fmtF(f: number): string {
  return f >= 1000 ? f.toFixed(1) : f >= 200 ? f.toFixed(1) : f.toFixed(2)
}

// An arrow saying which way the resonance has to go, and what that means for the antenna.
export function trimArrow(parts: string[], cx: number, cy: number, w: TrimWords, k: number): void {
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

export const BAND_COLORS: Record<string, string> = { mesh: LCD, '2m': SKY, '70cm': VIOLET, adsb: PINK, ism433: TEAL, fm: CYAN }

export function bandColor(b: BandDef): string {
  return BAND_COLORS[b.id] ?? (ANT[hashLabel(b.id) % ANT.length] as string)
}

// The V4 dipole helper: the RTL-SDR Blog V4 kit's dipole, each element ≈ 7150 / MHz cm.
export const DIPOLE_TARGETS: [number, string, string][] = [
  [98, 'FM broadcast', 'fm'],
  [146.52, '2 m', '2m'],
  [433.92, '433 ISM', 'ism433'],
  [446, '70 cm', '70cm'],
  [915, 'LoRa 915', 'mesh'],
  [1090, 'ADS-B', 'adsb'],
]

export function dipoleCm(f: number): number {
  return 7150 / f
}

export function dipoleSvg(f: number, g: Geo): string {
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
