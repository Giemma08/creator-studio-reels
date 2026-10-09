// Reel-Werkstatt: läuft im Cloudflare Container
// POST /analyze  -> Transkription mit Wort-Zeitmarken + KI-Schnittplan
// POST /render   -> Schnitt, Untertitel, Zooms, Bilder, Töne -> MP4
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const R = require("./render.cjs");

const PORT = 8080;
const WORK = "/tmp/jobs";
const SOUND_DIR = path.join(__dirname, "sounds");
const FONT_DIR = path.join(__dirname, "fonts");
const OPENAI = process.env.OPENAI_BASE || "https://api.openai.com";
fs.mkdirSync(WORK, { recursive: true });

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args); let err = "", out = "";
    p.stdout.on("data", d => { out += d; }); p.stderr.on("data", d => { err += d; });
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(cmd + " " + code + ": " + err.slice(-800))));
  });
}
async function download(url, headers, file) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("download " + res.status + " " + url);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}
async function upload(url, headers, file, type) {
  const res = await fetch(url, { method: "PUT", headers: Object.assign({ "Content-Type": type }, headers), body: fs.readFileSync(file) });
  if (!res.ok) throw new Error("upload " + res.status);
}
async function callback(job, body) {
  try {
    await fetch(job.base + "/internal/reels/callback/" + job.id, { method: "POST", headers: { "Content-Type": "application/json", "x-internal": job.token }, body: JSON.stringify(body) });
  } catch (e) { console.log("Callback Fehler", e.message); }
}
function hdr(job) { return { "x-internal": job.token }; }

async function probe(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const j = JSON.parse(out);
  return { duration: Number(j.format && j.format.duration) || 0, hasAudio: (j.streams || []).some(s => s.codec_type === "audio") };
}

async function getInput(job, dir) {
  const input = path.join(dir, "input");
  if (!fs.existsSync(input)) await download(job.base + "/internal/reels/input/" + job.id, hdr(job), input);
  return input;
}

// ---------- Analyse ----------
async function analyze(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  const input = await getInput(job, dir);
  const info = await probe(input);
  if (info.duration > (job.max_seconds || 185)) throw new Error("too_long");
  let words = [];
  if (info.hasAudio) {
    const audio = path.join(dir, "audio.mp3");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(audio)], { type: "audio/mpeg" }), "audio.mp3");
    fd.append("model", "whisper-1");
    fd.append("response_format", "verbose_json");
    fd.append("timestamp_granularities[]", "word");
    if (job.lang) fd.append("language", job.lang);
    const res = await fetch(OPENAI + "/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + job.openai_key }, body: fd });
    if (!res.ok) throw new Error("transcribe " + res.status + " " + (await res.text()).slice(0, 300));
    const tr = await res.json();
    words = (tr.words || []).map(w => ({ w: String(w.word).trim(), s: Number(w.start), e: Number(w.end) })).filter(w => w.w);
    // Satzzeichen aus dem Volltext übernehmen (Wort-Zeitmarken haben oft keine)
    if (tr.text) attachPunctuation(words, tr.text);
  }
  const plan = words.length ? await aiPlan(job, words) : { hook_titel: "", schnitte: [], betont: [], zooms: [], toene: [], bild_ideen: [] };
  // Plan auf die Wörter anwenden
  (plan.schnitte || []).forEach(r => { const a = Math.max(0, r[0] | 0), b = Math.min(words.length - 1, r[1] | 0); for (let i = a; i <= b; i++) words[i].cut = true; });
  (plan.betont || []).forEach(i => { if (words[i]) words[i].emph = true; });
  (plan.zooms || []).slice(0, 5).forEach(i => { if (words[i]) words[i].zoom = true; });
  (plan.toene || []).slice(0, 5).forEach(x => { if (words[x.i] && R.SOUNDS.includes(x.ton)) words[x.i].sound = x.ton; });
  // Vorschaubild
  const thumb = path.join(dir, "thumb.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(Math.min(1, info.duration / 2)), "-i", input, "-frames:v", "1", "-vf", "scale=360:-2", thumb]);
  await upload(job.base + "/internal/reels/output/" + job.id + "/thumb.jpg", hdr(job), thumb, "image/jpeg");
  return { status: "ready", duration: info.duration, has_audio: info.hasAudio, words, hook_titel: plan.hook_titel || "", bild_ideen: plan.bild_ideen || [] };
}

