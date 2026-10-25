#!/usr/bin/env node
// test/run.mjs: tests for whatsapp-readonly. Run with `npm test` or `node test/run.mjs`.
//
// Needs node and the sqlite3 command line tool. Uses ONLY the synthetic store built
// from test/fixture.sql. Every run gets its own HOME and TMPDIR, so the tool can
// never fall back to a real WhatsApp store on the machine running the tests, and
// leftover snapshot copies can be detected.
//
// UPDATE_GOLDEN=1 node test/run.mjs   rewrites test/golden/* from current output.

import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'bin', 'whatsapp-readonly.mjs')
const goldenDir = join(root, 'test', 'golden')
const update = process.env.UPDATE_GOLDEN === '1'

const work = mkdtempSync(join(tmpdir(), 'wa-readonly-test-'))
const home = join(work, 'home')
const tmp = join(work, 'tmp')
mkdirSync(home); mkdirSync(tmp)

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}${detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`) }
}

// --- fixture ---------------------------------------------------------------

const db = join(work, 'fixture.db')
const built = spawnSync('sqlite3', [db], { input: readFileSync(join(root, 'test', 'fixture.sql'), 'utf8'), encoding: 'utf8' })
if (built.status !== 0) {
  console.error(`Could not build the fixture with sqlite3: ${built.stderr || built.error}`)
  process.exit(2)
}

const baseEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, TZ: 'UTC', LANG: 'C' }

function run(args, { env = {} } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...baseEnv, ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const withDb = (...args) => run(['--db', db, ...args])

// Words that exist only in the invented messages. If any of these show up where
// they should not, a chat boundary leaked.
const OTHER_BOB = 'tulip order|paid'
const OTHER_CLUB = 'car park|patterned flask|route confirmed|you all there'
const ALL_MARKERS = ['allotment', 'tulip', 'car park', 'paid', 'wrong number', 'shed', 'spade']
const leaks = (text) => ALL_MARKERS.filter((m) => text.includes(m))

const sha = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null)
const liveState = (p) => ['', '-wal', '-shm'].map((s) => `${sha(p + s)}:${existsSync(p + s) ? statSync(p + s).mtimeMs : 0}`).join('|')

function golden(name, actual) {
  const file = join(goldenDir, name)
  if (update) { mkdirSync(goldenDir, { recursive: true }); writeFileSync(file, actual) }
  return readFileSync(file, 'utf8')
}

// --- 1. the dump refusal and the single-chat rule ----------------------------

console.log('== refuses to dump')
const refusals = [
  ['no command', []],
  ['dump', ['dump']],
  ['export', ['export']],
  ['all', ['all']],
  ['list', ['list']],
  ['sql', ['sql', 'SELECT * FROM ZWAMESSAGE']],
  ['read with no chat', ['read']],
  ['read --all', ['read', '--all']],
  ['read with only a limit', ['read', '--limit', '5']],
  ['read with two chats', ['read', '1', '2']],
  ['read with a blank chat', ['read', '   ']],
  ['search with no chat', ['search']],
  ['search with a chat but no term', ['search', '1']],
  ['search with a blank term', ['search', '1', '   ']],
  ['search with three arguments', ['search', '1', 'tulip', 'extra']],
  ['chats with no term', ['chats']],
  ['chats with an empty term', ['chats', '']],
  ['chats with a blank term', ['chats', '   ']],
  ['chats with two terms', ['chats', 'alice', 'bob']],
  ['--json option does not exist', ['--json', 'read', '1']],
  ['--all on chats', ['chats', 'alice', '--all']],
]
for (const [name, args] of refusals) {
  const r = withDb(...args)
  check(`refused: ${name}`, r.code === 1 && r.out === '' && leaks(r.out + r.err).length === 0,
    `exit ${r.code}\nstdout: ${r.out}\nstderr: ${r.err}`)
}
{
  const r = withDb('dump')
  check('the refusal explains itself', /no dump or export command, by design/.test(r.err), r.err)
}

console.log('== a chat reference must match exactly one chat')
{
  const r = withDb('read', '44770090')
  check('an ambiguous number is refused', r.code === 1 && r.out === '' && /ambiguous/.test(r.err), r.err)
  check('the ambiguity message lists candidates, never messages', /\n  1\tAlice Example\t/.test(r.err) && leaks(r.err).length === 0, r.err)
  const wild = withDb('read', '%')
  check('% is a literal, not a wildcard', wild.code === 1 && wild.out === '' && /No chat matches/.test(wild.err), wild.err)
  const under = withDb('read', '_')
  check('_ is a literal, not a wildcard', under.code === 1 && under.out === '', under.err)
  const miss = withDb('read', '99')
  check('a mistyped id does not fall through to a fuzzy match', miss.code === 1 && /No chat with id 99/.test(miss.err) && !/Alice|Bob|Hiking/.test(miss.err), miss.err)
  const none = withDb('read', 'nobody-by-this-name')
  check('an unknown name matches nothing', none.code === 1 && /No chat matches/.test(none.err), none.err)
  const partial = withDb('read', 'Alice')
  check('a partial name is not enough for read', partial.code === 1 && /No chat matches/.test(partial.err), partial.err)
}

console.log('== every read stays inside the named chat')
{
  const chat1 = withDb('read', '1').out
  const chat2 = withDb('read', '2').out
  const chat3 = withDb('read', '3').out
  const chat5 = withDb('read', '5').out
  check('chat 1 shows its own messages', chat1.includes('tulip bulbs') && chat1.includes('allotment'))
  check('chat 1 shows nothing from chats 2, 3 or 5', !new RegExp(`${OTHER_BOB}|${OTHER_CLUB}|wrong number`).test(chat1))
  check('chat 2 shows nothing from other chats', chat2.includes('tulip order') && !new RegExp(`allotment|${OTHER_CLUB}|wrong number|tulip bulbs`).test(chat2))
  check('chat 3 shows nothing from other chats', chat3.includes('car park') && !new RegExp(`allotment|${OTHER_BOB}|wrong number|tulip bulbs`).test(chat3))
  check('chat 5 shows nothing from other chats', chat5.includes('wrong number') && !new RegExp(`allotment|${OTHER_BOB}|${OTHER_CLUB}`).test(chat5))
  const s1 = withDb('search', '1', 'tulip').out
  check('search is scoped: the word is in three chats, chat 1 returns only its own', s1.includes('tulip bulbs') && !new RegExp(`${OTHER_BOB}|${OTHER_CLUB}`).test(s1), s1)
  const s2 = withDb('search', '2', 'tulip').out
  check('search in chat 2 returns only chat 2', s2.includes('tulip order') && !new RegExp(`allotment|tulip bulbs|${OTHER_CLUB}`).test(s2), s2)
  const s3 = withDb('search', '3', 'tulip').out
  check('search in chat 3 returns only chat 3', s3.includes('patterned flask') && !new RegExp(`allotment|tulip bulbs|${OTHER_BOB}`).test(s3), s3)
  const chats = withDb('chats', 'e')
  check('chats lists names and ids but never message text', chats.code === 0 && chats.out.includes('Alice Example') && leaks(chats.out).length === 0, chats.out)
  check('chats header is the only structure it adds', chats.out.split('\n')[0] === 'id\tlast activity\tname\tjid', chats.out)
}

console.log('== user input cannot become SQL')
{
  const cases = [
    ['quote and OR 1=1', ['search', '1', "x' OR 1=1 --"]],
    ['double quote and OR 1=1', ['search', '1', 'x" OR 1=1 --']],
    ['subquery pulling another chat', ['search', '1', "' || (SELECT ZTEXT FROM ZWAMESSAGE WHERE Z_PK = 201) || '"]],
    ['bare subquery', ['search', '1', '(SELECT ZTEXT FROM ZWAMESSAGE WHERE Z_PK = 201)']],
    ['statement terminator and DROP', ['search', '1', "x'; DROP TABLE ZWAMESSAGE; --"]],
    ['dot-command on a new line', ['search', '1', 'x\n.shell echo pwned']],
    ['% wildcard', ['search', '1', '%']],
    ['_ wildcard', ['search', '1', '_']],
  ]
  for (const [name, args] of cases) {
    const r = withDb(...args)
    check(`search term cannot inject: ${name}`, r.code === 0 && /# 0 message\(s\)/.test(r.out) && leaks(r.out).length === 0, `${r.out}\n${r.err}`)
  }
  const ref = withDb('read', '(SELECT ZPARTNERNAME FROM ZWACHATSESSION WHERE Z_PK = 2)')
  check('a chat reference cannot be a subquery', ref.code === 1 && ref.out === '' && /No chat matches/.test(ref.err), ref.out + ref.err)
  const ref2 = withDb('read', "Alice Example' OR '1'='1")
  check('a chat reference cannot add an OR', ref2.code === 1 && ref2.out === '', ref2.out + ref2.err)
  const t1 = withDb('chats', "%' OR 1=1 --")
  check('a chats term cannot add an OR', /^No chat matching/.test(t1.out) && leaks(t1.out).length === 0, t1.out)
  const t2 = withDb('chats', '%')
  check('chats % is a literal, so it cannot enumerate', /^No chat matching/.test(t2.out), t2.out)
  for (const bad of ['0', '-1', 'abc', '5;DROP', '1.5', '', '1e3', ' 5']) {
    const r = withDb('read', '1', '--limit', bad)
    check(`--limit ${JSON.stringify(bad)} is refused`, r.code === 1 && r.out === '' && /--limit/.test(r.err), r.err)
  }
  for (const bad of ['2026-13-45', '2026-02-30', '2026-1-1', 'yesterday', '', '2026-01-10T00:00']) {
    const r = withDb('read', '1', '--since', bad)
    check(`--since ${JSON.stringify(bad)} is refused`, r.code === 1 && r.out === '' && /--since/.test(r.err), r.err)
  }
}

console.log('== options')
{
  check('unknown option is refused', withDb('read', '1', '--bogus').code === 1)
  check('--limit does not apply to search', withDb('search', '1', 'x', '--limit', '3').code === 1)
  check('--since does not apply to chats', withDb('chats', 'a', '--since', '2026-01-01').code === 1)
  check('an option missing its value is refused', run(['read', '1', '--db']).code === 1)
  const h = run(['--help'])
  check('--help exits 0 and documents the refusal', h.code === 0 && /no command that dumps or exports/.test(h.out), h.out)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check('--version matches package.json', run(['--version']).out.trim() === pkg.version)
  check('bin VERSION constant matches package.json', new RegExp(`const VERSION = '${pkg.version}'`).test(readFileSync(cli, 'utf8')))
  const lit = withDb('search', '1', '--', '-nothing-')
  check('-- lets a search term start with a dash', lit.code === 0 && /# 0 message/.test(lit.out), lit.err)
}

// --- 2. output --------------------------------------------------------------------

console.log('== output')
{
  const chatsAlice = withDb('chats', 'alice').out
  check('chats output matches golden', chatsAlice === golden('chats-alice.txt', chatsAlice), chatsAlice)
  const read1 = withDb('read', '1').out
  check('read output matches golden', read1 === golden('read-alice.txt', read1), read1)
  const paths = withDb('read', '1', '--paths').out
  check('read --paths output matches golden', paths === golden('read-alice-paths.txt', paths), paths)
  const search = withDb('search', '1', 'tulip').out
  check('search output matches golden', search === golden('search-alice-tulip.txt', search), search)
  const club = withDb('read', '3').out
  check('group chat output matches golden', club === golden('read-club.txt', club), club)

  for (const [label, ref] of [
    ['a phone number', '447700900001'],
    ['a JID fragment of 8+ digits', '00900001'],
    ['a full JID', '447700900001@s.whatsapp.net'],
    ['an exact chat name', 'Alice Example'],
  ]) {
    check(`read resolves ${label}`, withDb('read', ref).out === read1, withDb('read', ref).err)
  }
  check('read resolves a group JID', withDb('read', '120363000000000001@g.us').out === club)

  check('media is never silent: image with caption', read1.includes('[image] Look at the state of the shed'))
  check('media is never silent: image never downloaded', read1.includes('[image not downloaded]'))
  check('media is never silent: voice note with duration', read1.includes('[voice note 1:15]'))
  check('media is never silent: video with duration', read1.includes('[video 0:08]'))
  check('media is never silent: GIF, sticker, location, contact, document', ['[GIF 0:03]', '[sticker]', '[location 52.2053, 0.1218]', '[contact card Pat Placeholder]', '[document allotment-rota.pdf]'].every((s) => read1.includes(s)))
  check('a link preview shows its own text', read1.includes('Me: https://example.com/seed-swap'))
  check('an unknown type is shown, not dropped', read1.includes('[unhandled type 99]'))
  check('an empty text row is shown, not dropped', read1.includes('[no text]'))
  check('system rows are hidden and counted', read1.includes('15 message(s), oldest first, 2 system row(s) hidden'), read1.split('\n')[1])
  check('reused media columns are not printed (pixel size, media key)', !/2048|1536|c29tZW/.test(read1))
  check('local media paths are hidden unless --paths', !read1.includes('Media/fixture') && paths.includes('<Media/fixture/shed.jpg>'))
  check('messages are oldest first', read1.indexOf('Morning!') < read1.indexOf('tulip bulbs'))

  check('1:1 speaker is the partner name, not the opaque push id', !read1.includes('A1B2C3D4') && read1.includes('] Alice Example: '))
  check('group speaker is the sender display name', club.includes('] Dee Demo: ') && club.includes('] Eli Example: '))
  check('a chat with no name uses the number as the speaker', withDb('read', '5').out.includes('] 447700900099@s.whatsapp.net: Sorry, wrong number.'))
  check('my label defaults to Me', read1.includes('] Me: Yes.'))
  check('--me sets my label', withDb('read', '1', '--me', 'Test User').out.includes('] Test User: Yes.'))
  check('WA_ME_LABEL sets my label', run(['--db', db, 'read', '1'], { env: { WA_ME_LABEL: 'Env User' } }).out.includes('] Env User: Yes.'))
  check('--me beats WA_ME_LABEL', run(['--db', db, 'read', '1', '--me', 'Flag User'], { env: { WA_ME_LABEL: 'Env User' } }).out.includes('] Flag User: Yes.'))

  const last3 = withDb('read', '1', '--limit', '3').out
  check('--limit keeps the newest N, oldest first', /# 3 message\(s\)/.test(last3) && last3.includes('tulip bulbs') && !last3.includes('Morning!') && last3.indexOf('[unhandled type 99]') < last3.indexOf('tulip bulbs'), last3)
  const since = withDb('read', '1', '--since', '2026-01-11').out
  check('--since filters by day', /# 1 message\(s\)/.test(since) && since.includes('tulip bulbs'), since)
  check('--since on the first day keeps everything', /# 15 message\(s\)/.test(withDb('read', '1', '--since', '2026-01-10').out))
  check('a chat with no messages prints an empty header', /# 0 message\(s\)/.test(withDb('read', '4').out))
  check('search with no hits prints an empty header', /# 0 message\(s\)/.test(withDb('search', '1', 'zebra').out))
  check('search is case-insensitive for ASCII', /# 1 message\(s\)/.test(withDb('search', '1', 'TULIP').out))

  const lon = run(['--db', db, 'read', '3'], { env: { TZ: 'Europe/London' } }).out
  check('timestamps are local time (13:00 in London in July, not 12:00 UTC)', lon.includes('[2026-07-01 13:00]') && club.includes('[2026-07-01 12:00]'), lon)
  check('--since is local midnight', /# 1 message\(s\)/.test(run(['--db', db, 'read', '3', '--since', '2026-07-01'], { env: { TZ: 'Europe/London' } }).out))

  const filler = join(work, 'filler.db')
  copyFileSync(db, filler)
  const ins = Array.from({ length: 30 }, (_, i) => `INSERT INTO ZWACHATSESSION VALUES (${100 + i}, 'Filler ${String(i).padStart(2, '0')}', '4477009100${String(i).padStart(2, '0')}@s.whatsapp.net', ${1000 + i});`).join('\n')
  spawnSync('sqlite3', [filler], { input: ins, encoding: 'utf8' })
  const many = run(['--db', filler, 'chats', 'Filler']).out
  const manyRows = many.split('\n').filter((l) => l.includes('Filler'))
  check('chats shows at most 25 and says when there are more', manyRows.length === 25 && /# more chats match/.test(many), many)
  check('a narrower chats term shows exactly one', run(['--db', filler, 'chats', 'Filler 07']).out.split('\n').filter((l) => l.includes('Filler')).length === 1)
}

// --- 2b. text from the store is untrusted ---------------------------------------------

console.log('== text from the store cannot rewrite the terminal or forge a line')
{
  // Chat 4 gets a name, a sender and messages that try to: clear the screen, set the
  // window title, ring the bell, overwrite the line, split a name across lines, and
  // forge a complete message line from "Me" with a line break.
  const hostile = join(work, 'hostile.db')
  copyFileSync(db, hostile)
  const sql = [
    "UPDATE ZWACHATSESSION SET ZPARTNERNAME = 'Carol' || char(10) || '# forged header' || char(9) || char(27) || '[31m' WHERE Z_PK = 4",
    "UPDATE ZWACHATSESSION SET ZLASTMESSAGEDATE = 800000000 WHERE Z_PK = 4",
    "INSERT INTO ZWAMESSAGE VALUES (401, 4, char(27) || '[2J' || char(27) || ']0;pwned' || char(7) || 'visible' || char(13) || 'overwrite' || char(155) || '31m', 0, 800000000, NULL, 0)",
    "INSERT INTO ZWAMESSAGE VALUES (402, 4, 'first line' || char(10) || '[2026-01-10 09:17] Me: I agree to pay 5000' || char(13) || char(10) || 'crlf line', 0, 800000001, NULL, 0)",
    "INSERT INTO ZWAMESSAGE VALUES (403, 4, 'bidi ' || char(8238) || 'txet' || char(8233) || 'end', 0, 800000002, NULL, 0)",
    "INSERT INTO ZWAMESSAGE VALUES (404, 4, 'caf' || char(233) || ' ' || char(128512) || ' ' || char(8205) || ' ' || char(8207), 0, 800000003, NULL, 0)",
  ].join(';\n')
  const made = spawnSync('sqlite3', [hostile], { input: sql + ';\n', encoding: 'utf8' })
  check('test setup: hostile chat built', made.status === 0, made.stderr)

  const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
  const r = run(['--db', hostile, 'read', '4'])
  const lines = r.out.split('\n')
  check('read exits 0 on a hostile chat', r.code === 0, r.err)
  check('no control character, escape, CR, bell, CSI, line separator or bidi override reaches the output', !CONTROL.test(r.out), JSON.stringify(r.out))
  check('control characters are shown as visible escapes, not dropped', r.out.includes('\\x1b[2J') && r.out.includes('\\x07visible\\x0doverwrite\\x9b31m'), r.out)
  check('a bidi override and a paragraph separator are shown as escapes', r.out.includes('bidi \\u202etxet\\u2029end'), r.out)
  check('ordinary text is untouched: accents, emoji, ZWJ and RLM', r.out.includes(`caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f600)} ${String.fromCodePoint(0x200d)} ${String.fromCodePoint(0x200f)}`), r.out)
  check('a line break in a name cannot add a header line: two header lines, then a blank', lines[2] === '' && lines[0].startsWith('# Carol\\n# forged header\\t\\x1b[31m  (chat 4, '), lines.slice(0, 3).join('|'))
  check('a forged "[date] Me:" line stays inside its message, indented', lines.includes('    [2026-01-10 09:17] Me: I agree to pay 5000') && !lines.some((l) => l.startsWith('[2026-01-10 09:17] Me:')), r.out)
  check('CRLF is read as one line break', lines.includes('    crlf line') && !r.out.includes('\\x0d\\n'), r.out)
  check('every message line starts with [date] and every other line is indented or a header', lines.slice(3).filter((l) => l).every((l) => /^\[\d{4}-\d\d-\d\d \d\d:\d\d\] /.test(l) || l.startsWith('    ')), r.out)
  check('the header counts four messages', lines[1] === '# 4 message(s), oldest first', lines[1])

  const c = run(['--db', hostile, 'chats', 'forged'])
  check('chats prints a hostile name on one line with visible escapes', c.code === 0 && c.out.split('\n').filter((l) => l).length === 2 && !CONTROL.test(c.out) && c.out.includes('Carol\\n# forged header\\t\\x1b[31m'), JSON.stringify(c.out))

  const amb = run(['--db', hostile, 'read', '44770090'])
  check('an ambiguity list prints a hostile name on one line with visible escapes', amb.code === 1 && !CONTROL.test(amb.err.replace(/\n/g, '').replace(/\t/g, '')) && /\n  4\tCarol\\n# forged header/.test(amb.err), JSON.stringify(amb.err))

  const sr = run(['--db', hostile, 'search', '4', 'first line'])
  check('search output is neutralised the same way', sr.code === 0 && !CONTROL.test(sr.out) && sr.out.includes('    [2026-01-10 09:17] Me: I agree to pay 5000'), sr.out)

  // The ambiguity list is capped, and says so rather than looking complete.
  const many = join(work, 'many.db')
  copyFileSync(db, many)
  const rows = Array.from({ length: 8 }, (_, i) => `INSERT INTO ZWACHATSESSION VALUES (${300 + i}, 'Twin ${i}', '4477009777${i}@s.whatsapp.net', NULL);`).join('\n')
  spawnSync('sqlite3', [many], { input: rows, encoding: 'utf8' })
  const capped = run(['--db', many, 'read', '4477009777'])
  check('an ambiguity list longer than five says there are more', capped.code === 1 && capped.err.split('\n').filter((l) => /^ {2}\d+\t/.test(l)).length === 5 && /and more/.test(capped.err), capped.err)
  const exact = run(['--db', many, 'read', '44770097775'])
  check('a reference matching exactly one chat still resolves', exact.code === 0 && exact.out.includes('Twin 5'), exact.err)
}

// --- 3. the store is never written ---------------------------------------------------

console.log('== read-only by construction')
{
  const before = liveState(db)
  for (const args of [['chats', 'a'], ['read', '1'], ['read', '2', '--paths'], ['search', '3', 'tulip'], ['read', '99'], ['dump'], ['read', '44770090']]) withDb(...args)
  check('the store file is byte-identical and untouched after a battery of commands', liveState(db) === before)
  const leftovers = readdirSync(tmp).filter((n) => n.startsWith('wa-readonly-'))
  check('no snapshot copy is left behind, after successes or errors', leftovers.length === 0, leftovers.join(', '))

  const ro = join(work, 'ro')
  mkdirSync(ro)
  const roDb = join(ro, 'ChatStorage.sqlite')
  copyFileSync(db, roDb)
  chmodSync(roDb, 0o444)
  chmodSync(ro, 0o555)
  const r = run(['--db', roDb, 'read', '1'])
  const entries = readdirSync(ro)
  chmodSync(ro, 0o755)
  check('works when the store and its folder are read-only (nothing is written next to it)', r.code === 0 && r.out.includes('tulip bulbs') && entries.length === 1, r.err)

  for (const [sig, expected] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { openStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)}; ` +
      `openStore(${JSON.stringify(db)}); console.log('open'); setTimeout(() => {}, 30000)`],
    { env: baseEnv, stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise((resolve) => child.stdout.once('data', resolve))
    const during = readdirSync(tmp).filter((n) => n.startsWith('wa-readonly-')).length
    const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)))
    child.kill(sig)
    const code = await closed
    const after = readdirSync(tmp).filter((n) => n.startsWith('wa-readonly-')).length
    check(`${sig} removes the snapshot copy and exits ${expected}`, during === 1 && after === 0 && code === expected, `during=${during} after=${after} code=${code}`)
  }

  // A live WAL-mode store with a message that exists ONLY in the write-ahead log.
  const live = join(work, 'live.db')
  copyFileSync(db, live)
  const holder = spawn('sqlite3', [live], { stdio: ['pipe', 'pipe', 'inherit'] })
  holder.stdout.resume()
  holder.stdin.write(
    "PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\n" +
    "INSERT INTO ZWAMESSAGE VALUES (999, 2, 'WAL-ONLY: lives only in the write-ahead log', 0, 800000000, NULL, 0);\n" +
    "SELECT count(*) FROM ZWAMESSAGE;\n",
  )
  // sqlite3 buffers its output on a pipe, so poll for the WAL instead of waiting for a reply.
  for (let i = 0; i < 100 && !(existsSync(live + '-wal') && statSync(live + '-wal').size > 4096); i++) await new Promise((r) => setTimeout(r, 50))
  await new Promise((r) => setTimeout(r, 300))
  const walSize = existsSync(live + '-wal') ? statSync(live + '-wal').size : 0
  check('test setup: the new message is in the WAL, not the main file', walSize > 0)
  const liveBefore = liveState(live)
  const viaTool = run(['--db', live, 'read', '2'])
  check('the snapshot includes the WAL (a message not yet checkpointed is visible)', viaTool.out.includes('WAL-ONLY'), viaTool.err)
  check('the live WAL store is untouched while its owner is still running', liveState(live) === liveBefore)
  const mainOnly = join(work, 'main-only.db')
  copyFileSync(live, mainOnly)
  check('control: the main file alone does not contain that message', !run(['--db', mainOnly, 'read', '2']).out.includes('WAL-ONLY'))
  holder.stdin.end()
  await new Promise((resolve) => holder.on('close', resolve))
}

