"""vna.py's slot, band and power-on logic without the NanoVNA:
python3 -m unittest discover -s tests -p 'test_*.py'

A fake NanoVNA shell (FakeNano) answers the commands vna.py sends the way DiSlord's firmware does
(1.2.4x: `save N`, `recall N` with "Err, default load", `trace`, `sweep`, `cal`), keeping its own save
slots, so every test can check what was written where. State and library folders are throwaway
(VNA_STATE_DIR, NANOVNA_DIR); no serial port is opened.
"""
import cmath
import copy
import fcntl
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import unittest

STATE = tempfile.mkdtemp(prefix="vna-test-state-")
LOCKS = tempfile.mkdtemp(prefix="vna-test-locks-")
os.environ["VNA_STATE_DIR"] = STATE
os.environ["VNA_LOCK_DIR"] = LOCKS
os.environ["NANOVNA_DIR"] = tempfile.mkdtemp(prefix="vna-test-lib-")
# Never the real NanoVNA (nor a bridge): find_port answers None, and the state folder has no bridge.json.
os.environ["VNA_NO_DEVICE"] = "1"
os.environ["VNA_NO_REVEAL"] = "1"  # no Finder window from the export tests
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "vna.py")
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))
import vna  # noqa: E402

time.sleep = lambda *_: None  # the calibration's settling pauses

TYPES = {"swr": "SWR", "smith": "SMITH", "logmag": "LOGMAG", "x": "X", "r": "R", "phase": "PHASE"}
DEFAULT_SCALE = {"SWR": (0.25, 0.0), "SMITH": (1.0, 0.0), "LOGMAG": (10.0, 7.0), "X": (100.0, 4.0), "R": (100.0, 0.0), "PHASE": (90.0, 4.0)}


def mesh_state():
    """Slot 0 as Seth's NanoVNA holds it: the mesh sweep, SWR / Smith / LOGMAG, trace 3 off (its
    channel the firmware default S21), markers on 907.2 / 910.45 / 915, calibrated."""
    return {"sweep": [850000000, 980000000, 201], "cal": "load Es Er cal'ed",
            "traces": {0: ["SWR", "S11", 0.5, 0.0, True], 1: ["SMITH", "S11", 1.0, 0.0, True],
                       2: ["LOGMAG", "S11", 5.0, 8.0, True], 3: ["PHASE", "S21", 90.0, 4.0, False]},
            "markers": {1: 88, 2: 93, 3: 100}}


