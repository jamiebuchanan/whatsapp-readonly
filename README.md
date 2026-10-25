# whatsapp-readonly

Read one WhatsApp chat at a time from your own local desktop store. Read-only by construction, and it refuses to dump everything.

I wanted scripts and AI coding agents to be able to look up a single conversation ("what did we agree about Saturday?") without being able to hoover up the whole of my WhatsApp. Most WhatsApp tooling does the opposite: it exports everything. This one is built around saying no.

```
$ whatsapp-readonly dump
whatsapp-readonly: Unknown command "dump". There is no dump or export command, by design: name one chat per read.
Commands: chats <term> | read <chat> | search <chat> <term>
```

## The safety design

This is the point of the project, so it comes first.

1. **Read-only by construction.** There is no write path in the code: no send, no draft, no delete, no edit. The live database is never opened. Its file, its `-wal` and its `-shm` are copied into a private temp directory (mode 0700) and every query runs against that copy, which is deleted on exit, on error and on Ctrl-C. sqlite3 is started with `-readonly` and `-safe` on the copy, and every statement must pass a SELECT-only guard before it runs.
2. **Every read names a single chat.** No command returns messages from more than one chat. The chat you name has to resolve to exactly one chat. If it matches several, the tool lists the candidates (id, name, number; the first five, and it says when there are more) and stops, so you pick by id. A mistyped id never falls through to a fuzzy match.
3. **`chats` returns names only.** It needs a search term, lists at most 25 chats, and never prints message text. `%` and `_` are treated as literal characters, so a wildcard cannot be used to enumerate.
4. **There is no dump or export command.** Anything the tool does not recognise is refused with an explanation, including `dump`, `export`, `all`, `--all` and `--json`.
5. **Nothing you type becomes SQL.** Search terms and chat references travel to sqlite3 as hex-encoded blobs, and numbers must be safe integers. There is no quoting to get wrong.
6. **Nothing is silently left out.** Photos, voice notes, videos, GIFs, stickers, locations, contacts and documents are shown as typed placeholders. A row the tool does not understand prints `[unhandled type N]`. The only rows hidden are known system rows, and the header counts them. A missing line changes the meaning of a conversation and leaves nothing to notice, so the tool never drops one quietly.
7. **No network, no dependencies.** It imports no network module and has no runtime dependencies. A test checks both.
8. **Text from the store is untrusted.** Messages, sender names and group names are chosen by other people. Control characters (terminal escape sequences, carriage returns, the bell, Unicode line separators and bidirectional overrides) are printed as visible `\x1b`-style escapes rather than sent to your terminal. A line break inside a message is indented under it, so a message cannot pose as a separate `[date] Me: ...` line, and a name cannot add a header line. Nothing is dropped; it is made visible.

The whole read-only surface is one short file: [`src/store.mjs`](src/store.mjs). It is the only file that touches the filesystem or runs a process. The tests read the source and fail if that stops being true.

## Setup on macOS

You need:

- A Mac with the native WhatsApp Desktop app, signed in.
- Node 18 or later.
- The `sqlite3` command line tool (macOS includes one). It must be recent enough to support `-readonly`, `-safe` and `-json`; the tool says so if yours is not.

```bash
git clone https://github.com/jamiebuchanan/whatsapp-readonly.git
cd whatsapp-readonly
npm test                                     # optional: runs against a synthetic store, never your real one
node bin/whatsapp-readonly.mjs chats "alice"
```

Optional: `npm link` puts a `whatsapp-readonly` command on your PATH. The package is marked `private`, so it cannot be published to npm by accident.

**Full Disk Access.** macOS protects WhatsApp's data folder. The first run from a terminal usually fails with a message about it. Grant Full Disk Access to your terminal app in System Settings, Privacy & Security, Full Disk Access, restart the terminal and try again. You do not need to quit WhatsApp.

**Where it looks.** By default:

```
~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite
```

To read a different file, for example a copy you staged yourself, use `--db <file>` or set `WA_CHATSTORAGE_PATH`. `--db` wins.

**Your own name in the output.** Messages you sent are labelled `Me`. Change it with `--me "Your Name"` or `WA_ME_LABEL`.

## Usage

```
whatsapp-readonly chats <term>               find chats by name or number (names only, no messages)
whatsapp-readonly read <chat> [options]      print one chat, oldest first
whatsapp-readonly search <chat> <term>       search inside one chat (newest 50 matches)

  --limit N           read: the newest N messages (default 50)
  --since YYYY-MM-DD  read: only messages from local midnight of that day
  --paths             read, search: show the local media file path after media lines
  --db <file>         the store to read
  --me <label>        label for messages you sent
```