console.log('== the store is found and checked')
{
  const missing = run(['--db', join(work, 'nope.sqlite'), 'chats', 'a'])
  check('a missing store is a clear error naming the path', missing.code === 1 && /not found/.test(missing.err) && missing.err.includes('nope.sqlite'), missing.err)
  const dflt = join(home, 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared')
  mkdirSync(dflt, { recursive: true })
  check('with no store at the default macOS path, it says so', /not found/.test(run(['chats', 'alice']).err))
  copyFileSync(db, join(dflt, 'ChatStorage.sqlite'))
  check('the default macOS path is used when nothing is configured', run(['chats', 'alice']).out.includes('Alice Example'))
  check('WA_CHATSTORAGE_PATH points the tool elsewhere', run(['chats', 'bob'], { env: { WA_CHATSTORAGE_PATH: db } }).out.includes('Bob Sample'))
  check('--db beats WA_CHATSTORAGE_PATH', run(['--db', db, 'chats', 'bob'], { env: { WA_CHATSTORAGE_PATH: join(work, 'nope.sqlite') } }).out.includes('Bob Sample'))

  const notDb = join(work, 'notes.txt')
  writeFileSync(notDb, 'this is not a database, just text '.repeat(200))
  const bad = run(['--db', notDb, 'chats', 'a'])
  check('a file that is not SQLite is a clear error', bad.code === 1 && /not a readable SQLite database|does not look like/.test(bad.err), bad.err)
  const other = join(work, 'other.db')
  spawnSync('sqlite3', [other], { input: 'CREATE TABLE notes (id INTEGER, body TEXT); INSERT INTO notes VALUES (1, "hello");', encoding: 'utf8' })
  const wrong = run(['--db', other, 'chats', 'a'])
  check('an unrelated SQLite file is refused with the missing columns listed', wrong.code === 1 && /Missing: ZWACHATSESSION\./.test(wrong.err) && !wrong.out.includes('hello'), wrong.err)
  mkdirSync(join(work, 'empty-path'))
  const nosql = run(['--db', db, 'chats', 'alice'], { env: { PATH: join(work, 'empty-path') } })
  check('a missing sqlite3 is a clear error', nosql.code === 1 && /sqlite3 was not found/.test(nosql.err), nosql.err)
}

// --- 4. the audit surface: what the source is allowed to do --------------------------

console.log('== source audit')
{
  const files = {
    cli: 'bin/whatsapp-readonly.mjs',
    store: 'src/store.mjs',
    queries: 'src/queries.mjs',
    render: 'src/render.mjs',
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
  const code = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, strip(readFileSync(join(root, f), 'utf8'))]))
  const importsOf = (src) => [...src.matchAll(/import\s+(?:\{([^}]*)\}|[\w*\s]+)\s+from\s+'([^']+)'/g)].map((m) => ({ names: (m[1] || '').split(',').map((s) => s.trim()).filter(Boolean), from: m[2] }))

  const fsUsers = Object.entries(code).filter(([, src]) => importsOf(src).some((i) => i.from === 'node:fs' || i.from === 'fs'))
  check('only src/store.mjs imports the filesystem', fsUsers.length === 1 && fsUsers[0][0] === 'store', fsUsers.map(([k]) => k).join(','))
  const fsNames = importsOf(code.store).filter((i) => i.from === 'node:fs').flatMap((i) => i.names).sort()
  check('the whole filesystem surface is five functions: chmod, copy, exists, mkdtemp, rm', JSON.stringify(fsNames) === JSON.stringify(['chmodSync', 'copyFileSync', 'existsSync', 'mkdtempSync', 'rmSync']), fsNames.join(','))
  check('the only chmod is on the private snapshot', (code.store.match(/chmodSync\(/g) || []).length === 1 && /chmodSync\(snap \+ suffix, 0o600\)/.test(code.store))
  check('the only copy goes from the store to the private snapshot', (code.store.match(/copyFileSync\(/g) || []).length === 1 && /copyFileSync\(dbPath \+ suffix, snap \+ suffix\)/.test(code.store))
  check('the only delete is of the private temp directory', (code.store.match(/rmSync\(/g) || []).length === 1 && /rmSync\(dir,/.test(code.store))
  const cp = Object.entries(code).filter(([, src]) => importsOf(src).some((i) => i.from === 'node:child_process'))
  check('only src/store.mjs can run a process', cp.length === 1 && cp[0][0] === 'store')
  const execs = [...code.store.matchAll(/execFileSync\(\s*'([^']+)'/g)]
  check('the only process it ever runs is sqlite3, with a fixed argument list', execs.length === 1 && execs[0][1] === 'sqlite3' && (code.store.match(/execFileSync\(/g) || []).length === 1)
  check('sqlite3 is started read-only and in safe mode', /'-readonly'/.test(code.store) && /'-safe'/.test(code.store))
  const net = ['node:http', 'node:https', 'node:http2', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:worker_threads', 'node:vm']
  const allImports = Object.values(code).flatMap((s) => importsOf(s).map((i) => i.from))
  check('no network or code-loading modules are imported anywhere', net.every((n) => !allImports.includes(n)), allImports.join(','))
  const dynamic = Object.values(code).some((s) => /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(|\brequire\s*\(|process\.binding/.test(s))
  check('no fetch, eval, dynamic import or require anywhere', !dynamic)
  check('there are no runtime dependencies', !('dependencies' in JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))))
  const writeVerbs = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|WRITEFILE|READFILE|LOAD_EXTENSION)\b/
  check('no SQL write verb appears in the query or CLI code', ['cli', 'queries', 'render'].every((k) => !writeVerbs.test(code[k])))
  check('every message query is bound to a single chat id', (code.queries.match(/FROM \$\{MSG_FROM\}/g) || []).length === 2 && (code.queries.match(/ZCHATSESSION = \$\{int\(chat\.Z_PK\)\}/g) || []).length === 2)
}

console.log('== the query guard')
{
  const { assertReadOnlySql, text, int, likeContains } = await import(new URL('../src/store.mjs', import.meta.url))
  const throws = (fn) => { try { fn(); return false } catch { return true } }
  check('guard accepts a plain SELECT', !throws(() => assertReadOnlySql('SELECT Z_PK FROM ZWACHATSESSION WHERE Z_PK = 1')))
  for (const [name, sql] of [
    ['DELETE', 'DELETE FROM ZWAMESSAGE'],
    ['UPDATE', 'UPDATE ZWAMESSAGE SET ZTEXT = NULL'],
    ['INSERT', "INSERT INTO ZWAMESSAGE (ZTEXT) VALUES ('x')"],
    ['DROP', 'DROP TABLE ZWAMESSAGE'],
    ['a second statement', 'SELECT 1; DROP TABLE ZWAMESSAGE'],
    ['PRAGMA', 'PRAGMA writable_schema = 1'],
    ['ATTACH', "ATTACH DATABASE '/tmp/x.db' AS x"],
    ['writefile()', "SELECT writefile('/tmp/x', 'y')"],
    ['readfile()', "SELECT readfile('/etc/hosts')"],
    ['load_extension()', "SELECT load_extension('x')"],
    ['a trailing comment', 'SELECT 1 -- hide'],
    ['a block comment', 'SELECT /* hide */ 1'],
    ['a dot-command on a later line', 'SELECT 1\n.shell id'],
    ['a CTE that deletes', 'WITH x AS (SELECT 1) DELETE FROM ZWAMESSAGE'],
    ['lower case delete', 'delete from ZWAMESSAGE'],
    ['an empty string', ''],
  ]) check(`guard refuses ${name}`, throws(() => assertReadOnlySql(sql)))
  const hostile = "'; DROP TABLE ZWAMESSAGE; --\n.shell id"
  check('text() yields only a hex blob expression, whatever it is given', /^CAST\(X'[0-9a-f]*' AS TEXT\)$/.test(text(hostile)))
  check('a hostile string embedded through text() still passes the guard as plain SELECT', !throws(() => assertReadOnlySql(`SELECT ${text(hostile)}`)))
  const accented = String.fromCodePoint(0x63, 0x61, 0x66, 0xe9, 0x20, 0x1f600)
  check('text() round-trips unicode', Buffer.from(text(accented).match(/X'([0-9a-f]*)'/)[1], 'hex').toString('utf8') === accented)
  check('int() accepts safe integers', int(5) === '5' && int(-3) === '-3')
  for (const bad of [1.5, '1', NaN, Infinity, 2 ** 60, null, undefined, '1; DROP']) check(`int() refuses ${String(bad)}`, throws(() => int(bad)))
  check('likeContains escapes %, _ and backslash', Buffer.from(likeContains('a%b_c\\d').match(/X'([0-9a-f]*)'/)[1], 'hex').toString('utf8') === '%a\\%b\\_c\\\\d%')
}

console.log('== defence in depth')
{
  const { openStore, SQLITE_FLAGS } = await import(new URL('../src/store.mjs', import.meta.url))
  const refusedByGuard = (fn) => { try { fn() } catch (e) { return /^Refused/.test(e.message) } return false }
  const store = openStore(db)
  const pwn = join(work, 'pwn.txt')
  check('store.query refuses a write before it reaches sqlite3', refusedByGuard(() => store.query('DELETE FROM ZWAMESSAGE')))
  check('store.query refuses file functions before they reach sqlite3', refusedByGuard(() => store.query(`SELECT writefile('${pwn}', 'x')`)) && !existsSync(pwn))
  check('store.query still answers a SELECT', store.query('SELECT count(*) AS n FROM ZWAMESSAGE')[0].n === 24)
  store.close()

  // Even with the guard out of the way, the sqlite3 flags alone refuse to write.
  const victim = join(work, 'victim.db')
  copyFileSync(db, victim)
  const del = spawnSync('sqlite3', [...SQLITE_FLAGS, victim], { input: 'DELETE FROM ZWAMESSAGE;\n', encoding: 'utf8' })
  const count = spawnSync('sqlite3', [victim, 'SELECT count(*) FROM ZWAMESSAGE'], { encoding: 'utf8' }).stdout.trim()
  check('sqlite3 -readonly alone refuses a DELETE and leaves every row', del.status !== 0 && /readonly/i.test(del.stderr) && count === '24', del.stderr)
  const wf = spawnSync('sqlite3', [...SQLITE_FLAGS, victim], { input: `SELECT writefile('${pwn}', 'x');\n`, encoding: 'utf8' })
  check('sqlite3 -safe alone refuses writefile()', wf.status !== 0 && /safe mode/i.test(wf.stderr) && !existsSync(pwn), wf.stderr)
  const sh = spawnSync('sqlite3', [...SQLITE_FLAGS, victim], { input: `.shell touch '${pwn}'\n`, encoding: 'utf8' })
  check('sqlite3 -safe alone refuses .shell', !existsSync(pwn), sh.stderr)
}

console.log('== docs')
{
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  for (const g of ['chats-alice.txt', 'read-alice.txt', 'search-alice-tulip.txt', 'read-club.txt']) {
    const body = readFileSync(join(goldenDir, g), 'utf8').trimEnd()
    check(`README shows the real output of ${g}`, readme.includes(body), `README is missing the exact text of test/golden/${g}`)
  }
  check('README states the licence and links LICENSE', /MIT/.test(readme) && readme.includes('(LICENSE)'))
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
