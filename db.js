// db.js — SQLite schema, migrations, and default data seeding.
// Uses Node's built-in node:sqlite (Node 22.5+).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'data', 'anchor.db');

// Make sure the data directory exists.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

// Pragmas for sensible defaults.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

// ─── schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS albums (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    artist      TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    year        INTEGER,
    genre       TEXT,
    rating      REAL    NOT NULL DEFAULT 0,
    cover_url   TEXT,    -- external URL OR /uploads/<file>
    tags        TEXT    NOT NULL DEFAULT '[]', -- JSON array
    snippet     TEXT,
    body        TEXT,    -- paragraphs separated by blank lines
    verdict     TEXT,
    is_draft    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id   INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    parent_id  INTEGER,
    body       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (album_id)  REFERENCES albums(id)   ON DELETE CASCADE,
    FOREIGN KEY (user_id)   REFERENCES users(id)    ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES comments(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id    INTEGER NOT NULL,
    album_id   INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, album_id),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_comments_album   ON comments(album_id);
  CREATE INDEX IF NOT EXISTS idx_comments_user    ON comments(user_id);
  CREATE INDEX IF NOT EXISTS idx_likes_album      ON likes(album_id);
  CREATE INDEX IF NOT EXISTS idx_albums_draft     ON albums(is_draft);
`);

// ─── migrations (safe to run every startup) ───────────────────────────────────

// add embed_url to albums if it doesn't exist yet
const albumCols = db.prepare(`PRAGMA table_info(albums)`).all().map(c => c.name);
if (!albumCols.includes('embed_url')) {
  db.exec(`ALTER TABLE albums ADD COLUMN embed_url TEXT`);
  console.log('[db] migration: added albums.embed_url');
}

// notifications: created when someone replies to your comment
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,          -- recipient
    actor       TEXT    NOT NULL,          -- username who triggered it
    album_id    INTEGER NOT NULL,
    comment_id  INTEGER,
    kind        TEXT    NOT NULL DEFAULT 'reply',
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// seed the visit counter row
db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('visits', '0')`).run();

// ─── default seed (only if albums table is empty) ─────────────────────────────