`<chat>` is one of:

- the numeric id shown by `chats` (digits only, under 8 long),
- a phone number or part of a JID (any reference that is not a short all-digit id; for a number, 8 or more digits), or
- an exact, case-sensitive chat name.

Output is plain text, oldest first, `[date] Who: message`. Times are your local time, so they match what your phone shows. Exit status is 0 on success (including a `chats` or `search` that finds nothing) and 1 on any refusal or error. Put `--` before a search term that starts with a dash.

## Example output

These examples use the synthetic store in [`test/fixture.sql`](test/fixture.sql). Every chat, name and number in it is invented (the phone numbers are in the range UK regulator Ofcom reserves for drama). Build it and point the tool at it:

```bash
sqlite3 /tmp/demo.db < test/fixture.sql
export WA_CHATSTORAGE_PATH=/tmp/demo.db
```

Find a chat by name. This lists names, ids and last activity, and nothing else:

```
$ whatsapp-readonly chats alice
id	last activity	name	jid
1	2026-01-12 18:40	Alice Example	447700900001@s.whatsapp.net
```

Read it. Note the media placeholders, the `[unhandled type 99]` row that is shown rather than dropped, and the header count of hidden system rows:

```
$ whatsapp-readonly read 1
# Alice Example  (chat 1, 447700900001@s.whatsapp.net)
# 15 message(s), oldest first, 2 system row(s) hidden

[2026-01-10 09:15] Alice Example: Morning! Are we still on for the allotment on Saturday?
[2026-01-10 09:17] Me: Yes. I'll bring the spade and the flask.
[2026-01-10 09:18] Alice Example: [image] Look at the state of the shed
[2026-01-10 09:19] Alice Example: [image not downloaded]
[2026-01-10 09:20] Me: [voice note 1:15]
[2026-01-10 09:21] Alice Example: [video 0:08]
[2026-01-10 09:22] Me: [GIF 0:03]
[2026-01-10 09:23] Alice Example: [sticker]
[2026-01-10 09:25] Alice Example: [location 52.2053, 0.1218]
[2026-01-10 09:26] Me: [contact card Pat Placeholder]
[2026-01-10 09:27] Alice Example: [document allotment-rota.pdf]
[2026-01-10 09:28] Me: https://example.com/seed-swap
[2026-01-10 09:30] Alice Example: [unhandled type 99]
[2026-01-10 09:31] Alice Example: [no text]
[2026-01-12 18:40] Alice Example: Don't forget the tulip bulbs.
```

Search is scoped to the one chat you name, even though the word also appears in other chats:

```
$ whatsapp-readonly search 1 tulip
# Alice Example  (chat 1, 447700900001@s.whatsapp.net)
# 1 message(s), oldest first

[2026-01-12 18:40] Alice Example: Don't forget the tulip bulbs.
```

In a group, the speaker is the sender's display name. This sample message was sent at 12:00 UTC on 1 July, and these examples ran with `TZ=UTC`:

```
$ whatsapp-readonly read 3
# Hiking Club Demo  (chat 3, 120363000000000001@g.us)
# 4 message(s), oldest first

[2026-01-13 20:10] Dee Demo: The Saturday walk is on, car park at nine.
[2026-01-13 20:12] Eli Example: I will bring a tulip-patterned flask.
[2026-01-13 20:13] Me: See you all there.
[2026-07-01 12:00] Dee Demo: Summer route confirmed.
```

And the refusals. A reference that matches several chats lists them and stops:

```
$ whatsapp-readonly read 44770090
whatsapp-readonly: "44770090" is ambiguous. Pick one by id:
  1	Alice Example	447700900001@s.whatsapp.net
  2	Bob Sample	447700900002@s.whatsapp.net
  4	Carol Test	447700900003@s.whatsapp.net
  5	-	447700900099@s.whatsapp.net

$ whatsapp-readonly read
whatsapp-readonly: Name one chat: read <id|number|name> [--limit N] [--since YYYY-MM-DD]

$ whatsapp-readonly chats %
No chat matching "%".
```

## How it stays read-only

The layers, in the order a query meets them:

