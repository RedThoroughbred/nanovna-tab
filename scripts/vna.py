#!/usr/bin/env python3
"""NanoVNA bridge for the VNA tab. Standard library only.

Talks to a NanoVNA (DiSlord firmware, e.g. NanoVNA-H4 1.2.x) over its USB
serial shell and prints one JSON object per call.

  vna.py status              connected?, firmware, battery, calibration, sweep
  vna.py poll --session <id> the tab's 3-second poll: sweeps only for the session holding the lease
                             and only while some session's VNA tab is on screen; else answers
                             with the last shared reading (live.json); see "one owner" below
  vna.py shared              the last shared reading, no device
  Every device verb takes --wait <s> (how long to wait for the device lock; past it the answer
  is the last shared reading with "busy": true) and --session <id> (who took the reading).
  vna.py live [--qc JSON]    status + the current S11 sweep: SWR curve, raw S11
                             points, mesh metrics, resonance, and (with --qc)
                             the QC verdict under those rules
  vna.py save <label>        live + writes a Touchstone .s1p into the library
                             (the same label again keeps every sweep: history)
  vna.py library             every saved sweep with its metrics, SWR curve and S11
  vna.py delete <file>       removes one saved sweep
  vna.py markers mesh|best   M1/M2/M3 on 906.875/910.525/915 MHz, or M1 on the
                             lowest SWR
  vna.py qc [--rules JSON]   the QC verdict for the antenna on PORT 1
  vna.py qc save <unit id> [--rules JSON]
                             records a QC test: a row in qc-log.csv, the sweep as
                             qc/<unit>-<time>.s1p and a one-page certificate
                             qc/<unit>-<time>-certificate.svg; refused when the
                             NanoVNA is not calibrated
  vna.py qc log              the QC records, newest first, and the next unit number
  vna.py cal begin|open|short|load|cancel
                             guided OPEN/SHORT/LOAD calibration with checks,
                             saved to slot 0 when LOAD is captured
  vna.py preset              mesh antenna layout: 850-980 MHz, SWR/Smith/dB, markers
  vna.py msg <text> [title]  pops a message on the NanoVNA's screen
  vna.py shot                screenshot of the NanoVNA's screen as a PNG
  vna.py presets             the band presets (built in + presets.json), each band's
                             save slot and whether it has a calibration; no device
  vna.py band <id>           switch band: `recall N` for a calibrated band, `recall 0`
                             for mesh (the power-on state, exactly as saved), or an
                             uncalibrated sweep of the band's range (nothing saved)
  vna.py band cal <id> begin|open|short|load|cancel
                             guided OPEN/SHORT/LOAD for a band, saved to that band's
                             spare slot (1..N-1); slot 0 is refused
  vna.py xtrace on|off       trace 3 = reactance X of S11 (or off), live, not saved
  vna.py export --svg <file> --name <name>
                             the tab's report card: moved to exports/<name>-<yyyymmdd-hhmm>.svg
                             and made into a 2x PNG beside it (headless Chrome, else rsvg-convert),
                             then shown in Finder; no device
  vna.py poweron save --confirm
                             saves slot 0 = the slot-0 mesh calibration in use now plus
                             the mesh layout with trace 3 as it is; refused unless the
                             sweep is 850-980 MHz / 201 and the calibration in use is
                             slot 0's

Save slots (DiSlord firmware, hardware.h SAVEAREA_MAX, 1.2.40 to 1.2.46): 7 on the
NanoVNA-H4 (STM32F303: slots 0-6), 5 on the NanoVNA-H (F072: 0-4). Slot 0 is what
the NanoVNA loads at power-on (with its Backup setting off, the default) and holds
the Meshtastic calibration and layout: only `cal` (the mesh recalibration) and
`poweron save` ever write it, and both refuse unless the sweep is the mesh band.

The port is found from the USB device tree (product name NanoVNA), so the
script never opens another serial device: opening a Meshtastic node's port
switches its Bluetooth off.

The library (sweeps, QC log, certificates, screenshots) is ~/NanoVNA; NANOVNA_DIR moves it for
testing. The lock that keeps callers from talking over each other is ~/Library/Caches/vna/nanovna.lock
whatever NANOVNA_DIR says.
"""
import csv
import datetime
import fcntl
import json
import math
import os
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import termios
import time
import zlib

HOME = os.path.expanduser("~")
# Everything stays on local disk. On this Mac ~/Documents syncs to iCloud, and opening or reading a
# file there has stalled for minutes (iCloud "unclean items" under Documents/NanoVNA), which froze the
# tab's one-at-a-time queue. The library is ~/NanoVNA (visible in Finder, not synced); the lock and
# small state files are in ~/Library.
DOCS_DIR = os.path.join(HOME, "NanoVNA")
LOCK_DIR = os.environ.get("VNA_LOCK_DIR") or os.path.join(HOME, "Library", "Caches", "vna")
STATE_DIR = os.environ.get("VNA_STATE_DIR") or os.path.join(HOME, "Library", "Application Support", "vna")
LIB = os.environ.get("NANOVNA_DIR") or DOCS_DIR
SWEEPS = os.path.join(LIB, "sweeps")
SHOTS = os.path.join(LIB, "screenshots")
EXPORTS = os.path.join(LIB, "exports")
QC_DIR = os.path.join(LIB, "qc")
QC_LOG = os.path.join(LIB, "qc-log.csv")
CAL_STATE = os.path.join(STATE_DIR, "cal-state.json")
BRIDGE = os.path.join(STATE_DIR, "bridge.json")  # {"host": "vna-bridge.local", "ip": "...", "port": 23}
PRESETS = os.path.join(STATE_DIR, "presets.json")  # Seth's bands, the band -> slot map, calibration records
SLOT_STATE = os.path.join(STATE_DIR, "slot-state.json")  # which save slot's calibration is in use, as far as we know
# One owner of the NanoVNA across every Claude session (0.5.0). Each session's tab used to sweep on
# its own every 3 s; four sessions queued on the lock and /vna timed out. Now one session holds a
# lease (lease.json: its id, the Claude process that runs it, until when) and is the only one that
# polls; it writes each reading to live.json, which the other sessions read. A session marks that
# someone is looking at its VNA tab by touching watch-<session> (LOCK_DIR); with no mark newer than
# WATCH_S the lease holder does not touch the device at all. A holder that dies lets its lease run
# out (LEASE_S) and the next session to poll takes over. Presses from any session still go straight
# to the device, under nanovna.lock, waiting a bounded time for it.
LIVE_JSON = os.path.join(STATE_DIR, "live.json")
LEASE = os.path.join(LOCK_DIR, "lease.json")
LEASE_LOCK = os.path.join(LOCK_DIR, "lease.lock")
LEASE_S = 10
WATCH_S = 10

# The frequencies the tab reports, in MHz.
MARKS = [
    ("meshtastic", "Meshtastic", 906.875),  # US LongFast, frequency slot 20
    ("meshcore", "MeshCore", 910.525),      # US MeshCore preset
    ("mid", "915", 915.0),
]
TARGET_LO, TARGET_HI = 906.875, 910.525

# QC: PASS when SWR <= bandMax at every point lo..hi MHz and SWR <= spotMax at each spot.
DEFAULT_QC = {"lo": 902.0, "hi": 928.0, "bandMax": 2.0, "spots": [906.875, 910.525], "spotMax": 1.5}
QC_FIELDS = ["timestamp", "unit", "result", "swr_906_875", "swr_910_525", "worst_swr", "worst_mhz",
             "resonance_mhz", "calibrated", "cal_status", "firmware", "failed", "rule", "s1p", "certificate"]


def out(obj):
    print(json.dumps(obj, separators=(",", ":")))
    sys.exit(0)


# ---------------------------------------------------------------- port

