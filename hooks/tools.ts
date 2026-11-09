// Three tools Claude can call beside the tab (0.7.0). The tab owns the state and the queue; this file
// owns what Claude sees: the names, the schemas, the descriptions and what is refused. The calls
// themselves are answered in register.tsx (the tab's state lives there), so a tool call and a click on
// the tab go through the very same code, queue and lock.

// Tool names are mcp__<plugin name>__<tool>, with the hyphens of the plugin name kept.
export const TOOL_PREFIX = 'mcp__wildcat-vna__'

const SAFETY =
  'Never connect a transmitting radio, or a node\'s antenna output, to the NanoVNA: it can destroy the NanoVNA\'s input. Ask the person to unscrew an antenna from a node only while the node is off.'

export const READING_DESCRIPTION = `Reads the antenna on the NanoVNA the way the VNA tab does. Use it whenever the person asks how an antenna is doing, what the SWR is, whether it is tuned, or after they change (cut, bend, lengthen, swap) the antenna while you trim it. Returns the reading in plain words plus the numbers: whether a NanoVNA is connected (and what to do if not), the band and the calibration state, SWR, return loss and impedance (R and X) at 906.875, 910.525 and 915 MHz (or the band's own targets), the grade and verdict, the best SWR and the stretch under 2:1, the resonance with the trim hint, and the trim assistant's words (how far from the target, which way to go, "on frequency"). It uses the reading the tab shares when it is under about 10 seconds old, otherwise one short sweep. Pass { fresh: true } after the person changes the antenna, so the answer is a new sweep and not a reading from before the change. It only reads: it never changes anything on the NanoVNA. ${SAFETY}`

export const ANTENNAS_DESCRIPTION = `Reads the antennas the person saved in the VNA tab's Library. With no input it lists them (name, colour, how many versions, SWR at 907 MHz, best SWR and where). With { name } it gives that antenna's history, one line per saved version, so you can say whether it got better. With { a, b } it gives the compare table of two antennas (SWR at 906.875, 910.525 and 915, best, the stretch under 2:1, resonance; the better value is marked). Use it for "which antenna is best", "did my trim help" and "compare X and Y". It only reads and never changes the Library or the NanoVNA.`

export const ACTION_DESCRIPTION = `Does one safe thing the VNA tab's buttons do, through the same queue, so a tool call and a click never collide. Actions: save (name: sweep the antenna now and keep it in the Library as a new version of that name), markers (value "mesh" puts the NanoVNA's markers at 907, 910.5 and 915; "best" moves M1 to the lowest point), band (value is a band id from the tab, or "mesh" to go back to Meshtastic: it only recalls a save slot that already holds a calibration, and never writes one), trim (value "snip" logs the reading as a change on the trim timeline, which makes the tab say "closer" or "you passed it"; "reset" clears the timeline; "meshtastic", "meshcore" or a number in MHz sets the target), export (optional name: makes the report card, an SVG and a PNG). Use save only when the person asks to keep an antenna; use trim snip after each change in a trim loop. It will NOT calibrate, save the power-on layout, delete an antenna, turn the X trace on or off, or write any NanoVNA save slot: those stay in the tab, where the person confirms, and if asked it says to do it there. Do not try to work around that. ${SAFETY}`

const TAB_ONLY: [RegExp, string][] = [
  [
    /^(cal|calibrate|calibration|short|open|load)$/,
    'Calibration stays in the tab, where you confirm each plug: open /vna, go to Calibrate (or Bands, Calibrate for another band) and follow the open, short and load steps. I will not do it for you.',
  ],
  [
    /^(poweron|power-on|power|layout|preset|slot|writeslot|save-slot|saveslot)$/,
    'The power-on save and anything that writes a NanoVNA save slot stay in the tab: open /vna, Bands, and press the guarded button yourself.',
  ],
  [/^(delete|remove|rm|erase)$/, 'Deleting a saved antenna is done in the tab: open /vna, Library, and delete it there, where you confirm.'],
  [/^(x|xtrace|x-trace)$/, 'The X trace changes the NanoVNA\'s screen setup, so it stays in the tab: /vna x on or /vna x off, or the X button in Measure.'],
  [/^(qc)$/, 'QC records (PASS or FAIL, the CSV log and the certificate) are made in the tab: open /vna, QC.'],
]

export function parseAction(input: any): { ok: true; verb: 'save' | 'markers' | 'band' | 'trim' | 'export'; arg: string } | { ok: false; say: string } {
  const action = String(input?.action ?? '').trim().toLowerCase()
  const clean = (v: unknown) =>
    String(v ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const name = clean(input?.name).slice(0, 60)
  const value = clean(input?.value).slice(0, 60)
  for (const [re, say] of TAB_ONLY) if (re.test(action)) return { ok: false, say }
  switch (action) {
    case 'save':
      if (!name) return { ok: false, say: 'save needs a name: { action: "save", name: "Muzi Works #1" }.' }
      return { ok: true, verb: 'save', arg: name }
    case 'markers': {
      const v = value.toLowerCase()
      if (v !== 'mesh' && v !== 'best') return { ok: false, say: 'markers needs value "mesh" or "best".' }
      return { ok: true, verb: 'markers', arg: v }
    }
    case 'band': {
      const v = value.toLowerCase()
      if (/^(cal|calibrate)\b/.test(v)) return { ok: false, say: TAB_ONLY[0]?.[1] ?? '' }
      if (!/^[a-z0-9_-]{1,24}$/.test(v)) return { ok: false, say: 'band needs a band id from the tab (for example mesh, 2m, 70cm), or "mesh" to go back to Meshtastic.' }
      return { ok: true, verb: 'band', arg: /^(back|mesh|meshtastic|home)$/.test(v) ? 'mesh' : v }
    }
    case 'trim': {
      const v = value.toLowerCase().replace(/\s*mhz$/, '')
      if (v === 'snip' || v === 'reset' || v === 'meshtastic' || v === 'meshcore') return { ok: true, verb: 'trim', arg: v }
      if (v === 'new') return { ok: true, verb: 'trim', arg: 'reset' }
      const f = Number(v)
      if (v !== '' && Number.isFinite(f) && f >= 1 && f <= 6000) return { ok: true, verb: 'trim', arg: String(f) }
      return { ok: false, say: 'trim needs value "snip", "reset", "meshtastic", "meshcore" or a target in MHz (for example 906.875).' }
    }
    case 'export':
      return { ok: true, verb: 'export', arg: name }
    default:
      return { ok: false, say: `vna_action can do save, markers, band, trim and export. "${action || '(nothing)'}" is not one of them; if it is something the tab does (calibrating, the power-on layout, deleting, the X trace, QC), do it in the tab: /vna.` }
  }
}
