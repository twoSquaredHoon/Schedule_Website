// Schedule server: one SQLite database + a memes folder, shared by the phone app (/app) and the website (/).
// Code lives in Schedule_Website (this folder) and Schedule_App (next to it). Data lives in ~/schedule-data.
const express = require('express');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = process.env.SCHEDULE_DATA || path.join(os.homedir(), 'schedule-data');
const APP_DIR = process.env.SCHEDULE_APP_DIR || path.resolve(__dirname, '..', 'Schedule_App');
const DATA = ROOT;
const MEMES = path.join(ROOT, 'memes');
const ORIGINALS = path.join(MEMES, '.originals');
const TMP = path.join(DATA, 'tmp');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';

for (const d of [DATA, MEMES, TMP]) fs.mkdirSync(d, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA, 'schedule.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  folder TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL UNIQUE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  media_id INTEGER REFERENCES media(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS entries_started ON entries(started_at);
`);

const q = (sql) => db.prepare(sql);
const now = () => new Date().toISOString();

// ---------- helpers ----------
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const GIF_EXT = new Set(['.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function folderFor(name) {
  // Safe folder name for a tag: no slashes, no leading dots.
  return name.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim() || 'tag';
}
function slug(s) {
  return String(s).toLowerCase().replace(/\.[^.]+$/, '').normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meme';
}
function mediaUrl(file) {
  return file ? '/memes/' + file.split('/').map(encodeURIComponent).join('/') : null;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 180000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}

// Square crop from the centre, the way the design shows every meme.
const SQUARE = "crop='min(iw,ih)':'min(iw,ih)'";
async function toSquareGif(input, output) {
  const vf = `${SQUARE},scale=360:360:flags=lanczos,fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-t', '15', '-i', input, '-vf', vf, '-loop', '0', output]);
}
async function toSquareImage(input, output) {
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-vf', `${SQUARE},scale='min(720,iw)':-2`, '-frames:v', '1', output]);
}
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  while (fs.existsSync(p)) p = path.join(dir, `${base}-${crypto.randomBytes(2).toString('hex')}${ext}`);
  return p;
}
const rel = (abs) => path.relative(MEMES, abs).split(path.sep).join('/');

function getOrCreateTagByName(name) {
  name = cleanName(name);
  if (!name) return null;
  const found = q('SELECT * FROM tags WHERE name = ?').get(name);
  if (found) return found;
  const folder = folderFor(name);
  fs.mkdirSync(path.join(MEMES, folder), { recursive: true });
  const r = q('INSERT INTO tags (name, folder) VALUES (?, ?)').run(name, folder);
  return q('SELECT * FROM tags WHERE id = ?').get(Number(r.lastInsertRowid));
}

