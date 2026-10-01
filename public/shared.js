// Small helpers used by both the phone app and the website.
window.LL = (() => {
  async function api(url, opts = {}) {
    const init = { ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
      delete init.json;
    }
    const res = await fetch(url, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  const pad = (n) => String(n).padStart(2, '0');
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  }
  function dur(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
  }
  function hours(ms) {
    if (ms < 3600000) return dur(ms);
    const h = ms / 3600000;
    return h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
  }
  const PALETTE = ['#4A63E7', '#E39A5A', '#C9729B', '#3E9B77', '#E5C46A', '#5B6799', '#8EA2F0', '#D2603A', '#9AA2AD', '#6DB59A', '#A86ED6', '#B08A5A'];
  const color = (id) => (id ? PALETTE[(id - 1) % PALETTE.length] : '#9AA2AD');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  return { api, clock, dur, hours, color, esc, time, startOfDay, addDays };
})();