function attachPunctuation(words, text) {
  const toks = text.split(/\s+/).filter(Boolean); let j = 0;
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let i = 0; i < words.length && j < toks.length; i++) {
    let k = j; while (k < toks.length && k < j + 4 && norm(toks[k]) !== norm(words[i].w)) k++;
    if (k < toks.length && norm(toks[k]) === norm(words[i].w)) { words[i].w = toks[k]; j = k + 1; }
  }
}

async function aiPlan(job, words) {
  const list = words.map((w, i) => i + ": " + w.w).join("\n");
  const instructions = "Du bist Cutterin für Instagram-Reels. Du bekommst ein Transkript Wort für Wort mit Nummern. Aufgaben:\n" +
    "1. 'schnitte': Bereiche [von, bis] (Wortnummern, inklusive), die raus sollen: Füllwörter (äh, ähm, also am Satzanfang ohne Funktion), Versprecher, abgebrochene Sätze und wiederholte Anläufe. Bei mehreren Anläufen desselben Satzes bleibt nur der letzte vollständige. Schneide nie Inhalt, der gebraucht wird.\n" +
    "2. 'hook_titel': ein kurzer Titel für die ersten 3 Sekunden, höchstens 7 Wörter, aus der Kernaussage des Anfangs.\n" +
    "3. 'betont': bis zu 6 Wortnummern mit den wichtigsten Wörtern (Zahlen, Kernbegriffe, Gefühle).\n" +
    "4. 'zooms': bis zu 3 Wortnummern für einen kurzen Zoom an starken Momenten.\n" +
    "5. 'toene': bis zu 3 Stellen für einen Soundeffekt, Ton aus: pop, ping, kling, whoosh, klick, tada. Sparsam, nur wo es den Moment unterstreicht (z. B. Zahl, Pointe, Wendung).\n" +
    "6. 'bild_ideen': bis zu 3 Wortnummern, an denen ein kleines eingeblendetes Bild helfen würde, mit kurzer Idee.\n" +
    "Antworte ausschließlich mit JSON: {\"schnitte\":[[0,0]],\"hook_titel\":\"\",\"betont\":[0],\"zooms\":[0],\"toene\":[{\"i\":0,\"ton\":\"pop\"}],\"bild_ideen\":[{\"i\":0,\"idee\":\"\"}]}";
  const res = await fetch(OPENAI + "/v1/responses", {
    method: "POST", headers: { Authorization: "Bearer " + job.openai_key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: job.model, instructions, input: [{ role: "user", content: list.slice(0, 60000) }], max_output_tokens: 2000 }),
  });
  if (!res.ok) { console.log("Plan Fehler", res.status, (await res.text()).slice(0, 300)); return {}; }
  const data = await res.json();
  let text = data.output_text || "";
  if (!text && Array.isArray(data.output)) data.output.forEach(o => (o.content || []).forEach(c => { if (c.type === "output_text") text += c.text; }));
  const usage = data.usage || {};
  job.usage = { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 };
  try { const m = text.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

// ---------- Rendern ----------
async function render(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  const input = await getInput(job, dir);
  const info = await probe(input);
  const words = (job.words || []).map(w => Object.assign({}, w));
  const segs = R.keptSegments(words, info.duration);
  if (!segs.length) throw new Error("nothing_left");
  const map = R.remapper(segs);
  const style = Object.assign({ accent: "#E6007E", font: "Poppins" }, job.style || {}, { hook_titel: job.hook_titel || "" });
  const assFile = path.join(dir, "subs.ass");
  fs.writeFileSync(assFile, R.buildAss(words, map, style));
  const kept = words.filter(w => !w.cut);
  const zooms = kept.filter(w => w.zoom).map(w => map(w.s));
  const sounds = kept.filter(w => w.sound && R.SOUNDS.includes(w.sound)).map(w => ({ file: path.join(SOUND_DIR, w.sound + ".wav"), t: Math.max(0, map(w.s) - 0.05) }));
  const images = [];
  for (const w of kept.filter(x => x.image && x.image.key)) {
    const f = path.join(dir, "img-" + images.length);
    await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(w.image.key), hdr(job), f);
    images.push({ file: f, t: map(w.s), dur: Math.min(4, Math.max(0.8, Number(w.image.dur) || 1.8)), pos: w.image.pos || "oben", size: w.image.size || "mittel" });
  }
  const out = path.join(dir, "final.mp4");
  await run("ffmpeg", R.buildFfmpegArgs({ input, segs, map, zooms, images, sounds, assFile, fontsDir: FONT_DIR, output: out, hasAudio: info.hasAudio }));
  const thumb = path.join(dir, "final.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.4", "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", thumb]);
  await upload(job.base + "/internal/reels/output/" + job.id + "/final.mp4", hdr(job), out, "video/mp4");
  await upload(job.base + "/internal/reels/output/" + job.id + "/final.jpg", hdr(job), thumb, "image/jpeg");
  return { status: "done", length: map.total };
}

