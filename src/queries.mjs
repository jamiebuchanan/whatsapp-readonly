/**
 * queries.mjs: the fixed set of questions this tool can ask the store.
 *
 * There is deliberately no function here that returns messages for more than one
 * chat. Every message query is bound to exactly one chat id, and that id has to
 * come from resolveChat(), which refuses anything ambiguous. If you are looking
 * for a way to read everything, it is not here, on purpose.
 */

import { ToolError, int, text, likeContains } from './store.mjs'
import { oneLine } from './render.mjs'

/** How many chats `chats` lists at most. It lists names only, never messages. */
export const CHAT_LIST_LIMIT = 25
/** How many matches `search` returns at most (newest first, shown oldest first). */
export const SEARCH_LIMIT = 50
/** How many candidates an ambiguous chat reference lists before it says there are more. */
export const AMBIGUOUS_SHOWN = 5

// Every message query needs the type and the joined media columns, so the column
// list lives in one place rather than being repeated.
const MSG_COLS = `m.ZTEXT, m.ZISFROMME, m.ZMESSAGEDATE, m.ZPUSHNAME, m.ZMESSAGETYPE,
   mi.ZMEDIALOCALPATH, mi.ZMOVIEDURATION, mi.ZTITLE, mi.ZVCARDNAME, mi.ZLATITUDE, mi.ZLONGITUDE`
const MSG_FROM = 'ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK'

/**
 * Chats whose name or JID contains `term`. Names and ids only. Returns up to
 * CHAT_LIST_LIMIT rows plus `more: true` when there were further matches.
 */
export function findChats(store, term) {
  const pattern = likeContains(term)
  const rows = store.query(
    `SELECT Z_PK, ZPARTNERNAME, ZCONTACTJID, ZLASTMESSAGEDATE FROM ZWACHATSESSION
     WHERE ZPARTNERNAME LIKE ${pattern} ESCAPE '\\' OR ZCONTACTJID LIKE ${pattern} ESCAPE '\\'
     ORDER BY ZLASTMESSAGEDATE DESC, Z_PK ASC LIMIT ${CHAT_LIST_LIMIT + 1}`,
  )
  return { rows: rows.slice(0, CHAT_LIST_LIMIT), more: rows.length > CHAT_LIST_LIMIT }
}

/**
 * Turn a user-supplied reference into exactly one chat row, or throw.
 *   - digits only and under 8 long: the numeric chat id from `chats`
 *   - anything else: a phone number or JID fragment, or an exact chat name
 * More than one match is an error that lists the candidates (id, name, JID) so
 * the caller can pick by id. A mistyped id never falls through to a fuzzy match.
 */
export function resolveChat(store, ref) {
  const r = String(ref ?? '').trim()
  if (!r) throw new ToolError('Name a chat: an id from `chats`, a phone number, or an exact chat name.')

  if (/^\d+$/.test(r) && r.length < 8) {
    const byId = store.query(
      `SELECT Z_PK, ZPARTNERNAME, ZCONTACTJID FROM ZWACHATSESSION WHERE Z_PK = ${int(Number(r))}`,
    )
    if (!byId.length) throw new ToolError(`No chat with id ${r}. Find one with: chats "<name>"`)
    return byId[0]
  }

  const rows = store.query(
    `SELECT Z_PK, ZPARTNERNAME, ZCONTACTJID FROM ZWACHATSESSION
     WHERE ZCONTACTJID LIKE ${likeContains(r)} ESCAPE '\\' OR ZPARTNERNAME = ${text(r)}
     ORDER BY Z_PK ASC LIMIT ${AMBIGUOUS_SHOWN + 1}`,
  )
  if (!rows.length) throw new ToolError(`No chat matches "${r}". Try: chats "<name>"`)
  if (rows.length > 1) {
    // Names come from the store and are chosen by other people, so they are neutralised.
    const list = rows.slice(0, AMBIGUOUS_SHOWN)
      .map((c) => `  ${c.Z_PK}\t${oneLine(c.ZPARTNERNAME ?? '-')}\t${oneLine(c.ZCONTACTJID ?? '-')}`).join('\n')
    const more = rows.length > AMBIGUOUS_SHOWN ? `\n  ... and more; use a longer fragment, or pick one by id from: chats "<name>"` : ''
    throw new ToolError(`"${r}" is ambiguous. Pick one by id:\n${list}${more}`)
  }
  return rows[0]
}

/** The newest `limit` messages in one chat, optionally from `sinceZ` (Apple seconds), oldest first. */
export function readMessages(store, chat, { limit, sinceZ = null }) {
  const where = [`m.ZCHATSESSION = ${int(chat.Z_PK)}`]
  if (sinceZ !== null) where.push(`m.ZMESSAGEDATE >= ${int(sinceZ)}`)
  const rows = store.query(
    `SELECT ${MSG_COLS} FROM ${MSG_FROM} WHERE ${where.join(' AND ')}
     ORDER BY m.ZMESSAGEDATE DESC, m.Z_PK DESC LIMIT ${int(limit)}`,
  )
  return rows.reverse()
}

/** Messages in one chat whose text contains `term`, newest SEARCH_LIMIT, oldest first. */
export function searchMessages(store, chat, term) {
  const rows = store.query(
    `SELECT ${MSG_COLS} FROM ${MSG_FROM}
     WHERE m.ZCHATSESSION = ${int(chat.Z_PK)} AND m.ZTEXT LIKE ${likeContains(term)} ESCAPE '\\'
     ORDER BY m.ZMESSAGEDATE DESC, m.Z_PK DESC LIMIT ${SEARCH_LIMIT}`,
  )
  return rows.reverse()
}
