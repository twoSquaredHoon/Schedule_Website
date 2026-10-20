// Schedule server: one SQLite database + a memes folder, shared by the phone app (/app) and the website (/).
// Code lives in Schedule_Website (this folder) and Schedule_App (next to it). Data lives in ~/schedule-data.
const express = require('express');
const webpush = require('web-push');
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
// Deleting a place or activity hides it (archived_at) so past entries keep their name.
for (const table of ['places', 'tags']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes('archived_at')) db.exec(`ALTER TABLE ${table} ADD COLUMN archived_at TEXT`);
}
// Places can have a pin on the map (lat/lng) and a radius in meters.
{
  const cols = db.prepare('PRAGMA table_info(places)').all().map((c) => c.name);
  if (!cols.includes('lat')) db.exec('ALTER TABLE places ADD COLUMN lat REAL');
  if (!cols.includes('lng')) db.exec('ALTER TABLE places ADD COLUMN lng REAL');
  if (!cols.includes('radius')) db.exec('ALTER TABLE places ADD COLUMN radius REAL NOT NULL DEFAULT 120');
}
db.exec(`
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  acc REAL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  place_id INTEGER REFERENCES places(id) ON DELETE SET NULL,
  tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
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
  if (found) {
    // Adding a deleted activity again brings it back.
    if (found.archived_at) q('UPDATE tags SET archived_at = NULL WHERE id = ?').run(found.id);
    fs.mkdirSync(path.join(MEMES, found.folder), { recursive: true });
    return found;
  }
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
  const places = q(`SELECT p.id, p.name, p.lat, p.lng, MAX(e.started_at) AS last FROM places p LEFT JOIN entries e ON e.place_id = p.id
                    WHERE p.archived_at IS NULL
                    GROUP BY p.id ORDER BY last IS NULL, last DESC, p.name`).all();
  const tags = q(`SELECT t.id, t.name, MAX(e.started_at) AS last FROM tags t LEFT JOIN entries e ON e.tag_id = t.id
                  WHERE t.archived_at IS NULL
                  GROUP BY t.id ORDER BY last IS NULL, last DESC, t.name`).all();
  res.json({ current, places, tags, now: now() });
}));

const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

app.post('/api/places', wrap((req, res) => {
  const name = cleanName(req.body.name);
  if (!name) throw bad('Name required');
  q('INSERT OR IGNORE INTO places (name) VALUES (?)').run(name);
  q('UPDATE places SET archived_at = NULL WHERE name = ?').run(name);
  res.json(q('SELECT id, name FROM places WHERE name = ?').get(name));
}));
// Rename. Past entries show the new name too.
app.patch('/api/places/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const name = cleanName(req.body.name);
  if (!name) throw bad('Name required');
  if (!q('SELECT id FROM places WHERE id = ?').get(id)) throw notFound();
  if (q('SELECT id FROM places WHERE name = ? AND id != ?').get(name, id)) throw conflict('That place already exists');
  q('UPDATE places SET name = ? WHERE id = ?').run(name, id);
  res.json({ id, name });
}));
// Delete = hide from the app. History and stats keep the name.
app.delete('/api/places/:id', wrap((req, res) => {
  q('UPDATE places SET archived_at = ? WHERE id = ?').run(now(), Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/tags', wrap((req, res) => {
  const tag = getOrCreateTagByName(req.body.name);
  if (!tag) throw bad('Name required');
  res.json({ id: tag.id, name: tag.name });
}));
// Rename an activity and its memes folder, and fix the saved meme paths.
app.patch('/api/tags/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const name = cleanName(req.body.name);
  if (!name) throw bad('Name required');
  const tag = q('SELECT * FROM tags WHERE id = ?').get(id);
  if (!tag) throw notFound();
  if (q('SELECT id FROM tags WHERE name = ? AND id != ?').get(name, id)) throw conflict('That activity already exists');
  if (scanning) await scanning;
  const folder = folderFor(name);
  if (folder !== tag.folder) {
    const oldDir = path.join(MEMES, tag.folder);
    const newDir = path.join(MEMES, folder);
    const sameDir = fs.existsSync(newDir) && fs.existsSync(oldDir) && fs.realpathSync(newDir) === fs.realpathSync(oldDir);
    if (fs.existsSync(newDir) && !sameDir) throw conflict('A memes folder with that name already exists');
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir); else fs.mkdirSync(newDir, { recursive: true });
    const prefix = tag.folder + '/';
    db.exec('BEGIN');
    try {
      for (const m of q('SELECT id, file FROM media WHERE substr(file, 1, ?) = ?').all(prefix.length, prefix)) {
        q('UPDATE media SET file = ? WHERE id = ?').run(folder + '/' + m.file.slice(prefix.length), m.id);
      }
      q('UPDATE tags SET name = ?, folder = ? WHERE id = ?').run(name, folder, id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else {
    q('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
  }
  res.json({ id, name });
}));
// Delete = hide from the app. History, stats and its memes stay.
app.delete('/api/tags/:id', wrap((req, res) => {
  q('UPDATE tags SET archived_at = ? WHERE id = ?').run(now(), Number(req.params.id));
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

// =====================================================================
// Location + notifications
//  1. OwnTracks on the iPhone posts your location to /api/owntracks.
//  2. If you are inside a pinned place's radius, that's "arriving".
//  3. The server guesses the activity from what you usually log there
//     at that time of day, saves a suggestion that starts at the
//     arrival time, and sends a push notification.
//  4. Confirming the suggestion in the app logs it from the arrival time.
// =====================================================================
const getMeta = (key) => { const r = q('SELECT value FROM meta WHERE key = ?').get(key); return r ? r.value : null; };
const setMeta = (key, value) => q('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

// --- push notifications (keys are made once and saved in the data folder) ---
const VAPID_FILE = path.join(DATA, 'vapid.json');
if (!fs.existsSync(VAPID_FILE)) fs.writeFileSync(VAPID_FILE, JSON.stringify(webpush.generateVAPIDKeys()));
const VAPID = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
webpush.setVapidDetails('mailto:schedule@example.com', VAPID.publicKey, VAPID.privateKey);

async function sendPush(payload) {
  for (const row of q('SELECT * FROM push_subs').all()) {
    try {
      await webpush.sendNotification(JSON.parse(row.sub), JSON.stringify(payload));
    } catch (e) {
      // 404/410 = the phone removed this subscription
      if (e.statusCode === 404 || e.statusCode === 410) q('DELETE FROM push_subs WHERE id = ?').run(row.id);
      else console.error('push failed', e.statusCode || e.message);
    }
  }
}

app.get('/api/push/key', (_req, res) => res.json({ key: VAPID.publicKey }));
app.post('/api/push/subscribe', wrap((req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) throw bad('No subscription');
  q('INSERT INTO push_subs (endpoint, sub) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET sub = excluded.sub').run(sub.endpoint, JSON.stringify(sub));
  res.json({ ok: true });
}));
app.post('/api/push/test', wrap(async (_req, res) => {
  await sendPush({ title: 'Schedule', body: 'Notifications work', url: '/app/' });
  res.json({ ok: true, phones: q('SELECT COUNT(*) AS n FROM push_subs').get().n });
}));

// --- place pins ---
app.put('/api/places/:id/location', wrap((req, res) => {
  const id = Number(req.params.id);
  if (!q('SELECT id FROM places WHERE id = ?').get(id)) throw notFound();
  if (req.body.clear) {
    q('UPDATE places SET lat = NULL, lng = NULL WHERE id = ?').run(id);
  } else {
    const lat = Number(req.body.lat), lng = Number(req.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('Need lat and lng');
    q('UPDATE places SET lat = ?, lng = ? WHERE id = ?').run(lat, lng, id);
    if (req.body.radius) q('UPDATE places SET radius = ? WHERE id = ?').run(Number(req.body.radius), id);
  }
  res.json(q('SELECT id, name, lat, lng, radius FROM places WHERE id = ?').get(id));
}));

// Distance in meters between two lat/lng points.
function meters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// The pinned place you're inside, or null. stretch > 1 makes the circle bigger
// (used so a little GPS wobble at the edge doesn't count as leaving).
function placeAt(lat, lng, acc, stretch = 1) {
  let best = null;
  for (const p of q('SELECT * FROM places WHERE lat IS NOT NULL AND archived_at IS NULL').all()) {
    const d = meters(lat, lng, p.lat, p.lng);
    if (d <= p.radius * stretch + Math.min(acc || 0, 100) && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

// Guess the activity from what you've logged at this place before:
// first look only at entries started within 2 hours of this time of day;
// if there are none, use everything you've logged at this place.
function guessTag(placeId, at) {
  const hour = at.getHours();
  const near = new Map(), all = new Map();
  const rows = q(`SELECT e.tag_id, e.started_at FROM entries e JOIN tags t ON t.id = e.tag_id
                  WHERE e.place_id = ? AND t.archived_at IS NULL`).all(placeId);
  for (const r of rows) {
    const h = new Date(r.started_at).getHours();
    const diff = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour));
    all.set(r.tag_id, (all.get(r.tag_id) || 0) + 1);
    if (diff <= 2) near.set(r.tag_id, (near.get(r.tag_id) || 0) + 1);
  }
  const counts = near.size ? near : all;
  let bestId = null, best = 0;
  for (const [id, n] of counts) if (n > best) { bestId = id; best = n; }
  return bestId;
}

async function handleLocation(lat, lng, acc, at) {
  q('INSERT INTO locations (at, lat, lng, acc) VALUES (?, ?, ?, ?)').run(at.toISOString(), lat, lng, acc ?? null);

  const prevId = getMeta('geo_place') ? Number(getMeta('geo_place')) : null;
  // Still at the previous place? (use a 1.5x bigger circle to ignore wobble)
  if (prevId) {
    const prev = placeAt(lat, lng, acc, 1.5);
    if (prev && prev.id === prevId) return { place: prev.name, changed: false };
  }
  const place = placeAt(lat, lng, acc);
  const newId = place ? place.id : null;
  if (newId === prevId) return { place: place ? place.name : null, changed: false };
  setMeta('geo_place', newId ?? '');
  if (!place) return { place: null, changed: true }; // left a place: nothing to ask

  // Arrived somewhere new.
  const cur = q(CURRENT_SQL).get();
  if (cur && cur.place_id === place.id) return { place: place.name, changed: true }; // already logged here
  q("UPDATE suggestions SET status = 'expired' WHERE status = 'pending'").run();
  const tagId = guessTag(place.id, at);
  q('INSERT INTO suggestions (at, place_id, tag_id) VALUES (?, ?, ?)').run(at.toISOString(), place.id, tagId);
  const tag = tagId ? q('SELECT name FROM tags WHERE id = ?').get(tagId) : null;
  await sendPush({
    title: place.name.toUpperCase(),
    body: tag ? `${tag.name.toUpperCase()}?` : 'WHAT ARE YOU DOING?',
    url: '/app/#suggest',
    tag: 'arrive',
  });
  return { place: place.name, changed: true, suggested: tag ? tag.name : null };
}

// OwnTracks (iPhone app) sends {_type: "location", lat, lon, acc, tst}.
// It expects a JSON array back.
app.post('/api/owntracks', wrap(async (req, res) => {
  const b = req.body || {};
  if (b._type === 'location' && Number.isFinite(b.lat) && Number.isFinite(b.lon)) {
    await handleLocation(b.lat, b.lon, b.acc, b.tst ? new Date(b.tst * 1000) : new Date());
  }
  res.json([]);
}));
// Plain version (for testing or iOS Shortcuts): {lat, lng, acc?}
app.post('/api/location', wrap(async (req, res) => {
  const lat = Number(req.body.lat), lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw bad('Need lat and lng');
  res.json(await handleLocation(lat, lng, req.body.acc, new Date()));
}));

// --- suggestions ---
const SUGGESTION_SQL = `
SELECT s.id, s.at, s.place_id, p.name AS place, s.tag_id, t.name AS tag
FROM suggestions s
LEFT JOIN places p ON p.id = s.place_id
LEFT JOIN tags t ON t.id = s.tag_id`;
app.get('/api/suggestion', wrap((_req, res) => {
  const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  res.json(q(`${SUGGESTION_SQL} WHERE s.status = 'pending' AND s.at > ? ORDER BY s.at DESC LIMIT 1`).get(since) || null);
}));
// Accept: log the activity starting at the arrival time.
app.post('/api/suggestion/:id/accept', wrap((req, res) => {
  const s = q('SELECT * FROM suggestions WHERE id = ?').get(Number(req.params.id));
  if (!s || s.status !== 'pending') throw bad('That suggestion is gone');
  const tagId = Number(req.body.tag_id);
  const placeId = req.body.place_id == null ? null : Number(req.body.place_id);
  if (!q('SELECT id FROM tags WHERE id = ?').get(tagId)) throw bad('Pick what you are doing');
  // If you already switched by hand after arriving, start now instead.
  const cur = q(CURRENT_SQL).get();
  const start = cur && cur.started_at > s.at ? now() : s.at;
  q('INSERT INTO entries (started_at, place_id, tag_id) VALUES (?, ?, ?)').run(start, placeId, tagId);
  q("UPDATE suggestions SET status = 'accepted' WHERE id = ?").run(s.id);
  res.json(withUrl(q(CURRENT_SQL).get()));
}));
app.post('/api/suggestion/:id/dismiss', wrap((req, res) => {
  q("UPDATE suggestions SET status = 'dismissed' WHERE id = ?").run(Number(req.params.id));
  res.json({ ok: true });
}));

// --- reminder when one activity runs a long time ---
const NUDGE_HOURS = Number(process.env.NUDGE_HOURS || 3);
async function nudge() {
  const cur = q(CURRENT_SQL).get();
  if (!cur || !cur.tag || /sleep/i.test(cur.tag)) return;
  const hour = new Date().getHours();
  if (hour < 8 || hour >= 23) return; // no reminders at night
  const hrs = (Date.now() - new Date(cur.started_at).getTime()) / 3600000;
  if (hrs < NUDGE_HOURS || getMeta('nudged_entry') === String(cur.id)) return;
  setMeta('nudged_entry', cur.id);
  await sendPush({ title: `STILL ${cur.tag.toUpperCase()}?`, body: `${Math.floor(hrs)}H SO FAR`, url: '/app/#switch', tag: 'nudge' });
}
setInterval(() => nudge().catch((e) => console.error('nudge failed', e)), 10 * 60 * 1000);
setTimeout(() => nudge().catch((e) => console.error('nudge failed', e)), 30 * 1000);

app.get('/app', (_req, res) => res.redirect('/app/'));

scanMemes().catch((e) => console.error('scan failed', e)).finally(() => {
  app.listen(PORT, HOST, () => console.log(`Schedule running on http://${HOST}:${PORT}  (phone: /app/  website: /)  data: ${ROOT}`));
});
setInterval(() => scanMemes().catch(() => {}), 5 * 60 * 1000);