def find_port():
    """The NanoVNA's /dev/cu.* from the USB tree, or None (always None under VNA_NO_DEVICE, for tests)."""
    if os.environ.get("VNA_NO_DEVICE"):
        return None
    try:
        text = subprocess.run(["/usr/sbin/ioreg", "-r", "-c", "IOUSBHostDevice", "-l", "-w0"],
                              capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None
    device = ""
    for line in text.splitlines():
        m = re.search(r"\+-o (.+?)@[0-9a-f]+\s+<class IOUSBHostDevice", line)
        if m:
            device = m.group(1)
            continue
        m = re.search(r'"IOCalloutDevice" = "(/dev/cu\.[^"]+)"', line)
        if m and "nanovna" in device.lower():
            return m.group(1)
    return None


class Shell:
    """The NanoVNA's text shell: a command, then its reply up to the ch> prompt."""

    def __init__(self, port):
        self.fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        a = termios.tcgetattr(self.fd)
        a[0] = 0
        a[1] = 0
        a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        a[3] = 0
        a[4] = a[5] = termios.B115200
        termios.tcsetattr(self.fd, termios.TCSANOW, a)
        # Exclusive while open: a second program opening the port now fails at once (EBUSY) instead
        # of interleaving its commands with ours and garbling both readings.
        try:
            fcntl.ioctl(self.fd, termios.TIOCEXCL)
        except (OSError, AttributeError):
            pass
        self.raw(b"", 0.3)

    def close(self):
        os.close(self.fd)

    def raw(self, data, wait=10.0, until=b"ch> ", size=None):
        if data:
            os.write(self.fd, data)
        buf = b""
        end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    buf += os.read(self.fd, 65536)
                except BlockingIOError:
                    pass
                if size is not None and len(buf) >= size:
                    break
                if size is None and buf.endswith(until):
                    break
        return buf

    def cmd(self, line, wait=10.0):
        buf = self.raw((line + "\r").encode(), wait)
        lines = buf.decode(errors="replace").replace("\r", "").split("\n")
        if lines and lines[0].strip() == line.strip():
            lines = lines[1:]
        return [l for l in lines if l and not l.startswith("ch>")]


class TcpShell(Shell):
    """The same console through the Wi-Fi bridge (Heltec V4 running vna-bridge)."""

    def __init__(self, sock):
        self.sock = sock
        self.sock.setblocking(False)
        self.fd = sock.fileno()

    def close(self):
        self.sock.close()

    def raw(self, data, wait=10.0, until=b"ch> ", size=None):
        if data:
            self.sock.sendall(data)
        buf = b""
        end = time.time() + wait
        while time.time() < end:
            r, _, _ = select.select([self.sock], [], [], 0.1)
            if r:
                try:
                    chunk = self.sock.recv(65536)
                except BlockingIOError:
                    chunk = b""
                if not chunk and r:
                    break
                buf += chunk
                if size is not None and len(buf) >= size:
                    break
                if size is None and buf.endswith(until):
                    break
        return buf


def bridge_config():
    try:
        with open(BRIDGE) as f:
            return json.load(f)
    except Exception:
        return None


def open_bridge(b):
    """Connects to the bridge, trying the last known address first. Returns (shell, label) or (None, state)."""
    sock = None
    for host, t in ((b.get("ip"), 0.8), (b.get("host"), 2.5)):
        if not host:
            continue
        try:
            sock = socket.create_connection((host, int(b.get("port", 23))), timeout=t)
            ip = sock.getpeername()[0]
            if ip != b.get("ip"):
                b["ip"] = ip
                with open(BRIDGE, "w") as f:
                    json.dump(b, f)
            break
        except OSError:
            sock = None
    if not sock:
        return None, {"host": b.get("host"), "state": "offline"}
    sh = TcpShell(sock)
    reply = sh.raw(b"\r", wait=2.0)
    if not reply.endswith(b"ch> "):
        sh.close()
        return None, {"host": b.get("host"), "ip": b.get("ip"), "state": "online, NanoVNA not answering on the wires"}
    return sh, f"wifi:{b.get('host')}"


def open_shell():
    port = find_port()
    if port:
        try:
            return Shell(port), port
        except OSError as e:
            if e.errno == 16:  # EBUSY: another program holds the port exclusively
                out({**(shared_live() or {}), "busy": True, "error": f"Another program has the NanoVNA's port open ({port})."})
            out({"connected": False, "port": port, "error": f"Could not open {port}: {e.strerror}"})
    b = bridge_config()
    if b:
        sh, label = open_bridge(b)
        if sh:
            return sh, label
        out({"connected": False, "bridge": label})
    return None, None


# ---------------------------------------------------------------- reading

def read_sweep(sh):
    """The sweep as {start, stop, points} (Hz), from `sweep` ("850000000 980000000 201"), or None."""
    sw = (sh.cmd("sweep") or ["0 0 0"])[0].split()
    try:
        return {"start": float(sw[0]), "stop": float(sw[1]), "points": int(sw[2])} if len(sw) == 3 else None
    except ValueError:
        return None


def read_traces(sh):
    """The traces on the NanoVNA's screen, from `trace` ("0 SWR S11 0.500000 0.000000" per enabled
    trace): [{n, type, ch, scale, refpos}], type in lower case (swr, smith, logmag, x...)."""
    out = []
    for l in sh.cmd("trace"):
        p = l.split()
        if len(p) >= 3 and p[0].isdigit():
            t = {"n": int(p[0]), "type": p[1].lower(), "ch": p[2]}
            if len(p) >= 5:
                try:
                    t["scale"], t["refpos"] = float(p[3]), float(p[4])
                except ValueError:
                    pass
            out.append(t)
    return out


class NotAnswering(Exception):
    pass


def info(sh, port):
    # A NanoVNA that does not answer `version` within 3 s is not going to answer the rest:
    # say so at once rather than waiting out every command (0.4.0 once took 51 s here).
    v = sh.cmd("version", wait=3)
    if not v:
        raise NotAnswering()
    ver = v[0].strip()
    board = ""
    for l in sh.cmd("info"):
        if l.startswith("Board:"):
            board = l.split(":", 1)[1].strip()
    vbat = None
    for l in sh.cmd("vbat"):
        m = re.match(r"(\d+)\s*mV", l.strip())
        if m:
            vbat = int(m.group(1))
    cal = " ".join(sh.cmd("cal")).strip()
    sweep = read_sweep(sh)
    st = cal_state()
    remember_board(board)
    return {
        "connected": True, "port": port, "via": "wifi" if str(port).startswith("wifi:") else "usb", "version": ver, "board": board or "NanoVNA",
        "vbatMv": vbat, "cal": cal, "calibrated": "cal'ed" in cal, "sweep": sweep,
        # Which save slot's calibration is in use (as far as this script has seen: None when unknown),
        # how many slots the NanoVNA has, its traces, and a calibration under way.
        "slot": current_slot(sweep), "slots": slot_count(board), "traces": read_traces(sh),
        "calStep": st.get("step"), "calBand": st.get("band") if st.get("step") else None,
    }


def read_s11(sh):
    freqs = [float(x) for x in sh.cmd("frequencies") if re.match(r"^\d", x)]
    pts = []
    for l in sh.cmd("data 0"):
        p = l.split()
        if len(p) == 2:
            pts.append((float(p[0]), float(p[1])))
    n = min(len(freqs), len(pts))
    return freqs[:n], pts[:n]


# ---------------------------------------------------------------- RF math
#
# S11 is the reflection coefficient gamma, a complex number: how much of the
# wave comes back, and with what phase. Everything the tab shows comes from it:
#   |gamma|            0 = all power taken, 1 = all reflected
#   SWR                (1 + |gamma|) / (1 - |gamma|)
#   return loss (dB)   -20 log10 |gamma|   (bigger is better)
#   reflected power    |gamma|^2
#   mismatch loss (dB) -10 log10 (1 - |gamma|^2)
#   impedance Z        50 (1 + gamma) / (1 - gamma) = R + jX ohms

def gamma(p):
    return math.hypot(p[0], p[1])


def swr_of(p):
    g = gamma(p)
    return (1 + g) / (1 - g) if g < 0.999 else 99.0


def z_complex(p):
    g = complex(p[0], p[1])
    if abs(1 - g) < 1e-9:
        return complex(1e6, 0)
    return 50 * (1 + g) / (1 - g)


def z_of(p):
    c = z_complex(p)
    return round(c.real, 1), round(c.imag, 1)


def rl_of(p):
    return -20 * math.log10(max(gamma(p), 1e-9))


def verdict(swr):
    if swr is None:
        return ""
    return "excellent" if swr < 1.5 else "good" if swr < 2 else "so-so" if swr < 3 else "poor"


def meaning(swr):
    """'about 3% of the power bounces back' for a plain reading of an SWR."""
    g = (swr - 1) / (swr + 1)
    pct = 100 * g * g
    share = "under 1%" if pct < 1 else f"about {pct:.0f}%"
    return f"{share} of the power bounces back"


def nearest(freqs, f):
    """The index of the sweep point nearest f (Hz); a tie goes to the higher one,
    as the Mesh layout's markers do (906.875 between 906.55 and 907.2 -> 907.2)."""
    return min(range(len(freqs)), key=lambda k: (round(abs(freqs[k] - f), 3), -k))


def gamma_at(freqs, pts, mhz):
    """S11 at mhz, interpolated between the two sweep points around it; None off the sweep."""
    f = mhz * 1e6
    if not freqs or f < freqs[0] or f > freqs[-1]:
        return None
    for i in range(1, len(freqs)):
        if freqs[i] >= f:
            a, b = freqs[i - 1], freqs[i]
            t = 0 if b == a else (f - a) / (b - a)
            p, q = pts[i - 1], pts[i]
            return (p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]))
    return pts[-1]


def reading(p, mhz, name=None, index=None):
    swr = min(swr_of(p), 99.0)
    g = gamma(p)
    d = {"mhz": round(mhz, 3), "swr": round(swr, 3), "rl": round(rl_of(p), 1), "z": z_of(p),
         "reflectedPct": round(100 * g * g, 2), "mismatchDb": round(max(0.0, -10 * math.log10(max(1 - g * g, 1e-9))), 3),
         "verdict": verdict(swr)}
    if name:
        d["name"] = name
    if index is not None:
        d["index"] = index
    return d


def resonance(freqs, pts):
    """Where the reactance X crosses zero, the one nearest the mesh frequencies,
    with a cautious trimming hint for a simple whip."""
    if len(freqs) < 2:
        return None
    zs = [z_complex(p) for p in pts]
    cross = []
    for i in range(1, len(zs)):
        x0, x1 = zs[i - 1].imag, zs[i].imag
        # A sign flip through a huge |X| is the trace passing the open end of
        # the chart, not a zero crossing.
        if (x0 < 0) == (x1 < 0) or max(abs(x0), abs(x1)) > 2000:
            continue
        t = x0 / (x0 - x1)
        f = freqs[i - 1] + t * (freqs[i] - freqs[i - 1])
        r = zs[i - 1].real + t * (zs[i].real - zs[i - 1].real)
        g = gamma_at(freqs, pts, f / 1e6)
        cross.append({"mhz": round(f / 1e6, 2), "r": round(r, 1), "swr": round(min(swr_of(g), 99.0), 3),
                      "kind": "series" if x1 > x0 else "parallel"})
    lo, hi = freqs[0] / 1e6, freqs[-1] / 1e6
    caveat = ("A matching network, a cable or an adapter between the antenna and PORT 1 moves where X crosses "
              "zero, and many LoRa antennas are matched rather than plain whips: trust the SWR first.")
    if not cross:
        xs = [z.imag for z in zs]
        k = min(range(len(xs)), key=lambda i: abs(xs[i]))
        neg = all(x < 0 for x in xs)
        sign = "negative" if neg else "positive"
        hint = (f"X stays {sign} ({'capacitive' if neg else 'inductive'}) from {lo:g} to {hi:g} MHz: no resonance in this sweep. "
                f"For a simple whip that points to {'short (resonance above' if neg else 'long (resonance below'} the sweep); "
                f"X comes closest to 0 at {freqs[k] / 1e6:.1f} MHz ({xs[k]:+.1f} Ω).".replace("(-", "(−"))
        return {"mhz": None, "xSign": sign, "closest": {"mhz": round(freqs[k] / 1e6, 2), "x": round(xs[k], 1)},
                "crossings": [], "trim": None, "hint": hint, "caveat": caveat}

    def dist(c):
        d = 0 if 902 <= c["mhz"] <= 928 else min(abs(c["mhz"] - 902), abs(c["mhz"] - 928))
        return (c["kind"] != "series", d, abs(c["mhz"] - (TARGET_LO + TARGET_HI) / 2))

    best = min(cross, key=dist)
    f = best["mhz"]
    res = {**best, "crossings": cross, "caveat": caveat}
    if best["kind"] != "series":
        res.update(trim=None, hint=f"X crosses zero at {f:.1f} MHz going down: that is an anti-resonance (R peaks near "
                                   f"{best['r']:.0f} Ω), not the series resonance a whip has. No trimming hint.")
        return res
    if TARGET_LO - 1 <= f <= TARGET_HI + 1:
        res.update(trim="on", offsetMhz=0.0, pct=0.0,
                   hint=f"Resonant at {f:.1f} MHz, right on the mesh frequencies (906.875 and 910.525).")
        return res
    below = f < TARGET_LO
    target = TARGET_LO if below else TARGET_HI
    pct = abs(1 - f / target) * 100
    qw = 0.95 * 299792.458 / (4 * target)  # mm, a quarter-wave whip with the usual end effect
    size = "slightly" if pct < 3 else "noticeably"
    word = "long" if below else "short"
    change = "shorter" if below else "longer"
    res.update(trim=word, offsetMhz=round(f - target, 2), pct=round(pct, 2),
               hint=(f"Resonant at {f:.1f} MHz, {abs(f - target):.1f} MHz {'below' if below else 'above'} {target:g}: "
                     f"for a simple whip that usually means {size} {word}. About {pct:.1f}% {change} "
                     f"(≈{pct / 100 * qw:.1f} mm on a {qw:.0f} mm quarter-wave whip) would move it to {target:g}."))
    return res


def metrics(freqs, pts):
    if not freqs:
        return None
    swr = [swr_of(p) for p in pts]
    m = {}
    for key, name, mhz in MARKS:
        g = gamma_at(freqs, pts, mhz)
        if g is not None:
            m[key] = reading(g, mhz, name, nearest(freqs, mhz * 1e6))
    b = min(range(len(swr)), key=lambda k: swr[k])
    m["best"] = reading(pts[b], freqs[b] / 1e6, None, b)
    # The stretch under SWR 2 around the best point.
    lo = hi = b
    if swr[b] < 2:
        while lo > 0 and swr[lo - 1] < 2:
            lo -= 1
        while hi < len(swr) - 1 and swr[hi + 1] < 2:
            hi += 1
        m["under2"] = [round(freqs[lo] / 1e6, 1), round(freqs[hi] / 1e6, 1)]
    else:
        m["under2"] = None
    m["resonance"] = resonance(freqs, pts)
    return m


def device_markers(sh, freqs, pts):
    """The NanoVNA's own markers (M1..M8 as set on its screen) with their readings."""
    found = []
    for l in sh.cmd("marker"):
        p = l.split()
        if len(p) == 3 and p[0].isdigit() and p[1].isdigit():
            n, i, f = int(p[0]), int(p[1]), float(p[2])
            if 0 <= i < len(pts):
                found.append({"id": n, **reading(pts[i], f / 1e6, None, i)})
    return found


def step_for(n, cap):
    return max(1, math.ceil(n / cap))


def curve(freqs, pts, step=1):
    return [[round(freqs[i] / 1e6, 3), round(min(swr_of(pts[i]), 99.0), 3)] for i in range(0, len(freqs), step)]


def s11_list(pts, step=1):
    return [[round(pts[i][0], 4), round(pts[i][1], 4)] for i in range(0, len(pts), step)]


# ---------------------------------------------------------------- QC

def qc_rules(text):
    """The rules from a JSON string, each field checked, the defaults filling gaps."""
    r = dict(DEFAULT_QC)
    try:
        given = json.loads(text) if text else {}
    except ValueError:
        given = {}
    if isinstance(given, dict):
        for k in ("lo", "hi", "bandMax", "spotMax"):
            v = given.get(k)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                r[k] = float(v)
        sp = given.get("spots")
        if isinstance(sp, list) and all(isinstance(x, (int, float)) for x in sp):
            r["spots"] = [float(x) for x in sp][:6]
    if r["hi"] <= r["lo"]:
        r["lo"], r["hi"] = DEFAULT_QC["lo"], DEFAULT_QC["hi"]
    return r


