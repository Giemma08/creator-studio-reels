// =====================================================================
// AI is Female Creator Studio – TOOL "REELS SCHNEIDEN" (Worker + Container)
// Oberfläche unter /tools/reels, Daten unter /api/reels, Werkstatt im Container.
// Wird vom Studio-Kern über das Service Binding "REELS" aufgerufen.
// Bereitstellung über GitHub Actions (siehe README.md).
// =====================================================================
import { Container, getContainer } from "@cloudflare/containers";
import UI from "./ui.js";
import SOUNDS from "./sounds.js";

export class ReelRenderer extends Container {
  defaultPort = 8080;
  sleepAfter = "20m";
  enableInternet = true;
}

const LANG_NAMES = { de: "Deutsch", en: "English", fr: "Français", it: "Italiano", es: "Español", pt: "Português", nl: "Nederlands", sv: "Svenska", ca: "Català" };
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const OUT_NAMES = ["thumb.jpg", "final.mp4", "final.jpg", "check.jpg"];
const IMG_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export default {
  // Täglich: hochgeladene Rohvideos und Aufnahmen nach 30 Tagen löschen (fertige Reels bleiben)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const old = await db(env, "reel_jobs?input_deleted=eq.false&created_at=lt." + cutoff + "&status=in.(done,ready,error)&select=id&limit=200") || [];
      for (const j of old) { try { await env.REELS_BUCKET.delete(keyOf(j.id, "input")); } catch (e) {} await patchJob(env, j.id, { input_deleted: true }); }
    })().catch(e => console.log("Aufräumen", e && e.message)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const p = url.pathname, m = request.method;
      if (p === "/tools/reels" || p === "/tools/reels/") {
        const html = UI.split("__SUPABASE_URL__").join(env.SUPABASE_URL || "").split("__SUPABASE_ANON_KEY__").join(env.SUPABASE_ANON_KEY || ""); // 2.19.2: alle Stellen ersetzen, nicht nur die erste
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p.startsWith("/tools/reels/sound/")) {
        const name = p.split("/").pop();
        if (!SOUNDS[name]) return new Response("", { status: 404 });
        return new Response(b64ToBytes(SOUNDS[name]), { headers: { "content-type": "audio/wav", "cache-control": "public, max-age=86400" } });
      }
      if (p.startsWith("/internal/reels/")) return await routeInternal(request, env, url);
      if (p.startsWith("/api/reels/media/")) return await routeMedia(request, env, url);
      const missing = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY", "INTERNAL_SECRET"].filter(k => !env[k]);
      if (missing.length) { console.log("Fehlende Einstellungen:", missing.join(", ")); return json({ error: "config" }, 500); }
      if (p === "/api/reels" && m === "GET") return await routeList(request, env, url);
      if (p === "/api/reels" && m === "DELETE") return await routeDelete(request, env, url);
        if (p === "/api/reels/start" && m === "POST") return await routeStart(request, env);
      if (p === "/api/reels/from-url" && m === "POST") return await routeFromUrl(request, env, url);
      if (p === "/api/reels/search" && m === "GET") return await routeSearch(request, env, url);
      if (p === "/api/reels/clips/make" && m === "POST") return await routeClipsMake(request, env, url);
      if (p === "/api/reels/clips/save" && m === "POST") return await routeClipsSave(request, env);
      if (p === "/api/reels/clips/ask" && m === "POST") return await routeClipsAsk(request, env);
      if (p === "/api/reels/clips/captions" && m === "POST") return await routeClipsCaptions(request, env);
      if (p === "/api/reels/part" && m === "PUT") return await routePart(request, env, url);
      if (p === "/api/reels/complete" && m === "POST") return await routeComplete(request, env, url);
      if (p === "/api/reels/save" && m === "POST") return await routeSave(request, env);
      if (p === "/api/reels/gifs" && m === "GET") return await routeGifs(request, env, url);
      if (p === "/api/reels/notes" && m === "POST") return await routeNotes(request, env, url);
      if (p === "/api/reels/cmd" && m === "POST") return await routeCmd(request, env);
      if (p === "/api/reels/prefs") return await routePrefs(request, env, m);
      if (p === "/api/reels/pip" && m === "PUT") return await routePip(request, env, url);
      if (p === "/api/reels/caption" && m === "POST") return await routeCaption(request, env);
      if (p === "/api/reels/profil" && m === "POST") return await routeProfil(request, env, url);
      if (p === "/api/reels/render" && m === "POST") return await routeRender(request, env, url);
      if (p === "/api/reels/image" && m === "POST") return await routeImage(request, env);
      return json({ error: "not_found" }, 404);
    } catch (e) {
      console.log("Serverfehler:", e && e.stack ? e.stack : String(e));
      return json({ error: "server" }, 500);
    }
  },
};

// ---------------- Gemeinsame Grundlage (Login, Credits, Brand Brain) ----------------

async function session(request, env, needActive = true) {
  const user = await getUser(request, env);
  if (!user) return { err: json({ error: "auth" }, 401) };
  const acc = await loadAccount(env, user);
  if (needActive && !acc.active) return { err: json({ error: "inactive" }, 403) };
  return { user, acc };
}

function monthKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function creditStatus(acc) {
  const plan = acc.plans || {};
  const total = Number(plan.monthly_credits || 0);
  const now = Date.now();
  let pe = acc.period_end ? new Date(acc.period_end).getTime() : 0;
  // Abrechnungszeitraum läuft noch: Restguthaben gilt. Abgelaufen oder keiner gesetzt: volle Credits (Erneuerung beim nächsten Abbuchen).
  const running = pe > now || (!pe && acc.credits_month === monthKey());
  const monthly = running ? Number(acc.monthly_credits_left || 0) : total;
  if (!pe) { const d = new Date(); pe = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); }
  while (pe <= now) { const d = new Date(pe); d.setUTCMonth(d.getUTCMonth() + 1); pe = d.getTime(); }
  const bonus = Number(acc.bonus_credits || 0);
  return { monthly, monthly_total: total, bonus, total: monthly + bonus, renews_at: new Date(pe).toISOString() };
}

async function loadBrand(env, userId) {
  const rows = await db(env, "brand_brains?user_id=eq." + userId + "&select=data");
  return rows && rows[0] && rows[0].data ? rows[0].data : {};
}

function brandForPrompt(brand) {
  const b = Object.assign({}, brand);
  if (b.visuell) { b.visuell = Object.assign({}, b.visuell); }
  const txt = JSON.stringify(b, null, 1);
  return txt.length > 2 ? txt.slice(0, 9000) : "Noch nicht ausgefüllt.";
}

function langBlock(acc) {
  const ui = LANG_NAMES[acc.ui_lang] || "Deutsch";
  const content = LANG_NAMES[acc.content_lang] || ui;
  return "\n\n# Sprache\nErklärungen, Fragen und Rückmeldungen schreibst du auf " + ui + ". Allen Social-Media-Content (Hooks, Skripte, Posts, Slides, Captions) schreibst du auf " + content + ".";
}


// ---------------- KI-Aufruf mit Credits ----------------

async function charged(env, s, action, { instructions, input }, opts = {}) {
  const costRows = await db(env, "action_costs?action=eq." + action + "&select=*");
  const cost = costRows && costRows[0];
  if (!cost) return { err: json({ error: "server" }, 500) };
  if (typeof opts.credits === "number") cost.credits = opts.credits;
  if (opts.maxTokens) cost.max_tokens = opts.maxTokens;
  if (opts.tier) cost.tier = opts.tier;
  const status = creditStatus(s.acc);
  if (status.total < cost.credits) return { err: json({ error: "credits", need: cost.credits, have: status.total }, 402) };

  const models = await db(env, "ai_models?tier=eq." + cost.tier + "&select=*");
  const m = models && models[0];
  if (!m || !m.model_id || m.model_id.startsWith("HIER")) return { err: json({ error: "model_missing" }, 500) };

  const call = async (maxTok) => {
    const payload = { model: m.model_id, instructions, input, max_output_tokens: maxTok };
    if (m.reasoning_effort) payload.reasoning = { effort: m.reasoning_effort };
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.OPENAI_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { console.log("OpenAI Fehler", res.status, (await res.text()).slice(0, 500)); return null; }
    return await res.json();
  };
  const rate = await usdEur(env);
  // Jeden Aufruf protokollieren, auch wenn die Antwort leer oder abgebrochen ist: OpenAI berechnet die Tokens trotzdem
  const logUsage = async (data, credits, note) => {
    const us = (data && data.usage) || {};
    const inTok = us.input_tokens || 0;
    const cached = (us.input_tokens_details && us.input_tokens_details.cached_tokens) || 0;
    const outTok = us.output_tokens || 0;
    const costUsd = ((inTok - cached) * Number(m.usd_per_m_input) + cached * Number(m.usd_per_m_cached) + outTok * Number(m.usd_per_m_output)) / 1e6;
    await db(env, "usage", { method: "POST", prefer: "return=minimal", body: {
      user_id: s.user.id, action: note ? action + ":" + note : action, model_id: m.model_id, input_tokens: inTok, cached_tokens: cached, output_tokens: outTok,
      cost_eur: Math.round(costUsd * rate * 1e6) / 1e6, credits,
    } });
  };

  let data = await call(cost.max_tokens);
  if (!data) return { err: json({ error: "ai" }, 502) };
  let text = extractText(data);
  // Hat das Nachdenken das Token-Budget aufgebraucht, einmal mit doppeltem Budget wiederholen
  if (!text && data.status === "incomplete") {
    console.log("Antwort abgebrochen:", JSON.stringify(data.incomplete_details || {}), "Budget", cost.max_tokens);
    await logUsage(data, 0, "abgebrochen");
    data = await call(Math.min(cost.max_tokens * 2, 16000));
    if (!data) return { err: json({ error: "ai" }, 502) };
    text = extractText(data);
  }
  if (!text) { await logUsage(data, 0, "leer"); return { err: json({ error: "empty_reply" }, 502) }; }

  // Credits abbuchen (erst nach erfolgreicher Antwort)
  let credits = status;
  if (cost.credits > 0) {
    const spent = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: cost.credits, p_action: action } });
    const row = Array.isArray(spent) ? spent[0] : spent;
    if (row) credits = { monthly: row.monthly_left, monthly_total: status.monthly_total, bonus: row.bonus_left, total: row.monthly_left + row.bonus_left };
  }
  await logUsage(data, cost.credits, "");

  return { text, credits };
}



// ---------------- Reels: Aufträge ----------------

const keyOf = (id, name) => "jobs/" + id + "/" + name;
const validId = id => /^[0-9a-f-]{36}$/.test(String(id || ""));

async function getJob(env, s, id) {
  if (!validId(id)) return null;
  const rows = await db(env, "reel_jobs?id=eq." + id + "&user_id=eq." + s.user.id + "&select=*");
  return rows && rows[0] ? rows[0] : null;
}
async function patchJob(env, id, patch) {
  patch.updated_at = new Date().toISOString();
  await db(env, "reel_jobs?id=eq." + id, { method: "PATCH", prefer: "return=minimal", body: patch });
}

