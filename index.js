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
        const html = UI.replace("__SUPABASE_URL__", env.SUPABASE_URL || "").replace("__SUPABASE_ANON_KEY__", env.SUPABASE_ANON_KEY || "");
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
      if (p === "/api/reels/clips/make" && m === "POST") return await routeClipsMake(request, env, url);
      if (p === "/api/reels/part" && m === "PUT") return await routePart(request, env, url);
      if (p === "/api/reels/complete" && m === "POST") return await routeComplete(request, env, url);
      if (p === "/api/reels/save" && m === "POST") return await routeSave(request, env);
      if (p === "/api/reels/gifs" && m === "GET") return await routeGifs(request, env, url);
      if (p === "/api/reels/notes" && m === "POST") return await routeNotes(request, env, url);
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
    out.input = await mediaUrl(env, origin, j.id, "input");
    if (j.status === "done") { out.final = await mediaUrl(env, origin, j.id, "final.mp4"); out.check = await mediaUrl(env, origin, j.id, "check.jpg"); out.report = Array.isArray(j.report) ? j.report : []; }
    const imgs = {};
    for (const w of (j.words || [])) if (w && w.image && w.image.key && !imgs[w.image.key]) imgs[w.image.key] = await mediaUrl(env, origin, j.id, w.image.key.split("/").pop());
    out.images = imgs;
  }
  return out;
}

async function routeList(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  const id = url.searchParams.get("id");
  if (id) { const j = await getJob(env, s, id); return j ? json({ job: await publicJob(env, url.origin, j, true) }) : json({ error: "not_found" }, 404); }
  const kindFilter = url.searchParams.get("kind") === "transcript" ? "&kind=eq.transcript" : "&kind=in.(reel,clips)";
  const rows = await db(env, "reel_jobs?user_id=eq." + s.user.id + kindFilter + "&select=id,created_at,updated_at,title,status,duration,renders,length,error,kind&order=created_at.desc&limit=50");
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
  const per = cost && cost[0] ? Number(cost[0].credits) : (isLong ? 1 : 30);
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
  const mp = env.REELS_BUCKET.resumeMultipartUpload(keyOf(j.id, "input"), j.upload_id);
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
  const picks = (Array.isArray(b.picks) ? b.picks : []).slice(0, 10).map(p => ({ start: Math.max(0, Number(p.start) || 0), end: Math.min(dur || 1e9, Number(p.end) || 0), titel: String(p.titel || "").slice(0, 120) })).filter(p => p.end - p.start >= 5 && p.end - p.start <= 180);
  if (!picks.length) return json({ error: "server" }, 400);
  const cost = await db(env, "action_costs?action=eq.reel_edit&select=credits"); const per = cost && cost[0] ? Number(cost[0].credits) : 30;
  const need = per * picks.length, st = creditStatus(s.acc);
  if (st.total < need) return json({ error: "credits", need, have: st.total }, 402);
  const style = sanitizeStyle(b.style), made = [];
  for (const p of picks) {
    const spent = await db(env, "rpc/spend_credits", { method: "POST", body: { p_user: s.user.id, p_amount: per, p_action: "reel_edit", p_note: "Clip aus Video" } });
    const row = Array.isArray(spent) ? spent[0] : spent; if (!row || row.ok === false) break;
    const rows = await db(env, "reel_jobs", { method: "POST", prefer: "return=representation", body: { user_id: s.user.id, title: (p.titel || src.title || "Clip").slice(0, 120), status: "analyzing", kind: "reel", source_id: src.id, clip_start: p.start, clip_end: p.end, style } });
    const job = rows[0];
    try { await startContainer(env, url.origin, job, "analyze", { openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "fast"), lang: s.acc.content_lang || "de", max_seconds: 200, clip: { start: p.start, end: p.end } }); made.push(job.id); }
    catch (e) { await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: s.user.id, p_amount: per, p_action: "reel_edit" } }); await patchJob(env, job.id, { status: "error", error: "Die Werkstatt war nicht erreichbar. Bitte versuch es gleich noch einmal." }); }
  }
  if (!made.length) return json({ error: "render_unavailable" }, 503);
  return json({ ok: true, ids: made });
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
  const mp = env.REELS_BUCKET.resumeMultipartUpload(keyOf(j.id, "input"), j.upload_id);
  await mp.complete(parts);
  if (j.kind === "clips") {
    await patchJob(env, j.id, { status: "analyzing", upload_id: null });
    try { await startContainer(env, url.origin, j, "clips", { openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "premium"), lang: s.acc.content_lang || "de", max_seconds: tierLimits(s.acc).minutes * 60 + 60 }); }
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
    await startContainer(env, url.origin, j, "analyze", { openai_key: env.OPENAI_API_KEY, model: await modelFor(env, "fast"), lang: s.acc.content_lang || "de", max_seconds: 185 });
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
    if (x.type === "emoji") { o.emoji = Array.from(String(x.emoji || "")).slice(0, 2).join(""); }
    if (x.type === "hinter") { o.woerter = (Array.isArray(x.woerter) ? x.woerter : []).slice(0, 3).map(w => ({ text: s(w && w.text, 12), wort: i(w && w.wort) })).filter(w => w.text); }
    if (x.type === "spotlight") { o.text = s(x.text, 30); }
    if (x.type === "greenscreen") { o.titel = s(x.titel, 50); o.text = s(x.text, 60); }
    if (x.type === "popout") { o.titel = s(x.titel, 40); }
    if (x.type === "lichtaus") { o.text = s(x.text, 12); }
    if (x.type === "gif") {
      const giphy = u => /^https:\/\/media\d?\.giphy\.com\/[A-Za-z0-9_\/.?=&-]+$/.test(String(u || "")) ? String(u) : "";
      o.suche = s(x.suche, 40); o.gif_id = /^[A-Za-z0-9]{1,40}$/.test(String(x.gif_id || "")) ? String(x.gif_id) : "";
      o.mp4 = giphy(x.mp4); o.preview = giphy(x.preview); o.titel = s(x.titel, 60);
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

// ---------------- GIFs über Giphy (Powered by GIPHY) ----------------
async function giphySearch(env, q, limit) {
  if (!env.GIPHY_API_KEY || !q) return [];
  const u = "https://api.giphy.com/v1/gifs/search?api_key=" + encodeURIComponent(env.GIPHY_API_KEY) + "&q=" + encodeURIComponent(q) + "&limit=" + (limit || 12) + "&rating=g&lang=de";
  const r = await fetch(u); if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d.data || []).map(g => {
    const im = g.images || {}; const v = im.fixed_height || im.original || {}; const pr = im.fixed_width_small || im.fixed_height_small || v;
    return { gif_id: g.id, titel: String(g.title || "").slice(0, 60), mp4: v.mp4 || (im.original && im.original.mp4) || "", preview: pr.webp || pr.url || "", w: Number(v.width) || 480, h: Number(v.height) || 270 };
  }).filter(g => g.mp4);
}
async function routeGifs(request, env, url) {
  const s = await session(request, env); if (s.err) return s.err;
  if (!env.GIPHY_API_KEY) return json({ error: "gifs_off" }, 503);
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 50);
  return json({ gifs: await giphySearch(env, q, 12) });
}
// Für KI-Vorschläge ohne Auswahl das erste passende GIF vorwählen
async function preselectGifs(env, effects) {
  for (const fx of effects || []) {
    if (fx && fx.type === "gif" && !fx.mp4 && fx.suche) { const g = (await giphySearch(env, fx.suche, 1))[0]; if (g) Object.assign(fx, g); }
  }
  return effects;
}

