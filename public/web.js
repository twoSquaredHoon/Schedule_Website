// Website: Timeline, Stats, Memes. Everything comes from the same database the phone app writes to.
const $ = (id) => document.getElementById(id);
const { api, dur, hours, color, esc, time, startOfDay, addDays, clock } = window.LL;

const W = { page: 'timeline', day: startOfDay(new Date()), place: null, range: 7, current: null };
const PAGES = ['timeline', 'stats', 'memes'];

// ---------- helpers ----------
// Clip each entry to [from, to) and to "now" so the running one counts up to the present.
function clip(entries, from, to, nowMs) {
  return entries.map((e) => {
    const s = Math.max(new Date(e.started_at).getTime(), from.getTime());
    const end = e.ended_at ? new Date(e.ended_at).getTime() : nowMs;
    const f = Math.min(end, to.getTime(), nowMs);
    return { ...e, s, f, ms: Math.max(0, f - s) };
  }).filter((e) => e.ms > 0 || !e.ended_at);
}
function totalsBy(clipped, key, nameKey) {
  const m = new Map();
  for (const e of clipped) {
    const k = e[key] ?? 0;
    const cur = m.get(k) || { id: e[key], name: e[nameKey] || '—', ms: 0, n: 0 };
    cur.ms += e.ms; cur.n += 1; m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.ms - a.ms);
}
const dayName = (d) => d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const shortDate = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
const isToday = (d) => startOfDay(new Date()).getTime() === d.getTime();
const X = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

// ---------- header ----------
let pillTimer = null;
async function refreshNow() {
  try {
    const st = await api('/api/state');
    W.current = st.current;
  } catch { W.current = null; }
  clearInterval(pillTimer);
  $('nowPill').hidden = !W.current;
  if (!W.current) return;
  $('nowPillTag').textContent = W.current.tag || '—';
  const start = new Date(W.current.started_at).getTime();
  const tick = () => { $('nowPillTime').textContent = clock(Date.now() - start); };
  tick(); pillTimer = setInterval(tick, 1000);
}

