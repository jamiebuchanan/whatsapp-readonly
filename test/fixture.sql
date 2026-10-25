-- test/fixture.sql
--
-- A SYNTHETIC WhatsApp desktop store. Every chat, name, number and message below
-- is invented. Phone numbers are in the UK Ofcom drama range (447700 900xxx),
-- which is reserved for fiction. Nothing here comes from a real account.
--
-- Only the tables and columns that whatsapp-readonly reads are created. A real
-- store has many more. Timestamps are Apple/CoreData seconds (since 2001-01-01
-- UTC), built here from readable dates so the file stays easy to review.
--
-- Build a copy:   sqlite3 /tmp/demo.db < test/fixture.sql

CREATE TABLE ZWACHATSESSION (
  Z_PK INTEGER PRIMARY KEY,
  ZPARTNERNAME TEXT,
  ZCONTACTJID TEXT,
  ZLASTMESSAGEDATE REAL
);

CREATE TABLE ZWAMESSAGE (
  Z_PK INTEGER PRIMARY KEY,
  ZCHATSESSION INTEGER,
  ZTEXT TEXT,
  ZISFROMME INTEGER,
  ZMESSAGEDATE REAL,
  ZPUSHNAME TEXT,
  ZMESSAGETYPE INTEGER
);

CREATE TABLE ZWAMEDIAITEM (
  Z_PK INTEGER PRIMARY KEY,
  ZMESSAGE INTEGER,
  ZMEDIALOCALPATH TEXT,
  ZMOVIEDURATION REAL,
  ZTITLE TEXT,
  ZVCARDNAME TEXT,
  ZLATITUDE REAL,
  ZLONGITUDE REAL
);

-- Chats. 4 has no activity yet. 5 has no saved name.
INSERT INTO ZWACHATSESSION VALUES
  (1, 'Alice Example',    '447700900001@s.whatsapp.net', strftime('%s', '2026-01-12 18:40:00') - 978307200),
  (2, 'Bob Sample',       '447700900002@s.whatsapp.net', strftime('%s', '2026-01-11 08:05:00') - 978307200),
  (3, 'Hiking Club Demo', '120363000000000001@g.us',     strftime('%s', '2026-07-01 12:00:00') - 978307200),
  (4, 'Carol Test',       '447700900003@s.whatsapp.net', NULL),
  (5, NULL,               '447700900099@s.whatsapp.net', strftime('%s', '2026-01-09 07:00:00') - 978307200);