// Signierte Medien-Links (Video-Elemente können keinen Login mitschicken)
async function hmac(env, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INTERNAL_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function mediaUrl(env, origin, id, name) {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
  return origin + "/api/reels/media/" + id + "/" + encodeURIComponent(name) + "?exp=" + exp + "&sig=" + await hmac(env, id + "|" + name + "|" + exp);
}

async function publicJob(env, origin, j, full) {
  const out = { id: j.id, created_at: j.created_at, updated_at: j.updated_at, title: j.title, status: j.status, duration: j.duration, renders: j.renders, length: j.length, error: j.error, kind: j.kind || "reel" };
  if (j.kind === "transcript") { out.has_text = !!j.transcript; return out; }
  if (j.kind === "clips") { out.thumb = ""; if (full) { out.clips = j.clips || {}; out.input = await mediaUrl(env, origin, j.id, "input"); } return out; }
  out.thumb = j.status !== "uploading" && j.status !== "analyzing" && j.status !== "error" ? await mediaUrl(env, origin, j.id, j.status === "done" ? "final.jpg" : "thumb.jpg") : "";
  if (full) {
    Object.assign(out, { words: j.words, hook_titel: j.hook_titel, bild_ideen: j.bild_ideen, style: j.style, has_audio: j.has_audio });
    const dsrc = j.clips && j.clips.draft && j.clips.source_id; out.draft = !!dsrc;
    out.input = await mediaUrl(env, origin, dsrc ? j.clips.source_id : j.id, "input");
    if (j.status === "done") { out.final = await mediaUrl(env, origin, j.id, "final.mp4"); out.check = await mediaUrl(env, origin, j.id, "check.jpg"); out.report = Array.isArray(j.report) ? j.report : []; }
    const imgs = {};
    for (const w of (j.words || [])) if (w && w.image && w.image.key && !imgs[w.image.key]) imgs[w.image.key] = await mediaUrl(env, origin, j.id, w.image.key.split("/").pop());
    out.images = imgs;
    const cv = j.style && j.style.cover && j.style.cover.key; if (cv) out.cover = await mediaUrl(env, origin, j.id, String(cv).split("/").pop()); // 2.24: Cover für das Posten
  }
  return out;
}

async function routeList(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const id = url.searchParams.get("id");
  if (id) { const j = await getJob(env, s, id); return j ? json({ job: await publicJob(env, url.origin, j, true) }) : json({ error: "not_found" }, 404); }
  const kindFilter = url.searchParams.get("kind") === "transcript" ? "&kind=eq.transcript" : "&kind=in.(reel,clips)";
  const rows = await db(env, "reel_jobs?user_id=eq." + s.user.id + kindFilter + "&status=neq.deleted&select=id,created_at,updated_at,title,status,duration,renders,length,error,kind&order=created_at.desc&limit=50");
  const list = [];
  for (const j of rows || []) list.push(await publicJob(env, url.origin, j, false));
  return json({ jobs: list });
}

async function routeStart(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  if (!(Number(b.size) > 0) || Number(b.size) > MAX_BYTES) return json({ error: "file_size" }, 400);
  const isTranscript = b.kind === "transcript", isClips = b.kind === "clips", isLong = isTranscript || isClips;
  const lim = tierLimits(s.acc);
  if (isLong) {
    if (Number(b.minutes) > lim.minutes) return json({ error: "too_long_plan", limit_min: lim.minutes, plan: lim.plan }, 403);
    if (Number(b.size) > lim.bytes) return json({ error: "file_size_plan", limit_gb: lim.bytes / 1073741824, plan: lim.plan }, 403);
  } else if (Number(b.size) > 1.5 * 1024 * 1024 * 1024) return json({ error: "file_size" }, 400);
  const cost = await db(env, "action_costs?action=eq." + (isClips ? "clips_min" : isTranscript ? "transcribe_min" : "reel_edit") + "&select=credits");
  const per = cost && cost[0] ? Number(cost[0].credits) : (isClips ? 2 : isLong ? 1 : 30);
  const need = isLong ? Math.ceil(Math.max(1, Math.min(240, Number(b.minutes) || 60)) * per) : per;
  const st = creditStatus(s.acc);
  if (st.total < need) return json({ error: "credits", need, have: st.total }, 402);
  // Speicher des Tarifs prüfen
  try {
    const f = (s.acc.plans && s.acc.plans.features) || {};
    const limit = (Number(f.storage_gb) || (f.pro ? 30 : 10)) * 1024 * 1024 * 1024;
    const u = await db(env, "rpc/storage_usage", { method: "POST", body: { p_user: s.user.id } });
    if ((Number(Array.isArray(u) ? u[0] : u) || 0) + Number(b.size) > limit) return json({ error: "storage_full" }, 403);
  } catch (e) {}
  const rows = await db(env, "reel_jobs", { method: "POST", prefer: "return=representation", body: { user_id: s.user.id, title: String(b.name || "Reel").slice(0, 120), status: "uploading", kind: isClips ? "clips" : isTranscript ? "transcript" : "reel", input_bytes: Math.round(Number(b.size) || 0) } });
  const job = rows[0];
  const mp = await env.REELS_BUCKET.createMultipartUpload(keyOf(job.id, "input"), { httpMetadata: { contentType: String(b.type || "video/mp4").slice(0, 60) } });
  await patchJob(env, job.id, { upload_id: mp.uploadId });
  return json({ id: job.id, uploadId: mp.uploadId });
}

async function routePart(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const j = await getJob(env, s, url.searchParams.get("id"));
  if (!j || j.status !== "uploading" || !j.upload_id) return json({ error: "not_found" }, 404);
  const n = Number(url.searchParams.get("n"));
  if (!(n >= 1 && n <= 10000)) return json({ error: "server" }, 400);
  const clip = Math.max(1, Math.min(6, Number(url.searchParams.get("clip")) || 1)); // mehrere Clips (2.15)
  const mp = env.REELS_BUCKET.resumeMultipartUpload(keyOf(j.id, clip > 1 ? "input" + clip : "input"), j.upload_id);
  const part = await mp.uploadPart(n, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

// Grenzen je Tarif für lange Aufnahmen (Dein Material) und Video in Reels verwandeln
function tierLimits(acc) {
  const id = String(acc.plan_id || "").toLowerCase(), feat = (acc.plans && acc.plans.features) || {};
  const pro = acc.is_admin || feat.pro || id === "pro";
  if (pro) return { minutes: 150, bytes: 4 * 1024 * 1024 * 1024, plan: "pro" };
  if (id === "standard") return { minutes: 75, bytes: 1.5 * 1024 * 1024 * 1024, plan: "standard" };
  return { minutes: 30, bytes: 1.5 * 1024 * 1024 * 1024, plan: "start" };
}
// ---------- Video in Reels verwandeln: gewählte Stellen als eigene Reels anlegen ----------
async function routeClipsMake(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  const src = await getJob(env, s, b.id);
  if (!src || src.kind !== "clips" || src.status !== "clips_ready") return json({ error: "not_found" }, 404);
  const dur = Number(src.duration) || 0;
  const span = v => v && typeof v === "object" && Number(v.end) - Number(v.start) >= 0.5 ? { start: Math.max(0, Number(v.start) || 0), end: Math.min(dur || 1e9, Number(v.end) || 0) } : null;
  const picks = (Array.isArray(b.picks) ? b.picks : []).slice(0, 15).map(p => { const v = span(p.vorne); return { agent: sanitizeAgent(p.agent), key: String(p.key || "").slice(0, 40), start: Math.max(0, Number(p.start) || 0), end: Math.min(dur || 1e9, Number(p.end) || 0), titel: String(p.titel || "").slice(0, 120), vorne: v && (v.end <= Number(p.start) || v.start >= Number(p.end)) ? v : null }; })
    .filter(p => { const len = p.end - p.start + (p.vorne ? p.vorne.end - p.vorne.start : 0); return p.end - p.start >= 3 && len >= 5 && len <= 180; });
  const layout = b.layout === "geteilt" ? "geteilt" : "folgen", retakes = b.retakes !== false, W = (src.clips && src.clips.words) || [];
  const wordsIn = sp => W.filter(x => Number(x[1]) >= sp.start - 0.1 && Number(x[2]) <= sp.end + 0.1);
  const vocab = ((await readPrefs(env, s.user.id)).dict || []).map(x => x.b).join(", ").slice(0, 800), keys = {};
  if (!picks.length) return json({ error: "server" }, 400);
  // Clip-Editor 1.2: bis zu 15 Clips pro Video sind im Durchsuchen enthalten; sie werden als Entwurf angelegt und erst beim Erstellen geschnitten
  const FREE = 15, old = await db(env, "reel_jobs?source_id=eq." + src.id + "&select=id") || [];
  const cost = await db(env, "action_costs?action=eq.reel_edit&select=credits"); const per = cost && cost[0] ? Number(cost[0].credits) : 30;
  const paid = Math.max(0, old.length + picks.length - FREE), need = per * paid, st = creditStatus(s.acc);
  if (need && st.total < need) return json({ error: "credits", need, have: st.total }, 402);
  const style = sanitizeStyle(b.style), made = [], srcToken = await hmac(env, "internal|" + src.id), model = await modelFor(env, "fast");
  for (let k = 0; k < picks.length; k++) {
    const p = picks[k], charge = old.length + k + 1 > FREE;
    if (charge) { const spent = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: per, p_action: "reel_edit", p_note: "Clip aus Video (über 15)" } }); const row = Array.isArray(spent) ? spent[0] : spent; if (!row || row.ok === false) break; }
    const teile = p.vorne ? [p.vorne, { start: p.start, end: p.end }] : null, ws = (p.vorne ? wordsIn(p.vorne) : []).concat(wordsIn(p));
    const draft = ws.length >= 3, clipInfo = { start: p.start, end: p.end, layout, teile };
    const rows = await db(env, "reel_jobs", { method: "POST", prefer: "return=representation", body: { user_id: s.user.id, title: (p.titel || src.title || "Clip").slice(0, 120), status: "analyzing", kind: "reel", source_id: src.id, clip_start: p.start, clip_end: p.end, style: p.agent ? Object.assign({}, style, { agent: p.agent }) : style,
      clips: { draft, charged: charge, source_id: src.id, clip: clipInfo } } });
    const job = rows[0];
    try {
      if (draft) await startContainer(env, url.origin, job, "plan", { broll: b.broll !== false, openai_key: env.OPENAI_API_KEY, model, lang: s.acc.content_lang || "de", retakes, clip: clipInfo, src_id: src.id, src_token: srcToken, words: ws.map(x => ({ w: String(x[0]), s: Number(x[1]), e: Number(x[2]) })) });
      else await startContainer(env, url.origin, job, "analyze", { openai_key: env.OPENAI_API_KEY, model, lang: s.acc.content_lang || "de", max_seconds: 200, vocab, retakes, clip: Object.assign({ words: ws }, clipInfo) });
      made.push(job.id); if (p.key) keys[p.key] = job.id;
    } catch (e) { if (charge) await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: per, p_action: "reel_edit" } }); await patchJob(env, job.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Bitte versuch es gleich noch einmal." }); }
  }
  if (!made.length) return json({ error: "render_unavailable" }, 503);
  // Clip-Editor 1.0: angelegte Reels an den Clip-Karten merken
  try { const c = src.clips || {}; (c.items || []).forEach(it => { if (it && it.key && keys[it.key]) it.reel_id = keys[it.key]; }); await patchJob(env, src.id, { clips: c }); } catch (e) { console.log("Clip-Zuordnung", e.message); }
  return json({ ok: true, ids: made, keys });
}
// ---------- Clip-Editor 1.0: Karten speichern und KIRA neu fragen ----------
function clipItem(c) {
  if (!c || typeof c !== "object") return null;
  const n = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0)), str = (v, k) => String(v == null ? "" : v).replace(/[\u0000-\u0009\u000b-\u001f]/g, " ").slice(0, k);
  const start = +n(c.start, 0, 1e6).toFixed(2), end = +n(c.end, 0, 1e6).toFixed(2); if (end - start < 3) return null;
  const score = c.score != null ? Math.round(n(c.score, 0, 100)) : Math.round(n(c.punkte, 1, 10) * 10);
  return { key: /^[a-z0-9]{3,20}$/i.test(String(c.key || "")) ? String(c.key) : Math.random().toString(36).slice(2, 10), start, end, titel: str(c.titel, 120), hook: str(c.hook, 300), warum: str(c.warum, 300), typ: str(c.typ || "wissen", 20), score,
    plan: c.plan && typeof c.plan === "object" ? { at: /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(String(c.plan.at || "")) ? String(c.plan.at).slice(0, 40) : null, caption: str(c.plan.caption, 2200).replace(/ {2,}/g, " "), hashtags: (Array.isArray(c.plan.hashtags) ? c.plan.hashtags : []).slice(0, 12).map(h => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "").slice(0, 40)), sent: !!c.plan.sent } : null,
    vorne: c.vorne && typeof c.vorne === "object" && Number(c.vorne.end) - Number(c.vorne.start) >= 0.5 ? { start: +n(c.vorne.start, 0, 1e6).toFixed(2), end: +n(c.vorne.end, 0, 1e6).toFixed(2), text: str(c.vorne.text, 300) } : null,
    agent: sanitizeAgent(c.agent),
    sel: c.sel !== false, eigen: !!c.eigen, reel_id: /^[0-9a-f-]{36}$/i.test(String(c.reel_id || "")) ? String(c.reel_id) : null };
}
async function routeClipsSave(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; const j = await getJob(env, s, b.id);
  if (!j || j.kind !== "clips" || j.status !== "clips_ready") return json({ error: "not_found" }, 404);
  const c = j.clips || {}; c.items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map(clipItem).filter(Boolean);
  if (Array.isArray(b.plan_acc)) c.plan_acc = b.plan_acc.slice(0, 10).map(x => String(x).slice(0, 80));
  if (b.plan_rhythm && typeof b.plan_rhythm === "object") c.plan_rhythm = { days: (Array.isArray(b.plan_rhythm.days) ? b.plan_rhythm.days : []).filter(d => d >= 0 && d <= 6).slice(0, 7), time: /^\d\d:\d\d$/.test(b.plan_rhythm.time || "") ? b.plan_rhythm.time : "18:00" };
  await patchJob(env, j.id, { clips: c }); return json({ ok: true, items: c.items });
}
const CLIP_ASK = "Du bist KIRA, eine erfahrene Social-Media-Cutterin. Du bekommst das Transkript eines langen Videos Satz für Satz (Nummer, Zeitmarke Minute:Sekunde, Text), die bisher gewählten Clips und einen Wunsch der Nutzerin. " +
  "Erfülle den Wunsch genau: Themen (z. B. alle Stellen über Preise), Anzahl, Länge in Sekunden und Zeitbereiche (z. B. nur Minute 10 bis 25) beachten. Jeder Clip muss FÜR SICH ALLEIN als Reel funktionieren: beginnt mit einem Satz, der ohne Vorwissen neugierig macht, entwickelt einen Gedanken und endet an einem natürlichen Schluss. " +
  "Keine Begrüßung, keine Technik, keine Verweise auf Folien oder frühere Teile. Clips dürfen sich nicht überschneiden. Ohne Längenwunsch 20 bis 90 Sekunden, höchstens 180. " +
  "modus: \"ersetzen\", wenn die Nutzerin neue Vorschläge statt der bisherigen will; \"ergaenzen\", wenn sie zusätzliche Clips will (z. B. \"noch 3 mehr\"); in beiden Fällen nur neue Clips liefern, keine bisherigen wiederholen. " +
  "Antworte NUR mit JSON: {\"antwort\":\"1 bis 2 freundliche Sätze, was du gemacht hast\",\"modus\":\"ersetzen\",\"clips\":[{\"von\":0,\"bis\":0,\"titel\":\"höchstens 8 Wörter\",\"hook\":\"erster Satz\",\"warum\":\"1 Satz, warum es als Reel funktioniert\",\"typ\":\"wissen|persoenlich|autoritaet|verkauf|leadmagnet\",\"staerke\":80}]} " +
  "von und bis sind Satznummern (inklusive). staerke: 0 bis 100, Hook-Stärke der ersten 3 Sekunden, streng bewerten. Optional \"vorne\": Nummer EINES besonders starken Satzes von außerhalb des Clips (meist später im Video, gleiches Thema), der als Hook VOR den Clip gesetzt wird; nur wenn die Nutzerin das wünscht oder der Clip dadurch deutlich stärker wird, sonst weglassen. Titel, Hook und Begründung in der Sprache des Transkripts.";
