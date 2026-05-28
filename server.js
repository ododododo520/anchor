// server.js — Express API for the Anchor music blog.
//
// Sections:
//   1. config + env validation
//   2. middleware setup (helmet, json, static, rate limit)
//   3. auth helpers (jwt, bcrypt, current user middleware)
//   4. admin bootstrap
//   5. file upload (multer)
//   6. helpers (album row -> JSON shape, comment shape, etc.)
//   7. auth routes      (/api/auth/*)
//   8. albums routes    (/api/albums/*)
//   9. comments routes  (/api/comments/*)
//  10. likes routes     (/api/albums/:id/like)
//  11. profile route    (/api/users/:username)
//  12. error handler + start

'use strict';

require('dotenv').config();

const path     = require('node:path');
const fs       = require('node:fs');
const crypto   = require('node:crypto');
const express  = require('express');
const helmet   = require('helmet');
const rateLimit= require('express-rate-limit');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const db       = require('./db');

// ─── 1. config ────────────────────────────────────────────────────────────────

const PORT            = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_EXPIRES_IN  = process.env.JWT_EXPIRES_IN || '30d';
const ADMIN_USERNAME  = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD  = process.env.ADMIN_PASSWORD;
const UPLOAD_DIR      = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
const MAX_UPLOAD_MB   = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5', 10);
const BCRYPT_ROUNDS   = 12;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set and at least 32 chars long.');
  console.error('       generate one with: openssl rand -hex 32');
  process.exit(1);
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── 2. middleware ────────────────────────────────────────────────────────────

const app = express();

app.set('trust proxy', 1); // behind nginx/cloudflare on most VPS setups
app.use(helmet({
  // we serve our own HTML + JS, so default CSP would block inline scripts.
  // a real production deploy might tighten this further with hashes/nonces.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '256kb' }));

// lightweight health check for the hosting platform (Fly, etc.)
app.get('/health', (_req, res) => res.json({ ok: true }));

// static frontend — serve ONLY the two known frontend files from the app root.
// We deliberately do NOT expose the whole directory (that would leak server.js,
// db.js, .env, the database, etc.).
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (_req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'app.js')));
// uploaded cover images
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  fallthrough: false,
}));

// rate limit auth endpoints to slow down brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many attempts, slow down' },
});

// ─── 3. auth helpers ──────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, is_admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN },
  );
}

function parseBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

// attaches req.user when a valid token is present; otherwise req.user = null
function attachUser(req, _res, next) {
  const token = parseBearer(req);
  if (!token) { req.user = null; return next(); }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // re-read from DB so admin/username changes are picked up
    const row = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(payload.id);
    req.user = row ? { id: row.id, username: row.username, is_admin: !!row.is_admin } : null;
  } catch {
    req.user = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'login required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user)              return res.status(401).json({ error: 'login required' });
  if (!req.user.is_admin)     return res.status(403).json({ error: 'admin only' });
  next();
}

app.use(attachUser);

// ─── 4. admin bootstrap ───────────────────────────────────────────────────────
// On startup: if no admin exists and ADMIN_USERNAME/ADMIN_PASSWORD env vars are set,
// create the admin account. If admin already exists, env vars are ignored.

(function bootstrapAdmin() {
  const existing = db.prepare('SELECT id, username FROM users WHERE is_admin = 1').get();
  if (existing) {
    console.log(`[auth] admin account already exists: ${existing.username}`);
    return;
  }
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.warn('[auth] no admin exists and ADMIN_USERNAME/ADMIN_PASSWORD not set.');
    console.warn('       set them in .env and restart to create the admin account.');
    return;
  }
  if (ADMIN_PASSWORD.length < 8) {
    console.warn('[auth] ADMIN_PASSWORD must be at least 8 characters. Skipping bootstrap.');
    return;
  }
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, BCRYPT_ROUNDS);
  db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)')
    .run(ADMIN_USERNAME, hash);
  console.log(`[auth] created admin account: ${ADMIN_USERNAME}`);
})();

// ─── 5. file upload ───────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 6);
      const safeExt = /^\.(jpe?g|png|gif|webp|avif)$/i.test(ext) ? ext : '.jpg';
      cb(null, crypto.randomBytes(16).toString('hex') + safeExt);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpe?g|png|gif|webp|avif)$/i.test(file.mimetype)) {
      return cb(new Error('only image files (jpeg, png, gif, webp, avif) are allowed'));
    }
    cb(null, true);
  },
});