-- Chat 1: a 1:1 thread that exercises every message type the tool renders.
-- ZPUSHNAME holds an opaque id in 1:1 chats (it is only a display name in groups).
INSERT INTO ZWAMESSAGE VALUES
  (101, 1, 'Morning! Are we still on for the allotment on Saturday?', 0, strftime('%s', '2026-01-10 09:15:00') - 978307200, 'A1B2C3D4', 0),
  (102, 1, 'Yes. I''ll bring the spade and the flask.',               1, strftime('%s', '2026-01-10 09:17:00') - 978307200, NULL,       0),
  (103, 1, 'Look at the state of the shed',                           0, strftime('%s', '2026-01-10 09:18:00') - 978307200, 'A1B2C3D4', 1),
  (104, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:19:00') - 978307200, 'A1B2C3D4', 1),
  (105, 1, NULL,                                                      1, strftime('%s', '2026-01-10 09:20:00') - 978307200, NULL,       3),
  (106, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:21:00') - 978307200, 'A1B2C3D4', 2),
  (107, 1, NULL,                                                      1, strftime('%s', '2026-01-10 09:22:00') - 978307200, NULL,       11),
  (108, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:23:00') - 978307200, 'A1B2C3D4', 15),
  (109, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:25:00') - 978307200, 'A1B2C3D4', 5),
  (110, 1, NULL,                                                      1, strftime('%s', '2026-01-10 09:26:00') - 978307200, NULL,       4),
  (111, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:27:00') - 978307200, 'A1B2C3D4', 8),
  (112, 1, 'https://example.com/seed-swap',                           1, strftime('%s', '2026-01-10 09:28:00') - 978307200, NULL,       7),
  (113, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:29:00') - 978307200, NULL,       10),
  (114, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:29:30') - 978307200, NULL,       66),
  (115, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:30:00') - 978307200, 'A1B2C3D4', 99),
  (116, 1, NULL,                                                      0, strftime('%s', '2026-01-10 09:31:00') - 978307200, 'A1B2C3D4', 0),
  (117, 1, 'Don''t forget the tulip bulbs.',                          0, strftime('%s', '2026-01-12 18:40:00') - 978307200, 'A1B2C3D4', 0);

-- Media rows. As in a real store, some columns are reused: on an image,
-- ZLATITUDE/ZLONGITUDE hold pixel size and ZTITLE holds a base64 media key.
-- The tool must not print those. Message 104 has no local path (not downloaded).
INSERT INTO ZWAMEDIAITEM VALUES
  (1, 103, 'Media/fixture/shed.jpg',        NULL, 'c29tZWZpeHR1cmVrZXk=', NULL,              2048,    1536),
  (2, 104, NULL,                            NULL, 'c29tZWZpeHR1cmVrZXk=', NULL,              2048,    1536),
  (3, 105, 'Media/fixture/note.opus',       75,   NULL,                   NULL,              NULL,    NULL),
  (4, 106, 'Media/fixture/clip.mp4',        8.4,  NULL,                   NULL,              NULL,    NULL),
  (5, 107, 'Media/fixture/laugh.mp4',       3,    NULL,                   NULL,              NULL,    NULL),
  (6, 108, 'Media/fixture/sticker.webp',    NULL, NULL,                   NULL,              NULL,    NULL),
  (7, 109, NULL,                            NULL, NULL,                   NULL,              52.2053, 0.1218),
  (8, 110, 'Media/fixture/pat.vcf',         NULL, NULL,                   'Pat Placeholder', NULL,    NULL),
  (9, 111, 'Media/fixture/allotment-rota.pdf', NULL, 'allotment-rota.pdf', NULL,             NULL,    NULL);

-- Chat 2: a different person. Tests use its distinctive words to prove that
-- reading or searching chat 1 never shows anything from here.
INSERT INTO ZWAMESSAGE VALUES
  (201, 2, 'The tulip order is confirmed.', 0, strftime('%s', '2026-01-11 08:00:00') - 978307200, 'E5F6A7B8', 0),
  (202, 2, 'Thanks, paid.',                 1, strftime('%s', '2026-01-11 08:05:00') - 978307200, NULL,       0);

-- Chat 3: a group. Here ZPUSHNAME is a real display name. The July message is
-- 12:00 UTC, which is 13:00 in London (British Summer Time).
INSERT INTO ZWAMESSAGE VALUES
  (301, 3, 'The Saturday walk is on, car park at nine.', 0, strftime('%s', '2026-01-13 20:10:00') - 978307200, 'Dee Demo', 0),
  (302, 3, 'I will bring a tulip-patterned flask.',      0, strftime('%s', '2026-01-13 20:12:00') - 978307200, 'Eli Example', 0),
  (303, 3, 'See you all there.',                          1, strftime('%s', '2026-01-13 20:13:00') - 978307200, NULL, 0),
  (304, 3, 'Summer route confirmed.',                     0, strftime('%s', '2026-07-01 12:00:00') - 978307200, 'Dee Demo', 0);

-- Chat 5: no saved name, so the speaker falls back to the number.
INSERT INTO ZWAMESSAGE VALUES
  (501, 5, 'Sorry, wrong number.', 0, strftime('%s', '2026-01-09 07:00:00') - 978307200, 'F9E8D7C6', 0);