// Look through the memes folder: add new files, turn videos into square GIFs,
// make a tag for every sub-folder, forget files that were deleted.
let scanning = null;
async function scanMemes() {
  if (scanning) return scanning;
  scanning = (async () => {
    const tagByFolder = new Map(q('SELECT * FROM tags').all().map((t) => [t.folder, t]));
    for (const ent of fs.readdirSync(MEMES, { withFileTypes: true })) {
      if (ent.isDirectory() && !ent.name.startsWith('.') && !tagByFolder.has(ent.name)) {
        const existing = q('SELECT * FROM tags WHERE name = ?').get(ent.name);
        if (existing) { q('UPDATE tags SET folder = ? WHERE id = ?').run(ent.name, existing.id); tagByFolder.set(ent.name, { ...existing, folder: ent.name }); }
        else {
          const r = q('INSERT INTO tags (name, folder) VALUES (?, ?)').run(ent.name, ent.name);
          tagByFolder.set(ent.name, { id: Number(r.lastInsertRowid), name: ent.name, folder: ent.name });
        }
      }
    }
    const known = new Set(q('SELECT file FROM media').all().map((m) => m.file));
    const seen = new Set();
    const walk = async (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(abs); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        let file = abs;
        if (VIDEO_EXT.has(ext)) {
          const out = uniquePath(dir, path.basename(ent.name, path.extname(ent.name)), '.gif');
          try {
            await toSquareGif(abs, out);
            fs.mkdirSync(ORIGINALS, { recursive: true });
            fs.renameSync(abs, uniquePath(ORIGINALS, path.basename(ent.name, path.extname(ent.name)), ext));
            file = out;
          } catch (e) { console.error('could not convert', abs, e.message); continue; }
        } else if (!IMAGE_EXT.has(ext) && !GIF_EXT.has(ext)) continue;
        const r = rel(file);
        seen.add(r);
        if (!known.has(r)) {
          const top = r.includes('/') ? r.split('/')[0] : null;
          const tag = top ? tagByFolder.get(top) : null;
          q('INSERT OR IGNORE INTO media (file, tag_id) VALUES (?, ?)').run(r, tag ? tag.id : null);
        }
      }
    };
    await walk(MEMES);
    for (const f of known) if (!seen.has(f)) q('DELETE FROM media WHERE file = ?').run(f);
  })().finally(() => { scanning = null; });
  return scanning;
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use('/memes', express.static(MEMES, { dotfiles: 'ignore', maxAge: '7d' }));
app.use('/app', express.static(APP_DIR));
app.use('/', express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  console.error(e);
  res.status(e.status || 500).json({ error: e.message });
});
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const CURRENT_SQL = `
SELECT e.id, e.started_at, e.place_id, p.name AS place, e.tag_id, t.name AS tag, e.media_id, m.file
FROM entries e
LEFT JOIN places p ON p.id = e.place_id
LEFT JOIN tags t ON t.id = e.tag_id
LEFT JOIN media m ON m.id = e.media_id
ORDER BY e.started_at DESC, e.id DESC LIMIT 1`;
const withUrl = (row) => row && { ...row, url: mediaUrl(row.file) };

app.get('/api/state', wrap((_req, res) => {
  const current = withUrl(q(CURRENT_SQL).get() || null);
  const places = q(`SELECT p.id, p.name, MAX(e.started_at) AS last FROM places p LEFT JOIN entries e ON e.place_id = p.id
                    GROUP BY p.id ORDER BY last IS NULL, last DESC, p.name`).all();
  const tags = q(`SELECT t.id, t.name, MAX(e.started_at) AS last FROM tags t LEFT JOIN entries e ON e.tag_id = t.id
                  GROUP BY t.id ORDER BY last IS NULL, last DESC, t.name`).all();
  res.json({ current, places, tags, now: now() });
}));