def lim(v):
    """A limit as written: 2.0, 1.5, 1.75."""
    return f"{v:.1f}" if round(v, 1) == v else f"{v:g}"


def rule_text(r):
    spots = " and ".join(f"{s:g}" for s in r["spots"])
    text = f"PASS when SWR ≤ {lim(r['bandMax'])} at every point {r['lo']:g}–{r['hi']:g} MHz"
    return text + (f" and SWR ≤ {lim(r['spotMax'])} at {spots} MHz" if r["spots"] else "")


def qc_eval(freqs, pts, r):
    lo, hi = r["lo"] * 1e6, r["hi"] * 1e6
    covered = bool(freqs) and freqs[0] <= lo and freqs[-1] >= hi
    checks = []
    worst = None
    if covered:
        band = [(freqs[i] / 1e6, swr_of(pts[i])) for i in range(len(freqs)) if lo <= freqs[i] <= hi]
        for edge in (r["lo"], r["hi"]):
            band.append((edge, swr_of(gamma_at(freqs, pts, edge))))
        wf, ws = max(band, key=lambda x: x[1])
        worst = {"mhz": round(wf, 2), "swr": round(min(ws, 99.0), 3)}
        ok = ws <= r["bandMax"]
        checks.append({"id": "band", "label": f"SWR ≤ {lim(r['bandMax'])} across {r['lo']:g}–{r['hi']:g} MHz", "pass": ok,
                       "value": worst["swr"], "mhz": worst["mhz"],
                       "detail": f"worst {worst['swr']:.2f} at {worst['mhz']:.1f} MHz" + ("" if ok else f", over {lim(r['bandMax'])}")})
    else:
        checks.append({"id": "band", "label": f"SWR ≤ {lim(r['bandMax'])} across {r['lo']:g}–{r['hi']:g} MHz", "pass": False,
                       "detail": f"the sweep does not cover {r['lo']:g}–{r['hi']:g} MHz"})
    for s in r["spots"]:
        g = gamma_at(freqs, pts, s)
        if g is None:
            checks.append({"id": f"spot-{s:g}", "label": f"SWR ≤ {lim(r['spotMax'])} at {s:g} MHz", "pass": False, "mhz": s,
                           "detail": "off this sweep"})
            continue
        v = round(min(swr_of(g), 99.0), 3)
        ok = v <= r["spotMax"]
        checks.append({"id": f"spot-{s:g}", "label": f"SWR ≤ {lim(r['spotMax'])} at {s:g} MHz", "pass": ok, "value": v, "mhz": s,
                       "detail": f"{v:.2f}" + ("" if ok else f", over {lim(r['spotMax'])}")})
    failed = [f"{c['label']}: {c['detail']}" for c in checks if not c["pass"]]
    return {"pass": not failed, "rule": rule_text(r), "rules": r, "checks": checks, "worst": worst,
            "covered": covered, "failed": failed}


def qc_records():
    rows = []
    try:
        with open(QC_LOG, newline="") as f:
            rows = list(csv.DictReader(f))
    except FileNotFoundError:
        pass
    return rows


def next_unit(rows):
    n = 0
    for r in rows:
        m = re.search(r"(\d+)\s*$", r.get("unit") or "")
        if m:
            n = max(n, int(m.group(1)))
    return f"Unit {n + 1}"


def qc_log():
    rows = qc_records()
    passed = sum(1 for r in rows if r.get("result") == "PASS")
    return {"log": QC_LOG, "dir": QC_DIR, "total": len(rows), "passed": passed, "failed": len(rows) - passed,
            "next": next_unit(rows), "records": list(reversed(rows))[:50]}


