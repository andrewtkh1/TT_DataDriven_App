"use strict";

// ---- Config -------------------------------------------------------------
const PROBE_MS = 15000, STATUS_MS = 60000, TIMEOUT_MS = 5000;
const MAX_SAMPLES = 120;            // ~30 min of history per target
const SLOW_ABS = 600, SLOW_REL = 2.5;
const STORE_KEY = "meorthem.v1";

// status = Atlassian Statuspage summary endpoint (public, CORS-enabled)
const PROVIDERS = [
  { id: "github",     name: "GitHub",     probe: "https://api.github.com/zen",                 status: "https://www.githubstatus.com/api/v2/summary.json" },
  { id: "cloudflare", name: "Cloudflare", probe: "https://1.1.1.1/cdn-cgi/trace", status: "https://www.cloudflarestatus.com/api/v2/summary.json" },
  { id: "discord",    name: "Discord",    probe: "https://discord.com/api/v10/gateway",        status: "https://discordstatus.com/api/v2/summary.json" },
  { id: "openai",     name: "OpenAI",     probe: "https://api.openai.com/v1/models",           status: "https://status.openai.com/api/v2/summary.json" },
  { id: "netlify",    name: "Netlify",    probe: "https://www.netlify.com/favicon.ico",        status: "https://www.netlifystatus.com/api/v2/summary.json" },
];
const CONTROLS = [
  { id: "google", name: "Google",         probe: "https://www.google.com/generate_204" },
  { id: "wiki",   name: "Wikipedia",      probe: "https://en.wikipedia.org/static/favicon/wikipedia.ico" },
];

// ---- State --------------------------------------------------------------
let hist = {};      // id -> [{t, ms|null}]
let statuses = {};  // id -> {ok, indicator, description, incidents[], at}
let paused = false;
try { hist = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (_) { hist = {}; }
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(hist)); } catch (_) {} };

// ---- Measurement --------------------------------------------------------
async function timeOnce(url) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const u = url + (url.includes("?") ? "&" : "?") + "_=" + Date.now() + Math.random().toString(36).slice(2, 6);
  const t0 = performance.now();
  try {
    // no-cors: response is opaque but timing still reflects the round trip,
    // and it works for endpoints that send no CORS headers.
    await fetch(u, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: ctl.signal });
    return Math.round(performance.now() - t0);
  } catch (_) {
    return null;                    // network failure / timeout
  } finally { clearTimeout(to); }
}

async function probeAll() {
  const all = [...PROVIDERS, ...CONTROLS];
  const res = await Promise.all(all.map(async p => [p.id, await timeOnce(p.probe)]));
  const t = Date.now();
  for (const [id, ms] of res) {
    (hist[id] = hist[id] || []).push({ t, ms });
    if (hist[id].length > MAX_SAMPLES) hist[id].shift();
  }
  save(); render();
}