class FakeNano:
    def __init__(self, board="NanoVNA-H 4", slots=7):
        self.board = board
        self.nslots = slots
        self.state = mesh_state()
        self.slots = {0: copy.deepcopy(self.state)}
        self.sent = []
        self.plug = "antenna"

    # What PORT 1 reflects: an open, a short (180 degrees from it), a 50 ohm load, or a whip.
    def gamma(self, f):
        ph = -2 * math.pi * f / 1.2e9
        if self.plug == "open":
            return 0.95 * cmath.exp(1j * ph)
        if self.plug == "short":
            return -0.95 * cmath.exp(1j * ph)
        if self.plug == "load":
            return complex(0.01, 0.0)
        z = complex(40, 400 * (f / 915e6 - 915e6 / f))
        return (z - 50) / (z + 50)

    def freqs(self):
        a, b, n = self.state["sweep"]
        return [a + (b - a) * i / (n - 1) for i in range(n)]

    def cmd(self, line, wait=10.0):
        self.sent.append(line)
        p = line.split()
        st = self.state
        if not p:
            return []
        c = p[0]
        if c == "version":
            return ["1.2.44"]
        if c == "info":
            return [f"Board: {self.board}", "Version: 1.2.44 [p:401, IF:12k, ADC:384k, Lcd:480x320]"]
        if c == "vbat":
            return ["4200 mV"]
        if c == "msg":
            return []
        if c == "sweep":
            if len(p) == 1:
                a, b, n = st["sweep"]
                return [f"{a} {b} {n}"]
            st["sweep"] = [int(p[1]), int(p[2]), int(p[3]) if len(p) > 3 else st["sweep"][2]]
            return []
        if c == "frequencies":
            return [f"{f:.0f}" for f in self.freqs()]
        if c == "data":
            return [f"{g.real:.9f} {g.imag:.9f}" for g in (self.gamma(f) for f in self.freqs())]
        if c == "cal":
            if len(p) == 1:
                return [st["cal"] + " "]
            if p[1] == "reset":
                st["cal"] = ""
            elif p[1] in ("open", "short", "load"):
                st["cal"] = (st["cal"] + " " + p[1]).strip()
            elif p[1] == "done":
                st["cal"] = "load Es Er cal'ed"
            return []
        if c == "save":
            if len(p) == 2 and p[1].isdigit() and int(p[1]) < self.nslots:
                self.slots[int(p[1])] = copy.deepcopy(st)
                return []
            return ["usage: save 0..6"]
        if c == "recall":
            if len(p) == 2 and p[1].isdigit() and int(p[1]) < self.nslots:
                n = int(p[1])
                if n in self.slots:
                    self.state = copy.deepcopy(self.slots[n])
                    return []
                self.state = {"sweep": [50000, 900000000, 101], "cal": "", "traces": mesh_state()["traces"], "markers": {}}
                return ["Err, default load"]
            return ["usage: recall 0..6"]
        if c == "trace":
            if len(p) == 1:
                return [f"{n} {t[0]} {t[1]} {t[2]:.6f} {t[3]:.6f}" for n, t in sorted(st["traces"].items()) if t[4]]
            n = int(p[1])
            t = st["traces"][n]
            if p[2] == "off":
                t[4] = False
            elif p[2] in TYPES:
                name = TYPES[p[2]]
                ch = ("S11", "S21")[int(p[3])] if len(p) > 3 else t[1]
                if name != t[0]:
                    t[2], t[3] = DEFAULT_SCALE[name]
                t[0], t[1], t[4] = name, ch, True
            elif p[2] == "scale":
                t[2] = float(p[3])
            elif p[2] == "refpos":
                t[3] = float(p[3])
            return []
        if c == "marker":
            if len(p) == 1:
                fs = self.freqs()
                return [f"{n} {i} {fs[i]:.0f}" for n, i in sorted(st["markers"].items()) if i < len(fs)]
            if p[2].isdigit():
                st["markers"][int(p[1])] = int(p[2])
            return []
        return [f"{c}?"]

    def writes(self):
        return [l for l in self.sent if l.startswith("save")]


def reset_state():
    for d in (STATE, LOCKS):
        for name in os.listdir(d):
            os.remove(os.path.join(d, name))


def run(*args, timeout=15):
    """vna.py as the tab runs it: one JSON object out, and how long it took."""
    t0 = time.monotonic()
    r = subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True, timeout=timeout)
    return json.loads(r.stdout), time.monotonic() - t0


LIVE_SAMPLE = {"connected": True, "board": "NanoVNA-H 4", "version": "1.2.44", "calibrated": True,
               "sweep": {"start": 850e6, "stop": 980e6, "points": 201}, "curve": [[906.875, 1.23]],
               "metrics": {"meshtastic": {"mhz": 906.875, "swr": 1.23}, "best": {"mhz": 906.875, "swr": 1.23}}, "at": 1, "by": "sA"}


def write_presets(obj):
    with open(vna.PRESETS, "w") as f:
        json.dump(obj, f)


def calibrate_band(fake, band_id):
    """The guided OPEN / SHORT / LOAD for a band, the plugs swapped as the steps ask."""
    b, _, _ = vna.find_band(band_id, fake.nslots)
    steps = []
    for step, plug in (("begin", "antenna"), ("open", "open"), ("short", "short"), ("load", "load")):
        fake.plug = plug
        steps.append(vna.calibrate(fake, step, b, fake.nslots))
    fake.plug = "antenna"
    return steps