// ─── 6. helpers ───────────────────────────────────────────────────────────────

function rowToAlbum(row, viewerId = null) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
  // likes count + viewer's like state, fetched in a single query each — fine for this scale.
  const likeCount = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE album_id = ?').get(row.id).c;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 FROM likes WHERE album_id = ? AND user_id = ?').get(row.id, viewerId)
    : false;
  const commentCount = db.prepare('SELECT COUNT(*) AS c FROM comments WHERE album_id = ?').get(row.id).c;
  return {
    id:        row.id,
    artist:    row.artist,
    title:     row.title,
    year:      row.year,
    genre:     row.genre,
    rating:    row.rating,
    cover_url: row.cover_url,
    tags,
    snippet:   row.snippet,
    body:      row.body,
    verdict:   row.verdict,
    is_draft:  !!row.is_draft,
    created_at: row.created_at,
    updated_at: row.updated_at,
    likes:     likeCount,
    liked,
    comments:  commentCount,
  };
}

function rowToComment(row) {
  return {
    id:        row.id,
    album_id:  row.album_id,
    user_id:   row.user_id,
    username:  row.username,
    is_admin:  !!row.is_admin,
    parent_id: row.parent_id,
    body:      row.body,
    created_at: row.created_at,
  };
}

function strOrNull(x) {
  if (x == null) return null;
  const s = String(x).trim();
  return s.length ? s : null;
}

// Validate + normalize an album payload (POST/PUT).
function parseAlbumInput(body) {
  const errors = [];
  const artist = strOrNull(body.artist);
  const title  = strOrNull(body.title);
  if (!artist) errors.push('artist required');
  if (!title)  errors.push('title required');
  if (artist && artist.length > 200) errors.push('artist too long');
  if (title  && title.length  > 200) errors.push('title too long');

  let year = null;
  if (body.year != null && body.year !== '') {
    const y = parseInt(body.year, 10);
    if (Number.isFinite(y) && y >= 1900 && y <= 2100) year = y;
    else errors.push('year must be 1900-2100');
  }

  let rating = 0;
  if (body.rating != null && body.rating !== '') {
    const r = Number(body.rating);
    if (Number.isFinite(r) && r >= 0 && r <= 5) rating = Math.round(r * 2) / 2;
    else errors.push('rating must be 0-5 (in 0.5 steps)');
  }

  let tags = [];
  if (Array.isArray(body.tags)) {
    tags = body.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20);
  } else if (typeof body.tags === 'string') {
    tags = body.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
  }

  return {
    errors,
    data: {
      artist,
      title,
      year,
      genre:     strOrNull(body.genre),
      rating,
      cover_url: strOrNull(body.cover_url),
      tags,
      snippet:   strOrNull(body.snippet),
      body:      strOrNull(body.body),
      verdict:   strOrNull(body.verdict),
      is_draft:  body.is_draft ? 1 : 0,
    },
  };
}

// ─── 7. auth routes ───────────────────────────────────────────────────────────