// ---------- Lange Aufnahmen in Text umwandeln (Repurposing) ----------
async function transcribe(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  const input = await getInput(job, dir);
  const info = await probe(input);
  if (info.duration > (job.max_seconds || 3 * 3600)) throw new Error("too_long");
  if (!info.hasAudio) throw new Error("Die Datei enthält keine Tonspur.");
  // Ton herauslösen und in 10-Minuten-Stücke teilen (jedes Stück bleibt unter der Größengrenze der Transkription)
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", "600", path.join(dir, "part_%03d.mp3")]);
  const parts = fs.readdirSync(dir).filter(f => /^part_\d+\.mp3$/.test(f)).sort();
  const texts = [];
  for (const f of parts) {
    let ok = false, tries = 0, last = "";
    while (!ok && tries++ < 3) {
      const fd = new FormData();
      fd.append("file", new Blob([fs.readFileSync(path.join(dir, f))], { type: "audio/mpeg" }), f);
      fd.append("model", "whisper-1"); fd.append("response_format", "text");
      if (job.lang) fd.append("language", job.lang);
      const res = await fetch(OPENAI + "/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + job.openai_key }, body: fd });
      if (res.ok) { texts.push((await res.text()).trim()); ok = true; } else { last = res.status + " " + (await res.text()).slice(0, 200); await new Promise(r => setTimeout(r, 2000 * tries)); }
    }
    if (!ok) throw new Error("transcribe " + last);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  return { status: "ready", duration: info.duration, text: texts.join("\n\n") };
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method !== "POST" || !["/analyze", "/render", "/transcribe"].includes(req.url)) { res.statusCode = 404; res.end(); return; }
  let body = "";
  req.on("data", d => { body += d; if (body.length > 5e6) req.destroy(); });
  req.on("end", () => {
    let job; try { job = JSON.parse(body); } catch { res.statusCode = 400; res.end(); return; }
    if (!job.id || !/^[0-9a-f-]{36}$/.test(job.id) || !job.base || !job.token) { res.statusCode = 400; res.end(); return; }
    res.statusCode = 202; res.end(JSON.stringify({ accepted: true }));
    const fn = req.url === "/analyze" ? analyze : req.url === "/transcribe" ? transcribe : render;
    const t0 = Date.now();
    fn(job).then(r => callback(job, Object.assign({ phase: req.url.slice(1), seconds: (Date.now() - t0) / 1000, usage: job.usage || null }, r)))
      .catch(e => { console.log("Fehler", e.stack || e); callback(job, { phase: req.url.slice(1), status: "error", error: String(e.message || e).slice(0, 300) }); });
  });
});
server.listen(PORT, () => console.log("Reel-Werkstatt läuft auf Port " + PORT));