app.post('/api/places', wrap((req, res) => {
  const name = cleanName(req.body.name);
  if (!name) throw bad('Name required');
  q('INSERT OR IGNORE INTO places (name) VALUES (?)').run(name);
  res.json(q('SELECT id, name FROM places WHERE name = ?').get(name));
}));
app.delete('/api/places/:id', wrap((req, res) => {
  q('DELETE FROM places WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/tags', wrap((req, res) => {
  const tag = getOrCreateTagByName(req.body.name);
  if (!tag) throw bad('Name required');
  res.json({ id: tag.id, name: tag.name });
}));
app.delete('/api/tags/:id', wrap((req, res) => {
  // The tag's memes folder is kept; its memes just become untagged.
  q('DELETE FROM tags WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/switch', wrap((req, res) => {
  const tagId = Number(req.body.tag_id);
  const placeId = req.body.place_id == null ? null : Number(req.body.place_id);
  if (!q('SELECT id FROM tags WHERE id = ?').get(tagId)) throw bad('Pick what you are doing');
  if (placeId != null && !q('SELECT id FROM places WHERE id = ?').get(placeId)) throw bad('Unknown place');
  const r = q('INSERT INTO entries (started_at, place_id, tag_id) VALUES (?, ?, ?)').run(now(), placeId, tagId);
  res.json(withUrl(q(CURRENT_SQL).get()) || { id: Number(r.lastInsertRowid) });
}));

app.post('/api/entries/:id/media', wrap((req, res) => {
  const mediaId = req.body.media_id == null ? null : Number(req.body.media_id);
  if (mediaId != null && !q('SELECT id FROM media WHERE id = ?').get(mediaId)) throw bad('Unknown meme');
  q('UPDATE entries SET media_id = ? WHERE id = ?').run(mediaId, Number(req.params.id));
  res.json({ ok: true });
}));

app.delete('/api/entries/:id', wrap((req, res) => {
  q('DELETE FROM entries WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Entries that overlap [from, to). ended_at is the next entry's start (null = still going).
app.get('/api/entries', wrap((req, res) => {
  const from = String(req.query.from || '1970-01-01T00:00:00.000Z');
  const to = String(req.query.to || '9999-01-01T00:00:00.000Z');
  const rows = q(`
    SELECT * FROM (
      SELECT e.id, e.started_at, LEAD(e.started_at) OVER (ORDER BY e.started_at, e.id) AS ended_at,
             e.place_id, p.name AS place, e.tag_id, t.name AS tag, e.media_id, m.file
      FROM entries e
      LEFT JOIN places p ON p.id = e.place_id
      LEFT JOIN tags t ON t.id = e.tag_id
      LEFT JOIN media m ON m.id = e.media_id
    ) WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
    ORDER BY started_at`).all(to, from);
  res.json({ entries: rows.map(withUrl), now: now() });
}));

// All memes. With ?tag_id, that tag's memes come first.
app.get('/api/media', wrap(async (req, res) => {
  if (req.query.rescan) await scanMemes();
  const rows = q(`
    SELECT m.id, m.file, m.tag_id, t.name AS tag, m.created_at,
           COUNT(e.id) AS uses, MAX(e.started_at) AS last_used
    FROM media m
    LEFT JOIN tags t ON t.id = m.tag_id
    LEFT JOIN entries e ON e.media_id = m.id
    GROUP BY m.id
    ORDER BY last_used IS NULL, last_used DESC, m.created_at DESC, m.id DESC`).all().map(withUrl);
  const tagId = req.query.tag_id ? Number(req.query.tag_id) : null;
  if (tagId) {
    // Memes you've used for this activity before also count as "tagged".
    const usedFor = new Set(q('SELECT DISTINCT media_id FROM entries WHERE tag_id = ? AND media_id IS NOT NULL').all(tagId).map((r) => r.media_id));
    const tagged = rows.filter((m) => m.tag_id === tagId || usedFor.has(m.id));
    const ids = new Set(tagged.map((m) => m.id));
    return res.json({ tagged, rest: rows.filter((m) => !ids.has(m.id)) });
  }
  res.json({ tagged: [], rest: rows });
}));

const upload = multer({ dest: TMP, limits: { fileSize: 200 * 1024 * 1024 } });
app.post('/api/media', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('No file');
  const tagId = req.body.tag_id ? Number(req.body.tag_id) : null;
  const tag = tagId ? q('SELECT * FROM tags WHERE id = ?').get(tagId) : null;
  const dir = tag ? path.join(MEMES, tag.folder) : MEMES;
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const mime = req.file.mimetype || '';
  const base = slug(req.file.originalname);
  let out;
  try {
    if (mime.startsWith('video/') || mime === 'image/gif' || VIDEO_EXT.has(ext) || ext === '.gif') {
      out = uniquePath(dir, base, '.gif');
      await toSquareGif(req.file.path, out);
    } else if (mime.startsWith('image/') || IMAGE_EXT.has(ext)) {
      out = uniquePath(dir, base, ext === '.png' ? '.png' : '.jpg');
      await toSquareImage(req.file.path, out);
    } else throw bad('Only pictures, GIFs and videos');
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
  const r = q('INSERT INTO media (file, tag_id) VALUES (?, ?)').run(rel(out), tag ? tag.id : null);
  res.json(withUrl({ id: Number(r.lastInsertRowid), file: rel(out), tag_id: tag ? tag.id : null, tag: tag ? tag.name : null, uses: 0 }));
}));

app.post('/api/rescan', wrap(async (_req, res) => { await scanMemes(); res.json({ ok: true }); }));

app.get('/app', (_req, res) => res.redirect('/app/'));

scanMemes().catch((e) => console.error('scan failed', e)).finally(() => {
  app.listen(PORT, HOST, () => console.log(`Schedule running on http://${HOST}:${PORT}  (phone: /app/  website: /)  data: ${ROOT}`));
});
setInterval(() => scanMemes().catch(() => {}), 5 * 60 * 1000);
