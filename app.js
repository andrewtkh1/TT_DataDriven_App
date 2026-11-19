"use strict";

// ---- Config -------------------------------------------------------------
const PROBE_MS = 15000, STATUS_MS = 60000, TIMEOUT_MS = 5000, STATUS_TIMEOUT_MS = 8000;
const MAX_SAMPLES = 120;            // ~30 min of history per target
const SLOW_ABS = 600, SLOW_REL = 2.5;
const STORE_KEY = "meorthem.v1";

// status = Atlassian Statuspage summary endpoint (public, CORS-enabled)
const DEFAULTS = [
  { id: "github",     name: "GitHub",     probe: "https://api.github.com/zen",                 status: "https://www.githubstatus.com/api/v2/summary.json" },
  { id: "cloudflare", name: "Cloudflare", probe: "https://1.1.1.1/cdn-cgi/trace", status: "https://www.cloudflarestatus.com/api/v2/summary.json" },
  { id: "discord",    name: "Discord",    probe: "https://discord.com/api/v10/gateway",        status: "https://discordstatus.com/api/v2/summary.json" },
  { id: "openai",     name: "OpenAI",     probe: "https://api.openai.com/v1/models",           status: "https://status.openai.com/api/v2/summary.json" },
  { id: "netlify",    name: "Netlify",    probe: "https://www.netlify.com/favicon.ico",        status: "https://www.netlifystatus.com/api/v2/summary.json" },
];
const MAX_CUSTOM = 20;
const PROV_KEY = "meorthem.providers.v1";
let custom = [];   // user-added: {id,name,probe,status|null,custom:true}
try { custom = (JSON.parse(localStorage.getItem(PROV_KEY)) || []).map(sanitize).filter(Boolean).slice(0, MAX_CUSTOM); } catch (_) { custom = []; }
const saveCustom = () => { try { localStorage.setItem(PROV_KEY, JSON.stringify(custom)); } catch (_) {} };
const providers = () => [...DEFAULTS, ...custom];

// Validate/normalise a provider from untrusted input (form, storage, share link).
function statusUrlFromDomain(d) {
  d = String(d || "").trim().replace(/^https?:\/\//i, "").replace(/[\/?#].*$/, "").toLowerCase();
  if (!d) return null;
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d) ? `https://${d}/api/v2/summary.json` : undefined;
}
// Reject loopback, private, link-local, IP-literal-IPv6 and single-label/internal hosts so a
// shared list can't make the browser probe the user's own network.
function isPublicHost(host) {
  host = host.toLowerCase();
  if (host.startsWith("[") || !host.includes(".")) return false;
  if (/\.(local|localhost|internal|lan|home|corp|intranet|test|invalid)$/.test(host)) return false;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}
function sanitize(p) {
  if (!p || typeof p !== "object") return null;
  const name = String(p.name || "").trim().slice(0, 40);
  let probe;
  try { const u = new URL(String(p.probe || "").trim()); if (u.protocol !== "https:" || !isPublicHost(u.hostname)) return null; probe = u.href; } catch (_) { return null; }
  if (!name) return null;
  let status = null;
  if (p.status) {
    try { const u = new URL(p.status); if (u.protocol !== "https:" || !isPublicHost(u.hostname) || !u.pathname.endsWith("/api/v2/summary.json")) return null; status = u.href; } catch (_) { return null; }
  }
  return { id: "c_" + btoa(probe).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), name, probe, status, custom: true };
}

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
  const list = [...providers(), ...CONTROLS];
  await Promise.all(list.map(async p => {
    const ms = await timeOnce(p.probe);
    // Skip providers removed while the probe was in flight (would resurrect their history).
    if (!providers().some(x => x.id === p.id) && !CONTROLS.some(x => x.id === p.id)) return;
    const h = (hist[p.id] = hist[p.id] || []);
    h.push({ t: Date.now(), ms });
    if (h.length > MAX_SAMPLES) h.shift();
    scheduleRender();
  }));
  save();
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; render(); }, 50);
}