def svg_esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def certificate_svg(unit, when, base, freqs, pts, m, q):
    """A one-page (US Letter at 96 dpi) test certificate, printable from a browser: an instrument
    header, the unit and a PASS/FAIL stamp, the key readings, the checks with a meter each, the SWR
    chart in the tab's zone colours and the numbers."""
    W, H = 816, 1056
    ok = q["pass"]
    r = q["rules"]
    green, amber, red, ink, dim, line, teal = "#1f8a4c", "#c98a00", "#c8382b", "#1b2328", "#5b6870", "#d5dde2", "#0f8f80"
    col = green if ok else red
    sans, mono = "Helvetica,Arial,sans-serif", "Menlo,monospace"

    def zone(s):
        return green if s <= 1.5 else amber if s <= 2 else red

    def g(s):
        return 0.0 if s <= 1 else (s - 1) / (s + 1)

    def t(x, y, s, size=13, fill=ink, weight=None, anchor=None, font=sans, spacing=None):
        return (f'<text x="{x:.1f}" y="{y:.1f}" font-size="{size}" fill="{fill}" font-family="{font}"'
                + (f' font-weight="{weight}"' if weight else "") + (f' text-anchor="{anchor}"' if anchor else "")
                + (f' letter-spacing="{spacing}"' if spacing else "") + f">{svg_esc(s)}</text>")

    stem = f"{safe(unit)}-{when.strftime('%Y%m%d-%H%M%S')}"
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{sans}">',
         '<defs><linearGradient id="hd" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#0b1215"/>'
         '<stop offset="1" stop-color="#10262a"/></linearGradient>'
         '<linearGradient id="band" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#0f8f80" stop-opacity="0.16"/>'
         '<stop offset="1" stop-color="#0f8f80" stop-opacity="0.04"/></linearGradient></defs>',
         f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
    # Header: an instrument band with a small antenna mark.
    o.append(f'<rect x="0" y="0" width="{W}" height="128" fill="url(#hd)"/>')
    o.append(f'<rect x="0" y="128" width="{W}" height="4" fill="{col}"/>')
    o.append('<g transform="translate(66,64)" fill="none" stroke="#62f0dc" stroke-width="2.4" stroke-linecap="round">'
             '<path d="M0,26 V-18"/><circle cx="0" cy="-22" r="3.5" fill="#62f0dc" stroke="none"/>'
             '<path d="M-12,-34 A17,17 0 0 0 -12,-10 M12,-34 A17,17 0 0 1 12,-10" stroke-opacity="0.8"/>'
             '<path d="M-21,-42 A28,28 0 0 0 -21,-2 M21,-42 A28,28 0 0 1 21,-2" stroke-opacity="0.45"/>'
             '<path d="M-10,26 H10" stroke-width="3"/></g>')
    o.append(t(112, 58, "ANTENNA TEST CERTIFICATE", 25, "#e6edf0", 800, spacing=2.5))
    o.append(t(112, 84, "S11 sweep on a calibrated vector network analyzer · 50 Ω reference", 13, "#9fb3bb"))
    o.append(t(W - 48, 52, "CERTIFICATE", 10, "#62f0dc", 700, "end", mono, 2))
    o.append(t(W - 48, 72, stem, 12, "#e6edf0", 700, "end", mono))
    o.append(t(W - 48, 92, when.strftime("%B %-d, %Y · %-I:%M %p"), 12, "#9fb3bb", None, "end"))
    # Unit and stamp.
    o.append(t(48, 176, "UNIT", 11, dim, 700, spacing=2))
    o.append(t(48, 214, unit, 36, ink, 800))
    res = m.get("resonance") or {}
    grades = [k["swr"] for k in (m.get("meshtastic"), m.get("meshcore")) if k]
    worst_mesh = max(grades) if grades else m["best"]["swr"]
    grade = "A" if worst_mesh <= 1.5 else "B" if worst_mesh <= 2 else "C" if worst_mesh <= 3 else "F"
    o.append(t(48, 244, f"Grade {grade} · {'meets' if ok else 'does not meet'} the rule below", 14, dim))
    o.append(f'<g transform="translate({W - 170},200) rotate(-7)">'
             f'<rect x="-118" y="-50" width="236" height="100" rx="14" fill="{col}" fill-opacity="0.06" stroke="{col}" stroke-width="5"/>'
             f'<rect x="-108" y="-40" width="216" height="80" rx="9" fill="none" stroke="{col}" stroke-width="1.6"/>'
             + t(0, -22, "QC VERIFIED" if ok else "QC REJECTED", 10, col, 700, "middle", mono, 3)
             + t(0, 26, "PASS" if ok else "FAIL", 58, col, 900, "middle", sans, 7) + "</g>")
    # Key readings as tiles.
    tiles = []
    for key, name in (("meshtastic", "MESHTASTIC"), ("meshcore", "MESHCORE")):
        k = m.get(key)
        if k:
            tiles.append((f"{name} · {k['mhz']:g} MHz", f"{k['swr']:.2f}", zone(k["swr"]), f"return loss {k['rl']:.1f} dB · {k['reflectedPct']:.1f}% reflected"))
    if q.get("worst"):
        w = q["worst"]
        tiles.append((f"WORST {r['lo']:g}–{r['hi']:g} MHz", f"{w['swr']:.2f}", zone(w["swr"]), f"at {w['mhz']:.1f} MHz"))
    tw_ = (W - 96 - 16 * (len(tiles) - 1)) / max(1, len(tiles))
    for i, (lab, val, c, sub) in enumerate(tiles):
        x = 48 + i * (tw_ + 16)
        o.append(f'<rect x="{x:.1f}" y="272" width="{tw_:.1f}" height="92" rx="10" fill="#f6f8f9" stroke="{line}"/>')
        o.append(f'<rect x="{x:.1f}" y="284" width="4" height="68" rx="2" fill="{c}"/>')
        o.append(t(x + 18, 296, lab, 10, dim, 700, spacing=1.2, font=mono))
        o.append(t(x + 18, 336, val, 34, c, 800, font=mono))
        o.append(t(x + 18 + len(val) * 21 + 4, 336, ":1", 15, c, 700, font=mono))
        o.append(t(x + 18, 354, sub, 10.5, dim))
    # The checks, each with a meter.
    y = 404
    o.append(t(48, y, "CHECKS", 11, dim, 700, spacing=2))
    o.append(t(W - 48, y, q["rule"], 10.5, dim, None, "end"))
    y += 12
    for c in q["checks"]:
        y += 34
        cc = green if c["pass"] else red
        o.append(f'<circle cx="60" cy="{y - 5}" r="11" fill="{cc}" fill-opacity="0.1" stroke="{cc}" stroke-width="1.5"/>')
        o.append(f'<path d="M54,{y - 5} l4,4 l7,-8" fill="none" stroke="{cc}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
                 if c["pass"] else f'<path d="M55,{y - 10} l10,10 m0,-10 l-10,10" fill="none" stroke="{cc}" stroke-width="2.2" stroke-linecap="round"/>')
        o.append(t(82, y, c["label"], 14, ink, 700))
        o.append(t(82, y + 15, c["detail"], 11, dim))
        limit = r["bandMax"] if c["id"] == "band" else r["spotMax"]
        bx0, bx1 = 470, W - 130
        vmax = limit + (limit - 1) * 0.65
        bx = lambda v: bx0 + max(0.0, min(1.0, (v - 1) / (vmax - 1))) * (bx1 - bx0)
        o.append(f'<rect x="{bx0}" y="{y - 10}" width="{bx1 - bx0}" height="10" rx="5" fill="#eef2f4"/>')
        if "value" in c:
            o.append(f'<rect x="{bx0}" y="{y - 10}" width="{max(10, bx(c["value"]) - bx0):.1f}" height="10" rx="5" fill="{zone(c["value"]) if c["pass"] else red}"/>')
            o.append(t(W - 48, y, f"{c['value']:.2f}", 18, zone(c["value"]) if c["pass"] else red, 800, "end", mono))
        else:
            o.append(t(W - 48, y, "—", 18, dim, 700, "end", mono))
        o.append(f'<line x1="{bx(limit):.1f}" x2="{bx(limit):.1f}" y1="{y - 15}" y2="{y + 5}" stroke="{ink}" stroke-width="1.6"/>')
        o.append(t(bx(limit), y + 17, f"limit {lim(limit)}", 9.5, dim, None, "middle", mono))
        y += 8
    # The SWR chart, scaled in |Γ| as the tab's: green to 1.5, amber to 2, red above.
    cx, cy, cw, ch = 48, y + 30, W - 96, 262
    lo, hi = freqs[0] / 1e6, freqs[-1] / 1e6
    L, R, T, B = 46, 18, 34, 30
    top = max(swr_of(p) for p in pts)
    cap = 3.0 if top <= 2.95 else 5.0 if top <= 4.9 else 10.0
    X = lambda f: cx + L + (f - lo) / (hi - lo) * (cw - L - R)
    Y = lambda s: cy + T + (1 - min(g(s), g(cap)) / g(cap)) * (ch - T - B)
    o.append(f'<rect x="{cx}" y="{cy}" width="{cw}" height="{ch}" rx="10" fill="#fbfcfc" stroke="{line}"/>')
    o.append(t(cx + 14, cy + 22, "SWR ACROSS THE SWEEP", 11, dim, 700, spacing=1.5))
    o.append(t(cx + cw - 14, cy + 22, "1.0 is a perfect match · the scale is stretched toward 1", 10.5, dim, None, "end"))
    pl, pr, pt_, pb = cx + L, cx + cw - R, cy + T, cy + ch - B
    for a, b, c, op in ((2, cap, red, 0.07), (1.5, 2, amber, 0.09), (1, 1.5, green, 0.08)):
        o.append(f'<rect x="{pl}" y="{Y(b):.1f}" width="{pr - pl}" height="{Y(a) - Y(b):.1f}" fill="{c}" fill-opacity="{op}"/>')
    if hi > r["lo"] and lo < r["hi"]:
        a, b = X(max(r["lo"], lo)), X(min(r["hi"], hi))
        o.append(f'<rect x="{a:.1f}" y="{pt_}" width="{b - a:.1f}" height="{pb - pt_}" fill="url(#band)"/>')
        o.append(t(b - 4, pt_ + 13, f"{r['lo']:g}–{r['hi']:g} MHz", 10, teal, 700, "end"))
        o.append(f'<line x1="{a:.1f}" x2="{b:.1f}" y1="{Y(r["bandMax"]):.1f}" y2="{Y(r["bandMax"]):.1f}" stroke="{red}" stroke-width="1.6" stroke-dasharray="6 4"/>')
        o.append(t(a + 4, Y(r["bandMax"]) - 5, f"limit {lim(r['bandMax'])}", 10, red, 700))
    ticks = (1, 1.2, 1.5, 2, 2.5, 3) if cap == 3 else (1, 1.2, 1.5, 2, 3, 5) if cap == 5 else (1, 1.5, 2, 3, 5, 10)
    for s in ticks:
        o.append(f'<line x1="{pl}" x2="{pr}" y1="{Y(s):.1f}" y2="{Y(s):.1f}" stroke="#e3e9ec"/>')
        o.append(t(pl - 7, Y(s) + 4, f"{s:g}{'+' if s == cap and top > cap else ''}", 11, green if s == 1.5 else amber if s == 2 else dim, 700 if s in (1.5, 2) else None, "end", mono))
    span = hi - lo
    stp = 50 if span > 200 else 20 if span > 60 else 5 if span > 20 else 2
    f = math.ceil(lo / stp) * stp
    while f <= hi:
        o.append(t(X(f), pb + 18, f"{f:g}{' MHz' if f + stp > hi else ''}", 11, dim, None, "end" if f + stp > hi else "middle", mono))
        f += stp
    ya, yb = Y(2), Y(1.5)
    span_y = (pb - pt_) or 1
    oa, ob = (ya - pt_) / span_y, (yb - pt_) / span_y
    o.append(f'<linearGradient id="zs" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="{pt_}" y2="{pb}">'
             f'<stop offset="0" stop-color="{red}"/><stop offset="{oa:.4f}" stop-color="{red}"/><stop offset="{oa:.4f}" stop-color="{amber}"/>'
             f'<stop offset="{ob:.4f}" stop-color="{amber}"/><stop offset="{ob:.4f}" stop-color="{green}"/><stop offset="1" stop-color="{green}"/></linearGradient>')
    d = "".join(f'{"L" if i else "M"}{X(freqs[i] / 1e6):.1f},{Y(swr_of(pts[i])):.1f}' for i in range(len(freqs)))
    o.append(f'<path d="{d}L{X(hi):.1f},{pb}L{X(lo):.1f},{pb}Z" fill="url(#zs)" fill-opacity="0.12"/>')
    o.append(f'<path d="{d}" fill="none" stroke="url(#zs)" stroke-width="2.6" stroke-linejoin="round"/>')
    for c in q["checks"]:
        if c["id"].startswith("spot") and "value" in c:
            px, py = X(c["mhz"]), Y(c["value"])
            o.append(f'<line x1="{px:.1f}" x2="{px:.1f}" y1="{pt_}" y2="{pb}" stroke="{teal}" stroke-opacity="0.5" stroke-dasharray="3 3"/>')
            o.append(f'<line x1="{px - 10:.1f}" x2="{px + 10:.1f}" y1="{Y(r["spotMax"]):.1f}" y2="{Y(r["spotMax"]):.1f}" stroke="{red}" stroke-width="2"/>')
            o.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="4.5" fill="{zone(c["value"]) if c["pass"] else red}" stroke="#ffffff" stroke-width="1.5"/>')
    b_ = m["best"]
    bx_, by_ = X(b_["mhz"]), Y(b_["swr"])
    o.append(f'<circle cx="{bx_:.1f}" cy="{by_:.1f}" r="7" fill="none" stroke="{zone(b_["swr"])}" stroke-width="1.8"/>')
    o.append(t(bx_ + (10 if bx_ < pr - 150 else -10), by_ + 20, f"lowest {b_['swr']:.2f} at {b_['mhz']:.1f} MHz", 11, ink, 700, "start" if bx_ < pr - 150 else "end"))
    if q.get("worst"):
        w = q["worst"]
        o.append(f'<circle cx="{X(w["mhz"]):.1f}" cy="{Y(w["swr"]):.1f}" r="5" fill="none" stroke="{ink}" stroke-width="1.5"/>')
        wx = X(w["mhz"])
        o.append(t(wx + (8 if wx < pr - 140 else -8), max(pt_ + 12, Y(w["swr"]) - 8), f"worst in band {w['swr']:.2f}", 11, ink, 700, "start" if wx < pr - 140 else "end"))
    # The numbers.
    y = cy + ch + 34
    left = []
    for key in ("meshtastic", "meshcore", "mid"):
        k = m.get(key)
        if k:
            left.append((f"{k['name']} {k['mhz']:g}" if k["name"] != "915" else "915 MHz",
                         f"SWR {k['swr']:.2f} · RL {k['rl']:.1f} dB · {k['z'][0]:.1f} {'+' if k['z'][1] >= 0 else '−'} j{abs(k['z'][1]):.1f} Ω"))
    right = [("Best", f"SWR {m['best']['swr']:.2f} at {m['best']['mhz']:.1f} MHz"),
             ("Under SWR 2", f"{m['under2'][0]:g}–{m['under2'][1]:g} MHz" if m.get("under2") else "nowhere in the sweep"),
             ("Resonance", f"X = 0 at {res['mhz']:.1f} MHz" if res.get("mhz") else "none in the sweep")]
    for i, (k, v) in enumerate(left):
        o.append(t(48, y + i * 22, k, 11, dim, 700))
        o.append(t(196, y + i * 22, v, 11, ink, None, None, mono))
    for i, (k, v) in enumerate(right):
        o.append(t(540, y + i * 22, k, 11, dim, 700))
        o.append(t(630, y + i * 22, v, 11.5, ink))
    # Sign-off and the instrument.
    y = H - 104
    o.append(f'<line x1="48" x2="300" y1="{y}" y2="{y}" stroke="{ink}"/><line x1="{W / 2 + 8}" x2="{W - 48}" y1="{y}" y2="{y}" stroke="{ink}"/>')
    o.append(t(48, y + 16, "Tested by", 10.5, dim))
    o.append(t(W / 2 + 8, y + 16, "Signature", 10.5, dim))
    sw = base.get("sweep") or {}
    foot = (f"Instrument {base.get('board', 'NanoVNA')} firmware {base.get('version', '?')} · "
            f"{'calibrated (' + base.get('cal', '') + ')' if base.get('calibrated') else 'NOT calibrated'} · "
            f"sweep {sw.get('start', 0) / 1e6:g}–{sw.get('stop', 0) / 1e6:g} MHz, {sw.get('points', len(freqs))} points")
    o.append(f'<rect x="0" y="{H - 52}" width="{W}" height="52" fill="#f3f6f7"/>')
    o.append(t(48, H - 30, foot, 10.5, dim))
    o.append(t(48, H - 14, f"Measured at the antenna connector, 50 Ω reference. Data: {stem}.s1p, saved with this certificate.", 10.5, dim))
    o.append("</svg>")
    return "".join(o)


def qc_save(sh, base, freqs, pts, unit, r):
    unit = unit.strip()
    if not unit:
        unit = next_unit(qc_records())
    if not base.get("calibrated"):
        return {"ok": False, "refused": "not calibrated",
                "say": f"Not recorded: the NanoVNA reports no calibration (cal: \"{base.get('cal', '')}\"). Uncalibrated "
                       f"numbers can be far off, so a QC record would mean nothing. Calibrate (OPEN, SHORT, LOAD) first."}
    m = metrics(freqs, pts)
    if not m:
        return {"ok": False, "refused": "no data", "say": "Not recorded: no sweep data from the NanoVNA."}
    if m["best"]["swr"] > 15:
        return {"ok": False, "refused": "open port",
                "say": "Not recorded: PORT 1 reads open (no antenna, a loose plug, or an RP-SMA antenna). Connect the unit's antenna."}
    q = qc_eval(freqs, pts, r)
    if not q["covered"]:
        return {"ok": False, "refused": "sweep",
                "say": f"Not recorded: the sweep ({freqs[0] / 1e6:g}–{freqs[-1] / 1e6:g} MHz) does not cover {r['lo']:g}–{r['hi']:g} MHz. Use Mesh layout."}
    now = datetime.datetime.now()
    stem = f"{safe(unit)}-{now.strftime('%Y%m%d-%H%M%S')}"
    os.makedirs(QC_DIR, exist_ok=True)
    s1p = os.path.join(QC_DIR, stem + ".s1p")
    with open(s1p, "w") as f:
        f.write(f"! label: {unit}\n! saved: {now.isoformat(timespec='seconds')}\n! instrument: {base['board']} {base['version']}\n")
        f.write(f"! qc: {'PASS' if q['pass'] else 'FAIL'} · {q['rule']}\n")
        f.write("# Hz S RI R 50\n")
        for fr, (a, b) in zip(freqs, pts):
            f.write(f"{fr:.0f} {a:.9f} {b:.9f}\n")
    cert = os.path.join(QC_DIR, stem + "-certificate.svg")
    with open(cert, "w") as f:
        f.write(certificate_svg(unit, now, base, freqs, pts, m, q))
    spot = {c["mhz"]: c.get("value") for c in q["checks"] if c["id"].startswith("spot")}
    res = m.get("resonance") or {}
    row = {
        "timestamp": now.isoformat(timespec="seconds"), "unit": unit, "result": "PASS" if q["pass"] else "FAIL",
        "swr_906_875": f"{m['meshtastic']['swr']:.3f}" if "meshtastic" in m else "",
        "swr_910_525": f"{m['meshcore']['swr']:.3f}" if "meshcore" in m else "",
        "worst_swr": f"{q['worst']['swr']:.3f}", "worst_mhz": f"{q['worst']['mhz']:.2f}",
        "resonance_mhz": f"{res['mhz']:.2f}" if res.get("mhz") else "",
        "calibrated": "yes" if base.get("calibrated") else "no", "cal_status": base.get("cal", ""),
        "firmware": f"{base.get('board', '')} {base.get('version', '')}".strip(),
        "failed": "; ".join(q["failed"]), "rule": q["rule"], "s1p": s1p, "certificate": cert,
    }
    new = not os.path.exists(QC_LOG)
    with open(QC_LOG, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=QC_FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)
    v = "PASS" if q["pass"] else "FAIL"
    s907 = m.get("meshtastic", {}).get("swr")
    msg(sh, f"{unit}: {v}" + (f", SWR {s907:.2f} at 907" if s907 else ""), "QC")
    s910 = m.get("meshcore", {}).get("swr")
    say = (f"{unit}: {v}. SWR {s907:.2f} at 906.875, {s910:.2f} at 910.525, "
           f"worst {q['worst']['swr']:.2f} at {q['worst']['mhz']:.1f} MHz.")
    if q["failed"]:
        say += " Failed: " + "; ".join(q["failed"]) + "."
    return {"ok": True, "record": row, "qc": q, "metrics": m, "s1p": s1p, "certificate": cert, "log": QC_LOG,
            "next": next_unit(qc_records()), "say": say}