async function fetchStatus(p) {
  try {
    const r = await fetch(p.status, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    statuses[p.id] = {
      ok: true,
      indicator: j.status.indicator,            // none | minor | major | critical
      description: j.status.description,
      incidents: (j.incidents || []).map(i => i.name),
      at: Date.now(),
    };
  } catch (_) {
    statuses[p.id] = { ok: false, at: Date.now() };
  }
}
async function statusAll() { await Promise.all(PROVIDERS.map(fetchStatus)); render(); }

// ---- Analysis -----------------------------------------------------------
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// state: "ok" | "slow" | "down" | "none"
function probeState(id) {
  const h = hist[id] || [];
  if (!h.length) return { state: "none" };
  const last = h[h.length - 1].ms;
  if (last == null) return { state: "down", last };
  const base = median(h.slice(0, -1).slice(-20).map(s => s.ms));
  const slow = last > SLOW_ABS && (base == null || last > base * SLOW_REL);
  return { state: slow ? "slow" : "ok", last, base };
}

function verdict() {
  const ctl = CONTROLS.map(c => probeState(c.id));
  if (ctl.every(c => c.state === "none")) return { cls: "checking", title: "Checking…", detail: "Running the first measurements." };
  const ctlBad = ctl.filter(c => c.state === "down" || c.state === "slow").length;
  const ctlDown = ctl.filter(c => c.state === "down").length;

  if (ctlDown === CONTROLS.length) {
    return { cls: "bad", title: "It's probably you",
      detail: "Even the control endpoints are unreachable, so your connection (Wi-Fi, router, VPN, DNS or ISP) is the likely culprit." };
  }
  if (ctlBad === CONTROLS.length) {
    return { cls: "warn", title: "It's probably you (degraded local connection)",
      detail: "All control endpoints are slow right now, which points to your own network or ISP rather than a single provider." };
  }

  const bad = PROVIDERS.map(p => ({ p, s: probeState(p.id), st: statuses[p.id] }))
    .filter(x => x.s.state === "down" || x.s.state === "slow" || (x.st && x.st.ok && x.st.indicator !== "none"));
  if (!bad.length) {
    const checked = PROVIDERS.filter(p => probeState(p.id).state === "ok").length;
    return { cls: "ok", title: "All clear",
      detail: `Your connection looks fine and ${checked} of ${PROVIDERS.length} providers are responding normally with no reported incidents.` };
  }
  const lines = bad.map(({ p, s, st }) => {
    const reported = st && st.ok && st.indicator !== "none";
    const measured = s.state === "down" || s.state === "slow";
    if (reported && measured) return `${p.name}: confirmed — slow/unreachable from here and the provider reports an incident.`;
    if (reported) return `${p.name}: provider reports an incident (${st.description.toLowerCase()}) but latency from here is normal.`;
    return `${p.name}: ${s.state === "down" ? "unreachable" : "slow"} from here but no incident reported (could be a regional or path issue).`;
  });
  const measured = bad.some(({ s }) => s.state === "down" || s.state === "slow");
  if (!measured) return { cls: "warn", title: "Incident reported, but not affecting you", detail: "Your connection is fine. " + lines.join("  ") };
  const confirmed = bad.some(({ s, st }) => (s.state !== "ok") && st && st.ok && st.indicator !== "none");
  return { cls: confirmed ? "bad" : "warn", title: "It's probably them", detail: lines.join("  ") };
}

// ---- Rendering ----------------------------------------------------------
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function spark(h) {
  const W = 220, H = 44, pts = h.slice(-60);
  if (pts.length < 2) return `<svg class="spark" viewBox="0 0 ${W} ${H}"></svg>`;
  const vals = pts.map(s => s.ms).filter(v => v != null);
  const max = Math.max(100, ...vals);
  const x = i => (i / (pts.length - 1)) * (W - 4) + 2;
  const y = v => H - 3 - (v / max) * (H - 8);
  let line = "", seg = [], dots = "";
  const flush = () => { if (seg.length > 1) line += `<polyline points="${seg.join(" ")}"/>`; seg = []; };
  pts.forEach((s, i) => {
    if (s.ms == null) { flush(); dots += `<circle class="x" cx="${x(i)}" cy="${H - 4}" r="2.5"/>`; }
    else seg.push(`${x(i).toFixed(1)},${y(s.ms).toFixed(1)}`);
  });
  flush();
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${line}${dots}</svg>`;
}

function probeBadge(s) {
  return { ok: ["ok", "Normal"], slow: ["warn", "Slow"], down: ["bad", "Unreachable"], none: ["na", "…"] }[s.state];
}

function card(p, withStatus) {
  const s = probeState(p.id), [cls, label] = probeBadge(s);
  const h = hist[p.id] || [];
  const med = median(h.map(x => x.ms));
  let inc = "";
  if (withStatus) {
    const st = statuses[p.id];
    if (!st) inc = `<p class="inc">Status: loading…</p>`;
    else if (!st.ok) inc = `<p class="inc">Status: unavailable</p>`;
    else if (st.indicator === "none") inc = `<p class="inc">Status: all systems operational</p>`;
    else inc = `<p class="inc hot">Status: ${esc(st.description)}${st.incidents.length ? " — " + esc(st.incidents.slice(0, 2).join("; ")) : ""}</p>`;
  }
  const now = s.last == null ? (s.state === "none" ? "—" : "×") : s.last;
  return `<div class="card"><h3>${esc(p.name)}<span class="badge ${cls}">${label}</span></h3>
    <div class="ms">${now}<small> ms${med != null ? ` · median ${med}` : ""}</small></div>
    ${spark(h)}${inc}</div>`;
}

function render() {
  $("cards").innerHTML = PROVIDERS.map(p => card(p, true)).join("");
  $("controls").innerHTML = CONTROLS.map(p => card(p, false)).join("");
  const v = verdict(), el = $("verdict");
  el.className = "verdict " + v.cls;
  el.innerHTML = `<div class="v-title">${esc(v.title)}</div><div class="v-detail">${esc(v.detail)}</div>`;
  $("meta").textContent = "Last updated " + new Date().toLocaleTimeString() + (paused ? " (paused)" : "");
}

// ---- Wire up ------------------------------------------------------------
$("clear").onclick = () => { hist = {}; save(); render(); };
$("pause").onclick = e => { paused = !paused; e.target.textContent = paused ? "Resume" : "Pause"; render(); };
render();
probeAll(); statusAll();
setInterval(() => { if (!paused && !document.hidden) probeAll(); }, PROBE_MS);
setInterval(() => { if (!paused && !document.hidden) statusAll(); }, STATUS_MS);
