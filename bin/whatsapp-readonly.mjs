#!/usr/bin/env node
/**
 * whatsapp-readonly: read ONE chat at a time from your own local WhatsApp
 * desktop store. Read-only by construction, and it refuses to dump everything.
 *
 *   whatsapp-readonly chats <term>
 *   whatsapp-readonly read <chat> [--limit N] [--since YYYY-MM-DD] [--paths]
 *   whatsapp-readonly search <chat> <term> [--paths]
 *
 * Run with --help for the full text. See README.md for the design.
 */

import { openStore, ToolError, DEFAULT_DB_PATH } from '../src/store.mjs'
import { findChats, resolveChat, readMessages, searchMessages } from '../src/queries.mjs'
import { renderChats, renderMessages, localMidnightToApple } from '../src/render.mjs'

const VERSION = '0.1.0'
const NAME = 'whatsapp-readonly'

const USAGE = `${NAME} ${VERSION}

Read one WhatsApp chat at a time from your own local desktop store.

Usage:
  ${NAME} chats <term>                 find chats by name or number (names only, no messages)
  ${NAME} read <chat> [options]        print one chat, oldest first
  ${NAME} search <chat> <term>         search inside one chat

<chat> is the numeric id from \`chats\` (digits only, under 8 long), a phone number or
part of a JID, or an exact, case-sensitive chat name.

Options:
  --limit N          read: newest N messages (default 50)
  --since YYYY-MM-DD read: only messages from local midnight of that day
  --paths            read, search: show the local media file path after media lines
  --db <file>        store to read (default: WA_CHATSTORAGE_PATH, else the macOS WhatsApp location)
  --me <label>       name for messages you sent (default: WA_ME_LABEL, else "Me")
  -h, --help         show this text
  -v, --version      show the version

There is no command that dumps or exports the whole store, by design.`

class UsageError extends ToolError {}

// Which options each command accepts, and whether the option takes a value.
const OPTIONS = {
  '--limit': { value: true, commands: ['read'] },
  '--since': { value: true, commands: ['read'] },
  '--paths': { value: false, commands: ['read', 'search'] },
  '--db': { value: true, commands: ['chats', 'read', 'search'] },
  '--me': { value: true, commands: ['read', 'search'] },
}

function parseArgs(argv) {
  const positionals = []
  const opts = {}
  let help = false
  let version = false
  let literal = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (literal || !a.startsWith('-') || a === '-') { positionals.push(a); continue }
    if (a === '--') { literal = true; continue }
    if (a === '-h' || a === '--help') { help = true; continue }
    if (a === '-v' || a === '--version') { version = true; continue }
    const spec = OPTIONS[a]
    if (!spec) throw new UsageError(`Unknown option "${a}". Run ${NAME} --help.`)
    if (spec.value) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value.`)
      opts[a] = argv[++i]
    } else {
      opts[a] = true
    }
  }
  return { positionals, opts, help, version }
}

function main(argv) {
  const { positionals, opts, help, version } = parseArgs(argv)
  if (version) { console.log(VERSION); return }
  if (help || positionals[0] === 'help') { console.log(USAGE); return }

  const [cmd, ...args] = positionals
  if (!cmd) throw new UsageError(`No command given.\n\n${USAGE}`)
  if (!['chats', 'read', 'search'].includes(cmd)) {
    throw new UsageError(
      `Unknown command "${cmd}". There is no dump or export command, by design: name one chat per read.\n` +
      `Commands: chats <term> | read <chat> | search <chat> <term>`,
    )
  }
  for (const o of Object.keys(opts)) {
    if (!OPTIONS[o].commands.includes(cmd)) throw new UsageError(`${o} does not apply to "${cmd}".`)
  }

  // Validate everything that can be validated before touching the store.
  let term = null
  let limit = 50
  let sinceZ = null
  if (cmd === 'chats') {
    term = (args[0] ?? '').trim()
    if (!term || args.length !== 1) throw new UsageError('Give one search term: chats "<name>". It lists chat names only, never messages.')
  } else if (cmd === 'read') {
    if (args.length !== 1 || !args[0].trim()) throw new UsageError('Name one chat: read <id|number|name> [--limit N] [--since YYYY-MM-DD]')
    if ('--limit' in opts) {
      limit = /^\d+$/.test(opts['--limit']) ? Number(opts['--limit']) : NaN
      if (!Number.isSafeInteger(limit) || limit < 1) throw new UsageError('--limit must be a whole number of 1 or more.')
    }
    if ('--since' in opts) {
      sinceZ = localMidnightToApple(opts['--since'])
      if (sinceZ === null) throw new UsageError('--since must be a real date as YYYY-MM-DD.')
    }
  } else {
    if (args.length !== 2 || !args[0].trim() || !args[1].trim()) throw new UsageError('Scope the search to one chat: search <id|number|name> "<term>"')
    term = args[1]
  }

  const dbPath = opts['--db'] || process.env.WA_CHATSTORAGE_PATH || DEFAULT_DB_PATH
  const me = opts['--me'] || process.env.WA_ME_LABEL || 'Me'
  const show = (lines) => console.log(lines.join('\n'))

  const store = openStore(dbPath)
  try {
    if (cmd === 'chats') {
      const found = findChats(store, term)
      if (!found.rows.length) { console.log(`No chat matching "${term}".`); return }
      show(renderChats(found))
    } else if (cmd === 'read') {
      const chat = resolveChat(store, args[0])
      show(renderMessages(chat, readMessages(store, chat, { limit, sinceZ }), { me, showPaths: !!opts['--paths'] }))
    } else {
      const chat = resolveChat(store, args[0])
      show(renderMessages(chat, searchMessages(store, chat, term), { me, showPaths: !!opts['--paths'] }))
    }
  } finally {
    store.close()
  }
}

try {
  main(process.argv.slice(2))
} catch (e) {
  if (e instanceof ToolError) {
    console.error(`${NAME}: ${e.message}`)
    process.exit(1)
  }
  throw e
}