1. **Snapshot.** The store is copied (database first, then `-wal`, then `-shm`, so the log is never older than the database it replays onto) into a fresh 0700 directory, with 0600 file modes. The original is only ever read.
2. **Read-only, safe sqlite3.** `sqlite3 -readonly -safe -bail -batch -json` runs on the copy. `-safe` also switches off the shell's file and process features. `-init /dev/null` stops a `~/.sqliterc` from changing the output mode.
3. **SELECT-only guard.** A statement must be a single `SELECT`: no second statement, no comments, no dot-commands, no write verbs, no `writefile()` or `readfile()`.
4. **Fixed queries, encoded inputs.** The queries are constants. User input only ever appears as a hex blob cast to text, or as a validated integer.
5. **Single-chat scoping.** Every message query is bound to one chat id, and that id comes from a resolver that refuses ambiguity.
6. **Cleanup.** The temp copy is removed on exit, on errors and on SIGINT, SIGTERM and SIGHUP.

**Why a snapshot rather than opening the file read-only in place?** WhatsApp keeps recent messages in the write-ahead log until it checkpoints. Opening the main file with `immutable=1` tells SQLite to ignore the log entirely, which silently omits everything since the last checkpoint, and that can be hours of the most relevant messages. Copying all three files and letting SQLite replay the log on the copy gets the full picture, and still cannot touch the original. A test builds a store with a message that exists only in the log and checks it appears.

## Your own data only

- It reads the database file WhatsApp Desktop keeps on your own Mac, for the account you are signed in to. It does not log in, connect to WhatsApp, decrypt anything, or touch the app.
- It makes no network connections and sends nothing anywhere. There is no telemetry.
- It is not affiliated with, endorsed by or sponsored by WhatsApp or Meta. WhatsApp is a trademark of Meta Platforms, Inc.
- The store's schema is not documented. The column meanings used here were worked out by inspecting a store, and they can change between WhatsApp releases. The tool checks the tables and columns it needs and stops with a clear message if they are missing.
- Your store contains other people's messages, which is their personal data as well as yours. Use this for your own records. If you pipe the output into an AI service or any other tool, that text leaves your machine, which is exactly why the single-chat rule exists: choose the chat deliberately.
- WhatsApp's terms of service apply to your use of WhatsApp. This tool does not interact with WhatsApp's services, but nothing here is legal advice, and you should read the current terms yourself.

## Limits

- **It is a guard rail, not an access-control boundary.** Anyone who can run this tool can also open the same file with `sqlite3`. The refusal makes the safe path the default for scripts and agents and makes broad access a deliberate act. It does not stop someone who loops over chat ids one at a time.
- **A named chat can be read in full.** `--limit` has no upper cap. You named the chat; that is the rule.
- **A hard kill skips cleanup.** SIGKILL or a power cut can leave the temp copy behind in your system temp directory (`wa-readonly-*`, mode 0700). Delete it. It is an unencrypted copy of your store.
- **Each run copies the whole store.** On a large store that takes a moment.
- **macOS native app only.** Other platforms store WhatsApp data differently and are not supported. The tests need only Node and sqlite3 and never touch a real store; they have been run on macOS, and other systems are untested.
- **Text and placeholders only.** Media files are not read; `--paths` shows where they are cached. Message types the tool does not know show as `[unhandled type N]`, and features such as reactions and edits are not rendered.
- **Search is plain substring matching.** It is case-insensitive for ASCII letters only. Exact chat-name matching is case-sensitive.

## Tests

```bash
npm test          # or: node test/run.mjs
```

The runner builds a synthetic store from `test/fixture.sql` and checks, among other things:

- every dump-style request is refused, with no message text printed;
- the single-chat rule holds: reading or searching one chat never shows another chat's messages, even for a word that appears in several;
- ambiguous, wildcard, mistyped and injection-style references are refused or match nothing;
- the live store is byte-identical afterwards, works when its folder is read-only, and leaves no temp copy behind;
- a message that exists only in the write-ahead log is read;
- hostile text in a message or a chat name (escape sequences, carriage returns, forged `[date] Me:` lines, bidi overrides) is shown as visible escapes and cannot add lines;
- the source imports no network module, runs only `sqlite3`, deletes only its own temp directory, and the query guard refuses every write.

It also checks that the four output examples in this README (`chats`, `read`, `search` and the group `read`) are the real output. Each run gets its own `HOME` and `TMPDIR`, so the tests can never fall back to a real WhatsApp store.

## Licence

MIT. See [LICENSE](LICENSE).
