// The mod-status file: the line a mod shows under the prompt, also written to
// ~/.claude/mod-status/<mod>.json for the Herdr app's status strip, which shows every mod's line
// once for the whole window instead of under each session's prompt.
//
// The format is exact (Herdr reads it):
//   {"mod": "releases", "text": "WattBench 2.0 Live · …", "level": "ok" | "warn" | "alert", "at": <ms since epoch>}
// text is the status line's summary without the mod-name prefix. The file is written atomically
// (a temp file in the same folder, then mv), rewritten when the line changes and at least every
// 10 minutes while the mod runs (Herdr hides entries older than 30), and deleted when there is
// nothing to say or the line is hidden. Several sessions may write the same file.
//
// Inside Herdr (it sets HC_TERMINAL_ID in every terminal it runs) the status line is never set,
// since the strip shows it; outside Herdr the status line works as before and the file is written too.
//
// The same short copy lives in releases, security, docker-tab and vna: each mod installs on its own,
// so this module's state is the one mod's.

export type Level = 'ok' | 'warn' | 'alert'
export type ModLine = { text: string; level: Level }

// The keep-fresh tick: call keepModStatusFresh this often. A rewrite is due after REWRITE_MS, so
// the file is never more than 10 minutes old while the mod runs.
export const KEEP_FRESH_MS = 60_000
const REWRITE_MS = 9 * 60_000
// A change of text alone (a reading that moves each sweep) is written at most this often; a change
// of level, or the line appearing, is written at once. The minute tick writes whatever is left.
const MIN_GAP_MS = 15_000

let mod = ''
let herdr: boolean | undefined
let dir: string | null = null
let started: Promise<void> | null = null
// The line to show; undefined when there is nothing to say, null when it isn't known yet (a first
// reading still running), which leaves the file to whatever another session last wrote.
let want: ModLine | undefined | null = null
// What the file holds as far as this session knows: null unknown, '' none, else level|text.
let wrote: string | null = null
let wroteLevel: Level | null = null
let wroteAt = 0
let chain: Promise<void> = Promise.resolve()

// Reads HC_TERMINAL_ID and HOME once. Await it at session.start, so the first post sets the status
// line at once.
export function startModStatus($: any, name: string): Promise<void> {
  mod = name
  started ??= (async () => {
    try {
      herdr = Boolean(await $.env.get('HC_TERMINAL_ID'))
    } catch {
      herdr = false
    }
    try {
      const home = await $.env.get('HOME')
      if (home) dir = `${home}/.claude/mod-status`
    } catch {}
  })()
  return started
}

// Whether this session runs inside Herdr (false until startModStatus has read it).
export function inHerdr(): boolean {
  return herdr === true
}

async function sync($: any): Promise<void> {
  if (!dir || !mod || want === null) return
  const file = `${dir}/${mod}.json`
  if (!want) {
    if (wrote !== '') {
      await $.process.run(['/bin/rm', '-f', file], { timeoutMs: 5_000 })
      wrote = ''
      wroteLevel = null
    }
    return
  }
  const key = `${want.level}|${want.text}`
  const now = await $.clock.now()
  if (key === wrote && now - wroteAt < REWRITE_MS) return
  if (wrote && key !== wrote && want.level === wroteLevel && now - wroteAt < MIN_GAP_MS) return
  const tmp = `${dir}/.${mod}.${Math.random().toString(36).slice(2, 10)}.tmp`
  await $.fs.write(tmp, `${JSON.stringify({ mod, text: want.text, level: want.level, at: now })}\n`)
  const r = await $.process.run(['/bin/mv', '-f', tmp, file], { timeoutMs: 5_000 })
  if (r.exitCode !== 0) {
    await $.process.run(['/bin/rm', '-f', tmp], { timeoutMs: 5_000 })
    return
  }
  wrote = key
  wroteLevel = want.level
  wroteAt = now
}

// Shows the line: statusText on the status line (outside Herdr only), line in the file. undefined
// clears each; a null line leaves the file alone (nothing known yet).
export function postModStatus($: any, statusText: string | undefined, line: ModLine | undefined | null): Promise<void> {
  want = line
  const known = herdr !== undefined
  if (known && !herdr) $.ui.status(statusText)
  chain = chain
    .then(async () => {
      if (started) await started
      if (!known && !herdr) $.ui.status(statusText)
      await sync($)
    })
    .catch(() => {})
  return chain
}

// Rewrites the file when it is due; call it every KEEP_FRESH_MS.
export function keepModStatusFresh($: any): Promise<void> {
  chain = chain.then(() => sync($)).catch(() => {})
  return chain
}