# ---------------------------------------------------------------- library

def safe(label):
    return re.sub(r"[^A-Za-z0-9_-]+", "-", label).strip("-")[:48] or "antenna"


def write_s1p(label, freqs, pts, board, ver):
    os.makedirs(SWEEPS, exist_ok=True)
    now = datetime.datetime.now()
    fn = os.path.join(SWEEPS, f"{safe(label)}-{now.strftime('%Y%m%d-%H%M%S')}.s1p")
    with open(fn, "w") as f:
        f.write(f"! label: {label}\n! saved: {now.isoformat(timespec='seconds')}\n! instrument: {board} {ver}\n")
        f.write("# Hz S RI R 50\n")
        for fr, (a, b) in zip(freqs, pts):
            f.write(f"{fr:.0f} {a:.9f} {b:.9f}\n")
    return fn


def read_s1p(path):
    label, saved = os.path.basename(path)[:-4], None
    freqs, pts = [], []
    unit, fmt = 1.0, "RI"
    with open(path) as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            if s.startswith("!"):
                m = re.match(r"!\s*label:\s*(.+)", s)
                if m:
                    label = m.group(1).strip()
                m = re.match(r"!\s*saved:\s*(.+)", s)
                if m:
                    saved = m.group(1).strip()
                continue
            if s.startswith("#"):
                t = s[1:].upper().split()
                unit = {"HZ": 1, "KHZ": 1e3, "MHZ": 1e6, "GHZ": 1e9}.get(t[0], 1) if t else 1
                fmt = "MA" if "MA" in t else "DB" if "DB" in t else "RI"
                continue
            p = s.split()
            if len(p) >= 3:
                fr, a, b = float(p[0]) * unit, float(p[1]), float(p[2])
                if fmt == "MA":
                    a, b = a * math.cos(math.radians(b)), a * math.sin(math.radians(b))
                elif fmt == "DB":
                    mag = 10 ** (a / 20)
                    a, b = mag * math.cos(math.radians(b)), mag * math.sin(math.radians(b))
                freqs.append(fr)
                pts.append((a, b))
    if saved is None:
        saved = datetime.datetime.fromtimestamp(os.path.getmtime(path)).isoformat(timespec="seconds")
    return label, saved, freqs, pts


def library():
    items = []
    if os.path.isdir(SWEEPS):
        for name in sorted(os.listdir(SWEEPS)):
            if not name.lower().endswith(".s1p"):
                continue
            try:
                label, saved, freqs, pts = read_s1p(os.path.join(SWEEPS, name))
            except Exception:
                continue
            if not freqs:
                continue
            step = step_for(len(freqs), 120)
            items.append({"file": name, "label": label, "saved": saved, "metrics": metrics(freqs, pts),
                          "curve": curve(freqs, pts, step), "s11": s11_list(pts, step)})
    return {"dir": SWEEPS, "items": items}


# ---------------------------------------------------------------- screen

def msg(sh, text, title=""):
    text = text.replace('"', "'")
    title = title.replace('"', "'")
    sh.cmd(f'msg 12000 "{text}" "{title}"' if title else f'msg 12000 "{text}"', wait=3)


