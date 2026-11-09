// Fixed tables of the VNA tab: sizes, the instrument palette, the views and sections, the default QC rules.

import type { BandDef, Rules, Section, View } from './types'

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
export const PANE = 'vna'

export const PATH = `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`

export const LIVE_MS = 3000

export const IDLE_MS = 15_000

export const MONO = 'Menlo,monospace'

export const SANS = 'Helvetica,Arial,sans-serif'

export const W_DESK = 660

export const W_PHONE = 360

export const LOG_MAX = 1000

export const POLL_LOG_MS = 300

// ---------------------------------------------------------------- palette
// The Radio tab's: dark glass, a teal LCD, amber peaks, turbo-like accents. Green,
// amber and red only ever mean the SWR zones (≤ 1.5, ≤ 2, above).
export const BG = '#10161a'

export const PLOT = '#0c1215'

export const GRID = '#243238'

export const GRID2 = '#1a252a'

export const AXIS = '#7f9199'

export const LABEL = '#c9d4da'

export const BRIGHT = '#e6edf0'

export const CYAN = '#4fd1e0'

export const AMBER = '#f0c050'

export const YELLOW = '#ffd84a'

export const GREEN = '#7ad67a'

export const MAGENTA = '#e07be0'

export const ORANGE = '#f0a050'

export const RED = '#ff6b6b'

export const SKY = '#7fb8ff'

export const VIOLET = '#a98bff'

export const PINK = '#ff7eb6'

export const TEAL = '#3fd0b0'

export const LILAC = '#d0a8ff'

export const ICE = '#d8f6ff'

export const LCD = '#62f0dc'

// Each saved antenna's own colour, kept for good (cards, overlays, A/B, history): no green, amber
// or red, which mean the SWR zones, and no yellow, the live trace.
export const ANT = [CYAN, MAGENTA, SKY, VIOLET, ICE, PINK, TEAL, LILAC]

export const LIVE_COLOR = YELLOW

export const MESH: [number, string][] = [
  [906.875, 'Meshtastic'],
  [910.525, 'MeshCore'],
]

export const VIEWS: [View, string][] = [
  ['swr', 'SWR'],
  ['rl', 'Return loss'],
  ['rx', 'R & X'],
  ['smith', 'Smith'],
]

export const EXPLAIN: Record<View, string> = {
  swr: 'SWR (standing wave ratio) compares the wave sent out with the wave bouncing back. 1.0 is a perfect match; under 1.5 is excellent (4% or less comes back, green), under 2 good (11%, amber), over 3 poor (25% or more, red). The teal stripe is the US 902–928 MHz band, the bracket the stretch under 2:1, the ringed dot the lowest point. The scale is stretched toward 1, where the detail is.',
  rl: 'Return loss is how far below the outgoing wave the reflection is, in dB: the deeper the dip, the better. 10 dB means 10% of the power comes back (SWR 1.9), 14 dB is SWR 1.5, 20 dB is 1% (SWR 1.22). The NanoVNA’s LOGMAG trace is this same curve.',
  rx: 'An antenna looks like a resistance R (teal) in series with a reactance X (magenta). The goal is R = 50 Ω and X = 0. Where X crosses 0 the antenna resonates. X below 0 (blue) is capacitive: for a whip, electrically short. X above 0 (orange) is inductive: electrically long.',
  smith: 'The Smith chart folds R and X into one picture. The centre target is 50 Ω, a perfect match; the right edge is an open circuit, the left a short. The top half is inductive, the bottom capacitive. Inside the amber circle the SWR is under 2, inside the green one under 1.5. The trace runs blue at the low end of the sweep to red at the top; the bright stretch is 902–928 MHz.',
}

export const SECTIONS: [Section, string, string, string][] = [
  ['measure', 'Measure', LCD, 'the live reading and the chart'],
  ['trim', 'Trim', YELLOW, 'cutting or bending an antenna: where it resonates now'],
  ['library', 'Library', MAGENTA, 'saved antennas, each in its own colour'],
  ['qc', 'QC', AMBER, 'PASS / FAIL for units you sell'],
  ['bands', 'Bands', SKY, 'other radios: each band its own calibration slot'],
]

export const DEFAULT_RULES: Rules = { lo: 902, hi: 928, bandMax: 2, spots: [906.875, 910.525], spotMax: 1.5 }

// The mesh band before vna.py presets has answered (and when it cannot).
export const MESH_BAND: BandDef = {
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

// The meter's scale runs in |Γ| to SWR 4, as a real SWR meter's does.
export const G_FULL = 0.6