function clipAskCost(d) { d = Number(d) || 0; return d <= 20 * 60 ? 1 : d <= 60 * 60 ? 2 : 3; }
// Clip-Editor 1.3: Beschreibungen für mehrere Clips auf einmal (1 Credit je angefangene 5 Clips)
async function routeClipsCaptions(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; const j = await getJob(env, s, b.id); if (!j || j.kind !== "clips" || j.status !== "clips_ready") return json({ error: "not_found" }, 404);
  const S = (j.clips && j.clips.sentences) || [], items = ((j.clips && j.clips.items) || []).filter(c => (b.keys || []).includes(c.key)).slice(0, 15);
  if (!items.length) return json({ error: "server" }, 400);
  const lang = LN9[s.acc.content_lang] ? s.acc.content_lang : "de", notes = ((await readPrefs(env, s.user.id)).notes || []).join("; ");
  const textOf = c => [c.vorne, { start: c.start, end: c.end }].filter(Boolean).map(p => S.filter(x => x.s >= p.start - 0.3 && x.e <= p.end + 0.5).map(x => x.t).join(" ")).join(" … ").slice(0, 3000);
  const input = items.map((c, i) => "### Clip " + i + " – " + (c.titel || "") + "\n" + textOf(c)).join("\n\n");
  const instructions = "Du schreibst Beschreibungen (Captions) für mehrere Instagram-Reels auf " + LN9[lang] + ", je eine pro Clip. Natürlich, nahbar, kein Werbesprech, keine Floskeln. Aufbau: erste Zeile als Hook (max. 12 Wörter), dann 2 bis 3 kurze Absätze mit dem Kern, dann eine Frage oder ein Kommentar-Aufruf. Höchstens 2 Emojis. Die Clips stammen aus demselben Video: Formuliere jede Beschreibung eigenständig und abwechslungsreich, nicht mit demselben Einstieg. Dazu je 5 bis 8 passende Hashtags. Antworte NUR mit JSON: {\"clips\":[{\"nr\":0,\"caption\":\"…\",\"hashtags\":[\"…\"]}]}" + (notes ? "\nVorlieben der Nutzerin: " + notes : "");
  const r = await charged(env, s, "kira_befehl", { instructions, input }, { tier: "standard", maxTokens: 900 * items.length, credits: Math.ceil(items.length / 5) }); if (r.err) return r.err;
  let d = {}; try { const m = /\{[\s\S]*\}/.exec(String(r.text)); d = m ? JSON.parse(m[0]) : {}; } catch (e) { d = {}; }
  const out = (Array.isArray(d.clips) ? d.clips : []).map(x => items[x.nr | 0] ? { key: items[x.nr | 0].key, caption: String(x.caption || "").slice(0, 2200), hashtags: (Array.isArray(x.hashtags) ? x.hashtags : []).map(h => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).slice(0, 12) } : null).filter(Boolean);
  return json({ items: out, credits: r.credits });
}
async function routeClipsAsk(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; const befehl = String(b.befehl || "").trim().slice(0, 600); if (!befehl) return json({ error: "cmd_empty" }, 400);
  const j = await getJob(env, s, b.id); if (!j || j.kind !== "clips" || j.status !== "clips_ready") return json({ error: "not_found" }, 404);
  const S = (j.clips && j.clips.sentences) || []; if (!S.length) return json({ error: "not_found" }, 404);
  const mm = t => { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  const list = S.map((x, i) => i + " [" + mm(x.s) + "] " + x.t).join("\n").slice(0, 150000);
  const cur = (Array.isArray(b.items) ? b.items : (j.clips.items || [])).slice(0, 40).map(c => mm(c.start) + "–" + mm(c.end) + " " + String(c.titel || "").slice(0, 80)).join("; ");
  const LN = { de: "Deutsch", en: "Englisch", fr: "Französisch", it: "Italienisch", es: "Spanisch", pt: "Portugiesisch", nl: "Niederländisch", sv: "Schwedisch", ca: "Katalanisch" };
  const uiLang = LN[b.ui_lang] ? b.ui_lang : "de", notes = ((await readPrefs(env, s.user.id)).notes || []).join("; ");
  const instructions = CLIP_ASK + " Schreib \"antwort\" auf " + LN[uiLang] + "." + (notes ? " Gemerkte Vorlieben der Nutzerin (berücksichtigen, wenn passend): " + notes : "");
  // 2.21.1: Transkript zuerst, damit OpenAI es ab der zweiten Frage aus dem Zwischenspeicher liest; Preis nach Videolänge
  const r = await charged(env, s, "kira_befehl", { instructions, input: "Transkript:\n" + list + "\n\nVideolänge " + mm(Number(j.duration) || 0) + "\nBisherige Clips: " + (cur || "keine") + "\n\nWunsch der Nutzerin: " + befehl }, { tier: "premium", maxTokens: 4000, credits: clipAskCost(j.duration) });
  if (r.err) return r.err;
  let d = {}; try { const m = /\{[\s\S]*\}/.exec(String(r.text)); d = m ? JSON.parse(m[0]) : {}; } catch (e) { d = {}; }
  const N = S.length, items = (Array.isArray(d.clips) ? d.clips : []).slice(0, 15).map(c => {
    let a = Math.max(0, Math.min(N - 1, c.von | 0)), z = Math.max(0, Math.min(N - 1, c.bis | 0)); if (z < a) [a, z] = [z, a];
    const v = Number.isInteger(c.vorne) && S[c.vorne] && (c.vorne < a || c.vorne > z) ? S[c.vorne] : null;
    return clipItem({ start: Math.max(0, S[a].s - 0.15), end: S[z].e + 0.25, titel: c.titel, hook: v ? v.t : (c.hook || S[a].t), warum: c.warum, typ: c.typ, score: c.staerke, vorne: v ? { start: Math.max(0, v.s - 0.15), end: v.e + 0.25, text: v.t } : null });
  }).filter(c => c && c.end - c.start >= 5 && c.end - c.start <= 185);
  return json({ antwort: String(d.antwort || "").slice(0, 400), modus: d.modus === "ergaenzen" ? "ergaenzen" : "ersetzen", items, credits: r.credits });
}
// Suche über alles Gesprochene (C2): Reels und lange Videos, mit Zeitmarke und Ausschnitt
async function routeSearch(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const norm = w => String(w || "").toLocaleLowerCase("de-DE").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 80), qs = q.split(/\s+/).map(norm).filter(Boolean);
  if (!qs.length || q.length < 3) return json({ hits: [] });
  const jobs = await db(env, "reel_jobs?user_id=eq." + s.user.id + "&kind=in.(reel,clips)&status=neq.error&select=id,title,kind,status,words,clips,created_at,source_id&order=created_at.desc&limit=80") || [];
  const hits = [];
  for (const j of jobs) {
    let W = [];
    if (j.kind === "clips" && j.clips && Array.isArray(j.clips.words)) W = j.clips.words.map(x => Array.isArray(x) ? { w: x[0], s: x[1] } : { w: x.w, s: x.s });
    else if (Array.isArray(j.words) && !j.source_id) W = j.words.map(x => ({ w: x.w, s: x.s }));
    if (!W.length) continue; const N = W.map(x => norm(x.w)); let found = 0;
    for (let i = 0; i < N.length && found < 3; i++) {
      let ok = true; for (let k = 0; k < qs.length; k++) { const t = N[i + k] || ""; if (!(k === qs.length - 1 ? t.startsWith(qs[k]) : t === qs[k])) { ok = false; break; } }
      if (!ok) continue;
      const a = Math.max(0, i - 8), b = Math.min(W.length, i + qs.length + 10);
      hits.push({ id: j.id, kind: j.kind, title: j.title || (j.kind === "clips" ? "Langes Video" : "Reel"), t: Number(W[i].s) || 0, before: W.slice(a, i).map(x => x.w).join(" "), match: W.slice(i, i + qs.length).map(x => x.w).join(" "), after: W.slice(i + qs.length, b).map(x => x.w).join(" "), at: j.created_at });
      found++; i += 25;
    }
    if (hits.length >= 40) break;
  }
  return json({ hits });
}

// Video per Link (C1): YouTube, Vimeo, Zoom-Aufzeichnung, Google Drive, Dropbox oder direkter Video-Link
async function routeFromUrl(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; let u = String(b.url || "").trim();
  if (!/^https:\/\/[^\s]{6,1500}$/.test(u)) return json({ error: "server", detail: "Bitte einen vollständigen Link mit https:// einfügen." }, 400);
  let host = ""; try { host = new URL(u).hostname.toLowerCase(); } catch (e) {}
  if (!host || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host) || host.endsWith(".internal")) return json({ error: "server", detail: "Dieser Link ist nicht erlaubt." }, 400);
  const cost = await db(env, "action_costs?action=eq.clips_min&select=credits"); const per = cost && cost[0] ? Number(cost[0].credits) : 2;
  const st = creditStatus(s.acc); if (st.total < per * 5) return json({ error: "credits", need: per * 5, have: st.total }, 402);
  const lim = tierLimits(s.acc);
  const title = String(b.title || "").trim() || (/youtu/.test(host) ? "YouTube-Video" : /vimeo/.test(host) ? "Vimeo-Video" : /zoom/.test(host) ? "Zoom-Aufzeichnung" : /google/.test(host) ? "Video aus Google Drive" : /dropbox/.test(host) ? "Video aus Dropbox" : "Video per Link");
  const rows = await db(env, "reel_jobs", { method: "POST", prefer: "return=representation", body: { user_id: s.user.id, title: title.slice(0, 120), status: "analyzing", kind: "clips" } });
  const j = rows && rows[0]; if (!j) return json({ error: "server" }, 500);
  const rg = b.range && Number(b.range.to) > Number(b.range.from) ? { from: Math.max(0, Number(b.range.from) || 0), to: Number(b.range.to) } : null;
  try { await startContainer(env, url.origin, j, "clips", { source_url: u, source_pw: String(b.password || "").slice(0, 100), range: rg, vocab: ((await readPrefs(env, s.user.id)).dict || []).map(x => x.b).join(", ").slice(0, 800), befehl: String(b.befehl || "").trim().slice(0, 600), openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "premium"), lang: s.acc.content_lang || "de", max_seconds: lim.minutes * 60 + 60 }); }
  catch (e) { await patchJob(env, j.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Bitte versuch es gleich noch einmal." }); return json({ error: "render_unavailable" }, 503); }
  return json({ ok: true, id: j.id });
}

async function startContainer(env, origin, job, phase, extra) {
  const c = getContainer(env.RENDERER, job.id);
  const body = Object.assign({ id: job.id, base: origin, token: await hmac(env, "internal|" + job.id) }, extra || {});
  const res = await c.fetch(new Request("http://container/" + phase, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  if (res.status !== 202) throw new Error("Container antwortet mit " + res.status);
}

async function modelFor(env, tier) {
  const rows = await db(env, "ai_models?tier=eq." + tier + "&select=model_id");
  return rows && rows[0] ? rows[0].model_id : "gpt-6-luna";
}

async function routeComplete(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  const j = await getJob(env, s, b.id);
  if (!j || j.status !== "uploading" || !j.upload_id) return json({ error: "not_found" }, 404);
  const parts = (Array.isArray(b.parts) ? b.parts : []).map(x => ({ partNumber: Number(x.partNumber), etag: String(x.etag) }));
  const clip = Math.max(1, Math.min(6, Number(b.clip) || 1)), clips = Math.max(1, Math.min(6, Number(b.clips) || 1));
  const mp = env.REELS_BUCKET.resumeMultipartUpload(keyOf(j.id, clip > 1 ? "input" + clip : "input"), j.upload_id);
  await mp.complete(parts);
  // Mehrere Clips (2.15): nächsten Upload vorbereiten, erst nach dem letzten Clip geht es weiter
  if (j.kind !== "clips" && j.kind !== "transcript" && clip < clips) {
    const nx = await env.REELS_BUCKET.createMultipartUpload(keyOf(j.id, "input" + (clip + 1)));
    await patchJob(env, j.id, { upload_id: nx.uploadId });
    return json({ ok: true, next: clip + 1 });
  }
  if (j.kind === "clips") {
    await patchJob(env, j.id, { status: "analyzing", upload_id: null });
    const rg = b.range && Number(b.range.to) > Number(b.range.from) ? { from: Math.max(0, Number(b.range.from) || 0), to: Number(b.range.to) } : null;
    try { await startContainer(env, url.origin, j, "clips", { range: rg, vocab: ((await readPrefs(env, s.user.id)).dict || []).map(x => x.b).join(", ").slice(0, 800), befehl: String(b.befehl || "").trim().slice(0, 600), openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "premium"), lang: s.acc.content_lang || "de", max_seconds: tierLimits(s.acc).minutes * 60 + 60 }); }
    catch (e) { await patchJob(env, j.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Bitte versuch es gleich noch einmal." }); return json({ error: "render_unavailable" }, 503); }
    return json({ ok: true });
  }
  if (j.kind === "transcript") {
    // Lange Aufnahme: nur in Text umwandeln, Credits nach der tatsächlichen Länge
    await patchJob(env, j.id, { status: "analyzing", upload_id: null });
    try { await startContainer(env, url.origin, j, "transcribe", { openai_key: env.OPENAI_API_KEY, lang: s.acc.content_lang || "de", max_seconds: tierLimits(s.acc).minutes * 60 + 60 }); }
    catch (e) { await patchJob(env, j.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Bitte versuch es gleich noch einmal." }); return json({ error: "render_unavailable" }, 503); }
    return json({ ok: true });
  }
  // Credits abbuchen
  const cost = await db(env, "action_costs?action=eq.reel_edit&select=credits");
  const need = cost && cost[0] ? Number(cost[0].credits) : 30;
  const spent = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: need, p_action: "reel_edit" } });
  const row = Array.isArray(spent) ? spent[0] : spent;
  if (!row || row.ok === false) return json({ error: "credits", need, have: creditStatus(s.acc).total }, 402);
  const style = sanitizeStyle(b.style);
  await patchJob(env, j.id, { status: "analyzing", upload_id: null, style });
  try {
    await startContainer(env, url.origin, j, "analyze", { openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "fast"), lang: s.acc.content_lang || "de", max_seconds: 185, clips: clips, vocab: ((await readPrefs(env, s.user.id)).dict || []).map(x => x.b).join(", ").slice(0, 800) });
  } catch (e) {
    console.log("Werkstatt nicht erreichbar:", e && e.message);
    await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: need, p_action: "reel_edit" } });
    await patchJob(env, j.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Deine Credits wurden zurückgebucht." });
    return json({ error: "render_unavailable" }, 503);
  }
  const st = creditStatus(s.acc);
  return json({ ok: true, credits: { monthly: row.monthly_left, monthly_total: st.monthly_total, bonus: row.bonus_left, total: row.monthly_left + row.bonus_left } });
}