app.post('/api/auth/register', authLimiter, (req, res) => {
  const username = strOrNull(req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';

  if (!username || !/^[a-zA-Z0-9_.-]{2,30}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 2-30 chars, letters/digits/._-' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'username taken' });

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);

  const user = { id: result.lastInsertRowid, username, is_admin: false };
  res.json({ user, token: signToken(user) });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const username = strOrNull(req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const row = db.prepare('SELECT id, username, password_hash, is_admin FROM users WHERE username = ?').get(username);
  // constant-ish time: always run bcrypt.compare against something
  const ok = row ? bcrypt.compareSync(password, row.password_hash) : bcrypt.compareSync(password, '$2a$12$0000000000000000000000000000000000000000000000000000');
  if (!row || !ok) return res.status(401).json({ error: 'wrong username or password' });

  const user = { id: row.id, username: row.username, is_admin: !!row.is_admin };
  res.json({ user, token: signToken(user) });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', requireUser, (req, res) => {
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  const next    = typeof req.body.new_password     === 'string' ? req.body.new_password     : '';
  if (next.length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!row || !bcrypt.compareSync(current, row.password_hash)) {
    return res.status(401).json({ error: 'current password incorrect' });
  }
  const hash = bcrypt.hashSync(next, BCRYPT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

// ─── 8. albums routes ─────────────────────────────────────────────────────────

// list albums. drafts are only included for admins.
app.get('/api/albums', (req, res) => {
  const showDrafts = req.user && req.user.is_admin;
  const rows = db.prepare(
    showDrafts
      ? 'SELECT * FROM albums ORDER BY id DESC'
      : 'SELECT * FROM albums WHERE is_draft = 0 ORDER BY id DESC'
  ).all();
  const viewerId = req.user ? req.user.id : null;
  res.json({ albums: rows.map(r => rowToAlbum(r, viewerId)) });
});

// single album
app.get('/api/albums/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM albums WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.is_draft && (!req.user || !req.user.is_admin)) {
    return res.status(404).json({ error: 'not found' });
  }
  res.json({ album: rowToAlbum(row, req.user ? req.user.id : null) });
});

// create album (admin)
app.post('/api/albums', requireAdmin, (req, res) => {
  const { errors, data } = parseAlbumInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const result = db.prepare(`
    INSERT INTO albums (artist, title, year, genre, rating, cover_url, tags, snippet, body, verdict, is_draft)
    VALUES (?,      ?,     ?,    ?,     ?,      ?,         ?,    ?,       ?,    ?,       ?)
  `).run(data.artist, data.title, data.year, data.genre, data.rating, data.cover_url,
         JSON.stringify(data.tags), data.snippet, data.body, data.verdict, data.is_draft);

  const row = db.prepare('SELECT * FROM albums WHERE id = ?').get(result.lastInsertRowid);
  res.json({ album: rowToAlbum(row, req.user.id) });
});

// update album (admin)
app.put('/api/albums/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM albums WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const { errors, data } = parseAlbumInput(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  db.prepare(`
    UPDATE albums
       SET artist=?, title=?, year=?, genre=?, rating=?, cover_url=?, tags=?, snippet=?, body=?, verdict=?, is_draft=?, updated_at=datetime('now')
     WHERE id=?
  `).run(data.artist, data.title, data.year, data.genre, data.rating, data.cover_url,
         JSON.stringify(data.tags), data.snippet, data.body, data.verdict, data.is_draft, id);

  const row = db.prepare('SELECT * FROM albums WHERE id = ?').get(id);
  res.json({ album: rowToAlbum(row, req.user.id) });
});

// delete album (admin)
app.delete('/api/albums/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM albums WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// upload cover image for an album (admin)
// frontend sends multipart/form-data with field "cover"
app.post('/api/albums/:id/cover', requireAdmin, (req, res, next) => {
  upload.single('cover')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

    const id = parseInt(req.params.id, 10);
    const exists = db.prepare('SELECT cover_url FROM albums WHERE id = ?').get(id);
    if (!exists) {
      // clean up the file we just wrote
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: 'album not found' });
    }
    // if old cover was an upload, delete the file
    if (exists.cover_url && exists.cover_url.startsWith('/uploads/')) {
      const oldPath = path.join(UPLOAD_DIR, path.basename(exists.cover_url));
      fs.unlink(oldPath, () => {});
    }
    const url = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE albums SET cover_url = ?, updated_at = datetime(\'now\') WHERE id = ?').run(url, id);
    res.json({ cover_url: url });
  });
});

// ─── 9. comments routes ───────────────────────────────────────────────────────

app.get('/api/albums/:id/comments', (req, res) => {
  const albumId = parseInt(req.params.id, 10);
  const rows = db.prepare(`
    SELECT c.id, c.album_id, c.user_id, c.parent_id, c.body, c.created_at,
           u.username, u.is_admin
      FROM comments c
      JOIN users u ON u.id = c.user_id
     WHERE c.album_id = ?
     ORDER BY c.id ASC
  `).all(albumId);
  res.json({ comments: rows.map(rowToComment) });
});

app.post('/api/albums/:id/comments', requireUser, (req, res) => {
  const albumId = parseInt(req.params.id, 10);
  const body = strOrNull(req.body.body);
  if (!body) return res.status(400).json({ error: 'comment body required' });
  if (body.length > 2000) return res.status(400).json({ error: 'comment too long' });

  const album = db.prepare('SELECT id, is_draft FROM albums WHERE id = ?').get(albumId);
  if (!album) return res.status(404).json({ error: 'album not found' });
  if (album.is_draft && !req.user.is_admin) return res.status(404).json({ error: 'album not found' });

  // parent must be a comment under the same album, if provided
  let parentId = null;
  if (req.body.parent_id != null && req.body.parent_id !== '') {
    const pid = parseInt(req.body.parent_id, 10);
    const parent = db.prepare('SELECT id, parent_id FROM comments WHERE id = ? AND album_id = ?').get(pid, albumId);
    if (!parent) return res.status(400).json({ error: 'invalid parent comment' });
    // limit to one level of nesting: replies always attach to top-level
    parentId = parent.parent_id || parent.id;
  }

  const result = db.prepare('INSERT INTO comments (album_id, user_id, parent_id, body) VALUES (?, ?, ?, ?)')
    .run(albumId, req.user.id, parentId, body);

  const row = db.prepare(`
    SELECT c.id, c.album_id, c.user_id, c.parent_id, c.body, c.created_at,
           u.username, u.is_admin
      FROM comments c JOIN users u ON u.id = c.user_id
     WHERE c.id = ?
  `).get(result.lastInsertRowid);

  res.json({ comment: rowToComment(row) });
});

app.delete('/api/comments/:id', requireUser, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = db.prepare('SELECT id, user_id FROM comments WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'not found' });

  // own comment or admin
  if (row.user_id !== req.user.id && !req.user.is_admin) {
    return res.status(403).json({ error: 'not allowed' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── 10. likes ────────────────────────────────────────────────────────────────

app.post('/api/albums/:id/like', requireUser, (req, res) => {
  const albumId = parseInt(req.params.id, 10);
  const album = db.prepare('SELECT id, is_draft FROM albums WHERE id = ?').get(albumId);
  if (!album) return res.status(404).json({ error: 'album not found' });
  if (album.is_draft && !req.user.is_admin) return res.status(404).json({ error: 'album not found' });

  const existing = db.prepare('SELECT 1 FROM likes WHERE user_id = ? AND album_id = ?').get(req.user.id, albumId);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE user_id = ? AND album_id = ?').run(req.user.id, albumId);
  } else {
    db.prepare('INSERT INTO likes (user_id, album_id) VALUES (?, ?)').run(req.user.id, albumId);
  }
  const count = db.prepare('SELECT COUNT(*) AS c FROM likes WHERE album_id = ?').get(albumId).c;
  res.json({ liked: !existing, likes: count });
});

// ─── 11. user profile ─────────────────────────────────────────────────────────

app.get('/api/users/:username', (req, res) => {
  const row = db.prepare('SELECT id, username, is_admin, created_at FROM users WHERE username = ?').get(req.params.username);
  if (!row) return res.status(404).json({ error: 'not found' });

  // comments the user has posted (with album info)
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.parent_id,
           a.id AS album_id, a.title AS album_title, a.artist AS album_artist, a.is_draft
      FROM comments c
      JOIN albums   a ON a.id = c.album_id
     WHERE c.user_id = ?
     ORDER BY c.id DESC
     LIMIT 200
  `).all(row.id).filter(c => !c.is_draft || (req.user && req.user.is_admin));

  // albums they've liked
  const liked = db.prepare(`
    SELECT a.id, a.artist, a.title, a.year, a.rating, a.cover_url, a.is_draft
      FROM likes l
      JOIN albums a ON a.id = l.album_id
     WHERE l.user_id = ?
     ORDER BY l.created_at DESC
     LIMIT 200
  `).all(row.id).filter(a => !a.is_draft || (req.user && req.user.is_admin));

  res.json({
    profile: {
      username:   row.username,
      is_admin:   !!row.is_admin,
      created_at: row.created_at,
      comment_count: comments.length,
      like_count:    liked.length,
    },
    comments,
    likes: liked,
  });
});

// ─── 12. error handler + start ────────────────────────────────────────────────

// SPA fallback: unmatched non-API GET paths return index.html — but paths that
// look like a file (have an extension) get a clean 404 instead of the HTML page.
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  if (/\.[a-z0-9]+$/i.test(req.path)) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

// Bind to 0.0.0.0 so it works inside containers (Fly.io, Docker, etc.),
// not just localhost. HOST can override if needed.
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  const indexPath = path.join(__dirname, 'index.html');
  console.log(`[anchor] serving frontend from ${__dirname} (index exists: ${fs.existsSync(indexPath)})`);
  console.log(`[anchor] listening on http://${HOST}:${PORT}`);
});
