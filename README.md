# nanovna-tab

A **VNA** tab for Claude Code that drives a NanoVNA (DiSlord firmware, e.g. NanoVNA-H4 1.2.x) over the Mac's USB, and explains what it is reading as it goes. It is built for tuning and testing antennas: live SWR with a grade and a plain verdict, a trim assistant for cutting a whip, an antenna library with history and compare, a QC mode with certificates, and band presets.

## Install

In Claude Code 2.1.275 or later:

```
/plugin install vna --marketplace RedThoroughbred/nanovna-tab
```

Then `/vna` opens the tab.

## What you need

- **A Mac.** The tab finds the NanoVNA in the Mac's USB device tree and keeps its files under `~/Library`.
- **A NanoVNA running DiSlord's firmware 1.2.x.** Tested on a NanoVNA-H4 with 1.2.44. Many H4s only connect over a USB-A to USB-C cable.
- **Python 3.** `scripts/vna.py` uses the standard library only.
- **For PNG exports:** Google Chrome or `rsvg-convert`. Without either you still get the SVG.
- **The main band is the US mesh band, 902–928 MHz** (Meshtastic and MeshCore). The 868 MHz EU band isn't built in yet; other bands work through presets.
- **Wi-Fi is experimental.** The tab can also reach the NanoVNA through a Heltec V4 running a small bridge firmware, which isn't published yet. USB is the supported way.

**Power-on is always slot 0, the Meshtastic layout, unchanged.** Nothing in the tab writes slot 0 except two things you ask for by name: the mesh recalibration (Calibrate on the 850–980 MHz band, as in 0.4.0) and "Make this my power-on layout" (Bands, with a confirmation). Band presets use slots 1–6.

## The five places

One row of buttons at the top: **Measure · Trim · Library · QC · Bands**, then **?** (the guide) and **📸 Export**. The tab remembers the last place. Every big view also opens in **its own tab** (⤢ on its title row, or `/vna tab <view>`): `reading`, `chart`, `smith`, `trim`, `library`, `qc`, `bands`, `guide`. An own tab draws that view alone, with the same top rows, and reads well on the phone.

The top rows of every pane: the NanoVNA (board, USB or Wi-Fi, firmware, battery, live or paused), the band being swept with its slot and whether its calibration is good for it (**CAL**, or **UNCAL** in amber with why), and while a press runs, **Doing now** (its step and how long it should take) and **Next** (the press waiting behind it).

### Measure

As 0.4.0: the hero (SWR at Meshtastic 906.875 MHz in big 7-segment LCD digits and MeshCore 910.525 in small ones, coloured by zone; an SWR meter in |Γ|; a letter grade and a one-line verdict with what it means), the readings at 906.875 / 910.525 / 915, the NanoVNA's markers, the best point and the stretch under SWR 2, the resonance hint with its whip drawing, and the chart with four views (SWR, return loss, R & X, Smith), each explained under it. On another band the hero and the readings are at that band's target (2 m calling 146.52, 70 cm calling 446, ADS-B 1090...), the chart marks that band, and the status line says `VNA · 2 m · SWR 1.41 @146.52`.

