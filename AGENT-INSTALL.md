# Install whatsapp-readonly (agent guide)

You are installing whatsapp-readonly for the user: a Node command line tool that reads one WhatsApp chat at a time from the user's own local WhatsApp Desktop store on their Mac. It is read-only and refuses to dump everything. Follow the sections in order, run each command, and report what you see. Do not change any code.

## Prerequisites

Run each check. Stop and tell the user if a required one fails (git, Node 18 or later, a working sqlite3). The `uname` line only reports the system: anything other than Darwin means "Verify live" cannot run here, but "Validate" still can.

```bash
git --version
node --version                 # needs 18 or later
sqlite3 --version              # macOS includes one
sqlite3 -readonly -safe -json :memory: "select 1 as x"   # must print [{"x":1}]
uname -s                       # Darwin on the user's Mac; "Validate" also works elsewhere
```

For "Verify live" only: a Mac with the native WhatsApp Desktop app, signed in, and Full Disk Access granted to the terminal app (System Settings, Privacy & Security, Full Disk Access; restart the terminal afterwards). WhatsApp does not need to be quit.

## Locate config

There is no config file. The tool is a folder you clone. Check for an existing install first (run these from the folder where you would clone it):

```bash
ls -d whatsapp-readonly 2>/dev/null && git -C whatsapp-readonly remote -v
command -v whatsapp-readonly
```

If a `whatsapp-readonly` folder with this remote already exists, use it and skip the clone. By default the tool reads `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`. To read a different file, use `--db <file>` or set `WA_CHATSTORAGE_PATH` (`--db` wins). Messages you sent are labelled `Me`; change that with `--me "Your Name"` or `WA_ME_LABEL`.

## Install

```bash
git clone https://github.com/jamiebuchanan/whatsapp-readonly.git
cd whatsapp-readonly
```

There are no dependencies to install. Optional: `npm link` puts a `whatsapp-readonly` command on the PATH. Only do it if the user wants it, since it writes outside the folder. The package is marked `private`, so it cannot be published to npm by accident.

## Credentials

None. It needs no account, key or login, and makes no network connections. The optional names `WA_CHATSTORAGE_PATH` (a file path) and `WA_ME_LABEL` (a label) are settings, not secrets.

## Validate

Run it from inside the `whatsapp-readonly` folder. It works on any system with Node and sqlite3. It runs the repo test against a synthetic store, never a real one, and prints one line:

```bash
node test/run.mjs >/dev/null 2>&1 && echo "ok: whatsapp-readonly test suite passes on the synthetic store"
```

If it does not print that line, run `node test/run.mjs` without the redirect and report the failing lines.

## Verify live

This is the real-use check. It reads the user's own WhatsApp data, so it needs the user's Mac and their say-so. Do not run it in a sandbox. Ask the user for a name or number to search for, then run:

```bash
node bin/whatsapp-readonly.mjs chats "<name or number>"
```

A list of matching chats (id, last activity, name, number) with no message text means it works. If it fails with a message about permissions, grant Full Disk Access to the terminal app, restart the terminal and try again. Only read a chat (`read <id>`) if the user asks for that specific chat.

## Safety rules

1. **Read-only by construction.** There is no write path in the code: no send, no draft, no delete, no edit. The live database is never opened. Its file, its `-wal` and its `-shm` are copied into a private temp directory (mode 0700) and every query runs against that copy, which is deleted on exit, on error and on Ctrl-C. sqlite3 is started with `-readonly` and `-safe` on the copy, and every statement must pass a SELECT-only guard before it runs.
2. **Every read names a single chat.** No command returns messages from more than one chat. The chat you name has to resolve to exactly one chat. If it matches several, the tool lists the candidates (id, name, number; the first five, and it says when there are more) and stops, so you pick by id. A mistyped id never falls through to a fuzzy match.

Your store contains other people's messages, which is their personal data as well as yours. Use this for your own records. If you pipe the output into an AI service or any other tool, that text leaves your machine, which is exactly why the single-chat rule exists: choose the chat deliberately.

Also: do not look for a dump or export command (there is none, by design), do not loop over chat ids to read everything, and do not open the WhatsApp database with any other tool.
