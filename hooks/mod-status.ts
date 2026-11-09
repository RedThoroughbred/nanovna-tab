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

// The functions that write the file live in register.tsx: the plugin directory wants a hook's $
// passed only to functions declared in the same file.