const BRAND_FONTS = ["Playfair Display", "Inter", "Outfit", "DM Sans", "Lora", "Montserrat", "Poppins", "Cormorant Garamond", "Space Grotesk", "Syne"];
const CAPTION_STYLES = ["marke", "klar", "box", "elegant", "leise", "gross", "plakat", "handschrift", "kino", "pop", "karaoke", "neon", "editorial", "mono", "pastell", "kontur", "magazin"];
const LOOKS = ["business", "warm", "editorial", "energie", "kino", "magazin"];
const CAP_FONTS = ["Poppins", "Montserrat", "Inter", "DM Sans", "Outfit", "Space Grotesk", "Syne", "Anton", "Bebas Neue", "Archivo Black", "Playfair Display", "DM Serif Display", "Lora", "Cormorant Garamond", "Abril Fatface", "Caveat Brush", "Pacifico", "Space Mono"];
const FX_TYPES = ["checkliste", "zahl", "kommentar", "karte", "zitat", "kapitel", "diagramm", "vergleich", "nachricht", "emoji", "gif", "hinter", "spotlight", "greenscreen", "popout", "lichtaus"];
const CUTOUT_TYPES = ["hinter", "spotlight", "greenscreen", "popout", "lichtaus"];
function sanitizeEffects(list) {
  const s = (v, n) => String(v == null ? "" : v).replace(/[<>]/g, "").slice(0, n);
  const i = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && n < 3000 ? n : undefined; };
  return (Array.isArray(list) ? list : []).filter(x => x && FX_TYPES.includes(x.type)).slice(0, 4).map(x => {
    const o = { type: x.type, von: i(x.von), bis: i(x.bis), wort: i(x.wort) };
    if (x.type === "checkliste") { o.titel = s(x.titel, 40); o.punkte = (Array.isArray(x.punkte) ? x.punkte : []).slice(0, 4).map(p => ({ text: s(p && p.text, 40), wort: i(p && p.wort) })).filter(p => p.text); }
    if (x.type === "zahl") { o.wert = s(x.wert, 16); o.praefix = s(x.praefix, 4); o.suffix = s(x.suffix, 6); o.label = s(x.label, 40); }
    if (x.type === "kommentar") { o.stichwort = s(x.stichwort, 24); o.antwort = s(x.antwort, 60); }
    if (x.type === "karte") { o.titel = s(x.titel, 30); o.text = s(x.text, 80); }
    if (x.type === "zitat") { o.text = s(x.text, 120); o.titel = s(x.titel, 30); }
    if (x.type === "kapitel") { o.nummer = s(x.nummer, 3); o.titel = s(x.titel, 40); }
    if (x.type === "diagramm") { o.titel = s(x.titel, 30); o.wert = s(x.wert, 16); }
    if (x.type === "vergleich") { o.vorher = s(x.vorher, 50); o.nachher = s(x.nachher, 50); }
    if (x.type === "nachricht") { o.nachrichten = (Array.isArray(x.nachrichten) ? x.nachrichten : []).slice(0, 3).map(m => s(m, 70)).filter(Boolean); }
    if (x.type === "emoji") { o.emoji = Array.from(String(x.emoji || "")).slice(0, 8).join(""); if (x.esize != null && isFinite(Number(x.esize))) o.esize = Math.max(100, Math.min(500, Math.round(Number(x.esize)))); }
    if ((x.type === "emoji" || x.type === "gif") && x.gy != null && x.gy !== "" && isFinite(Number(x.gy))) o.gy = Math.max(8, Math.min(85, Math.round(Number(x.gy))));
    if (x.type === "hinter") { o.woerter = (Array.isArray(x.woerter) ? x.woerter : []).slice(0, 3).map(w => ({ text: s(w && w.text, 12), wort: i(w && w.wort) })).filter(w => w.text); }
    if (x.type === "spotlight") { o.text = s(x.text, 30); }
    if (x.type === "greenscreen") { o.titel = s(x.titel, 50); o.text = s(x.text, 60); }
    if (x.type === "popout") { o.titel = s(x.titel, 40); }
    if (x.type === "lichtaus") { o.text = s(x.text, 12); }
    if (x.type === "gif") {
      const giphy = u => /^https:\/\/media\d?\.giphy\.com\/[A-Za-z0-9_\/.?=&-]+$/.test(String(u || "")) ? String(u) : "";
      o.suche = s(x.suche, 40); o.gif_id = /^[A-Za-z0-9]{1,40}$/.test(String(x.gif_id || "")) ? String(x.gif_id) : "";
      o.mp4 = giphy(x.mp4); o.src = giphy(x.src); o.art = x.art === "sticker" ? "sticker" : "gif"; o.preview = giphy(x.preview); o.titel = s(x.titel, 60);
      if (x.gw != null && isFinite(Number(x.gw))) o.gw = Math.max(240, Math.min(1000, Math.round(Number(x.gw))));
      o.w = Math.max(1, Math.min(2000, Number(x.w) || 480)); o.h = Math.max(1, Math.min(2000, Number(x.h) || 270));
    }
    if (x.off) o.off = true;
    return o;
  }).filter(o => o.von !== undefined || o.wort !== undefined);
}


// ---------------- Änderungen per Satz ----------------
// Die Kundin schreibt, was anders sein soll. Die KI übersetzt das in erlaubte Änderungen, der Server prüft und speichert sie.
async function routeNotes(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {};
  const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  if (!["ready", "done"].includes(j.status)) return json({ error: "busy" }, 409);
  const note = String(b.text || "").trim().slice(0, 600); if (!note) return json({ error: "server" }, 400);
  const st = j.style || {}; const words = (j.words || []).map(w => Object.assign({}, w));
  const state = { untertitel_stil: st.caption_style, look: st.look, groesse: st.size, position: st.position, hook_titel: j.hook_titel, hook_an: st.hook !== false, untertitel_an: st.captions !== false,
    logo_an: !!st.logo_on, zoom: st.zoom_scale == null ? 1 : st.zoom_scale, toene_an: !st.sounds_off,
    effekte: (st.effects || []).map((e, i) => ({ i, typ: e.type, aus: !!e.off, text: e.text || e.titel || e.label || e.stichwort || e.wert || (e.punkte || e.woerter || []).map(x => x.text).join(" / ") || "" })) };
  const transcript = words.slice(0, 1500).map((w, i) => i + ":" + w.w + (w.cut ? "[weg]" : "") + (w.emph ? "[betont]" : "")).join(" ");
  const instructions = "Du bist die Schnitt-Assistentin im AI is Female Creator Studio. Eine Kundin beschreibt, was an ihrem Reel anders sein soll. Übersetze ihren Wunsch in Änderungen. Antworte NUR mit JSON in diesem Format: " +
    "{\"antwort\":\"ein freundlicher Satz, was du änderst\",\"einstellungen\":{\"untertitel_stil\":\"klar|box|elegant|leise|gross|plakat|handschrift|kino|pop|karaoke|neon|editorial|mono|pastell|kontur|magazin|marke\",\"look\":\"business|warm|editorial|energie|kino|magazin|keiner\",\"groesse\":\"klein|mittel|gross\",\"position\":\"auto|unten|mitte|oben\",\"hook_an\":true,\"untertitel_an\":true,\"logo_an\":true,\"zoom\":1,\"toene_an\":true},\"hook_titel\":\"\",\"effekte\":[{\"i\":0,\"aus\":true,\"entfernen\":false,\"text\":\"\"}],\"woerter\":[{\"von\":0,\"bis\":0,\"aktion\":\"schneiden|behalten|betonen|nicht_betonen|zoom|kein_zoom\"}]}. " +
    "Lass alles weg, was sich nicht ändern soll. zoom ist eine Zahl von 0 (aus) bis 2 (stark). Wortnummern stehen im Text vor jedem Wort. Wenn ein Wunsch nicht umsetzbar ist, sag es in antwort ehrlich und ändere dazu nichts. Erfinde keine Inhalte." + langBlock(s.acc);
  const input = "Aktuelle Einstellungen: " + JSON.stringify(state) + "\n\nText des Reels mit Wortnummern: " + transcript + "\n\nWunsch der Kundin: " + note;
  const r = await charged(env, s, "reel_note", { instructions, input }, { credits: 1, maxTokens: 1500, tier: "standard" });
  if (r.err) return r.err;
  let d = {}; try { d = JSON.parse(String(r.text).replace(/^```json|```$/g, "").trim()); } catch (e) { return json({ error: "ai" }, 502); }
  const e = d.einstellungen || {}, ns = Object.assign({}, st), changed = [];
  const setIf = (k, v, ok) => { if (v !== undefined && ok) { ns[k] = v; changed.push(k); } };
  setIf("caption_style", e.untertitel_stil, CAPTION_STYLES.includes(e.untertitel_stil));
  if (e.look !== undefined) { if (e.look === "keiner") { ns.look = null; changed.push("look"); } else setIf("look", e.look, LOOKS.includes(e.look)); }
  setIf("size", e.groesse, ["klein", "mittel", "gross"].includes(e.groesse));
  setIf("position", e.position, ["auto", "unten", "mitte", "oben"].includes(e.position));
  if (typeof e.hook_an === "boolean") { ns.hook = e.hook_an; changed.push("hook"); }
  if (typeof e.untertitel_an === "boolean") { ns.captions = e.untertitel_an; changed.push("captions"); }
  if (typeof e.logo_an === "boolean") { ns.logo_on = e.logo_an && !!ns.logo; changed.push("logo"); }
  if (typeof e.zoom === "number") { ns.zoom_scale = Math.max(0, Math.min(2, e.zoom)); changed.push("zoom"); }
  if (typeof e.toene_an === "boolean") { ns.sounds_off = !e.toene_an; changed.push("toene"); }
  const fx = (ns.effects || []).map(x => Object.assign({}, x)); const drop = new Set();
  for (const c of Array.isArray(d.effekte) ? d.effekte.slice(0, 6) : []) {
    const x = fx[Number(c && c.i)]; if (!x) continue;
    if (c.entfernen) { drop.add(Number(c.i)); continue; }
    if (typeof c.aus === "boolean") x.off = c.aus;
    if (typeof c.text === "string" && c.text.trim()) { const k = ["zitat", "karte", "spotlight", "lichtaus"].includes(x.type) ? "text" : ["kapitel", "greenscreen", "diagramm", "popout"].includes(x.type) ? "titel" : x.type === "kommentar" ? "stichwort" : null; if (k) x[k] = c.text.trim().slice(0, 80); }
    changed.push("effekt");
  }
  ns.effects = fx.filter((x, i) => !drop.has(i));
  let hook = j.hook_titel;
  if (typeof d.hook_titel === "string" && d.hook_titel.trim()) { hook = d.hook_titel.trim().slice(0, 120); changed.push("hook_titel"); }
  for (const w of Array.isArray(d.woerter) ? d.woerter.slice(0, 20) : []) {
    const a = Math.max(0, Number(w && w.von) || 0), z = Math.min(words.length - 1, Number(w && w.bis != null ? w.bis : w.von) || a);
    if (!(z >= a) || z - a > 300) continue;
    for (let k = a; k <= z; k++) { const x = words[k]; if (!x) continue;
      if (w.aktion === "schneiden") x.cut = true; else if (w.aktion === "behalten") delete x.cut;
      else if (w.aktion === "betonen") x.emph = true; else if (w.aktion === "nicht_betonen") delete x.emph;
      else if (w.aktion === "zoom" && k === a) x.zoom = true; else if (w.aktion === "kein_zoom") delete x.zoom; }
    changed.push("woerter");
  }
  if (!words.some(w => !w.cut)) return json({ error: "nothing_left" }, 400);
  await patchJob(env, j.id, { style: sanitizeStyle(ns), words: sanitizeWords(words), hook_titel: hook });
  const fresh = await getJob(env, s, j.id);
  return json({ antwort: String(d.antwort || "").slice(0, 400), changed: [...new Set(changed)], job: await publicJob(env, url.origin, fresh, true), credits: r.credits });
}