const albumCount = db.prepare('SELECT COUNT(*) AS c FROM albums').get().c;
if (albumCount === 0) {
  const DEFAULT_ALBUMS = [
    {
      artist: 'Bladee', title: 'Eversince', year: 2017, genre: 'cloud rap / hyperpop', rating: 4.5,
      cover_url: 'https://f4.bcbits.com/img/a3304586428_10.jpg',
      tags: ['drain gang', '2017', 'cloud rap', 'ethereal', 'debut era'],
      snippet: 'The mixtape that crystallized the Drain Gang aesthetic. Hazy, brittle, defiantly weird.',
      body: `Eversince arrived the same way Bladee always does — quietly, without announcement, as if the music had always existed and you just hadn't found it yet. Released in 2017, it's the record where the Drain Gang aesthetic crystallized into something unmistakably its own: helium vocals, trap production dipped in gloss, lyrics that sit somewhere between pop sincerity and complete abstraction.

The production, largely handled by Whitearmor and Yung Sherman, is maximally empty in the best possible sense. There is space in these beats — room to breathe, room to dissociate. Bladee floats over rather than through the instrumentals, which is precisely the point. You don't headbang to this. You phase out.

Tracks like "Prada Season" and "Be Nice 2 Me" are as close to pop hooks as the project gets, while the back half drifts into genuinely strange territory. The album rarely overstays its welcome, keeping things brief, almost shy.

Eversince is not a perfect record, but it's a foundational one. Everything Bladee refined later — the emotional sincerity, the fashion-forward imagery, the sense of total stylistic commitment — is already present here in embryonic form.`,
      verdict: "Essential for Drain Gang context. Start here if you're new to the canon.",
    },
    {
      artist: 'Bladee', title: 'Red Light', year: 2018, genre: 'cloud rap / dream pop', rating: 4.5,
      cover_url: 'https://f4.bcbits.com/img/a0837011170_10.jpg',
      tags: ['drain gang', '2018', 'dream pop', 'red', 'whitearmor'],
      snippet: 'Red Light is Bladee at his most narcotic. A short, dense, evocative trip.',
      body: `Red Light arrived in 2018 with little fanfare and almost no rollout — a Bladee tradition by now. It's short, dense, and somehow simultaneously the most ambient and the most pop record in his catalog at the time. Whitearmor handles most of the production and you can feel the chemistry: this is the sound of two artists with shared vocabulary, finishing each other's sentences.

The opening run — "Red Lights," "Decay," "Cyber" — sets a mood and refuses to break it. Bladee's vocals are pushed even further into the helium register, layered into harmonies that feel less like singing and more like weather. The lyrics are full of his usual visual fixations: jewelry, light, neon, dissociation, longing.

What makes Red Light cohere is its willingness to be small. It's not trying to be a statement album. It's a 24-minute room you walk into and don't want to leave.`,
      verdict: 'A perfect mood piece. Best at night, alone, with headphones.',
    },
    {
      artist: 'Bladee', title: 'Icedancer', year: 2018, genre: 'cloud rap / trap', rating: 4.0,
      cover_url: 'https://f4.bcbits.com/img/a3019024543_10.jpg',
      tags: ['drain gang', '2018', 'trap', 'icy', 'sherman'],
      snippet: 'A pivot toward harder beats without losing the icy core. Bladee getting more confident.',
      body: `Icedancer feels like a transitional record, and that's not a knock. After the diaphanous Red Light, Bladee leans into trap textures — heavier drums, more aggressive 808s, a slight grit in the production that Whitearmor and Yung Sherman hadn't really committed to before. The result is the rare Bladee album that almost works as workout music.

"Into Dust" and the title track are the obvious highlights. There's still plenty of ethereal moments — Bladee is incapable of not sounding ethereal — but the album rewards a different kind of attention. Less drift. More motion.

It's not his most cohesive project, and the back half loses some steam, but Icedancer feels important in retrospect. It's the record where Bladee proved he could do more than vibe. He could ride.`,
      verdict: 'Lesser-discussed but pivotal. Worth revisiting.',
    },
    {
      artist: 'Bladee', title: '333', year: 2020, genre: 'cloud rap / electronic', rating: 4.5,
      cover_url: 'https://f4.bcbits.com/img/a2076587049_10.jpg',
      tags: ['drain gang', '2020', 'spirituality', 'numerology', 'ambient'],
      snippet: '333 is Bladee opening up. More personal, more searching, more emotionally raw.',
      body: `333 marked a real shift in Bladee's project. The numerology is on the cover. The spirituality is in the lyrics. The vocals are clearer, less buried, less treated. This is Bladee letting you hear him.

The production opens up to match. There's house, ambient, breakbeat, and ballad textures all coexisting without strain. "I Want It That Way" might be the most direct emotional statement in his catalog up to that point. "Reality Surf" feels like a Drain Gang summer anthem.

There's a sincerity here that some longtime fans found jarring at first. The mystique was always part of the appeal, and 333 trades a bit of that for vulnerability. The trade was worth it.`,
      verdict: `A defining record. The Bladee album for people who claim they "don't get Bladee."`,
    },
    {
      artist: 'Bladee', title: 'Gluee', year: 2014, genre: 'cloud rap', rating: 5.0,
      cover_url: 'https://f4.bcbits.com/img/a1428876283_10.jpg',
      tags: ['drain gang', '2014', 'classic', 'origins', 'sadboys-era'],
      snippet: 'The genesis. The mixtape that launched a whole sound. Still untouchable.',
      body: `Gluee is one of those rare debut projects that didn't just introduce an artist — it introduced a whole tonal universe. Released in 2014 when the Sadboys / Drain Gang aesthetic was still semi-underground, Gluee laid down the blueprint that everything that followed has been refining.

The production is rawer than anything Bladee would make later. Whitearmor's beats here are scrappier, looser, more lo-fi. But the formula is unmistakable: trap percussion, melodic clouds of synth, vocals soaked in autotune and reverb to the point of dissolving.

"Be Nice 2 Me" (yes, the original version is here) was already iconic by the time Eversince re-released it. "Vanilla Sky," "Lovestory," and "Decline" remain among the best things Bladee has ever recorded.

What makes Gluee untouchable is that it doesn't know yet that it's important. It's just a mixtape. That's part of the magic. Nothing on it sounds calculated. Everything on it sounds inevitable.`,
      verdict: `Bladee's magnum opus, in a discography full of contenders.`,
    },
    {
      artist: 'Ecco2k', title: 'E', year: 2019, genre: 'art pop / cloud rap', rating: 4.5,
      cover_url: 'https://f4.bcbits.com/img/a2820523439_10.jpg',
      tags: ['drain gang', '2019', 'art pop', 'androgynous', 'ecco'],
      snippet: 'A debut album that sounds like nothing else. Ecco2k as auteur from the jump.',
      body: `E is the kind of debut album that immediately recontextualizes everything around it. Ecco2k had been a Drain Gang fixture for years — visual artist, feature, collaborator — but E established him as a singular voice with a singular vision.

The first thing you notice is the production. E doesn't really sound like Bladee or Thaiboy Digital records. It's more textural, more sculpted, more interested in space than in propulsion. Whitearmor and Gud bring different palettes than they do elsewhere — softer synths, harp-like plucks, vocal samples that bloom and dissolve.

The second thing you notice is the voice. Ecco2k's androgynous register is doing real emotional work here. He sounds, by turns, mournful, ecstatic, and detached. The lyrics circle gender, transcendence, beauty, and loss.

"Peroxide," "AAA Powerline," and "Don't Ask" are the album's clear high points, but E really does work as a continuous listen. Forty minutes of one of the most distinctive sound worlds in 2010s pop music.`,
      verdict: 'A debut that already feels like a classic.',
    },
    {
      artist: 'Bladee & Ecco2k', title: 'Crest', year: 2022, genre: 'hyperpop / ambient pop', rating: 4.5,
      cover_url: 'https://f4.bcbits.com/img/a3625651659_10.jpg',
      tags: ['drain gang', '2022', 'collab', 'hyperpop', 'medieval'],
      snippet: 'A genuinely seamless collaboration. Bladee and Ecco sound like they were always meant to sound like this together.',
      body: `Crest is the kind of joint album that justifies the format. Bladee and Ecco2k have collaborated for years, but Crest is the first project where they share equal weight across every track, and the chemistry is undeniable.

The aesthetic is medieval-by-way-of-internet — lots of imagery of knights, crowns, fountains, swords. The production matches: there are harpsichords, choral pads, processed strings sitting alongside the trap and hyperpop palette they're known for. It shouldn't work as well as it does.

"The Flag Is Raised," "Echoes," and "5 Star Crest" are standouts, but the album really wants to be heard end-to-end. It moves like a suite. The transitions are deliberate. The track ordering is doing real work.

The other thing Crest does well is showcase how complementary Bladee and Ecco's voices are. Bladee's reedy, helium-tinged delivery sits perfectly under Ecco's softer, higher harmonies. They've been doing this for years, but Crest is where the duo finally feels like its own discrete entity.`,
      verdict: 'A best-case-scenario collab album.',
    },
    {
      artist: 'JPEGMAFIA', title: 'LP!', year: 2021, genre: 'experimental hip-hop', rating: 4.5,
      cover_url: 'https://upload.wikimedia.org/wikipedia/en/c/c1/JPEGMafia_-_LP%21.png',
      tags: ['experimental', '2021', 'noise rap', 'sampling', 'peggy'],
      snippet: 'Peggy at his most maximalist. Production that should not be legal.',
      body: `LP! is JPEGMAFIA at full throttle. The album, released in two versions (one for streaming, one offline due to sample clearance) is a 15-track demonstration of why Peggy has become one of the most singular producers in rap.

The production is overwhelming in the best way. Samples get chopped beyond recognition, fed back into themselves, layered with industrial textures, glitched out, then suddenly resolved into something almost gentle. "TRUST!" and "DIRTY!" are immediate, but the slower, weirder tracks like "WHAT KIND OF RAPPN'!!" reward patience.

Lyrically, Peggy is operating in his usual mode: hyper-online, hyper-confrontational, hyper-aware of his own contradictions. It's not for everyone. It's barely even for most people. But for the audience it's for, LP! is essential.

The "offline version" — pressed for those who own the album because of sample clearance issues — adds another layer of mystique. It's the rare contemporary album that rewards actually buying it.`,
      verdict: 'Required listening for experimental rap heads. Loud, ugly, brilliant.',
    },
    {
      artist: 'black midi', title: 'Cavalcade', year: 2021, genre: 'art rock / post-punk / jazz rock', rating: 5.0,
      cover_url: 'https://upload.wikimedia.org/wikipedia/en/3/30/Black_Midi_-_Cavalcade.png',
      tags: ['art rock', '2021', 'prog', 'jazz', 'london scene'],
      snippet: 'A staggering second record. Cavalcade is black midi unleashing.',
      body: `If Schlagenheim announced black midi as a band with ideas, Cavalcade is the record where they made good on them. The second album is a wildly ambitious, often beautiful, sometimes terrifying art-rock document that fuses prog, jazz, post-punk, and chamber music with a confidence that very few young bands ever achieve.

The opening track, "John L," is one of the most aggressive things they've ever recorded — angular, lurching, mathematical, exhausting. Then "Marlene Dietrich" arrives and the album reveals its other face: orchestrated, melodic, almost cinematic. The dynamic range here is enormous.

Geordie Greep's vocals continue to divide listeners. He's a deeply theatrical singer, prone to operatic gestures, sneering, whispering. On Cavalcade he commits even harder, and it works. Tracks like "Slow" benefit enormously from his willingness to be uncool.

What makes Cavalcade essential is the songwriting underneath all the virtuosity. These aren't just exercises. They're songs — strange, demanding songs, but songs — and the album rewards repeat listens in a way that pure noodling never could.`,
      verdict: 'A masterpiece. Already one of the records that will define this decade.',
    },
  ];

  const insert = db.prepare(`
    INSERT INTO albums (artist, title, year, genre, rating, cover_url, tags, snippet, body, verdict, is_draft)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);

  for (const a of DEFAULT_ALBUMS) {
    insert.run(a.artist, a.title, a.year, a.genre, a.rating, a.cover_url, JSON.stringify(a.tags), a.snippet, a.body, a.verdict);
  }

  console.log(`[db] seeded ${DEFAULT_ALBUMS.length} default albums.`);
}

module.exports = db;