def shot(sh):
    w, h = 480, 320
    for l in sh.cmd("info"):
        m = re.search(r"Lcd:(\d+)x(\d+)", l)
        if m:
            w, h = int(m.group(1)), int(m.group(2))
    echo = len("capture\r\n")
    buf = sh.raw(b"capture\r", wait=90 if isinstance(sh, TcpShell) else 15, size=echo + w * h * 2)
    sh.raw(b"", 0.5)
    px = buf[echo:echo + w * h * 2]
    if len(px) < w * h * 2:
        raise RuntimeError(f"short capture ({len(px)} of {w * h * 2} bytes)")
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        row = px[y * w * 2:(y + 1) * w * 2]
        for x in range(w):
            v = (row[2 * x] << 8) | row[2 * x + 1]
            rows += bytes(((v >> 11 & 31) * 255 // 31, (v >> 5 & 63) * 255 // 63, (v & 31) * 255 // 31))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) \
        + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    os.makedirs(SHOTS, exist_ok=True)
    fn = os.path.join(SHOTS, datetime.datetime.now().strftime("nanovna-%Y%m%d-%H%M%S.png"))
    with open(fn, "wb") as f:
        f.write(png)
    return fn


def set_markers(sh, freqs, pts, mode):
    """M1/M2/M3 on the mesh frequencies, or M1 on the lowest SWR. Display only:
    nothing is saved to a slot."""
    if not freqs:
        return {"ok": False, "say": "No sweep data from the NanoVNA."}
    if mode == "best":
        b = min(range(len(pts)), key=lambda k: swr_of(pts[k]))
        sh.cmd(f"marker 1 {b}")
        sh.cmd("marker 1 on")
        return {"ok": True, "say": f"M1 on the lowest SWR: {swr_of(pts[b]):.2f} at {freqs[b] / 1e6:.2f} MHz."}
    placed = []
    for n, (_, name, mhz) in enumerate(MARKS, start=1):
        f = mhz * 1e6
        if freqs[0] <= f <= freqs[-1]:
            i = nearest(freqs, f)
            sh.cmd(f"marker {n} {i}")
            sh.cmd(f"marker {n} on")
            placed.append(f"M{n} {freqs[i] / 1e6:.2f}")
    if not placed:
        return {"ok": False, "say": "The mesh frequencies are off this sweep. Use Mesh layout first."}
    return {"ok": True, "say": "Markers on the nearest sweep points: " + ", ".join(placed) + " MHz."}


# ---------------------------------------------------------------- state files

def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def write_json(path, obj, compact=False):
    """Written whole and swapped in, so a reader never sees half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":")) if compact else json.dump(obj, f, indent=1)
    os.replace(tmp, path)


# ---------------------------------------------------------------- one owner across sessions

def pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def lease_take(session, now=None):
    """(True, lease) when this session holds the polling lease now (taken or renewed), else
    (False, the other session's lease). A lease past its time, or whose Claude process has gone,
    is free."""
    now = time.time() if now is None else now
    os.makedirs(LOCK_DIR, exist_ok=True)
    with open(LEASE_LOCK, "a") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        cur = read_json(LEASE, {}) or {}
        other = cur.get("session") and cur.get("session") != session
        if other and float(cur.get("until") or 0) > now and pid_alive(cur.get("ppid")):
            return False, cur
        new = {"session": session, "ppid": os.getppid(), "pid": os.getpid(), "until": now + LEASE_S, "at": now}
        write_json(LEASE, new)
        return True, new


def watchers(now=None):
    """The sessions whose VNA tab was looked at in the last WATCH_S seconds (their watch-<id> marks)."""
    now = time.time() if now is None else now
    out_ = []
    try:
        names = os.listdir(LOCK_DIR)
    except OSError:
        return out_
    for name in names:
        if not name.startswith("watch-"):
            continue
        p = os.path.join(LOCK_DIR, name)
        try:
            age = now - os.path.getmtime(p)
        except OSError:
            continue
        if age < WATCH_S:
            out_.append(name[6:])
        elif age > 86400:
            try:
                os.remove(p)
            except OSError:
                pass
    return out_


def shared_live():
    s_ = read_json(LIVE_JSON, None)
    return s_ if isinstance(s_, dict) else None


PUBLISHED = ("connected", "port", "via", "version", "board", "vbatMv", "cal", "calibrated", "sweep", "metrics", "curve",
             "s11", "markers", "slot", "slots", "traces", "calStep", "calBand")


def publish(base, session):
    """A reading for every session: live.json, with when it was taken and by whom."""
    rec = {k: base[k] for k in PUBLISHED if k in base}
    rec["at"] = int(time.time() * 1000)
    rec["by"] = session or f"pid{os.getpid()}"
    try:
        write_json(LIVE_JSON, rec, compact=True)
    except OSError:
        pass
    base["at"] = rec["at"]
    return base


class LockWait(Exception):
    pass


def device_lock(wait):
    """nanovna.lock within `wait` seconds, or None (someone else is talking to the NanoVNA). A blocking
    wait under a timer, so this caller queues with the others rather than losing every race to them."""
    os.makedirs(LOCK_DIR, exist_ok=True)
    lk = open(os.path.join(LOCK_DIR, "nanovna.lock"), "w")
    try:
        fcntl.flock(lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return lk
    except BlockingIOError:
        pass
    if wait <= 0:
        lk.close()
        return None

    def on_timer(_sig, _frm):
        raise LockWait()
    left = signal.alarm(0)  # the watchdog's time, put back afterwards
    old = signal.signal(signal.SIGALRM, on_timer)
    got = False
    try:
        signal.setitimer(signal.ITIMER_REAL, wait)
        fcntl.flock(lk, fcntl.LOCK_EX)
        got = True
    except LockWait:
        pass
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
        if left:
            signal.alarm(max(1, left - int(wait)))
    if not got:
        lk.close()
        return None
    return lk


def busy_reply(why):
    """What a caller gets when the NanoVNA is busy or silent: the last shared reading, flagged."""
    last = shared_live() or {}
    return {**last, "busy": True, "say": why, "lastAt": last.get("at")}


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


# ---------------------------------------------------------------- save slots
#
# DiSlord's firmware keeps SAVEAREA_MAX calibration slots in flash (hardware.h, unchanged from
# 1.2.40 to 1.2.46): 7 on the STM32F303 boards (NanoVNA-H4: slots 0-6), 5 on the F072 NanoVNA-H
# (0-4). Each slot holds a whole state: sweep, calibration, traces, markers. At power-on the
# NanoVNA loads slot 0 (main.c load_settings), unless its Backup setting is on, when it reloads
# the slot and range last used. `recall N` loads a slot (printing "Err, default load" when the
# slot holds nothing valid); `save N` writes one.
#
# Slot 0 is Seth's Meshtastic power-on state. Two things here write it, both checked before the
# write: the mesh recalibration (cal ... load) and `poweron save`. Band presets use slots 1..N-1.

MESH_SWEEP = {"start": 850000000.0, "stop": 980000000.0, "points": 201}
# The mesh layout's traces (the same commands, in the same order, as `preset`).
MESH_TRACES = ["trace 0 swr", "trace 0 scale 0.5", "trace 0 refpos 0", "trace 1 smith", "trace 2 logmag",
               "trace 2 scale 5", "trace 2 refpos 8"]
MESH_MARKERS = ["marker 1 88", "marker 2 93", "marker 3 100"]
# The optional fourth trace: reactance X of S11 (src 0; trace 3's own default channel is S21),
# 25 ohm a division with X = 0 on the middle line (refpos 4 of NGRIDY 8).
X_TRACE = ["trace 3 x 0", "trace 3 scale 25", "trace 3 refpos 4"]


def slot_count(board):
    return 7 if re.search(r"H\s*4", board or "") else 5


def remember_board(board):
    if not board:
        return
    st = read_json(SLOT_STATE, {}) or {}
    if st.get("board") != board:
        st["board"] = board
        write_json(SLOT_STATE, st)


def same_sweep(a, b):
    try:
        return (abs(float(a["start"]) - float(b["start"])) < 1 and abs(float(a["stop"]) - float(b["stop"])) < 1
                and int(a["points"]) == int(b["points"]))
    except Exception:
        return False


def slot_state():
    st = read_json(SLOT_STATE, {})
    return st if isinstance(st, dict) else {}


def set_slot_state(slot, sweep):
    """Records which slot's calibration is now in use (None: none or unknown) and the sweep it came with."""
    st = slot_state()
    st.update(slot=slot, sweep=sweep, at=now_iso())
    write_json(SLOT_STATE, st)


def current_slot(sweep):
    """The slot whose calibration is in use, if the last one recorded still matches the sweep the
    NanoVNA shows (a power cycle, a change on its own screen or a cal reset makes it unknown: None)."""
    st = slot_state()
    n = st.get("slot")
    return n if isinstance(n, int) and not isinstance(n, bool) and same_sweep(st.get("sweep"), sweep) else None


def save_slot(sh, n, mesh=False):
    """`save n`. Slot 0 only for the mesh recalibration and `poweron save` (mesh=True); every
    preset path calls this with mesh=False, and slot 0 is refused there."""
    if isinstance(n, bool) or not isinstance(n, int) or n < 0:
        raise ValueError(f"bad slot {n!r}")
    if n == 0 and not mesh:
        raise ValueError("slot 0 is the Meshtastic power-on state: presets never write it")
    sh.cmd(f"save {n}", wait=10)


def recall_slot(sh, n):
    """`recall n`; False when the NanoVNA says the slot holds nothing valid."""
    r = sh.cmd(f"recall {n}", wait=10)
    return not any("err" in l.lower() for l in r)


# ---------------------------------------------------------------- band presets

# Built-in bands. Each sweeps a little wider than its band, so a dip that is off shows. The
# targets are what the tab and the trim assistant aim for.
BUILTIN_BANDS = [
    {"id": "mesh", "name": "Meshtastic / MeshCore", "short": "Mesh", "start": 850e6, "stop": 980e6, "points": 201,
     "band": [902.0, 928.0], "targets": [[906.875, "Meshtastic"], [910.525, "MeshCore"]],
     "for": "LoRa node antennas: the power-on layout"},
    {"id": "2m", "name": "2 m ham", "short": "2 m", "start": 130e6, "stop": 165e6, "points": 201,
     "band": [144.0, 148.0], "targets": [[146.52, "2 m calling"]], "for": "the Baofeng UV-5R's antennas (VHF side)"},
    {"id": "70cm", "name": "70 cm ham", "short": "70 cm", "start": 400e6, "stop": 470e6, "points": 201,
     "band": [420.0, 450.0], "targets": [[446.0, "70 cm calling"]], "for": "the Baofeng UV-5R's antennas (UHF side)"},
    {"id": "adsb", "name": "ADS-B 1090", "short": "1090", "start": 1000e6, "stop": 1180e6, "points": 201,
     "band": [1087.0, 1093.0], "targets": [[1090.0, "ADS-B"]], "for": "plane-tracking antennas"},
    {"id": "ism433", "name": "433 MHz ISM", "short": "433", "start": 410e6, "stop": 456e6, "points": 201,
     "band": [433.05, 434.79], "targets": [[433.92, "433.92"]], "for": "weather-sensor and gadget antennas"},
    {"id": "fm", "name": "FM broadcast", "short": "FM", "start": 76e6, "stop": 120e6, "points": 201,
     "band": [88.0, 108.0], "targets": [[98.0, "mid-band"]], "for": "FM receive antennas"},
]
BUILTIN_IDS = {b["id"] for b in BUILTIN_BANDS}
DEFAULT_SLOTS = {"2m": 1, "70cm": 2, "adsb": 3, "ism433": 4, "fm": 5}
POINTS_OK = (51, 101, 201, 301, 401)
PRESETS_ABOUT = ("The VNA tab's band presets. slots maps a band to a NanoVNA save slot (1-6 on the H4; slot 0 is the "
                 "Meshtastic power-on state and is never used here). bands adds your own: {\"id\": \"cb\", \"name\": "
                 "\"CB 11 m\", \"startMHz\": 25, \"stopMHz\": 29, \"band\": [26.965, 27.405], \"targets\": [[27.185, \"ch 19\"]]}. "
                 "cal is written by the tab when it calibrates a band: leave it alone.")


def presets_file():
    """(presets, warning). Creates presets.json with the defaults when it is missing; a file that
    does not read is left alone (never overwritten) and the defaults are used."""
    p = read_json(PRESETS, None)
    if p is None and not os.path.exists(PRESETS):
        p = {"about": PRESETS_ABOUT, "version": 1, "slots": dict(DEFAULT_SLOTS), "bands": [], "cal": {}}
        try:
            write_json(PRESETS, p)
        except OSError:
            pass
        return p, None
    if not isinstance(p, dict):
        return {"slots": dict(DEFAULT_SLOTS), "bands": [], "cal": {}, "unreadable": True}, \
            f"{PRESETS} does not read as JSON: the defaults are in use and nothing is written to it until it is fixed."
    return p, None


def user_bands(p):
    out = []
    for b in p.get("bands") or []:
        if not isinstance(b, dict):
            continue
        try:
            bid = re.sub(r"[^a-z0-9_-]", "", str(b.get("id", "")).lower())[:24]
            lo, hi = float(b["startMHz"]), float(b["stopMHz"])
            pts = int(b.get("points", 201))
            band = [float(x) for x in (b.get("band") or [lo, hi])][:2]
            targets = [[float(t[0]), str(t[1] if len(t) > 1 else "target")[:24]] for t in (b.get("targets") or [[(lo + hi) / 2, "centre"]])][:3]
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        # The firmware takes sweeps from under 1 kHz to 2.7 GHz (FREQUENCY_MIN, FREQUENCY_MAX).
        if not bid or bid in BUILTIN_IDS or not (0.001 <= lo < hi <= 2700) or pts not in POINTS_OK or len(band) != 2 or not targets:
            continue
        out.append({"id": bid, "name": str(b.get("name") or bid)[:40], "short": str(b.get("short") or b.get("name") or bid)[:10],
                    "start": lo * 1e6, "stop": hi * 1e6, "points": pts, "band": band, "targets": targets,
                    "for": str(b.get("for") or "")[:80], "custom": True})
    return out


def bands_view(p, nslots):
    """Every band with its slot, why it has none, and its calibration record when that is valid
    (written by this script for this band, slot and sweep)."""
    slots = p.get("slots") if isinstance(p.get("slots"), dict) else {}
    cal = p.get("cal") if isinstance(p.get("cal"), dict) else {}
    out = []
    for b in BUILTIN_BANDS + user_bands(p):
        v = dict(b)
        if b["id"] == "mesh":
            v.update(slot=0, slotWhy=None, cal=None, calOk=None, powerOn=True)
            out.append(v)
            continue
        raw = slots[b["id"]] if b["id"] in slots else DEFAULT_SLOTS.get(b["id"])
        slot, why = None, None
        if raw is None:
            why = "no save slot: give it one in presets.json"
        elif isinstance(raw, bool) or not isinstance(raw, int):
            why = f"slot {raw!r} is not a slot number"
        elif raw == 0:
            why = "slot 0 is the Meshtastic power-on state: presets never use it"
        elif not 1 <= raw < nslots:
            why = f"slot {raw} does not exist: this NanoVNA has slots 0-{nslots - 1}"
        else:
            slot = raw
        rec = cal.get(str(slot)) if slot is not None else None
        ok = isinstance(rec, dict) and rec.get("band") == b["id"] and rec.get("slot") == slot and same_sweep(rec, b)
        v.update(slot=slot, slotWhy=why, cal=rec if ok else None, calOk=bool(ok),
                 calOther=rec.get("band") if isinstance(rec, dict) and not ok and rec.get("band") != b["id"] else None)
        out.append(v)
    # Bands sharing a slot: each one's calibration replaces the other's.
    for v in out:
        v["shares"] = [w["id"] for w in out if w is not v and w.get("slot") is not None and w.get("slot") == v.get("slot")]
    return out


def presets_view():
    p, warn = presets_file()
    st = slot_state()
    n = slot_count(st.get("board") or "NanoVNA-H 4")
    return {"ok": True, "file": PRESETS, "slots": n, "spare": list(range(1, n)), "bands": bands_view(p, n),
            "powerOn": p.get("powerOn"), "slotState": {"slot": st.get("slot"), "sweep": st.get("sweep"), "at": st.get("at")},
            "warning": warn}


def find_band(bid, nslots):
    p, warn = presets_file()
    for v in bands_view(p, nslots):
        if v["id"] == bid:
            return v, p, warn
    return None, p, warn


def mhz_txt(hz):
    return f"{hz / 1e6:g}"


def band_markers(b):
    """M1 on the band's first target, M2 and M3 on the band's edges."""
    pts, lo, hi = b["points"], b["start"], b["stop"]

    def idx(f):
        return max(0, min(pts - 1, round((f * 1e6 - lo) / (hi - lo) * (pts - 1))))
    return [f"marker {k} {idx(f)}" for k, f in enumerate((b["targets"][0][0], b["band"][0], b["band"][1]), start=1)]


def band_switch(sh, base, b):
    """Switches the NanoVNA to a band: `recall 0` for mesh (the power-on state, exactly as saved),
    `recall N` for a band with a calibration, else its range swept uncalibrated. Nothing is saved."""
    name = b["name"]
    if b["id"] == "mesh" or b.get("calOk"):
        n = 0 if b["id"] == "mesh" else b["slot"]
        if not recall_slot(sh, n):
            set_slot_state(None, read_sweep(sh))
            return {"ok": False, "band": b["id"], "say": f"Slot {n} holds no valid calibration on the NanoVNA (it loaded its defaults "
                                                          f"instead). " + ("Calibrate the mesh band." if n == 0 else f"Calibrate {name} again.")}
        sw = read_sweep(sh)
        set_slot_state(n, sw)
        if not same_sweep(sw, b):
            got = f"{mhz_txt(sw['start'])}-{mhz_txt(sw['stop'])} MHz" if sw else "an unknown sweep"
            return {"ok": False, "band": b["id"], "slot": n, "mismatch": True,
                    "say": f"Slot {n} holds {got}, not {name}'s {mhz_txt(b['start'])}-{mhz_txt(b['stop'])} MHz. "
                           + ("" if n == 0 else f"Calibrate {name} to replace it.")}
        if n == 0:
            msg(sh, "Meshtastic: slot 0 recalled, the power-on state.", "Band")
            return {"ok": True, "band": "mesh", "slot": 0,
                    "say": "Back to Meshtastic: slot 0 recalled, the power-on state (850-980 MHz with its calibration and layout, exactly as saved)."}
        msg(sh, f"{name}: slot {n} recalled ({mhz_txt(b['start'])}-{mhz_txt(b['stop'])} MHz, calibrated).", "Band")
        return {"ok": True, "band": b["id"], "slot": n, "say": f"{name}: slot {n} recalled, calibrated {b['cal'].get('at', '')[:10]}."}
    sh.cmd(f"sweep {int(b['start'])} {int(b['stop'])} {b['points']}")
    for c in band_markers(b):
        sh.cmd(c)
    set_slot_state(None, read_sweep(sh))
    where = f"Calibrate it to save slot {b['slot']}." if b.get("slot") else (b.get("slotWhy") or "")
    msg(sh, f"{name}: {mhz_txt(b['start'])}-{mhz_txt(b['stop'])} MHz, NOT calibrated. {where}", "Band")
    return {"ok": True, "band": b["id"], "slot": None, "uncal": True,
            "say": f"{name}: sweeping {mhz_txt(b['start'])}-{mhz_txt(b['stop'])} MHz UNCALIBRATED (the numbers are rough). {where}"}


# ---------------------------------------------------------------- calibration

def cal_state():
    st = read_json(CAL_STATE, {})
    return st if isinstance(st, dict) else {}


def set_cal_state(s):
    write_json(CAL_STATE, s)


def raw_points(sh):
    return [complex(*p) for p in read_s11(sh)[1]]


def record_band_cal(b, slot, sweep, rl):
    p, warn = presets_file()
    if p.get("unreadable"):
        return warn
    cal = p.get("cal") if isinstance(p.get("cal"), dict) else {}
    cal[str(slot)] = {"band": b["id"], "slot": slot, "at": now_iso(), "start": sweep["start"], "stop": sweep["stop"],
                      "points": sweep["points"], "loadRl": round(rl, 1)}
    p["cal"] = cal
    write_json(PRESETS, p)
    return None


def calibrate(sh, step, band=None, nslots=7):
    """Guided OPEN -> SHORT -> LOAD. band None: the mesh recalibration, saved to slot 0, only on the
    850-980 MHz mesh sweep. A band: its own sweep and layout, saved to its spare slot (never 0)."""
    st = cal_state()
    who = band["id"] if band else "mesh"
    title = band["name"] if band else "Calibration"
    if step == "begin":
        if st.get("step") and st.get("band", "mesh") != who:
            return {"ok": False, "step": st.get("step"), "say": f"A calibration of {st.get('band', 'mesh')} is under way: finish or cancel it first."}
        sw = read_sweep(sh)
        if band is None:
            if not same_sweep(sw, MESH_SWEEP):
                got = f"{mhz_txt(sw['start'])}-{mhz_txt(sw['stop'])} MHz" if sw else "an unknown range"
                return {"ok": False, "step": None, "refused": "sweep",
                        "say": f"Not started: the NanoVNA is sweeping {got}, not the 850-980 MHz mesh band, and this calibration is saved "
                               f"to slot 0 (the power-on state). Press Back to Meshtastic first, or calibrate the band you are on."}
            target = {"slot": 0, "band": "mesh"}
        else:
            slot = band.get("slot")
            if isinstance(slot, bool) or not isinstance(slot, int) or not 1 <= slot < nslots:
                return {"ok": False, "step": None, "refused": "slot",
                        "say": f"Not started: {band['name']} has no spare save slot ({band.get('slotWhy') or 'slot 0 is never used for presets'})."}
            target = {"slot": slot, "band": band["id"], "restore": current_slot(sw)}
            sh.cmd(f"sweep {int(band['start'])} {int(band['stop'])} {band['points']}")
            for c in MESH_TRACES + ["trace 3 off"] + band_markers(band):
                sh.cmd(c)
            set_slot_state(None, read_sweep(sh))
        set_cal_state({"step": "open", **target})
        where = "" if band is None else f" {mhz_txt(band['start'])}-{mhz_txt(band['stop'])} MHz, for slot {target['slot']}."
        msg(sh, f"Unscrew the antenna. Screw the OPEN plug onto PORT 1, then press OPEN is on.{where}", f"{title} 1 of 3")
        return {"ok": True, "step": "open", "band": who, "calSlot": target["slot"],
                "say": f"Unscrew the antenna and screw the OPEN plug onto PORT 1.{where}"}
    if st.get("step") and st.get("band", "mesh") != who:
        return {"ok": False, "step": st.get("step"), "say": f"A calibration of {st.get('band', 'mesh')} is under way, not {who}: finish or cancel it first."}
    if step == "cancel":
        if not st.get("step"):
            return {"ok": True, "step": None, "say": "No calibration is under way."}
        if who == "mesh":
            if st.get("step") in ("short", "load"):
                recall_slot(sh, 0)
                set_slot_state(0, read_sweep(sh))
            set_cal_state({})
            msg(sh, "Calibration cancelled. The saved calibration is back.", "Calibration")
            return {"ok": True, "step": None, "say": "Cancelled. The calibration saved in slot 0 is back in use."}
        back = st.get("restore") if isinstance(st.get("restore"), int) else 0
        if not recall_slot(sh, back):
            back = 0
            recall_slot(sh, 0)
        set_slot_state(back, read_sweep(sh))
        set_cal_state({})
        msg(sh, f"{title} calibration cancelled. Slot {back} is back.", "Calibration")
        return {"ok": True, "step": None, "say": f"Cancelled. Slot {back} is back in use ({'Meshtastic' if back == 0 else 'as before'}); nothing was saved."}
    if step != st.get("step"):
        return {"ok": False, "step": st.get("step"), "say": f"Expected step {st.get('step') or 'begin'}, not {step}."}
    if step == "open":
        sh.cmd("cal reset")
        set_slot_state(None, read_sweep(sh))
        time.sleep(0.6)
        o = raw_points(sh)
        sh.cmd("cal open", wait=15)
        set_cal_state({**st, "step": "short", "open": [[c.real, c.imag] for c in o]})
        msg(sh, "OPEN captured. Now screw on the SHORT plug, then press SHORT is on.", f"{title} 2 of 3")
        return {"ok": True, "step": "short", "band": who, "say": "OPEN captured. Now screw on the SHORT plug."}
    o = [complex(*p) for p in st.get("open", [])]
    if step == "short":
        s = raw_points(sh)
        n = min(len(o), len(s))
        if not n:
            return {"ok": False, "step": "short", "say": "No reading from the NanoVNA. Try again."}
        diffs = [abs(math.degrees(math.atan2((s[i] / o[i]).imag, (s[i] / o[i]).real))) for i in range(n) if abs(o[i]) > 1e-6]
        mean = sum(diffs) / len(diffs)
        if mean < 150:
            return {"ok": False, "step": "short", "say": f"That doesn't read like a SHORT (only {mean:.0f}° from the OPEN; a short is about 180°). Check the plug and press again."}
        sh.cmd("cal short", wait=15)
        st.update({"step": "load", "short": [[c.real, c.imag] for c in s]})
        set_cal_state(st)
        msg(sh, "SHORT captured. Now screw on the LOAD plug (50 ohm), then press LOAD is on.", f"{title} 3 of 3")
        return {"ok": True, "step": "load", "band": who, "say": f"SHORT captured ({mean:.0f}° from the OPEN). Now the LOAD plug."}
    if step == "load":
        s = [complex(*p) for p in st.get("short", [])]
        l = raw_points(sh)
        n = min(len(o), len(s), len(l))
        ratios = [(abs(l[i] - o[i]) / abs(o[i] - s[i]), abs(l[i] - s[i]) / abs(o[i] - s[i])) for i in range(n) if abs(o[i] - s[i]) > 1e-6]
        if not ratios:
            return {"ok": False, "step": "load", "say": "No reading from the NanoVNA. Try again."}
        a = sum(r[0] for r in ratios) / len(ratios)
        b = sum(r[1] for r in ratios) / len(ratios)
        if not (0.3 < a < 0.7 and 0.3 < b < 0.7):
            return {"ok": False, "step": "load", "say": "That doesn't read like a 50 Ω LOAD (it should sit halfway between OPEN and SHORT). Check the plug and press again."}
        slot = st.get("slot", 0)
        sw = read_sweep(sh)
        # Checked again right before the write: slot 0 only ever gets the mesh band; a band only its spare slot.
        if who == "mesh":
            if slot != 0 or not same_sweep(sw, MESH_SWEEP):
                return {"ok": False, "step": "load", "refused": "sweep", "say": "Not saved: the sweep is no longer the 850-980 MHz mesh band. Cancel and start again."}
        elif isinstance(slot, bool) or not isinstance(slot, int) or not 1 <= slot < nslots or not same_sweep(sw, band):
            return {"ok": False, "step": "load", "refused": "slot", "say": "Not saved: the band's slot or sweep changed under the calibration. Cancel and start again."}
        sh.cmd("cal load", wait=15)
        sh.cmd("cal done", wait=15)
        save_slot(sh, slot, mesh=(who == "mesh"))
        time.sleep(0.8)
        worst = max(gamma(p) for p in read_s11(sh)[1])
        rl = -20 * math.log10(max(worst, 1e-9))
        set_cal_state({})
        set_slot_state(slot, sw)
        grade = "excellent" if rl >= 40 else "good" if rl >= 30 else "weak, redo it"
        warn = record_band_cal(band, slot, sw, rl) if band else None
        where = "slot 0" if who == "mesh" else f"slot {slot} ({band['name']})"
        msg(sh, f"Calibrated and saved to {where}. LOAD reads {rl:.0f} dB ({grade}).", "Calibration done")
        return {"ok": True, "step": None, "band": who, "calSlot": slot, "worstRl": round(rl, 1),
                "say": f"Calibrated and saved to {where}. The LOAD now reads {rl:.0f} dB return loss ({grade})." + (f" {warn}" if warn else "")}
    return {"ok": False, "step": st.get("step"), "say": f"Unknown step {step}."}


def preset(sh):
    for c in ["sweep 850000000 980000000 201", "trace 0 swr", "trace 0 scale 0.5", "trace 0 refpos 0",
              "trace 1 smith", "trace 2 logmag", "trace 2 scale 5", "trace 2 refpos 8", "trace 3 off",
              "marker 1 88", "marker 2 93", "marker 3 100"]:
        sh.cmd(c)
    msg(sh, "Mesh antenna layout set: 850-980 MHz. Calibrate before measuring.", "Layout")


# ---------------------------------------------------------------- 📸 export: the report card

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def svg_size(path):
    with open(path) as f:
        head = f.read(800)
    m = re.search(r'<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"', head)
    return (int(float(m.group(1))), int(float(m.group(2)))) if m else (540, 2000)


def bounded(argv, seconds, done=None):
    """Runs argv in its own process group and kills the group after `seconds` (or as soon as done()
    says the work is there: headless Chrome lingers after its screenshot, and once ran for a day)."""
    p = subprocess.Popen(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    end = time.time() + seconds
    while time.time() < end and p.poll() is None:
        if done and done():
            time.sleep(0.3)
            break
        time.sleep(0.1)
    if p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    return p.returncode


def chrome_png(svg, png):
    """The SVG at 2x through headless Chrome, a throwaway profile, a 30 s alarm, and the profile deleted after."""
    w, h = svg_size(svg)
    prof = tempfile.mkdtemp(prefix="vna-chrome-")
    try:
        shutil.copy(svg, os.path.join(prof, "card.svg"))
        page = os.path.join(prof, "card.html")
        with open(page, "w") as f:
            f.write(f'<!doctype html><html><body style="margin:0;background:#0b1012"><img src="card.svg" style="display:block;width:{w}px;height:{h}px"></body></html>')
        argv = ["/usr/bin/perl", "-e", "alarm 30; exec @ARGV", CHROME, "--headless=new", "--disable-gpu", "--no-first-run",
                "--no-default-browser-check", "--disable-extensions", "--use-mock-keychain", "--password-store=basic",
                "--disable-background-networking", "--disable-component-update", "--disable-sync", f"--user-data-dir={prof}",
                "--hide-scrollbars", "--force-device-scale-factor=2", f"--window-size={w},{h}", "--virtual-time-budget=2000",
                f"--screenshot={png}", "file://" + page]
        bounded(argv, 35, done=lambda: os.path.exists(png) and os.path.getsize(png) > 0)
    finally:
        shutil.rmtree(prof, ignore_errors=True)
    return os.path.exists(png) and os.path.getsize(png) > 0


def to_png(svg, png):
    """(how, None) once png exists, else (None, why). VNA_SVG_CONVERTER replaces the converters (tests):
    it is run as `<it> <svg> <png> 2`."""
    tries = []
    fake = os.environ.get("VNA_SVG_CONVERTER")
    if fake:
        tries.append(("converter", [fake, svg, png, "2"]))
    else:
        if os.path.exists(CHROME):
            tries.append(("chrome", None))
        rsvg = shutil.which("rsvg-convert", path="/opt/homebrew/bin:/usr/local/bin:/usr/bin")
        if rsvg:
            tries.append(("rsvg-convert", [rsvg, "-z", "2", "-o", png, svg]))
    why = []
    for how, argv in tries:
        try:
            ok = chrome_png(svg, png) if how == "chrome" else (bounded(argv, 30) == 0 and os.path.exists(png) and os.path.getsize(png) > 0)
        except Exception as e:  # noqa: BLE001 - any converter failure falls through to the next
            ok = False
            why.append(f"{how}: {e}")
        if ok:
            return how, None
        why.append(f"{how} made no PNG")
        try:
            os.remove(png)
        except OSError:
            pass
    return None, "; ".join(why) or "no converter found (Google Chrome or rsvg-convert)"


def export_card(tmp, name, when=None):
    """Moves the tab's card to exports/<name>-<yyyymmdd-hhmm>.svg, makes the PNG and shows it in Finder."""
    if not tmp or not os.path.isfile(tmp):
        return {"ok": False, "error": "no card to export"}
    when = when or datetime.datetime.now()
    os.makedirs(EXPORTS, exist_ok=True)
    stem = f"{safe(name or 'Live')}-{when.strftime('%Y%m%d-%H%M')}"
    k = 1
    base = stem
    while os.path.exists(os.path.join(EXPORTS, stem + ".svg")):
        k += 1
        stem = f"{base}-{k}"
    svg = os.path.join(EXPORTS, stem + ".svg")
    png = os.path.join(EXPORTS, stem + ".png")
    shutil.move(tmp, svg)
    how, why = to_png(svg, png)
    if not os.environ.get("VNA_NO_REVEAL"):
        bounded(["/usr/bin/open", "-R", png if how else svg], 10)
    if how:
        return {"ok": True, "svg": svg, "png": png, "converter": how, "say": f"Exported {png} (the SVG is beside it)."}
    return {"ok": True, "svg": svg, "png": None, "converter": None,
            "say": f"Exported {svg}, but no PNG: {why}. The SVG opens in any browser."}


# ---------------------------------------------------------------- the 4th trace and the power-on layout

def x_trace(sh, on):
    """Trace 3 = reactance X of S11 (or off), on the screen now; nothing is saved."""
    for c in (X_TRACE if on else ["trace 3 off"]):
        sh.cmd(c)
    traces = read_traces(sh)
    shown = any(t["n"] == 3 and t["type"] == "x" for t in traces)
    return {"ok": shown == on, "traces": traces,
            "say": ("Trace 4 shows X (reactance) now: it crosses zero where the antenna resonates. Not saved: the NanoVNA starts as before."
                    if on else "Trace 4 off. Not saved.") if shown == on else "The NanoVNA did not take the trace change."}


def poweron_refusal(base, st, confirm):
    """Why `poweron save` must not write slot 0 now, or None."""
    if not confirm:
        return "confirm", "Not saved: this writes slot 0 (the power-on state) and needs the confirmation step."
    if st.get("step"):
        return "cal", "Not saved: a calibration is under way. Finish or cancel it first."
    sw = base.get("sweep")
    if not same_sweep(sw, MESH_SWEEP):
        got = f"{mhz_txt(sw['start'])}-{mhz_txt(sw['stop'])} MHz / {sw['points']} points" if sw else "an unknown sweep"
        return "sweep", f"Not saved: the NanoVNA is sweeping {got}, not the 850-980 MHz / 201-point mesh band. Press Back to Meshtastic first."
    if not base.get("calibrated"):
        return "uncal", "Not saved: the NanoVNA reports no calibration in use."
    if current_slot(sw) != 0:
        return "slot", ("Not saved: the calibration in use is not known to be slot 0's (a band was recalled, a calibration "
                        "was reset, or the NanoVNA was changed on its own screen). Press Back to Meshtastic (recall 0) first.")
    return None


def poweron_save(sh, base, confirm):
    """Saves slot 0 = the slot-0 mesh calibration in use + the mesh layout (traces 0-2 as today,
    trace 3 as it is now: X or off, markers 88/93/100). Refused unless poweron_refusal is None."""
    why = poweron_refusal(base, cal_state(), confirm)
    if why:
        return {"ok": False, "refused": why[0], "say": why[1]}
    x_on = any(t["n"] == 3 and t["type"] == "x" for t in read_traces(sh))
    for c in MESH_TRACES + (X_TRACE if x_on else ["trace 3 off"]) + MESH_MARKERS:
        sh.cmd(c)
    sw = read_sweep(sh)
    if not same_sweep(sw, MESH_SWEEP) or current_slot(sw) != 0:
        return {"ok": False, "refused": "sweep", "say": "Not saved: the sweep changed while the layout was set."}
    save_slot(sh, 0, mesh=True)
    set_slot_state(0, sw)
    p, warn = presets_file()
    if not p.get("unreadable"):
        p["powerOn"] = {"at": now_iso(), "trace3": "x" if x_on else "off"}
        write_json(PRESETS, p)
    traces = "SWR, Smith, LOGMAG" + (" and X" if x_on else "")
    msg(sh, f"Power-on layout saved to slot 0: 850-980 MHz, {traces}.", "Power-on")
    return {"ok": True, "trace3": "x" if x_on else "off", "traces": read_traces(sh),
            "say": f"Saved slot 0: the mesh calibration in use, 850-980 MHz at 201 points, traces {traces}, markers at 907.2 / 910.45 / 915. "
                   f"The NanoVNA starts like this from now on."}


# ---------------------------------------------------------------- main

def pop_opt(args, name):
    """Removes `name value` from args and returns value (None when absent)."""
    if name in args:
        i = args.index(name)
        v = args[i + 1] if i + 1 < len(args) else ""
        del args[i:i + 2]
        return v
    return None


def sweep_payload(base, freqs, pts):
    step = step_for(len(freqs), 201)
    base["metrics"] = metrics(freqs, pts)
    base["curve"] = curve(freqs, pts, step)
    base["s11"] = s11_list(pts, step)


# How long each verb may take in all, and how long it waits for the device lock: a caller always
# gets an answer (the last shared reading, flagged busy) rather than a hang.
LIMITS = {"poll": (12, 1.5), "live": (10, 2.0), "status": (8, 2.0), "save": (15, 6.0), "markers": (15, 6.0), "qc": (20, 6.0),
          "cal": (45, 10.0), "band": (25, 6.0), "xtrace": (12, 6.0), "poweron": (20, 6.0), "preset": (20, 6.0),
          "msg": (10, 6.0), "shot": (40, 6.0)}


class Watchdog(Exception):
    pass


def garbled(base, freqs, pts):
    """A reading that does not add up: fewer or more points than the sweep (another program on the port)."""
    sw = base.get("sweep") or {}
    return not freqs or len(freqs) != len(pts) or (sw.get("points") and len(freqs) != int(sw["points"]))


def main():
    args = sys.argv[1:] or ["status"]
    qc_json = pop_opt(args, "--qc")
    rules_json = pop_opt(args, "--rules")
    session = pop_opt(args, "--session") or ""
    wait_opt = pop_opt(args, "--wait")
    confirm = "--confirm" in args
    args = [a for a in args if a != "--confirm"]
    verb = args[0]
    os.makedirs(STATE_DIR, exist_ok=True)
    # Files only: no lock, so the tab can read them beside a sweep.
    if verb == "presets":
        out(presets_view())
    if verb == "library":
        out(library())
    if verb == "delete":
        name = os.path.basename(args[1]) if len(args) > 1 else ""
        p = os.path.join(SWEEPS, name)
        if name.endswith(".s1p") and os.path.isfile(p):
            os.remove(p)
            out({"ok": True})
        out({"ok": False, "error": "no such sweep"})
    if verb == "qc" and len(args) > 1 and args[1] == "log":
        out(qc_log())
    if verb == "shared":
        out({**(shared_live() or {}), "shared": True})
    if verb == "export":
        out(export_card(pop_opt(args, "--svg"), pop_opt(args, "--name") or "Live"))
    total, wait = LIMITS.get(verb, (20, 6.0))
    if wait_opt:
        try:
            wait = max(0.0, min(float(wait_opt), 30.0))
        except ValueError:
            pass
    if verb == "poll":
        # Only the lease holder polls, and only while some session's VNA tab is being looked at.
        held, cur = lease_take(session or f"pid{os.getpid()}")
        if not held:
            out({**(shared_live() or {}), "shared": True, "holder": {"session": cur.get("session"), "until": cur.get("until")}})
        if not watchers():
            out({**(shared_live() or {}), "idle": True, "holder": {"session": session, "until": cur.get("until")}})

    def on_alarm(_sig, _frm):
        raise Watchdog()
    signal.signal(signal.SIGALRM, on_alarm)
    # The watchdog always outlasts the wait for the lock.
    total = max(total, int(wait) + 8)
    signal.alarm(int(total))
    sh = None
    try:
        # One conversation with the NanoVNA at a time, across every session and caller.
        lock = device_lock(wait)
        if lock is None:
            out(busy_reply("NanoVNA busy: another session or command is talking to it."))
        try:
            os.makedirs(LIB, exist_ok=True)
        except OSError:
            pass  # the library folder is only needed by save/QC; reading the NanoVNA must not wait on iCloud
        sh, port = open_shell()
        if not sh:
            if verb in ("poll", "live", "status"):
                publish({"connected": False}, session)
            out({"connected": False})
        base = info(sh, port)
        if verb == "status":
            out(base)
        if verb in ("live", "save", "poll"):
            freqs, pts = read_s11(sh)
            if garbled(base, freqs, pts):
                out(busy_reply("The reading came back garbled: another program may be talking to the NanoVNA."))
            sweep_payload(base, freqs, pts)
            base["markers"] = device_markers(sh, freqs, pts)
            publish(base, session)
            if qc_json is not None and freqs:
                base["qc"] = qc_eval(freqs, pts, qc_rules(qc_json))
            if verb == "save":
                label = " ".join(args[1:]).strip() or "Antenna"
                base["saved"] = write_s1p(label, freqs, pts, base["board"], base["version"])
                base["label"] = label
                b = base["metrics"]["meshtastic"]["swr"] if base["metrics"] and "meshtastic" in base["metrics"] else None
                msg(sh, f"Saved {label}" + (f": SWR {b:.2f} at 907" if b else ""), "Saved")
            out(base)
        if verb == "markers":
            mode = args[1] if len(args) > 1 else "mesh"
            freqs, pts = read_s11(sh)
            r = set_markers(sh, freqs, pts, "best" if mode == "best" else "mesh")
            sweep_payload(base, freqs, pts)
            base["markers"] = device_markers(sh, freqs, pts)
            publish(base, session)
            out({**base, **r})
        if verb == "qc":
            rules = qc_rules(rules_json if rules_json is not None else qc_json)
            freqs, pts = read_s11(sh)
            if len(args) > 1 and args[1] == "save":
                out({**base, **qc_save(sh, base, freqs, pts, " ".join(args[2:]), rules)})
            sweep_payload(base, freqs, pts)
            base["qc"] = qc_eval(freqs, pts, rules) if freqs else None
            out(base)
        if verb == "cal":
            out({**base, **calibrate(sh, args[1] if len(args) > 1 else "begin", None, base["slots"])})
        if verb == "band":
            n = base["slots"]
            if len(args) > 2 and args[1] == "cal":
                b, _, _ = find_band(args[2], n)
                if not b or b["id"] == "mesh":
                    out({**base, "ok": False, "say": "Calibrate the mesh band with `cal` (it is the one that saves slot 0)." if b else f"No band {args[2]}."})
                r = calibrate(sh, args[3] if len(args) > 3 else "begin", b, n)
                out({**base, **r, **info(sh, port)})
            b, _, _ = find_band(args[1] if len(args) > 1 else "mesh", n)
            if not b:
                out({**base, "ok": False, "say": f"No band {args[1]}."})
            r = band_switch(sh, base, b)
            now_ = info(sh, port)
            freqs, pts = read_s11(sh)
            sweep_payload(now_, freqs, pts)
            now_["markers"] = device_markers(sh, freqs, pts)
            publish(now_, session)
            out({**now_, **r})
        if verb == "xtrace":
            r = x_trace(sh, len(args) > 1 and args[1] == "on")
            out({**base, **r})
        if verb == "poweron":
            if len(args) < 2 or args[1] != "save":
                out({**base, "ok": False, "say": "usage: poweron save --confirm"})
            r = poweron_save(sh, base, confirm)
            out({**base, **r, **({"slot": 0} if r.get("ok") else {})})
        if verb == "preset":
            preset(sh)
            out({**info(sh, port), "ok": True})
        if verb == "msg":
            msg(sh, args[1] if len(args) > 1 else "", args[2] if len(args) > 2 else "")
            out({"ok": True})
        if verb == "shot":
            out({**base, "png": shot(sh)})
        out({"error": f"unknown command {verb}"})
    except NotAnswering:
        out(busy_reply("The NanoVNA is on USB but not answering (busy on its own screen, or another program is talking to it)."))
    except Watchdog:
        out(busy_reply(f"The NanoVNA took longer than {total} s: stopped waiting."))
    finally:
        signal.alarm(0)
        if sh:
            sh.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as e:  # noqa: BLE001 - the tab always gets one JSON object, never a traceback alone
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