// ---------------- Eigene Einstellungen (2.18): Wörterbuch und eigene Reel-Stile ----------------
const prefsKey = uid => "users/" + uid + "/reel-prefs.json";
async function readPrefs(env, uid) { try { const o = await env.REELS_BUCKET.get(prefsKey(uid)); return o ? JSON.parse(await o.text()) : {}; } catch (e) { return {}; } }
async function routePrefs(request, env, m) {
  const s = await session(request, env); if (s.err) return s.err;
  if (m === "GET") { const p = await readPrefs(env, s.user.id); return json({ dict: p.dict || [], styles: p.styles || [], notes: p.notes || [] }); }
  if (m !== "POST") return json({ error: "server" }, 405);
  const b = await readJson(request) || {}, cur = await readPrefs(env, s.user.id), str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  if (Array.isArray(b.notes)) cur.notes = b.notes.map(x => str(x, 160)).filter(Boolean).slice(0, 30);
  if (Array.isArray(b.dict)) cur.dict = b.dict.map(x => ({ a: str(x && x.a, 60), b: str(x && x.b, 60) })).filter(x => x.a && x.b).slice(0, 200);
  if (Array.isArray(b.styles)) cur.styles = b.styles.map(x => ({ name: str(x && x.name, 40), style: sanitizeStyle(x && x.style || {}) })).filter(x => x.name).slice(0, 20).map(x => { ["texts", "cover", "split", "titelkarte"].forEach(k => delete x.style[k]); if (x.style.ende) delete x.style.ende.freebie_key; return x; });
  await env.REELS_BUCKET.put(prefsKey(s.user.id), JSON.stringify(cur), { httpMetadata: { contentType: "application/json" } });
  return json({ ok: true, dict: cur.dict || [], styles: cur.styles || [], notes: cur.notes || [] });
}

