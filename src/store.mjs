/**
 * store.mjs: the ONLY module that touches the filesystem or runs sqlite3.
 *
 * Everything else in this project is pure text handling, so this file is the
 * whole safety surface. Read it first if you want to audit the tool.
 *
 * How the store is kept read-only, in layers:
 *
 *   1. The live database is never opened. Its file, its -wal and its -shm are
 *      copied into a private temp directory (mode 0700) and every query runs
 *      against that copy. Nothing can be written back to the original, and the
 *      copy is deleted on exit, on error and on Ctrl-C.
 *   2. sqlite3 is started with -readonly and -safe on the copy. -safe also turns
 *      off the shell's file and process features (.shell, .import, writefile()).
 *   3. Every statement must pass assertReadOnlySql(): a single SELECT, no write
 *      verbs, no dot-commands, no file functions.
 *   4. Nothing the user types is ever spliced into SQL as text. Strings travel as
 *      hex-encoded blobs and numbers must be safe integers, so there is no
 *      quoting to get wrong and nothing to inject.
 *   5. No network access, no writes outside the temp copy. A test greps this
 *      file to keep it that way.
 *
 * Why a snapshot rather than opening the file with immutable=1: WhatsApp keeps
 * recent messages in the write-ahead log until it checkpoints, and immutable=1
 * tells SQLite to ignore the WAL entirely. That silently omits everything since
 * the last checkpoint, which can be hours of the most relevant messages.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Where the native macOS WhatsApp desktop app keeps its store. */
export const DEFAULT_DB_PATH = join(
  homedir(), 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite',
)

/** An error with a message that is safe and useful to show the user as is. */
export class ToolError extends Error {
  constructor(message) { super(message); this.name = 'ToolError' }
}

// The tables and columns the tool reads. WhatsApp's schema is not documented
// and can change, so these are checked up front for a clear error.
const REQUIRED_SCHEMA = {
  ZWACHATSESSION: ['Z_PK', 'ZPARTNERNAME', 'ZCONTACTJID', 'ZLASTMESSAGEDATE'],
  ZWAMESSAGE: ['Z_PK', 'ZCHATSESSION', 'ZTEXT', 'ZISFROMME', 'ZMESSAGEDATE', 'ZPUSHNAME', 'ZMESSAGETYPE'],
  ZWAMEDIAITEM: ['ZMESSAGE', 'ZMEDIALOCALPATH', 'ZMOVIEDURATION', 'ZTITLE', 'ZVCARDNAME', 'ZLATITUDE', 'ZLONGITUDE'],
}

const FORBIDDEN_WORDS = new RegExp(
  '\\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|' +
  'SAVEPOINT|BEGIN|COMMIT|ROLLBACK|WRITEFILE|READFILE|LOAD_EXTENSION|EDIT)\\b', 'i',
)

/** Throw unless sql is one plain SELECT. Belt and braces: the queries are fixed. */
export function assertReadOnlySql(sql) {
  const s = String(sql).trim()
  if (!/^SELECT\b/i.test(s)) throw new ToolError('Refused: only SELECT statements are allowed.')
  if (s.includes(';')) throw new ToolError('Refused: one statement at a time.')
  if (/--|\/\*/.test(s)) throw new ToolError('Refused: comments are not allowed in queries.')
  if (/^\s*\./m.test(s)) throw new ToolError('Refused: shell dot-commands are not allowed.')
  if (FORBIDDEN_WORDS.test(s)) throw new ToolError('Refused: this query contains a write or file operation.')
}

/** A string as a SQL expression that cannot be anything but that string. */
export const text = (v) => `CAST(X'${Buffer.from(String(v), 'utf8').toString('hex')}' AS TEXT)`

/** A number as SQL. Anything that is not a safe integer is refused. */
export function int(v) {
  if (!Number.isSafeInteger(v)) throw new ToolError(`Refused: ${JSON.stringify(v)} is not an integer.`)
  return String(v)
}