function sanitizeStyle(st) {
  st = st && typeof st === "object" ? st : {};
  const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v) : undefined;
  return { accent: hex(st.accent) || "#E6007E", position: ["auto", "unten", "mitte", "oben"].includes(st.position) ? st.position : "auto",
    size: ["klein", "mittel", "gross"].includes(st.size) ? st.size : "mittel", hook: st.hook !== false, captions: st.captions !== false,
    caption_style: CAPTION_STYLES.includes(st.caption_style) ? st.caption_style : "klar", look: LOOKS.includes(st.look) ? st.look : null, effects: sanitizeEffects(st.effects),
    brand_font: BRAND_FONTS.includes(st.brand_font) ? st.brand_font : null, logo_on: !!st.logo_on,
    zoom_scale: st.zoom_scale == null ? null : Math.max(0, Math.min(2, Number(st.zoom_scale) || 0)), sounds_off: !!st.sounds_off,
    logo: /^https:\/\/[^\s"'<>]{8,500}$/.test(String(st.logo || "")) ? String(st.logo) : null };
}

function sanitizeWords(words, max) {
  return (Array.isArray(words) ? words : []).slice(0, 3000).map(w => {
    const o = { w: String(w.w || "").slice(0, 60), s: Number(w.s) || 0, e: Number(w.e) || 0 };
    if (w.cut) o.cut = true; if (w.emph) o.emph = true; if (w.zoom) o.zoom = true;
    if (["kling", "ping", "pop", "whoosh", "klick", "tada"].includes(w.sound)) o.sound = w.sound;
    if (w.image && typeof w.image.key === "string" && w.image.key.startsWith("jobs/")) o.image = { key: w.image.key.slice(0, 200), dur: Math.min(4, Math.max(0.8, Number(w.image.dur) || 1.8)), pos: ["oben", "mitte", "unten"].includes(w.image.pos) ? w.image.pos : "oben", size: ["klein", "mittel", "gross"].includes(w.image.size) ? w.image.size : "mittel" };
    return o;
  }).filter(w => w.w && w.e >= w.s && (!max || w.s <= max + 1));
}

async function routeSave(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  const j = await getJob(env, s, b.id); if (!j) return json({ error: "not_found" }, 404);
  if (!["ready", "done", "error"].includes(j.status)) return json({ error: "busy" }, 409);
  const words = sanitizeWords(b.words, Number(j.duration) || 0);
  for (const w of words) if (w.image && !w.image.key.startsWith("jobs/" + j.id + "/")) delete w.image;
  await patchJob(env, j.id, { words, hook_titel: String(b.hook_titel || "").slice(0, 120), style: sanitizeStyle(b.style) });
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
    await startContainer(env, url.origin, j, "render", { words: j.words, hook_titel: j.hook_titel, style: j.style, replicate_key: nCut ? env.REPLICATE_API_TOKEN : undefined });
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
  const list = await env.REELS_BUCKET.list({ prefix: "jobs/" + j.id + "/" });
  if (list.objects.length) await env.REELS_BUCKET.delete(list.objects.map(o => o.key));
  await db(env, "reel_jobs?id=eq." + j.id, { method: "DELETE", prefer: "return=minimal" });
  return json({ ok: true });
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
  if (kind === "input" && request.method === "GET") {
    if (!(await env.REELS_BUCKET.head(keyOf(id, "input")))) { const r = await db(env, "reel_jobs?id=eq." + id + "&select=source_id"); const src = r && r[0] && r[0].source_id; if (src && validId(src)) return await serveObject(env, keyOf(src, "input"), request); }
    return await serveObject(env, keyOf(id, "input"), request);
  }
  if (kind === "output" && request.method === "PUT" && parts[5] === "input.mp4") { const r = await db(env, "reel_jobs?id=eq." + id + "&select=source_id"); if (!(r && r[0] && r[0].source_id)) return new Response("", { status: 403 }); await env.REELS_BUCKET.put(keyOf(id, "input"), request.body, { httpMetadata: { contentType: "video/mp4" } }); return new Response("ok"); }
  if (kind === "asset" && request.method === "GET") {
    const key = url.searchParams.get("key") || "";
    if (!key.startsWith("jobs/" + id + "/img-")) return new Response("", { status: 403 });
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
      if (b.status === "error") { await patchJob(env, id, { status: "error", error: b.error === "too_long" ? "Das Video ist länger, als dein Tarif erlaubt (Start 30 Minuten, Standard 1 Stunde 15, Pro 2,5 Stunden)." : String(b.error || "").slice(0, 300) }); return new Response("ok"); }
      const mins = Math.max(1, Math.ceil((Number(b.duration) || 0) / 60));
      const items = (Array.isArray(b.clips) ? b.clips : []).slice(0, 12);
      await patchJob(env, id, { status: items.length ? "clips_ready" : "error", duration: Number(b.duration) || 0, clips: { sentences: (b.sentences || []).slice(0, 4000), items }, error: items.length ? null : "In diesem Video habe ich keine Stellen gefunden, die als eigenes Reel funktionieren. Am besten eignen sich Videos, in denen du frei sprichst." });
      const cost = await db(env, "action_costs?action=eq.clips_min&select=credits"); const per = cost && cost[0] ? Number(cost[0].credits) : 1;
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
      if (b.phase === "analyze") {
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
      const mins = (Number(b.duration) || 0) / 60, u = b.usage || {};
      const usd = mins * 0.006 + ((u.input_tokens || 0) * 0.5 + (u.output_tokens || 0) * 2) / 1e6 + (Number(b.seconds) || 0) * 0.00006;
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "reel_edit", model_id: "whisper-1+plan", input_tokens: u.input_tokens || 0, cached_tokens: 0, output_tokens: u.output_tokens || 0, cost_eur: Math.round(usd * rate * 1e6) / 1e6, credits: 0 } });
    } else {
      let outBytes = 0; try { const hd = await env.REELS_BUCKET.head(keyOf(id, "final.mp4")); outBytes = hd ? hd.size : 0; } catch (e) {}
      const report = (Array.isArray(b.report) ? b.report : []).slice(0, 10).map(x => String(x).slice(0, 200));
      await patchJob(env, id, { status: "done", length: Number(b.length) || 0, error: null, output_bytes: outBytes, cutout_credits: 0, report });
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