class Slots(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_the_h4_has_seven_slots_and_the_h_five(self):
        self.assertEqual(vna.slot_count("NanoVNA-H 4"), 7)
        self.assertEqual(vna.slot_count("NanoVNA-H4"), 7)
        self.assertEqual(vna.slot_count("NanoVNA-H"), 5)

    def test_save_slot_refuses_slot_0_unless_it_is_the_mesh_path(self):
        fake = FakeNano()
        for bad in (0, True, -1, "1"):
            with self.assertRaises(ValueError):
                vna.save_slot(fake, bad)
        self.assertEqual(fake.writes(), [])
        vna.save_slot(fake, 3)
        vna.save_slot(fake, 0, mesh=True)
        self.assertEqual(fake.writes(), ["save 3", "save 0"])

    def test_traces_parse_from_the_firmware_listing(self):
        fake = FakeNano()
        t = vna.read_traces(fake)
        self.assertEqual([(x["n"], x["type"], x["ch"]) for x in t], [(0, "swr", "S11"), (1, "smith", "S11"), (2, "logmag", "S11")])
        self.assertEqual(t[2]["refpos"], 8.0)

    def test_preset_sends_the_same_layout_as_before(self):
        fake = FakeNano()
        vna.preset(fake)
        self.assertEqual([l for l in fake.sent if not l.startswith("msg")],
                         ["sweep 850000000 980000000 201", "trace 0 swr", "trace 0 scale 0.5", "trace 0 refpos 0", "trace 1 smith",
                          "trace 2 logmag", "trace 2 scale 5", "trace 2 refpos 8", "trace 3 off", "marker 1 88", "marker 2 93", "marker 3 100"])


class Presets(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_defaults_file_and_slot_map(self):
        v = vna.presets_view()
        self.assertTrue(os.path.exists(vna.PRESETS))
        by = {b["id"]: b for b in v["bands"]}
        self.assertEqual(by["mesh"]["slot"], 0)
        self.assertTrue(by["mesh"]["powerOn"])
        self.assertEqual({k: by[k]["slot"] for k in ("2m", "70cm", "adsb", "ism433", "fm")}, {"2m": 1, "70cm": 2, "adsb": 3, "ism433": 4, "fm": 5})
        self.assertEqual(v["slots"], 7)
        self.assertEqual(v["spare"], [1, 2, 3, 4, 5, 6])
        for b in v["bands"]:
            if b["id"] != "mesh":
                self.assertIn(b["slot"], v["spare"])
                self.assertFalse(b["calOk"])

    def test_a_band_mapped_to_slot_0_gets_no_slot(self):
        write_presets({"slots": {"2m": 0, "fm": 9, "adsb": True}})
        by = {b["id"]: b for b in vna.presets_view()["bands"]}
        self.assertIsNone(by["2m"]["slot"])
        self.assertIn("power-on", by["2m"]["slotWhy"])
        self.assertIsNone(by["fm"]["slot"])
        self.assertIn("does not exist", by["fm"]["slotWhy"])
        self.assertIsNone(by["adsb"]["slot"])

    def test_presets_never_write_slot_0(self):
        """Every band's calibration lands in its own spare slot; slot 0 stays byte for byte as it was."""
        for b in vna.BUILTIN_BANDS:
            if b["id"] == "mesh":
                continue
            reset_state()
            fake = FakeNano()
            slot0 = copy.deepcopy(fake.slots[0])
            steps = calibrate_band(fake, b["id"])
            self.assertEqual([s["ok"] for s in steps], [True] * 4, steps)
            slot = vna.DEFAULT_SLOTS[b["id"]]
            self.assertEqual(fake.writes(), [f"save {slot}"])
            self.assertNotIn("save 0", fake.sent)
            self.assertEqual(fake.slots[0], slot0)
            self.assertEqual(fake.slots[slot]["sweep"], [int(b["start"]), int(b["stop"]), 201])
            by = {x["id"]: x for x in vna.presets_view()["bands"]}
            self.assertTrue(by[b["id"]]["calOk"])
            self.assertEqual(vna.slot_state()["slot"], slot)

    def test_a_band_with_slot_0_is_refused_before_anything_is_sent(self):
        write_presets({"slots": {"2m": 0}})
        fake = FakeNano()
        b, _, _ = vna.find_band("2m", 7)
        r = vna.calibrate(fake, "begin", b, 7)
        self.assertFalse(r["ok"])
        self.assertEqual(r["refused"], "slot")
        # Only the sweep was read: nothing set, reset or written.
        self.assertEqual(fake.sent, ["sweep"])

    def test_your_own_band_in_presets_json(self):
        write_presets({"slots": {"cb": 6}, "bands": [{"id": "cb", "name": "CB 11 m", "startMHz": 25, "stopMHz": 29, "band": [26.965, 27.405], "targets": [[27.185, "ch 19"]]}]})
        fake = FakeNano()
        steps = calibrate_band(fake, "cb")
        self.assertTrue(all(s["ok"] for s in steps))
        self.assertEqual(fake.writes(), ["save 6"])
        cb = [b for b in vna.presets_view()["bands"] if b["id"] == "cb"][0]
        self.assertTrue(cb["calOk"])
        self.assertEqual(cb["targets"], [[27.185, "ch 19"]])

    def test_a_file_that_does_not_read_is_never_overwritten(self):
        with open(vna.PRESETS, "w") as f:
            f.write("{ not json")
        v = vna.presets_view()
        self.assertIn("does not read", v["warning"])
        fake = FakeNano()
        calibrate_band(fake, "fm")
        with open(vna.PRESETS) as f:
            self.assertEqual(f.read(), "{ not json")

    def test_two_bands_sharing_a_slot_replace_each_other(self):
        write_presets({"slots": {"2m": 1, "fm": 1}})
        fake = FakeNano()
        calibrate_band(fake, "2m")
        calibrate_band(fake, "fm")
        by = {b["id"]: b for b in vna.presets_view()["bands"]}
        self.assertTrue(by["fm"]["calOk"])
        self.assertFalse(by["2m"]["calOk"])
        self.assertEqual(by["2m"]["calOther"], "fm")
        self.assertEqual(by["2m"]["shares"], ["fm"])


class BandSwitch(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_switch_to_a_band_and_back_restores_the_power_on_state_exactly(self):
        fake = FakeNano()
        power_on = copy.deepcopy(fake.slots[0])
        calibrate_band(fake, "2m")
        fake.sent.clear()
        b, _, _ = vna.find_band("2m", 7)
        r = vna.band_switch(fake, vna.info(fake, "fake"), b)
        self.assertTrue(r["ok"], r)
        self.assertIn("recall 1", fake.sent)
        self.assertEqual(fake.state["sweep"], [130000000, 165000000, 201])
        self.assertEqual(vna.current_slot(vna.read_sweep(fake)), 1)
        # Seth plays with the screen on 2 m: X on, a marker moved. Back to Meshtastic undoes all of it.
        vna.x_trace(fake, True)
        fake.cmd("marker 1 12")
        mesh, _, _ = vna.find_band("mesh", 7)
        r = vna.band_switch(fake, vna.info(fake, "fake"), mesh)
        self.assertTrue(r["ok"], r)
        self.assertIn("recall 0", fake.sent)
        self.assertEqual(fake.state, power_on)
        self.assertEqual(fake.slots[0], power_on)
        self.assertEqual(vna.info(fake, "fake")["slot"], 0)
        self.assertEqual(fake.writes(), [])

    def test_a_band_without_a_calibration_is_swept_uncalibrated_and_nothing_is_saved(self):
        fake = FakeNano()
        b, _, _ = vna.find_band("70cm", 7)
        r = vna.band_switch(fake, vna.info(fake, "fake"), b)
        self.assertTrue(r["uncal"])
        self.assertIn("sweep 400000000 470000000 201", fake.sent)
        self.assertFalse(any(l.startswith(("recall", "save")) for l in fake.sent))
        self.assertIsNone(vna.info(fake, "fake")["slot"])
        self.assertIn("UNCALIBRATED", r["say"])

    def test_a_recorded_slot_the_nanovna_has_lost_is_reported(self):
        write_presets({"cal": {"3": {"band": "adsb", "slot": 3, "start": 1000e6, "stop": 1180e6, "points": 201, "at": "2026-10-06T20:00:00"}}})
        fake = FakeNano()
        b, _, _ = vna.find_band("adsb", 7)
        self.assertTrue(b["calOk"])
        r = vna.band_switch(fake, vna.info(fake, "fake"), b)
        self.assertFalse(r["ok"])
        self.assertIn("no valid calibration", r["say"])
        self.assertIsNone(vna.current_slot(vna.read_sweep(fake)))

    def test_cancelling_a_band_calibration_goes_back_to_the_slot_in_use(self):
        fake = FakeNano()
        vna.band_switch(fake, vna.info(fake, "fake"), vna.find_band("mesh", 7)[0])
        b, _, _ = vna.find_band("fm", 7)
        fake.plug = "open"
        vna.calibrate(fake, "begin", b, 7)
        vna.calibrate(fake, "open", b, 7)
        r = vna.calibrate(fake, "cancel", b, 7)
        self.assertTrue(r["ok"])
        self.assertIn("recall 0", fake.sent)
        self.assertEqual(fake.state, fake.slots[0])
        self.assertEqual(fake.writes(), [])


class MeshCalibration(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_refused_unless_the_sweep_is_the_mesh_band(self):
        fake = FakeNano()
        fake.cmd("sweep 130000000 165000000 201")
        r = vna.calibrate(fake, "begin", None, 7)
        self.assertFalse(r["ok"])
        self.assertEqual(r["refused"], "sweep")
        self.assertEqual(fake.writes(), [])

    def test_the_mesh_recalibration_saves_slot_0(self):
        fake = FakeNano()
        for step, plug in (("begin", "antenna"), ("open", "open"), ("short", "short"), ("load", "load")):
            fake.plug = plug
            r = vna.calibrate(fake, step, None, 7)
            self.assertTrue(r["ok"], r)
        self.assertEqual(fake.writes(), ["save 0"])
        self.assertEqual(vna.slot_state()["slot"], 0)

    def test_a_mesh_step_does_not_finish_a_band_calibration(self):
        fake = FakeNano()
        b, _, _ = vna.find_band("2m", 7)
        vna.calibrate(fake, "begin", b, 7)
        r = vna.calibrate(fake, "open", None, 7)
        self.assertFalse(r["ok"])
        self.assertIn("under way", r["say"])


class PowerOn(unittest.TestCase):
    def setUp(self):
        reset_state()

    def base(self, fake):
        return vna.info(fake, "fake")

    def test_refusals(self):
        fake = FakeNano()
        # Slot unknown (nothing recorded yet): refused even on the mesh sweep.
        r = vna.poweron_save(fake, self.base(fake), True)
        self.assertEqual(r["refused"], "slot")
        # No confirmation step.
        vna.band_switch(fake, self.base(fake), vna.find_band("mesh", 7)[0])
        self.assertEqual(vna.poweron_save(fake, self.base(fake), False)["refused"], "confirm")
        # Another band's sweep.
        calibrate_band(fake, "2m")
        vna.band_switch(fake, self.base(fake), vna.find_band("2m", 7)[0])
        self.assertEqual(vna.poweron_save(fake, self.base(fake), True)["refused"], "sweep")
        # The mesh sweep, but with 2 m's calibration (Mesh layout pressed on 2 m): not slot 0's.
        vna.preset(fake)
        self.assertEqual(vna.poweron_save(fake, self.base(fake), True)["refused"], "slot")
        # A calibration under way.
        vna.band_switch(fake, self.base(fake), vna.find_band("mesh", 7)[0])
        vna.set_cal_state({"step": "short", "band": "mesh", "slot": 0})
        self.assertEqual(vna.poweron_save(fake, self.base(fake), True)["refused"], "cal")
        vna.set_cal_state({})
        # Not calibrated.
        fake.state["cal"] = ""
        self.assertEqual(vna.poweron_save(fake, self.base(fake), True)["refused"], "uncal")
        self.assertNotIn("save 0", fake.sent)

    def test_saves_slot_0_with_the_mesh_layout_and_x(self):
        fake = FakeNano()
        vna.band_switch(fake, self.base(fake), vna.find_band("mesh", 7)[0])
        vna.x_trace(fake, True)
        fake.cmd("marker 1 140")  # moved by "Markers to best": put back before the save
        fake.sent.clear()
        r = vna.poweron_save(fake, self.base(fake), True)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["trace3"], "x")
        self.assertEqual(fake.writes(), ["save 0"])
        cmds = [l for l in fake.sent if not l.startswith("msg")]
        self.assertLess(cmds.index("trace 3 x 0"), cmds.index("save 0"))
        self.assertLess(cmds.index("marker 1 88"), cmds.index("save 0"))
        saved = fake.slots[0]
        self.assertEqual(saved["sweep"], [850000000, 980000000, 201])
        self.assertEqual(saved["traces"][3][:2], ["X", "S11"])
        self.assertTrue(saved["traces"][3][4])
        self.assertEqual(saved["traces"][0][:4], ["SWR", "S11", 0.5, 0.0])
        self.assertEqual(saved["traces"][2][:4], ["LOGMAG", "S11", 5.0, 8.0])
        self.assertEqual(saved["markers"], {1: 88, 2: 93, 3: 100})
        self.assertEqual(saved["cal"], "load Es Er cal'ed")
        with open(vna.PRESETS) as f:
            self.assertEqual(json.load(f)["powerOn"]["trace3"], "x")

    def test_x_trace_is_reactance_of_s11_and_is_not_saved(self):
        fake = FakeNano()
        r = vna.x_trace(fake, True)
        self.assertTrue(r["ok"])
        self.assertEqual(fake.sent[:3], ["trace 3 x 0", "trace 3 scale 25", "trace 3 refpos 4"])
        self.assertEqual(fake.state["traces"][3][:4], ["X", "S11", 25.0, 4.0])
        self.assertTrue(vna.x_trace(fake, False)["ok"])
        self.assertEqual(fake.writes(), [])


class OneOwner(unittest.TestCase):
    """One session polls the NanoVNA for all of them (the lease); the rest read live.json."""

    def setUp(self):
        reset_state()

    def test_the_lease_is_one_sessions_until_it_runs_out_or_its_claude_dies(self):
        held, a = vna.lease_take("sA", now=1000.0)
        self.assertTrue(held)
        held, cur = vna.lease_take("sB", now=1003.0)
        self.assertFalse(held)
        self.assertEqual(cur["session"], "sA")
        self.assertTrue(vna.lease_take("sA", now=1005.0)[0])  # renewed
        self.assertFalse(vna.lease_take("sB", now=1005.0 + vna.LEASE_S - 1)[0])
        self.assertTrue(vna.lease_take("sB", now=1005.0 + vna.LEASE_S + 0.1)[0])  # ran out: B takes over
        # A holder whose Claude process has gone is free at once.
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        vna.write_json(vna.LEASE, {"session": "sC", "ppid": dead.pid, "until": time.time() + 60})
        self.assertTrue(vna.lease_take("sB")[0])

    def test_nobody_watching_means_no_device_traffic(self):
        vna.write_json(vna.LIVE_JSON, LIVE_SAMPLE)
        r, took = run("poll", "--session", "sA")
        self.assertTrue(r["idle"])
        self.assertEqual(r["by"], "sA")
        self.assertFalse(os.path.exists(os.path.join(LOCKS, "nanovna.lock")))
        self.assertLess(took, 5)

    def test_a_session_without_the_lease_reads_the_shared_reading(self):
        vna.write_json(vna.LIVE_JSON, LIVE_SAMPLE)
        vna.write_json(vna.LEASE, {"session": "sA", "ppid": os.getpid(), "until": time.time() + 60})
        open(os.path.join(LOCKS, "watch-sB"), "w").close()
        r, _ = run("poll", "--session", "sB")
        self.assertTrue(r["shared"])
        self.assertEqual(r["holder"]["session"], "sA")
        self.assertEqual(r["metrics"]["meshtastic"]["swr"], 1.23)
        self.assertFalse(os.path.exists(os.path.join(LOCKS, "nanovna.lock")))

    def test_the_holder_with_a_watcher_polls_and_shares_what_it_found(self):
        open(os.path.join(LOCKS, "watch-sB"), "w").close()
        r, _ = run("poll", "--session", "sA")
        self.assertFalse(r["connected"])  # no device in the tests: that is shared too
        shared = vna.shared_live()
        self.assertFalse(shared["connected"])
        self.assertEqual(shared["by"], "sA")

    def test_a_busy_lock_still_produces_a_reply_at_once(self):
        vna.write_json(vna.LIVE_JSON, LIVE_SAMPLE)
        with open(os.path.join(LOCKS, "nanovna.lock"), "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)  # another session is mid-sweep, for as long as it likes
            for verb in (["live", "--wait", "0.5"], ["save", "Nag whip", "--wait", "0.5"], ["band", "2m", "--wait", "0.5"]):
                r, took = run(*verb, "--session", "sA")
                self.assertTrue(r["busy"], verb)
                self.assertIn("busy", r["say"])
                self.assertEqual(r["lastAt"], 1)
                self.assertEqual(r["metrics"]["meshtastic"]["swr"], 1.23)
                self.assertLess(took, 4, verb)


class Watchdog(unittest.TestCase):
    def setUp(self):
        reset_state()

    def test_a_long_wait_for_the_lock_still_ends_in_one_json_answer(self):
        """A lock wait longer than the verb's own time limit: the watchdog waits it out and answers busy
        (0.5.0 before this fix printed nothing at all)."""
        vna.write_json(vna.LIVE_JSON, LIVE_SAMPLE)
        with open(os.path.join(LOCKS, "nanovna.lock"), "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            r, took = run("live", "--wait", "11", "--session", "sA", timeout=40)
        self.assertTrue(r["busy"])
        self.assertEqual(r["lastAt"], 1)
        self.assertLess(took, 20)


class Export(unittest.TestCase):
    """The report card: the tab's SVG moved into exports/ with its date and time, and a PNG beside it."""

    CARD = '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="900" viewBox="0 0 540 900"><rect width="540" height="900" fill="#0b1012"/></svg>'

    def setUp(self):
        reset_state()
        self.tmp = os.path.join(STATE, "export-sA.svg")
        with open(self.tmp, "w") as f:
            f.write(self.CARD)
        self.bin = tempfile.mkdtemp(prefix="vna-test-bin-")

    def tearDown(self):
        os.environ.pop("VNA_SVG_CONVERTER", None)

    def converter(self, body):
        path = os.path.join(self.bin, "convert")
        with open(path, "w") as f:
            f.write("#!/bin/sh\n" + body + "\n")
        os.chmod(path, 0o755)
        os.environ["VNA_SVG_CONVERTER"] = path

    def test_the_card_and_its_png_are_named_and_placed(self):
        self.converter('printf "\\211PNG fake" > "$2"')
        when = vna.datetime.datetime(2026, 10, 6, 21, 5)
        r = vna.export_card(self.tmp, "Nag stock whip #2", when)
        self.assertTrue(r["ok"])
        self.assertEqual(r["converter"], "converter")
        self.assertEqual(r["svg"], os.path.join(vna.EXPORTS, "Nag-stock-whip-2-20261006-2105.svg"))
        self.assertEqual(r["png"], os.path.join(vna.EXPORTS, "Nag-stock-whip-2-20261006-2105.png"))
        self.assertTrue(os.path.getsize(r["png"]) > 0)
        with open(r["svg"]) as f:
            self.assertEqual(f.read(), self.CARD)
        self.assertFalse(os.path.exists(self.tmp))
        self.assertIn(r["png"], r["say"])
        # The same minute again gets its own name, never overwriting the first.
        with open(self.tmp, "w") as f:
            f.write(self.CARD)
        r2 = vna.export_card(self.tmp, "Nag stock whip #2", when)
        self.assertTrue(r2["svg"].endswith("Nag-stock-whip-2-20261006-2105-2.svg"))

    def test_a_failed_converter_keeps_the_svg_and_says_so(self):
        self.converter('echo broken >&2; exit 1')
        r = vna.export_card(self.tmp, "", vna.datetime.datetime(2026, 10, 6, 21, 5))
        self.assertTrue(r["ok"])
        self.assertIsNone(r["png"])
        self.assertTrue(os.path.exists(r["svg"]))
        self.assertTrue(r["svg"].endswith("Live-20261006-2105.svg"))
        self.assertFalse(os.path.exists(r["svg"][:-4] + ".png"))
        self.assertIn("no PNG", r["say"])

    def test_export_runs_without_the_device_lock(self):
        self.converter('printf x > "$2"')
        with open(os.path.join(LOCKS, "nanovna.lock"), "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)
            r, took = run("export", "--svg", self.tmp, "--name", "Kit duck")
        self.assertTrue(r["png"].endswith(".png"))
        self.assertLess(took, 10)


if __name__ == "__main__":
    unittest.main()
