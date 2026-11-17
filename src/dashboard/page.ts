// The dashboard page: one self-contained HTML file, no external scripts, fonts or images.
// It fetches `api/state` from the same local server every 10 seconds and fills the cards with plain text.
import { LOGO_SVG } from './logo.ts'

export function page(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Mapshift Dashboard</title>
<style nonce="${nonce}">
:root {
  --bg: #f6f8fb; --card: #ffffff; --ink: #0b1530; --muted: #5b6785; --line: #e3e8f2; --accent: #0e7490; --track: #e8edf5;
  --ok: #3fb950; --mid: #e3b341; --high: #f85149;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #070d20; --card: #0f1a36; --ink: #eef2ff; --muted: #94a3c7; --line: #1f2c50; --accent: #5eead4; --track: #1c2848; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 'Segoe UI', system-ui, -apple-system, sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 20px 16px 8px; max-width: 1100px; margin: 0 auto; }
header svg { width: 40px; height: 40px; flex: none; }
header h1 { font-size: 22px; margin: 0; letter-spacing: -0.3px; }
header h1 span { color: var(--accent); }
header .project { color: var(--muted); font-size: 14px; margin-left: auto; text-align: right; overflow-wrap: anywhere; }
main { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; padding: 16px; max-width: 1100px; margin: 0 auto; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 18px; min-width: 0; }
section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 12px; }
.big { font-size: 30px; font-weight: 700; letter-spacing: -0.5px; }
.muted { color: var(--muted); font-size: 13px; }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); }
.row:first-of-type { border-top: 0; }
.row b { font-weight: 600; text-align: right; }
.rings { display: flex; gap: 24px; flex-wrap: wrap; }
.ring { text-align: center; }
.ring svg { width: 112px; height: 112px; }
.ring .label { font-weight: 600; }
.bars { margin-top: 10px; }
.barline { display: grid; grid-template-columns: 110px 1fr auto; gap: 8px; align-items: center; margin: 6px 0; font-size: 13px; }
.track { height: 10px; background: var(--track); border-radius: 5px; overflow: hidden; }
.fill { height: 100%; background: var(--accent); border-radius: 5px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td { padding: 6px 4px; border-top: 1px solid var(--line); vertical-align: top; }
td:last-child { text-align: right; white-space: nowrap; }
.wide { grid-column: 1 / -1; }
footer { text-align: center; color: var(--muted); font-size: 12px; padding: 8px 16px 24px; }
@media (max-width: 480px) { header .project { display: none; } .barline { grid-template-columns: 90px 1fr auto; } }
</style>
</head>
<body>
<header>
${LOGO_SVG.replace('<svg ', '<svg aria-hidden="true" ')}
<h1>Map<span>shift</span></h1>
<div class="project" id="project"></div>
</header>
<main>
  <section><h2>Map</h2>
    <div class="big" id="map-state">…</div>
    <div class="muted" id="map-detail"></div>
    <div class="bars">
      <div class="row"><span>Lookups today</span><b id="lookups">0</b></div>
      <div class="row"><span>This week</span><b id="lookups-week">0</b></div>
      <div class="row"><span>By agent</span><b id="by-agent">none yet</b></div>
    </div>
  </section>
  <section><h2>Limits</h2>
    <div class="rings" id="rings"></div>
    <div class="muted" id="limits-note">No Codex sessions found on this computer.</div>
  </section>
  <section><h2>Savings</h2>
    <div class="big" id="saved">0</div>
    <div class="muted">tokens at most, today (upper bound: whole files the map pointed to, minus its answers)</div>
    <div class="bars">
      <div class="barline"><span>Without map</span><div class="track"><div class="fill" id="bar-without"></div></div><span id="t-without">0</span></div>
      <div class="barline"><span>With map</span><div class="track"><div class="fill" id="bar-with"></div></div><span id="t-with">0</span></div>
    </div>
    <div class="muted" id="codex-tokens"></div>
    <div class="muted">Dollar figures appear only where an agent reports what you really paid.</div>
  </section>
  <section class="wide"><h2>Recent activity</h2>
    <table><tbody id="recent"><tr><td class="muted">No map lookups in this project yet.</td><td></td></tr></tbody></table>
  </section>
</main>
<footer>Everything on this page is read on this computer and never leaves it. <span id="updated"></span></footer>
<script nonce="${nonce}">
(() => {
  const $ = id => document.getElementById(id);
  const fmt = x => Number(x || 0).toLocaleString('en-US');
  const color = p => (p >= 85 ? '#f85149' : p >= 65 ? '#e3b341' : '#3fb950');
  const ago = ts => {
    if (!ts) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  };
  const resets = at => {
    if (!at) return '';
    const d = new Date(at);
    const mins = Math.max(0, Math.round((at - Date.now()) / 60000));
    const when = d.toLocaleString('en-US', mins >= 1440 ? { weekday: 'short', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
    return 'resets ' + when;
  };
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const e = tag === 'svg' || tag === 'circle' || tag === 'text' ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  function ring(limit) {
    const p = limit.reset ? 0 : Math.round(limit.usedPercent);
    const r = 46, c = 2 * Math.PI * r;
    const box = el('div', { class: 'ring' });
    const svg = el('svg', { viewBox: '0 0 112 112', role: 'img', 'aria-label': limit.label + ' ' + p + '% used' });
    const track = el('circle', { cx: 56, cy: 56, r, fill: 'none', 'stroke-width': 10 });
    track.style.stroke = 'var(--track)';
    svg.appendChild(track);
    svg.appendChild(el('circle', { cx: 56, cy: 56, r, fill: 'none', stroke: color(p), 'stroke-width': 10, 'stroke-linecap': p ? 'round' : 'butt',
      'stroke-dasharray': (c * p / 100) + ' ' + c, transform: 'rotate(-90 56 56)' }));
    svg.appendChild(el('text', { x: 56, y: 62, 'text-anchor': 'middle', 'font-size': 20, 'font-weight': 700, fill: 'currentColor' }, p + '%'));
    box.appendChild(svg);
    box.appendChild(el('div', { class: 'label' }, limit.label));
    box.appendChild(el('div', { class: 'muted' }, limit.reset ? 'fresh window' : resets(limit.resetsAt)));
    return box;
  }
  function render(s) {
    $('project').textContent = s.project.name + '  ·  ' + s.project.shown;
    const m = s.map;
    $('map-state').textContent = m.state === 'ready' ? 'Ready' : m.state === 'building' ? 'Building ' + m.percent + '%' : 'Not built yet';
    $('map-detail').textContent = m.state === 'none' ? 'It builds the first time an agent asks the map something here.'
      : fmt(m.files) + ' files · ' + fmt(m.symbols) + ' definitions · updated ' + ago(m.builtAt);
    $('lookups').textContent = fmt(s.today.lookups);
    $('lookups-week').textContent = fmt(s.week.lookups);
    $('by-agent').textContent = s.today.byAgent.length ? s.today.byAgent.map(b => b.label + ' ' + fmt(b.n)).join(' · ') : 'none yet';
    $('saved').textContent = fmt(s.today.savedUpperBound);
    const max = Math.max(1, s.today.withoutMap, s.today.withMap);
    $('bar-without').style.width = (100 * s.today.withoutMap / max) + '%';
    $('bar-with').style.width = (100 * s.today.withMap / max) + '%';
    $('t-without').textContent = fmt(s.today.withoutMap);
    $('t-with').textContent = fmt(s.today.withMap);
    const rings = $('rings');
    rings.replaceChildren();
    const cx = s.codex;
    if (cx && cx.limits.length) {
      for (const l of cx.limits) rings.appendChild(ring(l));
      $('limits-note').textContent = 'Codex' + (cx.plan ? ' · ' + cx.plan + ' plan' : '') + ' · as of ' + ago(cx.at);
    } else {
      $('limits-note').textContent = cx ? 'Codex has not reported its limits yet.' : 'No Codex sessions found on this computer.';
    }
    $('codex-tokens').textContent = cx && cx.today.sessions
      ? 'Codex today: ' + fmt(cx.today.input + cx.today.output) + ' tokens (' + fmt(cx.today.cached) + ' cached) in ' + cx.today.sessions + ' session' + (cx.today.sessions === 1 ? '' : 's') + '.'
      : '';
    const body = $('recent');
    body.replaceChildren();
    if (!s.recent.length) {
      const tr = el('tr'); tr.appendChild(el('td', { class: 'muted' }, 'No map lookups in this project yet.')); tr.appendChild(el('td')); body.appendChild(tr);
    }
    for (const r of s.recent) {
      const tr = el('tr');
      tr.appendChild(el('td', {}, r.agent + ' · ' + r.tool.replace('map_', '') + ' · pointed to ' + r.files + ' file' + (r.files === 1 ? '' : 's') + ' (' + fmt(r.pointedTokens) + ' tokens) · answer ' + fmt(r.answerTokens) + ' tokens'));
      tr.appendChild(el('td', { class: 'muted' }, ago(r.ts)));
      body.appendChild(tr);
    }
    $('updated').textContent = 'Updated ' + new Date(s.generatedAt).toLocaleTimeString('en-US') + '.';
  }
  async function tick() {
    try {
      const res = await fetch('api/state', { cache: 'no-store' });
      if (res.ok) render(await res.json());
      else $('updated').textContent = 'The dashboard has stopped. Run mapshift dash again.';
    } catch {
      $('updated').textContent = 'The dashboard has stopped. Run mapshift dash again.';
    }
  }
  tick();
  setInterval(tick, 10000);
})();
</script>
</body>
</html>
`
}