// ---------------- Bild-in-Bild, Beschreibung, Reel-Profil (2.19) ----------------
async function routePip(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const j = await getJob(env, s, url.searchParams.get("id")); if (!j) return json({ error: "not_found" }, 404);
  const ct = request.headers.get("content-type") || "", ext = /quicktime/.test(ct) ? "mov" : /webm/.test(ct) ? "webm" : "mp4";
  if (!/^video\//.test(ct)) return json({ error: "file_type" }, 400);
  if (Number(request.headers.get("content-length") || 0) > 95 * 1024 * 1024) return json({ error: "file_size" }, 400);
  const name = "pip-" + crypto.randomUUID().slice(0, 8) + "." + ext;
  await env.REELS_BUCKET.put(keyOf(j.id, name), request.body, { httpMetadata: { contentType: ct } });
  return json({ key: keyOf(j.id, name), url: await mediaUrl(env, new URL(request.url).origin, j.id, name) });
}
const LN9 = { de: "Deutsch", en: "Englisch", fr: "Französisch", it: "Italienisch", es: "Spanisch", pt: "Portugiesisch", nl: "Niederländisch", sv: "Schwedisch", ca: "Katalanisch" };
async function routeCaption(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  const lang = LN9[s.acc.content_lang] ? s.acc.content_lang : "de", notes = ((await readPrefs(env, s.user.id)).notes || []).join("; ");
  const text = (Array.isArray(j.words) ? j.words : []).filter(w => !w.cut).map(w => w.w).join(" ").slice(0, 8000) || String(b.stimmung || "").slice(0, 2000);
  if (b.gedicht) { const r0 = await charged(env, s, "kira_befehl", { instructions: "Du schreibst den Text für ein Stimmungs-Reel ohne Sprechen auf " + LN9[lang] + ": 5 bis 8 kurze, poetische Zeilen (je höchstens 7 Wörter), ruhig und bildhaft, passend zum Thema. Markiere in 2 bis 3 Zeilen ein Schlüsselwort mit *Sternchen*. Antworte NUR mit JSON: {\"zeilen\":[\"…\"]}" + (notes ? "\nVorlieben: " + notes : ""), input: "Thema: " + String(b.gedicht).slice(0, 300) }, { tier: "standard", maxTokens: 1000 }); if (r0.err) return r0.err;
    let d0 = {}; try { d0 = JSON.parse(String(r0.text).replace(/^```(json)?|```$/g, "").trim()); } catch (e) { const m = /\{[\s\S]*\}/.exec(String(r0.text)); try { d0 = m ? JSON.parse(m[0]) : {}; } catch (e2) {} }
    return json({ zeilen: (Array.isArray(d0.zeilen) ? d0.zeilen : []).map(x => String(x).slice(0, 80)).slice(0, 10), credits: r0.credits }); }
  const instructions = "Du schreibst die Beschreibung (Caption) für ein Instagram-Reel auf " + LN9[lang] + ". Natürlich, nahbar, kein Werbesprech, keine Floskeln. Aufbau: erste Zeile als Hook (max. 12 Wörter), dann 2 bis 4 kurze Absätze mit dem Kern, dann eine Frage oder ein Kommentar-Aufruf" + (b.stichwort ? " mit dem Stichwort " + String(b.stichwort).slice(0, 24) : "") + ". Höchstens 2 Emojis. Danach 5 bis 8 passende Hashtags (Mischung aus Nische und breiter). Antworte NUR mit JSON: {\"caption\":\"…\",\"hashtags\":[\"#…\"]}" + (notes ? "\nVorlieben der Nutzerin: " + notes : "");
  const r = await charged(env, s, "kira_befehl", { instructions, input: "Überschrift: " + (j.hook_titel || "") + "\nTranskript: " + text }, { tier: "standard", maxTokens: 1500 }); if (r.err) return r.err;
  let d = {}; try { d = JSON.parse(String(r.text).replace(/^```(json)?|```$/g, "").trim()); } catch (e) { const m = /\{[\s\S]*\}/.exec(String(r.text)); try { d = m ? JSON.parse(m[0]) : {}; } catch (e2) {} }
  return json({ caption: String(d.caption || "").slice(0, 2200), hashtags: (Array.isArray(d.hashtags) ? d.hashtags : []).map(h => "#" + String(h).replace(/^#+/, "").replace(/\s+/g, "")).slice(0, 12), credits: r.credits });
}
// Reel-Profil aus Vorbild-Reels: Standbilder ansehen und daraus Stil-Vorschläge und Notizen ableiten
async function routeProfil(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {}; const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  const keys = (Array.isArray(b.keys) ? b.keys : []).filter(k => typeof k === "string" && k.startsWith("jobs/" + j.id + "/img-")).slice(0, 3); if (!keys.length) return json({ error: "server" }, 400);
  const content = [{ type: "input_text", text: "Das sind Standbilder aus Reels, die der Nutzerin gefallen." + (b.hinweis ? " Ihr Hinweis: " + String(b.hinweis).slice(0, 300) : "") }];
  for (const k of keys) content.push({ type: "input_image", image_url: await mediaUrl(env, url.origin, j.id, k.split("/").pop()) });
  const instructions = "Analysiere den Stil der Reels (Untertitel, Schrift, Farben, Kästen, Position, Textmenge, Bewegung, Bildlook). Übersetze ihn in Einstellungen für einen Reel-Editor und kurze Merksätze. Antworte NUR mit JSON: {\"stil\":{\"caption_style\":\"klar|box|elegant|leise|gross|plakat|handschrift|kino|pop|karaoke|neon|editorial|mono|pastell|kontur|magazin\",\"cap_font\":\"Poppins|Montserrat|Inter|DM Sans|Outfit|Anton|Bebas Neue|Playfair Display|DM Serif Display|Lora|Caveat Brush\",\"cap_color\":\"#RRGGBB\",\"cap_box\":\"none|dark|light|accent|custom\",\"cap_box_bg\":\"#RRGGBB\",\"cap_n\":1,\"cap_case\":\"upper|normal\",\"position\":\"auto|oben|mitte|unten\",\"hook_box\":\"accent|black|white|none|custom\",\"hook_bg\":\"#RRGGBB\",\"hook_font\":\"Poppins|Playfair Display|Lora|DM Sans\",\"filter\":\"warm|kuehl|hell|kontrast|sw|vintage\",\"tempo\":1.05,\"dauerzoom\":true},\"merksaetze\":[\"kurz, z. B. viel Bewegung, wenig Text\"],\"zusammenfassung\":\"ein Satz auf Deutsch\"}. Nur Felder, die du wirklich erkennst.";
  const r = await charged(env, s, "kira_befehl", { instructions, input: [{ role: "user", content }] }, { tier: "standard", maxTokens: 2000 }); if (r.err) return r.err;
  let d = {}; try { d = JSON.parse(String(r.text).replace(/^```(json)?|```$/g, "").trim()); } catch (e) { const m = /\{[\s\S]*\}/.exec(String(r.text)); try { d = m ? JSON.parse(m[0]) : {}; } catch (e2) {} }
  const stil = sanitizeStyle(Object.assign({}, d.stil || {})), want = Object.keys(d.stil || {}), out = {}; want.forEach(k => { if (stil[k] != null) out[k] = stil[k]; });
  return json({ stil: out, merksaetze: (Array.isArray(d.merksaetze) ? d.merksaetze : []).map(x => String(x).slice(0, 160)).slice(0, 6), zusammenfassung: String(d.zusammenfassung || "").slice(0, 300), credits: r.credits });
}

// ---------------- KIRA-Befehle im Reel-Editor (2.13) ----------------
// KIRA übersetzt einen Wunsch in Handgriffe. Der Editor führt sie sofort aus, die Kundin sieht das Ergebnis in der Vorschau und kann es rückgängig machen.
const CMD_REEL = `Du steuerst einen Reel-Editor. Die Nutzerin beschreibt, was sich an ihrem Reel ändern soll. Übersetze ihren Wunsch in Handgriffe. Ändere nur, was sie verlangt.
Das Transkript steht mit Wortnummern vor jedem Wort, z. B. 12:Hallo. Markierungen: [weg] = herausgeschnitten, [betont] = farbig hervorgehoben, [zoom], [ton]. Sätze findest du über ihren Inhalt, nicht über die genaue Formulierung. Bezieht sich der Wunsch auf „das hier“, „das Markierte“ oder „diese Wörter“, nimm die markierten Wörter.
Farben gibst du als #RRGGBB an. Farbnamen übersetzt du NIE in grelle Standard-Webfarben, sondern in diese gedeckten Designfarben:
gold #C9A227, champagner #E8D9B5, creme #F7F1E8, beige #E9DCC9, sand #D8C3A5, navy/marineblau/dunkelblau #1F2A44, blau #2F5D8A, hellblau #A9C7E3, petrol #1F5F6B, türkis #2A9D8F, mint #BFE3D0, salbei #A3B18A, grün #3A7D44, smaragd #1F7A5C, rot #B83A3A, bordeaux/weinrot #7A1F33, rosa #F2C4CE, altrosa #D8A7A7, pink #E0457B, beere #8E2C58, lila/violett #6C4C9E, lavendel #C9B8E6, orange #E07A3F, terrakotta #C66B4B, apricot #F4B183, gelb #F2C94C, senf #D1A52B, braun #7A5640, grau #8A8F98, anthrazit #2E3138, schwarz #141414, weiß #FFFFFF.
Erlaubte Handgriffe:
{"op":"untertitel","stil":"marke|klar|box|elegant|leise|gross|plakat|handschrift|kino|pop|karaoke|neon|editorial|mono|pastell|kontur|magazin"}
{"op":"untertitel","schrift":"Poppins|Montserrat|Inter|DM Sans|Outfit|Space Grotesk|Syne|Anton|Bebas Neue|Archivo Black|Playfair Display|DM Serif Display|Lora|Cormorant Garamond|Abril Fatface|Caveat Brush|Pacifico|Space Mono|stil"}
{"op":"untertitel","farbe":"#F2C94C"}   (Textfarbe der Untertitel, "stil" = wie der Stil)
{"op":"untertitel","hervorhebung":"#F2C94C"}   (Farbe des gesprochenen und der betonten Wörter, "marke" = Markenfarbe)
{"op":"untertitel","groesse":1.2}   (Faktor zur aktuellen Größe: größer 1.15 bis 1.4, kleiner 0.75 bis 0.9)
{"op":"untertitel","position":"auto|oben|mitte|unten"}  oder  {"op":"untertitel","hoehe":40}   (Oberkante in Prozent von oben, 8 bis 85; für „etwas höher“ ändere die aktuelle Höhe um 5 bis 10)
{"op":"untertitel","unterlegung":"stil|ohne|dunkel|hell|marke|#RRGGBB"}
{"op":"untertitel","woerter":2}   (Wörter pro Einblendung 1 bis 5, "stil" = wie der Stil)
{"op":"untertitel","schreibweise":"gross|normal|stil"}
{"op":"untertitel","an":false}
{"op":"untertitel","zuruecksetzen":true}   (alle eigenen Anpassungen weg, wieder wie der Stil)
{"op":"ueberschrift","text":"…","an":true,"dauer":5,"position":"auto|oben|mitte|unten","groesse":"klein|normal|gross","unterlegung":"marke|schwarz|weiss|ohne|#RRGGBB","schrift":"Poppins|Montserrat|Playfair Display|Lora|Cormorant Garamond|DM Sans|Outfit|Space Grotesk|Syne|Inter|marke","breit":true}   (nur genannte Felder; „weiter nach oben“ heißt position oben; dauer = Sekunden am Anfang, 1 bis 60, 3600 = das ganze Video)
{"op":"woerter","von":12,"bis":18,"aktion":"schneiden|behalten|betonen|nicht_betonen|zoom|kein_zoom|ton|kein_ton","ton":"kling|ping|pop|whoosh|klick|tada"}   (zoom wirkt über den ganzen Bereich: langsam hinein, halten, langsam heraus; am besten 2 bis 6 Wörter. ton wirkt auf das erste Wort, nur mit aktion "ton")
{"op":"wort_aendern","wort":7,"neu":"richtiges Wort"}   (Tippfehler oder falsch erkannte Wörter im Untertitel korrigieren)
{"op":"fuellwoerter"}   (Ähs, Ähms und Mms herausschneiden)
{"op":"text","art":"punkt|kapitel|liste|zahl|zitat|banner|notiz","text":"…","text2":"Beschriftung unter der Zahl","items":["Punkt 1","Punkt 2"],"von":12,"bis":30,"anim":"einblenden|hoch|pop|schreiben|marker","y":20}   (Text-Einblendung über dem Video ab Wort von bis Wort bis. punkt = Kernaussage mit Pfeil, kapitel = Kapitel-Überschrift oben, liste = laufende Checkliste (items erscheinen nacheinander), zahl = große Zahl, zitat = Zitat-Karte, banner = Stichwort-Banner, notiz = handschriftliche Notiz mit Pfeil. Kurz halten: höchstens 8 Wörter. y = Höhe in Prozent, nur wenn gewünscht)
{"op":"text_aendern","i":0,"text":"…","anim":"pop","y":30,"entfernen":false}   (vorhandene Text-Einblendung Nummer i ändern oder entfernen)
{"op":"woerter","von":12,"bis":14,"aktion":"zoom","art":"sanft|ruck|raus|schwenk|wackeln"}   (Zoom-Art: sanft = langsam hinein, ruck = schneller Zoom-Ruck, raus = herauszoomen, schwenk = langsamer Schwenk, wackeln = Handkamera-Wackeln)
{"op":"wort_effekt","wort":12,"effekt":"glitch|blitz|wisch|unschaerfe|kein"}   (kurzer Übergangs-Effekt genau an diesem Wort)
{"op":"bild","filter":"warm|kuehl|hell|kontrast|sw|vintage|kein","kontrast":0,"waerme":0,"saettigung":0,"schaerfe":0,"haut":0,"vignette":false,"koernung":false,"dauerzoom":false}   (nur genannte Felder; kontrast, waerme, saettigung -2 bis 2, schaerfe 0 bis 3, haut 0 bis 5)
{"op":"ende","kommentar":"GUIDE","kommentar_text":"und ich schicke dir …","freebie_titel":"…","schleife":true}   (Ende des Reels: Kommentar-Stichwort, Freebie-Titel, Schleife zum Anfang; leerer Text entfernt das Element)
{"op":"bild_karte","wort":12,"art":"foto|screenshot|logo|meme","text":"Meme-Text","position":"oben|mitte|unten","groesse":"klein|mittel|gross"}   (nur für Wörter, an denen schon ein Bild hängt)
{"op":"stimme","wert":"sanft|stark|aus"}   (Stimme verbessern: Rauschen weg, Lautstärke ausgleichen)
{"op":"versprecher"}   (Versprecher und doppelte Satzanfänge herausschneiden)
{"op":"merken","text":"mehr Bewegung, weniger Text"}   (wenn sie sagt „merk dir …“ oder eine dauerhafte Vorliebe nennt)
{"op":"tempo","wert":1.1}   (Geschwindigkeit 1 bis 1.25)
{"op":"pausen","wert":"knapp|normal"}   (knapp = auch kurze Pausen raus)
{"op":"look","wert":"business|warm|editorial|energie|kino|magazin|keiner"}
{"op":"licht","belichtung":1,"haut":2}   (belichtung -2 bis 3, haut 0 bis 3, Werte sind absolut, nur genannte)
{"op":"zoom_staerke","wert":1}   (0 aus bis 2 stark)
{"op":"toene","an":false}
{"op":"logo","an":true}
{"op":"effekt","i":0,"aus":true,"entfernen":false,"text":""}
Antworte NUR mit JSON: {"ops":[...],"antwort":"ein kurzer, freundlicher Satz, was du gemacht hast"}. Ist der Wunsch unklar oder nicht machbar (zum Beispiel Musik, Übergänge oder Einblendungen, die es noch nicht gibt), gib "ops":[] und sag es ehrlich in "antwort". Erfinde keine Inhalte.`;

async function routeCmd(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request) || {};
  const befehl = String(b.befehl || "").trim().slice(0, 600); if (!befehl) return json({ error: "cmd_empty" }, 400);
  const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  const st = b.stand && typeof b.stand === "object" ? b.stand : {};
  const words = Array.isArray(st.woerter) ? st.woerter.slice(0, 3000) : [];
  const transcript = words.map((w, i) => i + ":" + String(w.w || "").slice(0, 40) + (w.cut ? "[weg]" : "") + (w.emph ? "[betont]" : "") + (w.zoom ? "[zoom]" : "") + (w.sound ? "[ton]" : "")).join(" ").slice(0, 30000);
  const info = Object.assign({}, st); delete info.woerter;
  const LN = { de: "Deutsch", en: "Englisch", fr: "Französisch", it: "Italienisch", es: "Spanisch", pt: "Portugiesisch", nl: "Niederländisch", sv: "Schwedisch", ca: "Katalanisch" };
  const uiLang = LN[b.ui_lang] ? b.ui_lang : (LN[s.acc.ui_lang] ? s.acc.ui_lang : "de");
  const notes = ((await readPrefs(env, s.user.id)).notes || []).join("; ");
  const instructions = CMD_REEL + "\n\nSchreib das Feld \"antwort\" auf " + LN[uiLang] + ". Neue Überschriften und korrigierte Wörter schreibst du in der Sprache des Transkripts." + (notes ? "\nGemerkte Vorlieben der Nutzerin (berücksichtigen, wenn passend): " + notes : "");
  const input = "Aktuelle Einstellungen: " + JSON.stringify(info).slice(0, 4000) + "\n\nTranskript mit Wortnummern: " + transcript + "\n\nWunsch der Nutzerin: " + befehl;
  const r = await charged(env, s, "kira_befehl", { instructions, input }, { tier: "standard", maxTokens: 2500 });
  if (r.err) return r.err;
  let d = {}; try { d = JSON.parse(String(r.text).replace(/^```(json)?|```$/g, "").trim()); } catch (e) { const m = /\{[\s\S]*\}/.exec(String(r.text)); try { d = m ? JSON.parse(m[0]) : {}; } catch (e2) { d = {}; } }
  return json({ ops: Array.isArray(d.ops) ? d.ops.slice(0, 40) : [], antwort: String(d.antwort || "").slice(0, 400), credits: r.credits });
}

// ---------------- GIFs über Giphy (Powered by GIPHY) ----------------
async function giphyRaw(env, q, limit, art) {
  const key = String(env.GIPHY_API_KEY || "").trim();
  if (!key || !q) return { ok: false, status: 0, list: [] };
  const u = "https://api.giphy.com/v1/" + (art === "sticker" ? "stickers" : "gifs") + "/search?api_key=" + encodeURIComponent(key) + "&q=" + encodeURIComponent(q) + "&limit=" + (limit || 12) + "&rating=g";
  let r; try { r = await fetch(u); } catch (e) { console.log("Giphy nicht erreichbar", e && e.message); return { ok: false, status: 0, list: [] }; }
  if (!r.ok) { console.log("Giphy Fehler", r.status, (await r.text().catch(() => "")).slice(0, 300)); return { ok: false, status: r.status, list: [] }; }
  const d = await r.json().catch(() => ({}));
  const list = (d.data || []).map(g => {
    const im = g.images || {}; const v = im.fixed_height || im.fixed_width || im.original || {}; const pr = im.fixed_width_small || im.fixed_height_small || im.fixed_width || v;
    const mp4 = v.mp4 || (im.original && im.original.mp4) || (im.original_mp4 && im.original_mp4.mp4) || (im.fixed_width && im.fixed_width.mp4) || "";
    // Sticker haben einen durchsichtigen Hintergrund: dafür die .gif-Datei nehmen, MP4 kann keine Transparenz
    if (art === "sticker") return { gif_id: g.id, titel: String(g.title || "").slice(0, 60), art: "sticker", mp4: "", src: v.url || (im.original && im.original.url) || "", preview: pr.webp || pr.url || "", w: Number(v.width) || 480, h: Number(v.height) || 270 };
    return { gif_id: g.id, titel: String(g.title || "").slice(0, 60), art: "gif", mp4: mp4, src: "", preview: pr.webp || pr.url || "", w: Number(v.width) || 480, h: Number(v.height) || 270 };
  }).filter(g => g.mp4 || g.src);
  if (!list.length) console.log("Giphy ohne Treffer", q, "Rohdaten:", (d.data || []).length, JSON.stringify(d.meta || {}).slice(0, 200));
  return { ok: true, status: r.status, list };
}
async function giphySearch(env, q, limit) { return (await giphyRaw(env, q, limit)).list; }
async function routeGifs(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  if (!String(env.GIPHY_API_KEY || "").trim()) return json({ error: "gifs_off" }, 503);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 50);
  const r = await giphyRaw(env, q, 12, url.searchParams.get("art") === "sticker" ? "sticker" : "gif");
  if (!r.ok) return json({ error: "gifs_failed", status: r.status }, 502);
  return json({ gifs: r.list });
}
// Für KI-Vorschläge ohne Auswahl das erste passende GIF vorwählen
async function preselectGifs(env, effects) {
  for (const fx of effects || []) {
    if (fx && fx.type === "gif" && !fx.mp4 && fx.suche) { const g = (await giphySearch(env, fx.suche, 1))[0]; if (g) Object.assign(fx, g); }
  }
  return effects;
}

// Text-Einblendungen (2.14)
const TEXT_ARTS = ["punkt", "kapitel", "liste", "zahl", "zitat", "banner", "notiz", "poesie"], TEXT_ANIMS = ["einblenden", "hoch", "pop", "schreiben", "marker"];
const imgKey = k => typeof k === "string" && /^jobs\/[0-9a-f-]{36}\/img-[a-z0-9]{8}\.(jpg|jpeg|png|webp)$/i.test(k);
// Ende des Reels (2.16)
// Verknüpfung mit einem Thema aus „Meine Woche“ (KIRA-Agent)
function sanitizeAgent(a) {
  if (!a || typeof a !== "object") return null; const id = v => /^[0-9a-f-]{36}$/.test(String(v || "")) ? String(v) : null;
  const o = { week: /^\d{4}-\d\d-\d\d$/.test(String(a.week || "")) ? a.week : null, topic_id: /^[a-z0-9]{4,20}$/i.test(String(a.topic_id || "")) ? String(a.topic_id) : null, item_id: id(a.item_id), titel: String(a.titel || "").slice(0, 160), applied: !!a.applied, linked: !!a.linked };
  return o.week && o.topic_id ? o : null;
}
function sanitizeEnde(e) {
  if (!e || typeof e !== "object") return null;
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  const o = { kommentar: str(e.kommentar, 24), kommentar_text: str(e.kommentar_text, 70), freebie_titel: str(e.freebie_titel, 60), freebie_key: typeof e.freebie_key === "string" && /^jobs\/[0-9a-f-]{36}\/img-[a-z0-9]{8}\.(png|jpg|jpeg|webp)$/i.test(e.freebie_key) ? e.freebie_key : "", schleife: !!e.schleife, dauer: Math.max(2, Math.min(6, Number(e.dauer) || 3.5)) };
  return (o.kommentar || o.freebie_titel || o.freebie_key || o.schleife) ? o : null;
}
function sanitizeTexts(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
  return list.slice(0, 40).map(t => {
    if (!t || !TEXT_ARTS.includes(t.art)) return null;
    const von = Math.round(Number(t.von)); if (!isFinite(von) || von < 0) return null;
    const bis = t.bis == null || t.bis === "" || !isFinite(Number(t.bis)) ? null : Math.max(von, Math.round(Number(t.bis)));
    const o = { id: str(t.id, 24), art: t.art, text: str(t.text, 160), at: t.at != null && isFinite(Number(t.at)) ? Math.max(0, Number(t.at)) : undefined, dur: t.dur != null && isFinite(Number(t.dur)) ? Math.max(0.5, Math.min(10, Number(t.dur))) : undefined, text2: str(t.text2, 40), von, bis, anim: TEXT_ANIMS.includes(t.anim) ? t.anim : "einblenden", y: t.y == null || t.y === "" || !isFinite(Number(t.y)) ? null : Math.max(4, Math.min(90, Math.round(Number(t.y)))), off: !!t.off };
    if (t.art === "liste") o.items = (Array.isArray(t.items) ? t.items : String(t.text || "").split(/\n|;/)).map(x => str(x, 60)).filter(Boolean).slice(0, 6);
    return (o.text || (o.items && o.items.length)) ? o : null;
  }).filter(Boolean);
}
function sanitizeStyle(st) {
  st = st && typeof st === "object" ? st : {};
  const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v) : undefined;
  const num = (v, a, b) => v == null || v === "" || !isFinite(Number(v)) ? null : Math.max(a, Math.min(b, Number(v)));
  return { accent: hex(st.accent) || "#E6007E", position: ["auto", "unten", "mitte", "oben", "frei"].includes(st.position) ? st.position : "auto",
    cap_font: CAP_FONTS.includes(st.cap_font) ? st.cap_font : null, cap_color: hex(st.cap_color) || null, cap_hl: hex(st.cap_hl) || null,
    cap_scale: num(st.cap_scale, 0.6, 1.6), cap_y: num(st.cap_y, 8, 85), cap_box: ["none", "dark", "light", "accent", "custom"].includes(st.cap_box) ? st.cap_box : null,
    cap_box_bg: hex(st.cap_box_bg) || null, cap_n: st.cap_n == null ? null : (Math.round(num(st.cap_n, 1, 5)) || null), cap_case: ["upper", "normal"].includes(st.cap_case) ? st.cap_case : null,
    size: ["klein", "mittel", "gross"].includes(st.size) ? st.size : "mittel", hook: st.hook !== false, captions: st.captions !== false,
    caption_style: CAPTION_STYLES.includes(st.caption_style) ? st.caption_style : "klar", look: LOOKS.includes(st.look) ? st.look : null, effects: sanitizeEffects(st.effects),
    brand_font: BRAND_FONTS.includes(st.brand_font) ? st.brand_font : null, logo_on: !!st.logo_on, hook_box: ["accent", "black", "white", "none", "custom"].includes(st.hook_box) ? st.hook_box : "accent", hook_bg: /^#[0-9a-fA-F]{6}$/.test(st.hook_bg || "") ? st.hook_bg : null, hook_pos: ["auto", "oben", "mitte", "unten"].includes(st.hook_pos) ? st.hook_pos : "auto", hook_size: ["klein", "normal", "gross"].includes(st.hook_size) ? st.hook_size : "normal", hook_wide: !!st.hook_wide, hook_dur: num(st.hook_dur, 1, 3600), tempo: num(st.tempo, 1, 1.25), pausen: st.pausen === "knapp" ? "knapp" : null, kontrast: num(st.kontrast, -2, 2), waerme: num(st.waerme, -2, 2), saettigung: num(st.saettigung, -2, 2), schaerfe: num(st.schaerfe, 0, 3),
    filter: ["warm", "kuehl", "hell", "kontrast", "sw", "vintage"].includes(st.filter) ? st.filter : null, vignette: !!st.vignette, koernung: !!st.koernung, dauerzoom: !!st.dauerzoom, ende: sanitizeEnde(st.ende), agent: sanitizeAgent(st.agent), cover: st.cover && typeof st.cover.key === "string" && /^jobs\/[0-9a-f-]{36}\/img-[a-z0-9]{8}\.(jpg|jpeg|png|webp)$/i.test(st.cover.key) ? { key: st.cover.key, layout: ["oben", "mitte", "unten"].includes(st.cover.layout) ? st.cover.layout : "oben", t: Number(st.cover.t) || 0, title: String(st.cover.title || "").slice(0, 80) } : null, stil_paket: ["walk", "news", "tipps", "story"].includes(st.stil_paket) ? st.stil_paket : null, stimme: ["sanft", "stark"].includes(st.stimme) ? st.stimme : null, cap_round: st.cap_round === false ? false : null, caption: typeof st.caption === "string" ? st.caption.slice(0, 2200) : null, hashtags: Array.isArray(st.hashtags) ? st.hashtags.map(h => String(h).slice(0, 40)).slice(0, 15) : null,
    split: st.split && imgKey(st.split.key) ? { key: st.split.key, dauer: Math.max(1.5, Math.min(5, Number(st.split.dauer) || 3)) } : null,
    titelkarte: st.titelkarte && typeof st.titelkarte === "object" && (String(st.titelkarte.titel || "").trim() || (Array.isArray(st.titelkarte.keys) && st.titelkarte.keys.some(imgKey))) ? { titel: String(st.titelkarte.titel || "").trim().slice(0, 60), keys: (Array.isArray(st.titelkarte.keys) ? st.titelkarte.keys : []).filter(imgKey).slice(0, 3), dauer: Math.max(1, Math.min(4, Number(st.titelkarte.dauer) || 2)) } : null, texts: sanitizeTexts(st.texts), hook_font: BRAND_FONTS.includes(st.hook_font) ? st.hook_font : null,
    zoom_scale: st.zoom_scale == null ? null : Math.max(0, Math.min(2, Number(st.zoom_scale) || 0)), sounds_off: !!st.sounds_off,
    licht: Math.max(-2, Math.min(3, Math.round(Number(st.licht) || 0))), haut: Math.max(0, Math.min(5, Math.round(Number(st.haut) || 0))),
    logo: /^https:\/\/[^\s"'<>]{8,500}$/.test(String(st.logo || "")) ? String(st.logo) : null };
}

function sanitizeWords(words, max) {
  return (Array.isArray(words) ? words : []).slice(0, 3000).map(w => {
    const o = { w: String(w.w || "").slice(0, 60), s: Number(w.s) || 0, e: Number(w.e) || 0 };
    if (w.cut) o.cut = true; if (w.emph) o.emph = true; if (w.zoom) o.zoom = true; if (["ruck", "raus", "schwenk", "wackeln"].includes(w.zt)) o.zt = w.zt; if (["glitch", "blitz", "wisch", "unschaerfe"].includes(w.vfx)) o.vfx = w.vfx; if (w.hide) o.hide = true; if (w.pip && /^jobs\/[0-9a-f-]{36}\/pip-[a-z0-9]{8}\.(mp4|mov|webm)$/i.test(w.pip.key || "")) o.pip = { key: w.pip.key, pos: ["oben-rechts", "oben-links", "unten-rechts", "unten-links"].includes(w.pip.pos) ? w.pip.pos : "oben-rechts", size: w.pip.size === "mittel" ? "mittel" : "klein", dur: Math.max(1, Math.min(8, Number(w.pip.dur) || 3)) };
    if (["kling", "ping", "pop", "whoosh", "klick", "tada"].includes(w.sound)) o.sound = w.sound;
    if (w.image && typeof w.image.key === "string" && w.image.key.startsWith("jobs/")) o.image = { key: w.image.key.slice(0, 200), dur: Math.min(4, Math.max(0.8, Number(w.image.dur) || 1.8)), pos: ["oben", "mitte", "unten"].includes(w.image.pos) ? w.image.pos : "oben", size: ["klein", "mittel", "gross"].includes(w.image.size) ? w.image.size : "mittel" }; if (o.image) { if (["foto", "screenshot", "logo", "meme"].includes(w.image.art)) o.image.art = w.image.art; if (w.image.text) o.image.text = String(w.image.text).slice(0, 40); }
    return o;
  }).filter(w => w.w && w.e >= w.s && (!max || w.s <= max + 1));
}

async function routeSave(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  // Nur den Namen ändern: geht immer, auch während das Reel erstellt wird (2.13.1)
  if (b.only_title) { const t = String(b.title || "").trim().slice(0, 120); if (!t) return json({ error: "server" }, 400); await patchJob(env, j.id, { title: t }); return json({ ok: true, title: t }); }
  if (!["ready", "done", "error"].includes(j.status)) return json({ error: "busy" }, 409);
  const words = sanitizeWords(b.words, Number(j.duration) || 0);
  for (const w of words) if (w.image && !w.image.key.startsWith("jobs/" + j.id + "/")) delete w.image;
  const patch = { words, hook_titel: String(b.hook_titel || "").slice(0, 120), style: sanitizeStyle(b.style) };
  if (typeof b.title === "string" && b.title.trim()) patch.title = b.title.trim().slice(0, 120);
  await patchJob(env, j.id, patch);
  return json({ ok: true });
}

async function routeRender(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  if (j && j.input_deleted) return json({ error: "input_deleted" }, 410);
  if (!["ready", "done", "error"].includes(j.status) || !(j.words || []).length && j.has_audio) return json({ error: "busy" }, 409);
  let credits = null;
  if (j.renders >= 3) {
    const cost = await db(env, "action_costs?action=eq.reel_rerender&select=credits");
    const need = cost && cost[0] ? Number(cost[0].credits) : 5;
    const spent = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: need, p_action: "reel_rerender" } });
    const row = Array.isArray(spent) ? spent[0] : spent;
    if (!row || row.ok === false) return json({ error: "credits", need, have: creditStatus(s.acc).total }, 402);
    const st = creditStatus(s.acc);
    credits = { monthly: row.monthly_left, monthly_total: st.monthly_total, bonus: row.bonus_left, total: row.monthly_left + row.bonus_left };
  }
  // Freistellungs-Effekte kosten pro Schnitt extra (Rechenzeit auf einer Grafikkarte)
  const nCut = ((j.style && j.style.effects) || []).filter(e => CUTOUT_TYPES.includes(e.type) && !e.off).length;
  let cutCredits = 0;
  if (nCut) {
    if (!env.REPLICATE_API_TOKEN) return json({ error: "cutout_off" }, 503);
    const cc = await db(env, "action_costs?action=eq.reel_cutout&select=credits"); const per = cc && cc[0] ? Number(cc[0].credits) : 8;
    const sp = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: nCut * per, p_action: "reel_cutout", p_note: nCut + " Freistellungs-Effekte" } });
    const r0 = Array.isArray(sp) ? sp[0] : sp;
    if (!r0 || r0.ok === false) {
      if (credits) { const c2 = await db(env, "action_costs?action=eq.reel_rerender&select=credits"); await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: c2 && c2[0] ? Number(c2[0].credits) : 5, p_action: "reel_rerender" } }); }
      return json({ error: "credits", need: nCut * per, have: creditStatus(s.acc).total }, 402);
    }
    cutCredits = nCut * per;
    credits = { monthly: r0.monthly_left, bonus: r0.bonus_left, total: r0.monthly_left + r0.bonus_left, monthly_total: creditStatus(s.acc).monthly_total };
  }
  await patchJob(env, j.id, { status: "rendering", renders: j.renders + 1, error: null, cutout_credits: cutCredits });
  try {
    const dr = j.clips && j.clips.draft && j.clips.source_id ? { draft: true, clip: j.clips.clip, src_id: j.clips.source_id, src_token: await hmac(env, "internal|" + j.clips.source_id) } : {};
    await startContainer(env, url.origin, j, "render", Object.assign({ lang: s.acc.content_lang || "de", words: j.words, hook_titel: j.hook_titel, style: j.style, replicate_key: nCut ? env.REPLICATE_API_TOKEN : undefined }, dr));
  } catch (e) {
    console.log("Werkstatt nicht erreichbar:", e && e.message);
    if (cutCredits) await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: cutCredits, p_action: "reel_cutout" } });
    if (credits) { const cost = await db(env, "action_costs?action=eq.reel_rerender&select=credits"); await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: cost && cost[0] ? Number(cost[0].credits) : 5, p_action: "reel_rerender" } }); }
    await patchJob(env, j.id, { status: j.status === "done" ? "done" : "ready", renders: j.renders });
    return json({ error: "render_unavailable" }, 503);
  }
  return json({ ok: true, credits });
}