/** A LIKE pattern matching `term` as a literal substring. % and _ are escaped. */
export const likeContains = (term) => text('%' + String(term).replace(/[\\%_]/g, '\\$&') + '%')

/** How sqlite3 is started. Exported so the tests can prove these flags alone stop a write. */
export const SQLITE_FLAGS = ['-init', '/dev/null', '-readonly', '-safe', '-bail', '-batch', '-json']

const TCC_HINT = 'macOS is blocking read access to the WhatsApp store.\n' +
  '  Grant Full Disk Access to your terminal app (System Settings, Privacy & Security,\n' +
  '  Full Disk Access), restart the terminal, then retry.'

/**
 * Snapshot the store at dbPath and return { query, close }. Always call close()
 * (the CLI does, in a finally block). Cleanup also runs on exit and on signals.
 */
export function openStore(dbPath) {
  if (!existsSync(dbPath)) {
    throw new ToolError(
      `WhatsApp store not found at:\n  ${dbPath}\n` +
      'Is WhatsApp Desktop installed and signed in? To read another copy, pass --db <file> or set WA_CHATSTORAGE_PATH.',
    )
  }

  const dir = mkdtempSync(join(tmpdir(), 'wa-readonly-')) // mode 0700
  const snap = join(dir, 'ChatStorage.sqlite')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  process.once('exit', close)
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(sig, () => process.exit(code)) // 'exit' then runs close()
  }

  // The main file goes first so the -wal we copy is never older than the db it
  // replays onto. WhatsApp may be mid-write; SQLite recovers the copy on open.
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      if (!existsSync(dbPath + suffix)) continue
      copyFileSync(dbPath + suffix, snap + suffix)
      chmodSync(snap + suffix, 0o600) // private, and writable so SQLite can open the WAL index
    }
  } catch (e) {
    close()
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw new ToolError(TCC_HINT)
    throw new ToolError(`Could not copy the store: ${e && e.message}`)
  }

  const query = (sql) => {
    assertReadOnlySql(sql)
    try {
      const out = execFileSync(
        'sqlite3', [...SQLITE_FLAGS, snap],
        { input: `${sql};\n`, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim()
      return out ? JSON.parse(out) : []
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new ToolError('sqlite3 was not found on PATH. macOS ships one at /usr/bin/sqlite3.')
      const msg = String((e && e.stderr) || (e && e.message) || e)
      if (/authorization denied|operation not permitted/i.test(msg)) throw new ToolError(TCC_HINT)
      if (/not a database|malformed/i.test(msg)) throw new ToolError(`${dbPath} is not a readable SQLite database.`)
      if (/unknown option/i.test(msg)) throw new ToolError('This sqlite3 is too old: it needs the -readonly, -safe and -json options. Install a newer one (for example: brew install sqlite).')
      throw new ToolError(`sqlite3 failed: ${msg.trim()}`)
    }
  }

  try {
    const names = Object.keys(REQUIRED_SCHEMA).map((n) => `'${n}'`).join(', ')
    const have = {}
    for (const r of query(
      `SELECT m.name AS tbl, p.name AS col FROM sqlite_master AS m, pragma_table_info(m.name) AS p ` +
      `WHERE m.type = 'table' AND m.name IN (${names})`,
    )) (have[r.tbl] ||= new Set()).add(r.col)
    const missing = []
    for (const [tbl, cols] of Object.entries(REQUIRED_SCHEMA)) {
      for (const c of cols) if (!have[tbl] || !have[tbl].has(c)) missing.push(`${tbl}.${c}`)
    }
    if (missing.length) {
      throw new ToolError(
        `${dbPath} does not look like a WhatsApp desktop store this tool understands.\n` +
        `  Missing: ${missing.join(', ')}\n` +
        '  WhatsApp\'s schema is undocumented and can change between versions.',
      )
    }
  } catch (e) {
    close()
    throw e
  }

  return { query, close }
}
