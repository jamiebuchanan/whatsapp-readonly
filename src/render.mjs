/**
 * render.mjs: turns rows into plain text. No filesystem, no sqlite, no state.
 *
 * Silent omission is the failure mode this tool must never have: a message that
 * quietly vanishes changes the meaning of a conversation and leaves nothing to
 * notice. So media is rendered as typed placeholders, anything unrecognised
 * prints "[unhandled type N]", and the only rows hidden are known system rows,
 * which are counted in the header.
 */

const APPLE_EPOCH = 978307200 // seconds between 1970-01-01 and 2001-01-01

// Everything read from the store is text that somebody else chose: a message, a
// sender's display name, a group name, a media title. Printed raw, an escape
// sequence can rewrite or blank the reader's terminal, a carriage return can
// overwrite what was just printed, and a line break can forge a complete
// "[date] Me: ..." line that no one sent. So control characters (and the Unicode
// line separators and bidirectional overrides, which reorder or split text) are
// printed as visible \xNN / \uNNNN escapes. Nothing is dropped, only made visible.
// Tab and newline survive here and are handled by oneLine() and block() below.
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const visible = (c) => {
  const n = c.codePointAt(0)
  return n <= 0xff ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`
}
const neutralise = (v) => String(v).replace(/\r\n/g, '\n').replace(UNSAFE, visible)

/** A value for a single-line field (a name, a number, a path): no line breaks or tabs survive. */
export const oneLine = (v) => neutralise(v).replace(/\n/g, '\\n').replace(/\t/g, '\\t')

/** Message text. A line break stays, but the next line is indented so it can never pass for a new message. */
const block = (v) => neutralise(v).replace(/\n/g, '\n    ')

export const appleToUnix = (z) => z + APPLE_EPOCH

/** Seconds since 2001-01-01 to local midnight of a YYYY-MM-DD date, or null if invalid. */
export function localMidnightToApple(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return Math.floor(date.getTime() / 1000) - APPLE_EPOCH
}

// Local time, not UTC: these get compared against what the phone shows, and a
// silent one-hour shift in summer makes every timestamp in the output wrong.
export function formatDate(z) {
  const d = new Date(appleToUnix(z) * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * ZMESSAGETYPE to a human label. Derived by inspecting a store rather than copied
 * from elsewhere: each was confirmed against the file extension on the joined
 * ZWAMEDIAITEM (1 to .jpg, 2 and 11 to .mp4, 3 to .opus, 15 to .webp, 8 to
 * .pdf/.docx) or against the populated column (4 to ZVCARDNAME, 5 to ZLATITUDE).
 * Type 7 is a link preview and always carries its own text, so it never reaches
 * this map.
 */
const MEDIA_TYPES = {
  1: 'image', 2: 'video', 3: 'voice note', 4: 'contact card',
  5: 'location', 8: 'document', 11: 'GIF', 15: 'sticker',
}

/**
 * Internal rows that are not messages anybody sent: group/system events, E2E
 * notices, and the album container WhatsApp writes immediately before a batch of
 * photos. Rendering these would be noise, so they stay hidden when they carry no
 * text. Everything NOT in this set is shown.
 */
const SYSTEM_TYPES = new Set([6, 10, 12, 13, 14, 66])

export function describeMedia(m) {
  const t = m.ZMESSAGETYPE
  const label = MEDIA_TYPES[t]
  if (!label) return `[unhandled type ${oneLine(t)}]`
  // Read each column ONLY for the type that actually means it. ZWAMEDIAITEM
  // reuses its columns: on an image, ZLATITUDE/ZLONGITUDE hold the pixel width
  // and height and ZTITLE holds a base64 media key. Printing them
  // opportunistically produces nonsense like `[image <hash>, 2048, 1536]`.
  const bits = []
  if ((t === 2 || t === 3 || t === 11) && m.ZMOVIEDURATION > 0) {
    const s = Math.round(m.ZMOVIEDURATION)
    bits.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)
  }
  if (t === 4 && m.ZVCARDNAME) bits.push(m.ZVCARDNAME)
  if (t === 8 && m.ZTITLE) bits.push(m.ZTITLE)
  if (t === 5) bits.push(`${m.ZLATITUDE}, ${m.ZLONGITUDE}`)
  // A missing local path means the file was never downloaded or has been evicted
  // from the cache. The message still happened, so say so rather than hiding it.
  if (t !== 5 && !m.ZMEDIALOCALPATH) bits.push('not downloaded')
  return `[${label}${bits.length ? ' ' + bits.map(oneLine).join(', ') : ''}]`
}

/**
 * Render one chat's messages as text lines: a two-line header, a blank line,
 * then `[date] Speaker: message`, oldest first.
 *
 * `me` labels messages you sent. In group chats the speaker is the sender's push
 * name; in 1:1 chats that column holds an opaque id, so the partner name is used.
 */
export function renderMessages(chat, rows, { me = 'Me', showPaths = false } = {}) {
  const who = oneLine(chat.ZPARTNERNAME || chat.ZCONTACTJID)
  const isGroup = String(chat.ZCONTACTJID || '').includes('@g.us')
  let hidden = 0
  const lines = []
  for (const m of rows) {
    if (!m.ZTEXT && SYSTEM_TYPES.has(m.ZMESSAGETYPE)) { hidden++; continue }
    const speaker = m.ZISFROMME ? oneLine(me) : (isGroup && m.ZPUSHNAME ? oneLine(m.ZPUSHNAME) : who)
    // Media can carry a caption. Show both when it does.
    const body = m.ZMESSAGETYPE && m.ZMESSAGETYPE !== 7
      ? [describeMedia(m), m.ZTEXT && block(m.ZTEXT)].filter(Boolean).join(' ')
      : (m.ZTEXT ? block(m.ZTEXT) : '[no text]')
    const path = showPaths && m.ZMEDIALOCALPATH ? `  <${oneLine(m.ZMEDIALOCALPATH)}>` : ''
    lines.push(`[${formatDate(m.ZMESSAGEDATE)}] ${speaker}: ${body}${path}`)
  }
  return [
    `# ${who}  (chat ${chat.Z_PK}, ${oneLine(chat.ZCONTACTJID)})`,
    `# ${lines.length} message(s), oldest first${hidden ? `, ${hidden} system row(s) hidden` : ''}`,
    '',
    ...lines,
  ]
}

/** Render a `chats` result as tab-separated lines with a header row. */
export function renderChats({ rows, more }) {
  const lines = ['id\tlast activity\tname\tjid']
  for (const r of rows) {
    lines.push(`${r.Z_PK}\t${r.ZLASTMESSAGEDATE ? formatDate(r.ZLASTMESSAGEDATE) : '-'}\t${oneLine(r.ZPARTNERNAME || '-')}\t${oneLine(r.ZCONTACTJID || '-')}`)
  }
  if (more) lines.push(`# more chats match than are shown (${rows.length}); narrow the search`)
  return lines
}
