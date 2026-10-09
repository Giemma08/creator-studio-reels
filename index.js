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
const MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
const OUT_NAMES = ["thumb.jpg", "final.mp4", "final.jpg"];
const IMG_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export default {
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
      if (p === "/api/reels/part" && m === "PUT") return await routePart(request, env, url);
      if (p === "/api/reels/complete" && m === "POST") return await routeComplete(request, env, url);
      if (p === "/api/reels/save" && m === "POST") return await routeSave(request, env);
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
  out.thumb = j.status !== "uploading" && j.status !== "analyzing" && j.status !== "error" ? await mediaUrl(env, origin, j.id, j.status === "done" ? "final.jpg" : "thumb.jpg") : "";
  if (full) {
    Object.assign(out, { words: j.words, hook_titel: j.hook_titel, bild_ideen: j.bild_ideen, style: j.style, has_audio: j.has_audio });
    out.input = await mediaUrl(env, origin, j.id, "input");
    if (j.status === "done") out.final = await mediaUrl(env, origin, j.id, "final.mp4");
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
  const kindFilter = url.searchParams.get("kind") === "transcript" ? "&kind=eq.transcript" : "&kind=eq.reel";
  const rows = await db(env, "reel_jobs?user_id=eq." + s.user.id + kindFilter + "&select=id,created_at,updated_at,title,status,duration,renders,length,error,kind&order=created_at.desc&limit=50");
  const list = [];
  for (const j of rows || []) list.push(await publicJob(env, url.origin, j, false));
  return json({ jobs: list });
}

async function routeStart(request, env) {
  const s = await session(request, env); if (s.err) return s.err;
  const b = await readJson(request); if (!b) return json({ error: "server" }, 400);
  if (!(Number(b.size) > 0) || Number(b.size) > MAX_BYTES) return json({ error: "file_size" }, 400);
  const isTranscript = b.kind === "transcript";
  const cost = await db(env, "action_costs?action=eq." + (isTranscript ? "transcribe_min" : "reel_edit") + "&select=credits");
  const per = cost && cost[0] ? Number(cost[0].credits) : (isTranscript ? 1 : 30);
  const need = isTranscript ? Math.ceil(Math.max(1, Math.min(240, Number(b.minutes) || 60)) * per) : per;
  const st = creditStatus(s.acc);
  if (st.total < need) return json({ error: "credits", need, have: st.total }, 402);
  const rows = await db(env, "reel_jobs", { method: "POST", prefer: "return=representation", body: { user_id: s.user.id, title: String(b.name || "Reel").slice(0, 120), status: "uploading", kind: isTranscript ? "transcript" : "reel" } });
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
  if (j.kind === "transcript") {
    // Lange Aufnahme: nur in Text umwandeln, Credits nach der tatsächlichen Länge
    await patchJob(env, j.id, { status: "analyzing", upload_id: null });
    try { await startContainer(env, url.origin, j, "transcribe", { openai_key: env.OPENAI_API_KEY, lang: s.acc.content_lang || "de", max_seconds: 3 * 3600 + 60 }); }
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

function sanitizeStyle(st) {
  st = st && typeof st === "object" ? st : {};
  const hex = v => /^#[0-9a-f]{6}$/i.test(String(v || "")) ? String(v) : undefined;
  return { accent: hex(st.accent) || "#E6007E", position: ["unten", "mitte", "oben"].includes(st.position) ? st.position : "unten",
    size: ["klein", "mittel", "gross"].includes(st.size) ? st.size : "mittel", hook: st.hook !== false, captions: st.captions !== false };
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
  await patchJob(env, j.id, { status: "rendering", renders: j.renders + 1, error: null });
  try {
    await startContainer(env, url.origin, j, "render", { words: j.words, hook_titel: j.hook_titel, style: j.style });
  } catch (e) {
    console.log("Werkstatt nicht erreichbar:", e && e.message);
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
  if (kind === "input" && request.method === "GET") return await serveObject(env, keyOf(id, "input"), request);
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
    if (b.phase === "transcribe") {
      if (b.status === "error") { await patchJob(env, id, { status: "error", error: b.error === "too_long" ? "Die Aufnahme ist länger als 3 Stunden." : String(b.error || "").slice(0, 300) }); return new Response("ok"); }
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
      await patchJob(env, id, { status: b.phase === "analyze" ? "error" : (j.words && j.words.length ? "ready" : "error"), error: String(b.error || "").slice(0, 300) });
      if (b.phase === "analyze") {
        const cost = await db(env, "action_costs?action=eq.reel_edit&select=credits");
        await db(env, "rpc/refund_credits", { method: "POST", body: { p_user: j.user_id, p_amount: cost && cost[0] ? Number(cost[0].credits) : 30, p_action: "reel_edit" } });
      }
      return new Response("ok");
    }
    if (b.phase === "analyze") {
      await patchJob(env, id, { status: "ready", duration: Number(b.duration) || 0, has_audio: !!b.has_audio, words: sanitizeWords(b.words), hook_titel: String(b.hook_titel || "").slice(0, 120), bild_ideen: Array.isArray(b.bild_ideen) ? b.bild_ideen.slice(0, 5) : [] });
      // Kosten protokollieren: Transkription + Schnittplan + Rechenzeit
      const rate = await usdEur(env);
      const mins = (Number(b.duration) || 0) / 60, u = b.usage || {};
      const usd = mins * 0.006 + ((u.input_tokens || 0) * 0.5 + (u.output_tokens || 0) * 2) / 1e6 + (Number(b.seconds) || 0) * 0.00006;
      await db(env, "usage", { method: "POST", prefer: "return=minimal", body: { user_id: j.user_id, action: "reel_edit", model_id: "whisper-1+plan", input_tokens: u.input_tokens || 0, cached_tokens: 0, output_tokens: u.output_tokens || 0, cost_eur: Math.round(usd * rate * 1e6) / 1e6, credits: 0 } });
    } else {
      await patchJob(env, id, { status: "done", length: Number(b.length) || 0, error: null });
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