async function routeImage(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  let form; try { form = await request.formData(); } catch { return json({ error: "server" }, 400); }
  const j = await getJob(env, s, form.get("id")); if (!j) return json({ error: "not_found" }, 404);
  const f = form.get("file");
  if (!f || typeof f === "string" || !IMG_TYPES[f.type]) return json({ error: "file_type" }, 400);
  if (f.size > 8 * 1024 * 1024) return json({ error: "file_size" }, 400);
  const name = "img-" + crypto.randomUUID().slice(0, 8) + "." + IMG_TYPES[f.type];
  await env.REELS_BUCKET.put(keyOf(j.id, name), await f.arrayBuffer(), { httpMetadata: { contentType: f.type } });
  return json({ key: keyOf(j.id, name), url: await mediaUrl(env, new URL(request.url).origin, j.id, name) });
}

async function routeDelete(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const j = await getJob(env, s, url.searchParams.get("id")); if (!j) return json({ error: "not_found" }, 404);
  if (j.kind === "clips") { const dr = await db(env, "reel_jobs?source_id=eq." + j.id + "&status=neq.done&select=id,clips") || []; if (dr.some(x => x.clips && x.clips.draft)) return json({ error: "has_drafts", detail: "Aus diesem Video gibt es noch Entwürfe, die das Video brauchen. Erstelle oder lösche sie zuerst." }, 409); }
  // 2.19.1: erst Verweise lösen (geschnittene Clips, geplante Posts), dann löschen; klappt das nicht, wird das Reel ausgeblendet
  try { await db(env, "reel_jobs?source_id=eq." + j.id, { method: "PATCH", body: { source_id: null }, prefer: "return=minimal" }); } catch (e) { console.log("Clip-Verweise", e.message); }
  let hard = true;
  try { await db(env, "reel_jobs?id=eq." + j.id, { method: "DELETE", prefer: "return=minimal" }); }
  catch (e) { hard = false; console.log("Löschen über Datenbank nicht möglich, wird ausgeblendet:", e.message);
    try { await db(env, "reel_jobs?id=eq." + j.id, { method: "PATCH", body: { status: "deleted" }, prefer: "return=minimal" }); }
    catch (e2) { console.log("Ausblenden fehlgeschlagen:", e2.message); return json({ error: "delete_failed", detail: String(e.message).slice(0, 200) }, 500); } }
  try { const list = await env.REELS_BUCKET.list({ prefix: "jobs/" + j.id + "/" }); if (list.objects.length) await env.REELS_BUCKET.delete(list.objects.map(o => o.key)); } catch (e) { console.log("Dateien löschen", e.message); }
  return json({ ok: true, hard });
}

// Medien ausliefern, mit Range-Unterstützung für Video
async function routeMedia(request, env, url) {
  const parts = url.pathname.split("/"); const id = parts[4], name = decodeURIComponent(parts[5] || "");
  const exp = Number(url.searchParams.get("exp")), sig = url.searchParams.get("sig") || "";
  if (!validId(id) || !/^[a-z0-9.\-]+$/i.test(name) || !(exp > Date.now() / 1000) || sig !== await hmac(env, id + "|" + name + "|" + exp)) return new Response("", { status: 403 });
  return await serveObject(env, keyOf(id, name), request);
}
async function serveObject(env, key, request) {
  const range = request.headers.get("range");
  let obj;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const head = await env.REELS_BUCKET.head(key); if (!head) return new Response("", { status: 404 });
    const size = head.size, start = m && m[1] ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    obj = await env.REELS_BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response("", { status: 404 });
    return new Response(obj.body, { status: 206, headers: { "content-type": head.httpMetadata && head.httpMetadata.contentType || "application/octet-stream", "content-range": "bytes " + start + "-" + end + "/" + size, "content-length": String(end - start + 1), "accept-ranges": "bytes", "cache-control": "private, max-age=3600" } });
  }
  obj = await env.REELS_BUCKET.get(key); if (!obj) return new Response("", { status: 404 });
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata && obj.httpMetadata.contentType || "application/octet-stream", "content-length": String(obj.size), "accept-ranges": "bytes", "cache-control": "private, max-age=3600" } });
}