function route() {
  const p = (location.hash || '#timeline').slice(1);
  W.page = PAGES.includes(p) ? p : 'timeline';
  for (const id of PAGES) $(id).hidden = id !== W.page;
  document.querySelectorAll('.tabs a').forEach((a) => { if (a.dataset.tab === W.page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('rangeSeg').hidden = W.page === 'timeline';
  render();
}
window.addEventListener('hashchange', route);
$('rangeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  W.range = Number(b.dataset.range);
  render();
});

function render() {
  document.querySelectorAll('#rangeSeg button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === W.range)));
  refreshNow();
  if (W.page === 'timeline') return renderTimeline().catch(console.error);
  if (W.page === 'stats') return renderStats().catch(console.error);
  return renderMemes().catch(console.error);
}

// ---------- timeline ----------
$('prevDay').addEventListener('click', () => { W.day = addDays(W.day, -1); renderTimeline(); });
$('nextDay').addEventListener('click', () => { if (!isToday(W.day)) { W.day = addDays(W.day, 1); renderTimeline(); } });
$('placeFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  W.place = b.dataset.id ? Number(b.dataset.id) : null;
  renderTimeline();
});
$('feed').addEventListener('click', async (e) => {
  const b = e.target.closest('button.del');
  if (!b || !confirm('Delete this entry?')) return;
  await api(`/api/entries/${b.dataset.id}`, { method: 'DELETE' });
  renderTimeline(); refreshNow();
});

async function renderTimeline() {
  const from = W.day, to = addDays(W.day, 1);
  const { entries, now } = await api(`/api/entries?from=${from.toISOString()}&to=${to.toISOString()}`);
  const nowMs = Math.max(Date.now(), new Date(now).getTime());
  const all = clip(entries, from, to, nowMs);

  $('dayLabel').textContent = isToday(W.day) ? 'Today' : shortDate(W.day);
  $('dayTitle').textContent = dayName(W.day);
  $('nextDay').disabled = isToday(W.day);

  const span = 24 * 3600 * 1000;
  $('dayStrip').innerHTML = all.map((e) =>
    `<span title="${esc(e.tag)}" style="left:${((e.s - from) / span) * 100}%;width:${(e.ms / span) * 100}%;background:${color(e.tag_id)}"></span>`).join('');
  $('dayLegend').innerHTML = totalsBy(all, 'tag_id', 'tag').map((t) =>
    `<div class="legend-row"><span class="dot" style="background:${color(t.id)}"></span><span class="name">${esc(t.name)}</span><span class="t">${dur(t.ms)}</span></div>`).join('');

  const places = totalsBy(all, 'place_id', 'place').filter((p) => p.id);
  if (W.place && !places.some((p) => p.id === W.place)) W.place = null;
  $('placeFilter').innerHTML = `<button type="button" class="chip" aria-pressed="${W.place == null}">All</button>` +
    places.map((p) => `<button type="button" class="chip" data-id="${p.id}" aria-pressed="${W.place === p.id}">${esc(p.name)}</button>`).join('');

  const shown = all.filter((e) => W.place == null || e.place_id === W.place).reverse();
  $('feedEmpty').hidden = shown.length > 0;
  $('feed').innerHTML = shown.map((e) => {
    const full = (e.ended_at ? new Date(e.ended_at).getTime() : nowMs) - new Date(e.started_at).getTime();
    return `<article class="entry">
      <div class="when">${time(e.started_at)}</div>
      <div class="body">
        <div class="pic inset">${e.url ? `<img src="${e.url}" alt="" loading="lazy">` : ''}</div>
        <div class="info">
          ${e.ended_at ? '' : '<div class="live">Now</div>'}
          <div class="what">${esc(e.tag || '—')}</div>
          <div class="where"><span class="dot" style="background:${color(e.tag_id)}"></span>${e.place ? esc(e.place) : ''}</div>
        </div>
        <div class="right">
          <div class="len">${dur(full)}</div>
          <button type="button" class="del" data-id="${e.id}" aria-label="Delete entry">${X}</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

// ---------- stats ----------
function rangeBounds() {
  const to = addDays(startOfDay(new Date()), 1);
  const from = addDays(to, -W.range);
  return { from, to };
}
const rangeText = (from, to) => (W.range === 1 ? 'Today' : `Last ${W.range} days · ${shortDate(from)} – ${shortDate(addDays(to, -1))}`);

function barRows(list, max) {
  if (!list.length) return '<p class="empty muted">Nothing logged yet.</p>';
  return list.map((t) => `<div class="bar-row"><span class="name">${esc(t.name)}</span>
    <div class="track inset-sm"><div class="fill" style="width:${(t.ms / max) * 100}%;background:${t.c}"></div></div>
    <span class="h">${hours(t.ms)}</span></div>`).join('');
}

async function renderStats() {
  const { from, to } = rangeBounds();
  const { entries, now } = await api(`/api/entries?from=${from.toISOString()}&to=${to.toISOString()}`);
  const nowMs = Math.max(Date.now(), new Date(now).getTime());
  const all = clip(entries, from, to, nowMs);
  const total = all.reduce((a, e) => a + e.ms, 0);
  const possible = Math.min(nowMs, to.getTime()) - from.getTime();
  const started = entries.filter((e) => new Date(e.started_at) >= from);

  $('statsRange').textContent = rangeText(from, to);
  $('statsTotal').textContent = `${hours(total)} logged`;
  $('statsSub').textContent = `of ${hours(possible)} · ${started.length} switches · ${started.filter((e) => e.media_id).length} memes`;

  const tags = totalsBy(all, 'tag_id', 'tag').map((t) => ({ ...t, c: color(t.id) }));
  $('tagBars').innerHTML = barRows(tags, tags[0] ? tags[0].ms : 1);
  const places = totalsBy(all, 'place_id', 'place').map((p) => ({ ...p, name: p.id ? p.name : 'No place', c: 'var(--accent)' }));
  $('placeBars').innerHTML = barRows(places, places[0] ? places[0].ms : 1);

  $('dailyCard').hidden = W.range === 1;
  if (W.range === 1) return;
  const cols = [];
  for (let i = 0; i < W.range; i++) {
    const d0 = addDays(from, i), d1 = addDays(d0, 1);
    const day = clip(entries, d0, d1, nowMs);
    const byTag = totalsBy(day, 'tag_id', 'tag');
    const sum = day.reduce((a, e) => a + e.ms, 0);
    const label = W.range <= 7 ? d0.toLocaleDateString([], { weekday: 'short' }) : String(d0.getDate());
    cols.push(`<div class="col"><div class="tot">${sum ? hours(sum) : ''}</div>
      <div class="well inset-sm"><div class="stack">${byTag.map((t) =>
        `<div title="${esc(t.name)} ${dur(t.ms)}" style="height:${(t.ms / 86400000) * 192}px;background:${color(t.id)}"></div>`).join('')}</div></div>
      <div class="day">${label}</div></div>`);
  }
  $('dailyCols').innerHTML = cols.join('');
}

// ---------- memes ----------
async function renderMemes() {
  const { from, to } = rangeBounds();
  const [{ entries }, media, st] = await Promise.all([
    api(`/api/entries?from=${from.toISOString()}&to=${to.toISOString()}`),
    api('/api/media'),
    api('/api/state'),
  ]);
  const lib = media.rest;
  const byId = new Map(lib.map((m) => [m.id, m]));
  const inRange = entries.filter((e) => e.media_id && new Date(e.started_at) >= from);

  $('memesRange').textContent = rangeText(from, to);
  $('memesSub').textContent = `${inRange.length} picked · ${lib.length} in library`;

  const counts = new Map();
  for (const e of inRange) {
    const c = counts.get(e.media_id) || { n: 0, tags: new Map() };
    c.n += 1; c.tags.set(e.tag, (c.tags.get(e.tag) || 0) + 1);
    counts.set(e.media_id, c);
  }
  const top = [...counts.entries()].filter(([id]) => byId.has(id)).sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  $('topEmpty').hidden = top.length > 0;
  $('topMemes').innerHTML = top.map(([id, c], i) => {
    const tag = [...c.tags.entries()].sort((a, b) => b[1] - a[1])[0][0] || '';
    return `<div class="item"><div class="frame inset"><img src="${byId.get(id).url}" alt="" loading="lazy"><span class="rank raised-sm">${i + 1}</span></div>
      <div class="meta"><b>${esc(tag)}</b><span>${c.n}×</span></div></div>`;
  }).join('');

  $('byTag').innerHTML = st.tags.map((t) => {
    const ms = lib.filter((m) => m.tag_id === t.id);
    return `<div class="tagrow"><span class="tagname raised-sm">${esc(t.name)}</span>
      <div class="thumbs">${ms.length ? ms.slice(0, 6).map((m) => `<img src="${m.url}" alt="" loading="lazy">`).join('') : '<span class="muted small">No memes yet</span>'}</div>
      <span class="n">${ms.length}</span></div>`;
  }).join('') || '<p class="empty muted">Add activities in the app to see them here.</p>';

  $('libCount').textContent = `${lib.length} memes`;
  $('library').innerHTML = lib.map((m) => `<img src="${m.url}" alt="" loading="lazy">`).join('');
}

route();
setInterval(() => { if (!document.hidden && W.page === 'timeline' && isToday(W.day)) renderTimeline().catch(() => {}); }, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