async function fetchStatus(p) {
  try {
    const r = await fetch(p.status, { cache: "no-store", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
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
async function statusAll() { await Promise.all(providers().filter(p => p.status).map(fetchStatus)); render(); }

// ---- Analysis -----------------------------------------------------------
const isIncident = st => !!(st && st.ok && st.indicator !== "none" && st.indicator !== "maintenance");
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

  const badCtl = CONTROLS.filter((c, i) => ctl[i].state === "down" || ctl[i].state === "slow").map(c => c.name);
  const ctlNote = badCtl.length ? ` Note: control endpoint${badCtl.length > 1 ? "s" : ""} ${badCtl.join(", ")} ${badCtl.length > 1 ? "are" : "is"} also failing or slow, so part of this may be your own network.` : "";
  const bad = providers().map(p => ({ p, s: probeState(p.id), st: statuses[p.id] }))
    .filter(x => x.s.state === "down" || x.s.state === "slow" || isIncident(x.st));
  if (!bad.length) {
    const checked = providers().filter(p => probeState(p.id).state === "ok").length;
    if (ctlNote) return { cls: "warn", title: "Providers look fine, but a control is failing", detail: "All providers respond normally." + ctlNote };
    return { cls: "ok", title: "All clear",
      detail: `Your connection looks fine and ${checked} of ${providers().length} providers are responding normally with no reported incidents.` };
  }
  const lines = bad.map(({ p, s, st }) => {
    const reported = isIncident(st);
    const measured = s.state === "down" || s.state === "slow";
    if (reported && measured) return `${p.name}: confirmed — slow/unreachable from here and the provider reports an incident.`;
    if (reported) return `${p.name}: provider reports an incident (${st.description.toLowerCase()}) but latency from here is normal.`;
    return `${p.name}: ${s.state === "down" ? "unreachable" : "slow"} from here but no incident reported (could be a regional or path issue).`;
  });
  const measured = bad.some(({ s }) => s.state === "down" || s.state === "slow");
  if (!measured) return { cls: "warn", title: "Incident reported, but not affecting you", detail: "Your connection looks fine. " + lines.join("  ") + ctlNote };
  const confirmed = bad.some(({ s, st }) => s.state !== "ok" && isIncident(st));
  return { cls: confirmed ? "bad" : "warn", title: "It's probably them", detail: lines.join("  ") + ctlNote };
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
  if (withStatus && !p.status) inc = `<p class="inc">Status: no status feed (latency only)</p>`;
  else if (withStatus) {
    const st = statuses[p.id];
    if (!st) inc = `<p class="inc">Status: loading…</p>`;
    else if (!st.ok) inc = `<p class="inc">Status: unavailable</p>`;
    else if (st.indicator === "none") inc = `<p class="inc">Status: all systems operational</p>`;
    else inc = `<p class="inc hot">Status: ${esc(st.description)}${st.incidents.length ? " — " + esc(st.incidents.slice(0, 2).join("; ")) : ""}</p>`;
  }
  const now = s.last == null ? (s.state === "none" ? "—" : "×") : s.last;
  return `<div class="card"><h3>${esc(p.name)}<span class="badge ${cls}">${label}</span></h3>
    ${p.custom ? `<button class="rm" data-rm="${p.id}" type="button">Remove</button>` : ""}
    <div class="ms">${now}<small> ms${med != null ? ` · median ${med}` : ""}</small></div>
    ${spark(h)}${inc}</div>`;
}

function render() {
  $("cards").innerHTML = providers().map(p => card(p, true)).join("");
  $("controls").innerHTML = CONTROLS.map(p => card(p, false)).join("");
  const v = verdict(), el = $("verdict");
  el.className = "verdict " + v.cls;
  el.innerHTML = `<div class="v-title">${esc(v.title)}</div><div class="v-detail">${esc(v.detail)}</div>`;
  $("meta").textContent = "Last updated " + new Date().toLocaleTimeString() + (paused ? " (paused)" : "");
}

// ---- Add / remove / share providers --------------------------------------
const msg = (t, cls) => { const m = $("form-msg"); m.textContent = t; m.className = "form-msg " + (cls || ""); };
const exists = probe => providers().some(p => p.probe === probe);

$("add-form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector("button[type=submit]");
  if (custom.length >= MAX_CUSTOM) return msg(`Limit of ${MAX_CUSTOM} added providers reached. Remove one first.`, "bad");
  const rawProbe = f.probe.value.trim();
  if (/^http:\/\//i.test(rawProbe)) return msg("The probe URL must start with https:// (browsers block plain http from an https page).", "bad");
  const sUrl = statusUrlFromDomain(f.status.value);
  if (sUrl === undefined) return msg("That status domain doesn't look valid. Use something like status.example.com.", "bad");
  const p = sanitize({ name: f.pname.value, probe: /^https:\/\//i.test(rawProbe) ? rawProbe : "https://" + rawProbe, status: sUrl });
  if (!p) return msg("Name and a valid public https:// probe URL are required (localhost and private addresses are not allowed).", "bad");
  if (exists(p.probe)) return msg("A provider with that probe URL already exists.", "bad");

  btn.disabled = true; msg("Testing…");
  const warns = [];
  const ms = await timeOnce(p.probe);
  if (ms == null) warns.push("the probe URL didn't respond (it may be down, blocked, or unreachable from this browser)");
  if (p.status) {
    await fetchStatus(p);
    if (!statuses[p.id].ok) warns.push("the status feed couldn't be read (wrong domain, not a Statuspage site, or no CORS), so it will show latency only");
  }
  custom.push(p); saveCustom(); render();
  msg(warns.length ? `Added "${p.name}", but ${warns.join("; and ")}.` : `Added "${p.name}".`, warns.length ? "warn" : "ok");
  f.reset(); btn.disabled = false;
  probeAll();
});

$("cards").addEventListener("click", e => {
  const id = e.target.dataset && e.target.dataset.rm;
  if (!id) return;
  custom = custom.filter(p => p.id !== id); delete hist[id]; delete statuses[id];
  saveCustom(); save(); render();
});

const b64 = {
  enc: o => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: s => {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  },
};

$("share").onclick = async () => {
  if (!custom.length) return msg("Add at least one provider before sharing.", "warn");
  const url = location.origin + location.pathname + "#share=" + b64.enc(custom.map(({ name, probe, status }) => ({ name, probe, status })));
  try { await navigator.clipboard.writeText(url); msg("Share link copied to clipboard.", "ok"); }
  catch (_) { prompt("Copy this share link:", url); }
};

function checkShareLink() {
  const m = location.hash.match(/^#share=(.+)$/);
  if (!m) return;
  history.replaceState(null, "", location.pathname + location.search);
  let list;
  try { list = b64.dec(m[1]); if (!Array.isArray(list)) throw 0; } catch (_) { return msg("That share link couldn't be read.", "bad"); }
  const seen = new Set(providers().map(p => p.probe));
  const incoming = [];
  for (const raw of list) {
    const p = sanitize(raw);
    if (p && !seen.has(p.probe)) { seen.add(p.probe); incoming.push(p); }
  }
  const room = MAX_CUSTOM - custom.length, take = incoming.slice(0, Math.max(0, room));
  if (!take.length) return msg("The share link had nothing new to add (duplicates, invalid entries, or the 20-provider limit).", "warn");
  const ul = $("import-list"); ul.textContent = "";
  for (const p of take) {
    const li = document.createElement("li");
    li.textContent = `${p.name} — ${p.probe}` + (p.status ? ` (status: ${new URL(p.status).host})` : "");
    ul.appendChild(li);
  }
  $("import-note").textContent = incoming.length > take.length ? `${incoming.length - take.length} more were skipped because of the ${MAX_CUSTOM}-provider limit.` : "";
  const dlg = $("import-dialog");
  $("import-yes").onclick = () => { custom.push(...take); saveCustom(); dlg.close(); msg(`Imported ${take.length} provider(s).`, "ok"); probeAll(); statusAll(); };
  $("import-no").onclick = () => dlg.close();
  dlg.showModal();
}

// ---- Wire up ------------------------------------------------------------
$("clear").onclick = () => { hist = {}; save(); render(); };
$("pause").onclick = e => { paused = !paused; e.target.textContent = paused ? "Resume" : "Pause"; render(); };
render();
checkShareLink();
probeAll(); statusAll();
setInterval(() => { if (!paused && !document.hidden) probeAll(); }, PROBE_MS);
setInterval(() => { if (!paused && !document.hidden) statusAll(); }, STATUS_MS);