// ---------------- Schnittstelle für die Werkstatt im Container ----------------

async function routeInternal(request, env, url) {
  const parts = url.pathname.split("/"); // ["", "internal", "reels", kind, id, name]
  const kind = parts[3], id = parts[4];
  if (!validId(id) || request.headers.get("x-internal") !== await hmac(env, "internal|" + id)) return new Response("", { status: 403 });
  if (kind === "input" && request.method === "GET" && /^[2-6]$/.test(parts[5] || "")) return await serveObject(env, keyOf(id, "input" + parts[5]), request);
  if (kind === "output" && request.method === "PUT" && parts[5] === "joined.mp4") { // zusammengefügte Clips ersetzen das Original
    if (!(await env.REELS_BUCKET.head(keyOf(id, "input2")))) return new Response("", { status: 403 });
    await env.REELS_BUCKET.put(keyOf(id, "input"), request.body, { httpMetadata: { contentType: "video/mp4" } });
    for (let k = 2; k <= 6; k++) await env.REELS_BUCKET.delete(keyOf(id, "input" + k));
    return new Response("ok");
  }
  if (kind === "input" && request.method === "GET") {
    if (!(await env.REELS_BUCKET.head(keyOf(id, "input")))) { const r = await db(env, "reel_jobs?id=eq." + id + "&select=source_id"); const src = r && r[0] && r[0].source_id; if (src && validId(src)) return await serveObject(env, keyOf(src, "input"), request); }
    return await serveObject(env, keyOf(id, "input"), request);
  }
  if (kind === "output" && request.method === "PUT" && parts[5] === "source.mp4") { // Video per Link: heruntergeladenes Original wird zum Original des Auftrags
    const r = await db(env, "reel_jobs?id=eq." + id + "&select=kind,status"); const jj = r && r[0];
    if (!jj || jj.kind !== "clips" || jj.status !== "analyzing" || (await env.REELS_BUCKET.head(keyOf(id, "input")))) return new Response("", { status: 403 });
    await env.REELS_BUCKET.put(keyOf(id, "input"), request.body, { httpMetadata: { contentType: "video/mp4" } });
    const h = await env.REELS_BUCKET.head(keyOf(id, "input")); if (h) await patchJob(env, id, { input_bytes: h.size });
    return new Response("ok");
  }
  if (kind === "output" && request.method === "PUT" && parts[5] === "input.mp4") { const r = await db(env, "reel_jobs?id=eq." + id + "&select=source_id"); if (!(r && r[0] && r[0].source_id)) return new Response("", { status: 403 }); await env.REELS_BUCKET.put(keyOf(id, "input"), request.body, { httpMetadata: { contentType: "video/mp4" } }); return new Response("ok"); }
  if (kind === "asset" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("jobs/" + id + "/img-") && !key.startsWith("jobs/" + id + "/pip-")) return new Response("", { status: 403 });
    return await serveObject(env, key, request);
  }
  if (kind === "output" && request.method === "PUT") {
    const name = parts[5];
    if (!OUT_NAMES.includes(name)) return new Response("", { status: 403 });
    await env.REELS_BUCKET.put(keyOf(id, name), request.body, { httpMetadata: { contentType: name.endsWith(".mp4") ? "video/mp4" : "image/jpeg" } });
    return new Response("ok");
  }
  if (kind === "callback" && request.method === "POST") {
    const b = await request.json();
    const rows = await db(env, "reel_jobs?id=eq." + id + "&select=*"); const j = rows && rows[0]; if (!j) return new Response("", { status: 404 });
    if (b.phase === "clips") {
      const SRC_ERR = { source_blocked: "Die Plattform hat das Herunterladen blockiert. Lade das Video bitte selbst herunter und dann hier hoch.", source_password: "Das Video ist mit einem Passwort geschützt. Gib den Kenncode im Feld „Passwort“ mit an.", source_unsupported: "Diesen Link kann ich nicht öffnen. Funktionieren: YouTube, Vimeo, Zoom-Aufzeichnungen, Google Drive, Dropbox und direkte Video-Links.", source_not_public: "Der Link ist nicht öffentlich. Stell die Freigabe auf „Jeder mit dem Link“ und versuch es noch einmal.", source_too_big: "Das Video ist größer als 6 GB.", source_failed: "Das Video konnte über den Link nicht geladen werden. Lade es bitte direkt hoch." };
      const se = String(b.error || "").replace(/^source_http_\d+$/, "source_failed");
      if (b.status === "error" && SRC_ERR[se]) { await patchJob(env, id, { status: "error", error: SRC_ERR[se] }); return new Response("ok"); }
      if (b.status === "error") { await patchJob(env, id, { status: "error", error: b.error === "too_long" ? "Das Video ist länger, als dein Tarif erlaubt (Start 30 Minuten, Standard 1 Stunde 15, Pro 2,5 Stunden)." : String(b.error || "").slice(0, 300) }); return new Response("ok"); }
      const mins = Math.max(1, Math.ceil((Number(b.processed) || Number(b.duration) || 0) / 60));
      const items = (Array.isArray(b.clips) ? b.clips : []).slice(0, 15);
      await patchJob(env, id, { status: items.length ? "clips_ready" : "error", duration: Number(b.duration) || 0, clips: { sentences: (b.sentences || []).slice(0, 4000), words: (Array.isArray(b.words) ? b.words : []).slice(0, 40000), items: items.map(clipItem).filter(Boolean) }, error: items.length ? null : "In diesem Video habe ich keine Stellen gefunden, die als eigenes Reel funktionieren. Am besten eignen sich Videos, in denen du frei sprichst." });
      const cost = await db(env, "action_costs?action=eq.clips_min&select=credits"); const per = cost && cost[0] ? Number(cost[0].credits) : 2;
      try { await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: j.user_id, p_amount: mins * per, p_action: "clips_min", p_note: mins + " Minuten" } }); } catch (e) {}
      const rate = await usdEur(env); const u = b.usage || {};
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "clips_min", model_id: "whisper-1", input_tokens: Number(u.input_tokens) || 0, cached_tokens: 0, output_tokens: Number(u.output_tokens) || 0, cost_eur: Math.round((mins * 0.006 + (Number(u.input_tokens) || 0) * 0.000002 + (Number(u.output_tokens) || 0) * 0.00001) * rate * 1e6) / 1e6, credits: mins * per } }).catch(() => {});
      return new Response("ok");
    }
    if (b.phase === "transcribe") {
      if (b.status === "error") { await patchJob(env, id, { status: "error", error: b.error === "too_long" ? "Die Aufnahme ist länger, als dein Tarif erlaubt (Start 30 Minuten, Standard 1 Stunde 15, Pro 2,5 Stunden)." : String(b.error || "").slice(0, 300) }); return new Response("ok"); }
      const mins = Math.max(1, Math.ceil((Number(b.duration) || 0) / 60));
      await patchJob(env, id, { status: "ready", duration: Number(b.duration) || 0, transcript: String(b.text || "").slice(0, 400000) });
      const cost = await db(env, "action_costs?action=eq.transcribe_min&select=credits");
      const per = cost && cost[0] ? Number(cost[0].credits) : 1;
      try { await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: j.user_id, p_amount: mins * per, p_action: "transcribe_min", p_note: mins + " Minuten" } }); } catch (e) {}
      const rate = await usdEur(env);
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "transcribe_min", model_id: "whisper-1", input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_eur: Math.round((mins * 0.006 + (Number(b.seconds) || 0) * 0.00006) * rate * 1e6) / 1e6, credits: mins * per } });
      return new Response("ok");
    }
    if (b.status === "error") {
      if (b.phase === "render" && Number(j.cutout_credits) > 0) await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: j.user_id, p_amount: Number(j.cutout_credits), p_action: "reel_cutout" } });
      await patchJob(env, id, { status: b.phase === "analyze" ? "error" : (j.words && j.words.length ? "ready" : "error"), error: String(b.error || "").slice(0, 300) });
      if (b.phase === "analyze" && !(j.clips && j.clips.source_id && !j.clips.charged)) {
        const cost = await db(env, "action_costs?action=eq.reel_edit&select=credits");
        await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: j.user_id, p_amount: cost && cost[0] ? Number(cost[0].credits) : 30, p_action: "reel_edit" } });
      }
      return new Response("ok");
    }
    if (b.phase === "analyze") {
      await patchJob(env, id, { status: "ready", duration: Number(b.duration) || 0, has_audio: !!b.has_audio, words: sanitizeWords(b.words), hook_titel: String(b.hook_titel || "").slice(0, 120), bild_ideen: Array.isArray(b.bild_ideen) ? b.bild_ideen.slice(0, 5) : [],
        style: sanitizeStyle(Object.assign({}, j && j.style || {}, { effects: await preselectGifs(env, b.effekte || []) })) });
      // Kosten protokollieren: Transkription + Schnittplan + Rechenzeit
      const rate = await usdEur(env);
      const mins = b.draft ? 0 : (Number(b.duration) || 0) / 60, u = b.usage || {};
      const usd = mins * 0.006 + ((u.input_tokens || 0) * 0.5 + (u.output_tokens || 0) * 2) / 1e6 + (Number(b.seconds) || 0) * 0.00006;
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "reel_edit", model_id: "whisper-1+plan", input_tokens: u.input_tokens || 0, cached_tokens: 0, output_tokens: u.output_tokens || 0, cost_eur: Math.round(usd * rate * 1e6) / 1e6, credits: 0 } });
    } else {
      let outBytes = 0; try { const hd = await env.REELS_BUCKET.head(keyOf(id, "final.mp4")); outBytes = hd ? hd.size : 0; } catch (e) {}
      const report = (Array.isArray(b.report) ? b.report : []).slice(0, 10).map(x => String(x).slice(0, 200));
      await patchJob(env, id, Object.assign({ status: "done", length: Number(b.length) || 0, error: null, output_bytes: outBytes, cutout_credits: 0, report },
        Array.isArray(b.words_new) && j.clips && j.clips.draft ? { words: sanitizeWords(b.words_new), clips: Object.assign({}, j.clips, { draft: false }) } : {}));
      const failed = Number(b.cutout_failed) || 0, charged = Number(j.cutout_credits) || 0;
      if (failed && charged) {
        const nAll = ((j.style && j.style.effects) || []).filter(e => CUTOUT_TYPES.includes(e.type) && !e.off).length || failed;
        await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: j.user_id, p_amount: Math.min(charged, Math.round(charged / nAll * failed)), p_action: "reel_cutout" } });
      }
      if (charged) { // Kosten der Freistellung für den Admin protokollieren (Schätzwert pro erfolgreichem Effekt)
        const nOk = Math.max(0, (((j.style && j.style.effects) || []).filter(e => CUTOUT_TYPES.includes(e.type) && !e.off).length) - failed);
        if (nOk) { const rate2 = await usdEur(env); await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "reel_cutout", model_id: "replicate-rvm", input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_eur: Math.round(nOk * 0.06 * rate2 * 10000) / 10000 } }); }
      }
      const rate = await usdEur(env);
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "reel_render", model_id: "container", input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_eur: Math.round((Number(b.seconds) || 0) * 0.00006 * rate * 1e6) / 1e6, credits: 0 } });
    }
    return new Response("ok");
  }
  return new Response("", { status: 404 });
}

function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

// ---------------- Hilfsfunktionen ----------------

async function getUser(request, env) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return null;
  const res = await fetch(env.SUPABASE_URL + "/auth/v1/user", { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
  if (!res.ok) return null;
  const u = await res.json();
  return u && u.id ? u : null;
}

async function loadAccount(env, user) {
  let rows = await db(env, "profiles?id=eq." + user.id + "&select=*,plans(*)");
  if (!rows || !rows.length) {
    await db(env, "profiles", { method: "POST", prefer: "return=minimal", body: { id: user.id, email: user.email } });
    rows = await db(env, "profiles?id=eq." + user.id + "&select=*,plans(*)");
  }
  return rows[0];
}

async function usdEur(env) {
  const rows = await db(env, "settings?key=eq.usd_eur&select=value");
  const v = rows && rows[0] ? Number(rows[0].value) : 0.92;
  return v > 0 ? v : 0.92;
}

function serviceHeaders(env) {
  const key = env.SUPABASE_SERVICE_KEY;
  const h = { apikey: key };
  if (!key.startsWith("sb_")) h.Authorization = "Bearer " + key;
  return h;
}

async function db(env, path, opts = {}) {
  const headers = Object.assign(serviceHeaders(env), { "Content-Type": "application/json" });
  if (opts.prefer) headers.Prefer = opts.prefer;
  const res = await fetch(env.SUPABASE_URL + "/rest/v1/" + path, {
    method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error("Supabase " + res.status + ": " + (await res.text()).slice(0, 300));
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function storage(env, path, opts = {}) {
  const headers = Object.assign(serviceHeaders(env), { "Content-Type": "application/json" });
  const res = await fetch(env.SUPABASE_URL + "/storage/v1/" + path, {
    method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) { console.log("Storage Fehler", res.status, (await res.text()).slice(0, 300)); return null; }
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : null; } catch { return null; }
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

function extractText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  if (!Array.isArray(data.output)) return "";
  return data.output.filter(i => i.type === "message" && Array.isArray(i.content)).flatMap(i => i.content)
    .filter(c => c.type === "output_text" && typeof c.text === "string").map(c => c.text).join("\n").trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