Under the chart: Pause live, Save (a name field on the desktop, one press on the phone), Calibrate (the band you are on: slot 0 on the mesh band, the band's own slot elsewhere), Screenshot, **Trace 4: X** and Mesh layout, with one line saying what each does.

### Trim: the live trim assistant

For cutting or bending an antenna. A big LCD readout of where it resonates now (where X crosses zero going up, the nearest the target; for a matched antenna with no crossing, the middle of the SWR dip's floor), against the target (Meshtastic 906.875 by default, MeshCore 910.525 a press away; each band its own), an arrow (raise it: cut; lower it: lengthen; a tick on frequency) and a plain verdict:

- `12 MHz low · cut a little` (under 0.6% "trim a hair", over 3% "cut more"; above the target "add a little length");
- `closer… 4.4 MHz low · cut a little` when the last change got closer;
- `On frequency ✓` within ±0.25% (2.3 MHz at 907) or one sweep step;
- `You passed it · now 6.1 MHz high` when the last change crossed the target, with an undo hint ("that cut went too far. Undo: lengthen a touch (straighten a bend, solder a short extension or slide a sleeve on the tip), or stop here if the SWR is fine").

A timeline under it logs every change: a step is logged when the resonance has moved 0.4% (3.6 MHz at 907) and two readings in a row agree (so handling the antenna logs nothing), or when you press **✂ Snip**. Each step keeps its time, where it resonated, how it was found and the SWR at the target; the chart shows each as a dot above (short) or below (long) the target line, and a passed one ringed in red. Changing the target re-measures the whole timeline. It uses the live sweep and changes nothing on the NanoVNA. `/vna trim` prints it; `/vna trim snip`, `/vna trim 915`, `/vna trim reset`.

### Library

The antennas as cards, **each in its own colour**: kept for good in the plugin's store (a new antenna takes the colour fewest others have), and the same colour on its card (frame, header tint, bar and name), as its overlay on the Measure chart, as A or B in a compare, and as the shades of its history. The grade, the sparkline and the numbers keep the SWR zone colours. Green, amber and red are never an antenna's colour; yellow stays the live trace. The terminal shows each name in its colour. Overlay (○ chart), A and B, and N versions work as in 0.4.0; compare and history open the Library.

### QC

As 0.4.0: PASS / FAIL stamp, a meter per check, **Save as Unit N**, the CSV log and a certificate per unit. The verdict is worked out in the tab from the live curve (the same rule as `vna.py`'s), so every session gets it from the one shared reading. QC tests mesh units: on another band it says to go back to Meshtastic.

### Bands

A band map (log frequency on the desktop, with tooltips; rows on the phone), each band in its colour with its slot and CAL / UNCAL, the one being swept glowing. Built in:

| Band | Sweep (201 points) | Band / target | Slot |
|---|---|---|---|
| Meshtastic / MeshCore | 850–980 MHz | 902–928, 906.875 / 910.525 | 0 (power-on; never written by presets) |
| 2 m ham (UV-5R) | 130–165 MHz | 144–148, 146.52 | 1 |
| 70 cm ham (UV-5R) | 400–470 MHz | 420–450, 446.0 | 2 |
| ADS-B 1090 | 1000–1180 MHz | 1087–1093, 1090 | 3 |
| 433 MHz ISM | 410–456 MHz | 433.05–434.79, 433.92 | 4 |
| FM broadcast | 76–120 MHz | 88–108, 98 | 5 |

Slot 6 is free for a band of your own. Your own bands and the band → slot map live in `~/Library/Application Support/vna/presets.json` (written with the defaults the first time; a file that does not read as JSON is never overwritten, and the tab says so):

```json
{ "slots": { "2m": 1, "70cm": 2, "adsb": 3, "ism433": 4, "fm": 5, "cb": 6 },
  "bands": [ { "id": "cb", "name": "CB 11 m", "startMHz": 25, "stopMHz": 29, "band": [26.965, 27.405], "targets": [[27.185, "ch 19"]] } ] }
```

A band mapped to slot 0, to a slot the NanoVNA does not have, or to no slot gets no Calibrate button and says why. Two bands sharing a slot each replace the other's calibration (both say so).

- **Switch** (`Switch to 2 m`, `/vna band 2m`): a band with a calibration is `recall N`, checked afterwards (the sweep must be the band's; a slot the NanoVNA has lost says so). A band without one sweeps its range uncalibrated (nothing recalled or saved) and shows UNCAL with "Calibrate saves it to slot N".
- **Back to Meshtastic** (`/vna band mesh`, `/vna back`): `recall 0`, which restores exactly what the NanoVNA starts with. Pressed while slot 0 is already known to be in use, it asks the NanoVNA nothing.
- **Calibrate → slot N** (`/vna band cal 2m`): the 0.4.0 guided OPEN → SHORT → LOAD for that band: it sets the band's sweep, the mesh layout's traces and markers on the band's target and edges, checks each plug, and saves to the band's slot. Cancel recalls the slot that was in use before. The calibration is recorded in presets.json (band, slot, sweep, when, the LOAD's return loss), which is how the tab knows a band is calibrated.
- The mesh **Calibrate** now refuses unless the sweep is 850–980 MHz / 201, so slot 0 only ever gets the mesh band.
- The NanoVNA's own **Backup** setting (DiSlord: Config, off unless you turned it on) makes it start in the slot and range used last. With it on, press Back to Meshtastic before switching off. The shell has no way to read the setting, so the tab cannot check it.

**The optional 4th trace.** *Show X on trace 4* (Measure or Bands, `/vna x on|off`) sets trace 3 to the reactance X of S11 (`trace 3 x 0`, 25 Ω a division, zero on the middle line) on the NanoVNA's screen now, without saving: switched off and on, it starts as before. X crosses zero where the antenna resonates; it tells you longer or shorter.

**Make this my power-on layout…** writes slot 0 with the mesh calibration in use, 850–980 MHz at 201 points, traces SWR · Smith · LOGMAG (· X when trace 4 shows X), markers M1 907.2 / M2 910.45 / M3 915. The first press only checks and asks: it refuses (and says which) unless the NanoVNA is connected, no calibration is under way, the sweep is exactly 850–980 MHz / 201, the NanoVNA reports a calibration, and the calibration in use is known to be slot 0's (after Back to Meshtastic or the mesh recalibration in this sweep; after a band, a cal reset, or a change on the NanoVNA's own screen it is not). Then a box names what it writes; **Yes, save slot 0** saves it. `vna.py poweron save` checks all of it again and refuses without `--confirm`.

**V4 dipole helper.** Pick what to listen to (FM 98, 2 m, 433, 70 cm, LoRa 915, ADS-B 1090): a drawing of the RTL-SDR Blog V4 kit's dipole with each element's length (≈ 7150 / MHz cm, e.g. 6.6 cm at 1090), then *Sweep it* switches to that band and opens Trim aimed at that frequency to confirm the dip.

### The guide

**?** opens "How the VNA tab works": one card per place, calibration, the buttons and several sessions, then **What this NanoVNA can do**, checked against DiSlord's firmware source (1.2.40 and 1.2.46, either side of this H4's 1.2.44): sweeps from under 1 kHz to 2.7 GHz, with harmonics above 300 MHz so its dynamic range is best below about 300 MHz; S11 for antennas, S21 for filters, cables and attenuators; time-domain (TDR) for cable length and faults, plus cable, resonance and LC-match measure modes; up to 401 points; 7 save slots on the H4; accuracy comes from calibration; and never connect a transmitting radio or a node's antenna output to it.

### 📸 Export

The Export button (the top row, desktop and phone) or `/vna export [name]` makes one tall portrait report card in the instrument style, from the tab's own pictures (their phone layouts, so it matches): a header (the name or "Live", the date and time, `NanoVNA-H4 · fw 1.2.44 · calibrated 850–980 MHz`), the hero, the SWR chart, an A/B compare when one is set (overlays are on the chart), the Smith chart, a numbers table (SWR, return loss, reflected %, mismatch loss and Z at 906.875 / 910.525 / 915, the best point, the width under 2:1, resonance and the trim hint) and a "Wildcat RF" footer. It is saved as `~/NanoVNA/exports/<name>-<yyyymmdd-hhmm>.svg` and `.png` (540 px wide at 2x: 1080 px, for LinkedIn or TikTok), shown in Finder (`open -R`) and toasted. The PNG comes from headless Google Chrome (a throwaway profile, a 30 s alarm, its process group killed and the profile deleted after), else `rsvg-convert`; with neither, the SVG stays and the tab says so.

## Presses and polls

For every button:

- **Shown at once.** A press shows on its button in the very next drawing ("Placing…", "Saving…", "Recalling slot 0…"), and at the top as **Doing now** with its step and "about N s" (learned from the last time).
- **One at a time, never dropped.** A press while another runs is queued (dim "Queued: …", and **Next** at the top) and runs when that one ends. Only one waits: a newer press replaces it (the last click wins; the replaced one is logged as `superseded`). The same press again joins it: three quick clicks run once.
- **A press says what it wants.** "Show X", "overlay this", "Back to Meshtastic", never "toggle": a second press from a drawing a moment old asks for the same thing again, and one for what is already so changes nothing.
- **Presses before polls.** Device commands run one at a time; a press waits only for a sweep already under way, polls never run while a press runs or waits, and reads that never touch the device (the library, presets, the QC log) run beside them.
- **The timing log.** Each press adds a line to `~/Library/Application Support/vna/actions.jsonl` (the last 1000): `action`, `key`, `pressedAt`, `startedAt`, `finishedAt`, `waitMs`, `runMs`, `expectMs`, `step`, `queued`, `coalesced`, `ok` (false with `failed`, also toasted), or `superseded: true` with `by`. A poll over 300 ms adds `{"poll": …, "ms": …}` (always when a press waited behind it: `delayedAPress`).

```sh
tail -n 20 ~/Library/Application\ Support/vna/actions.jsonl | jq -c '{action, waitMs, runMs, expectMs, queued, coalesced, ok}'
```

## Several Claude sessions, one NanoVNA

With the plugin loaded in several sessions, only one of them talks to the NanoVNA:

- **A lease.** The session that polls holds `~/Library/Caches/vna/lease.json` (its id, its Claude process, until when: 10 s, renewed with each poll). The others read the reading it writes to `~/Library/Application Support/vna/live.json` (with when it was taken) and never sweep. When the holder's Claude process is gone or its lease runs out, the next session to poll takes over.
- **Only when someone is looking.** A session whose VNA pane is on screen touches `~/Library/Caches/vna/watch-<session>`; the holder sweeps only while one of these is under 10 s old. With no VNA tab on screen anywhere, nothing talks to the NanoVNA.
- **`/vna` always answers.** From the shared reading when it is under 10 s old; else one short sweep (waiting at most 2 s for the device, 7 s in all); else "NanoVNA busy; Last reading 2 min ago:" and that reading. Every command answers within 7 s: a press that takes longer says "Working on it" and finishes in the tab.
- **Bounded everywhere.** `vna.py` waits a bounded time for the device lock (1.5 s for a poll, 2 s for `/vna`, 6 s for a press) and answers `busy` with the last shared reading past it; a NanoVNA that does not answer `version` within 3 s is reported at once (0.4.0 once spent 51 s there); each verb has a watchdog; the port is opened exclusively (TIOCEXCL), so a second program cannot interleave its commands; a reading whose point count does not match the sweep is dropped as garbled.

## The status line and Herdr

The status line (`VNA · SWR 1.23 @907`, `VNA · 2 m · SWR 1.41 @146.52`, `VNA · nothing on PORT 1`)
shows only while a NanoVNA is connected; with none connected there is nothing. `/vna hide` puts it
away and `/vna show` brings it back (remembered).

The same line is also written to `~/.claude/mod-status/vna.json`, which the Herdr app's status strip
reads to show it once for the whole window: `{"mod": "vna", "text": "SWR 1.23 @907", "level": "ok",
"at": <ms since epoch>}`. The text is the status line without `VNA · `; `level` is `alert` on SWR 3 or
more or a QC FAIL, `warn` on SWR 2 or more or nothing on PORT 1, `ok` otherwise. The file is written
atomically (a temp file in the same folder, then `mv`), rewritten when the line changes (a change of
the reading alone at most every 15 s) and at least every 10 minutes, and deleted when the NanoVNA is
unplugged or by `/vna hide`.

Inside Herdr (it sets `HC_TERMINAL_ID` in every terminal) the status line under the prompt is never
set, since the strip shows it. Outside Herdr the status line works as before, and the file is written
too. `hooks/mod-status.ts` does this.

## Commands

| Command | What it does |
|---|---|
| `/vna` | The whole reading as text (from the shared reading when fresh) |
| `/vna save <name>` | Save the antenna on PORT 1 (the same name adds a version) |
| `/vna trim [snip\|reset\|<MHz>\|meshtastic\|meshcore]` | The trim assistant as text; log a change; start a new timeline; aim at a frequency |
| `/vna band [<id>\|mesh\|cal <id>]` | The bands and slots; switch (recall its slot); back to Meshtastic (recall 0); calibrate a band into its slot |
| `/vna back` | Back to Meshtastic (recall 0) |
| `/vna x on\|off` | Trace 4 = X on the NanoVNA's screen, not saved |
| `/vna poweron` | Checks and explains the power-on save; the save itself is the tab's "Yes, save slot 0" |
| `/vna compare <a> <b>` | Side-by-side table; `/vna compare off` clears it |
| `/vna history <name>` | Every version of one antenna; `/vna history off` |
| `/vna markers mesh` / `best` | M1–M3 on 907 / 910.5 / 915, or M1 on the lowest SWR |
| `/vna view swr\|rl\|rx\|smith` | Switch the chart and explain it |
| `/vna qc` / `on` / `off` / `save [unit]` / `rules …` / `log` | QC mode, as 0.4.0 |
| `/vna tab <view>` | Open reading, chart, smith, trim, library, qc, bands or guide in its own tab |
| `/vna export [name]` | The report card, SVG and PNG, shown in Finder |
| `/vna guide` | How the tab works and what this NanoVNA can do |
| `/vna hide` / `show` | The status line and the Herdr strip's entry (remembered) |
| `/vna cal`, `/vna shot`, `/vna layout`, `/vna msg <text>`, `/vna live on\|off`, `/vna delete <name>` | As 0.4.0 (cal calibrates the band you are on) |

## Notes

The port is found from the USB device tree (product name NanoVNA), so the tab never opens another serial device; opening a Meshtastic node's port turns its Bluetooth off. Many NanoVNA-H4s only connect over a USB-A to USB-C cable.

`scripts/vna.py` is standard-library Python and works on its own (`python3 scripts/vna.py live`, `band 2m`, `presets`, `poll --session x`, `export --svg f --name n`). `NANOVNA_DIR` moves the library, log, certificates and exports; `VNA_STATE_DIR` and `VNA_LOCK_DIR` move the state and lock folders; `VNA_NO_DEVICE=1` makes it find no NanoVNA (the tests use all of them).

Save slots: DiSlord's `SAVEAREA_MAX` (hardware.h) is 7 on the STM32F303 boards (NanoVNA-H4: slots 0–6) and 5 on the F072 NanoVNA-H (0–4); `vna.py` picks by the board `info` reports.

## Tests

- `claude plugin test .` (from this folder) draws the tab on the terminal, desktop, VS Code and phone from a captured real sweep, synthetic whips and a 2 m sweep: the five places, every picture's height and size in each, the hero, the trimming drawing, QC, the cards in their own colours with A/B in the same colours, the first-click presses (the pending label, queued, the newest waiting press winning, three presses running once, a press waiting only for the sweep under way and no polls meanwhile, the timing log), the lease (another session's reading shown, no sweeps), `/vna` from a fresh shared reading, a busy lock and a silent NanoVNA still answering, a slow press answering in time, band switch and back (recall N, recall 0, nothing calibrated or saved, a slot-0 band offering no calibration), the power-on button's refusals and its confirmation, the trim assistant's steps, crossing and undo hint, own tabs, the export card (the tab's pictures, unique ids, sizes, the file names it hands on, a failed PNG), and the status line and its Herdr file (outside and inside Herdr, nothing while none is connected, unplugging, the levels, hide and show).
- `python3 -m unittest discover -s tests -p 'test_*.py'` runs `vna.py`'s slot, band and power-on logic against a fake NanoVNA shell that keeps its own save slots: presets never write slot 0 (every built-in band calibrates into its own slot and slot 0 stays byte for byte), a band mapped to slot 0 is refused before anything is sent, switching to a band and back restores the power-on state exactly, an uncalibrated band sweeps without recalling or saving, a lost slot is reported, cancel goes back, the mesh calibration only on the mesh sweep, every power-on refusal and the save itself, trace 4 as X of S11, the lease (taken, renewed, run out, a dead holder), no device traffic with nobody watching, a busy lock answering at once for live, save and band, and the export's names, placement and a failed converter keeping the SVG.

## Files (0.5.0)

The library (sweeps, `qc-log.csv`, `qc/` certificates, screenshots, `exports/`) is in `~/NanoVNA` (local, not synced). In `~/Library/Application Support/vna/`: `presets.json`, `live.json`, `slot-state.json` (which slot's calibration is in use, as far as the tab has seen), `cal-state.json`, `bridge.json`, `actions.jsonl`. In `~/Library/Caches/vna/`: `nanovna.lock`, `lease.json`, `lease.lock`, `watch-<session>`. Nothing lives in `~/Documents`.

## License

MIT. See [LICENSE](LICENSE). An independent project, not affiliated with the NanoVNA makers or DiSlord.
