// Reel-Werkstatt: läuft im Cloudflare Container
// POST /analyze  -> Transkription mit Wort-Zeitmarken + KI-Schnittplan
// POST /render   -> Schnitt, Untertitel, Zooms, Bilder, Töne -> MP4
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const R = require("./render.cjs");
const E = require("./effects.cjs");
const C = require("./cutout.cjs");
const ASSET_DIR = path.join(__dirname, "assets");
const HF_BIN = path.join(__dirname, "node_modules", ".bin", "hyperframes");

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
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation", "-of", "json", file]);
  const j = JSON.parse(out), vs = (j.streams || []).find(s => s.codec_type === "video") || {};
  let w = Number(vs.width) || 0, h = Number(vs.height) || 0; const rot = Math.abs(Number((vs.tags && vs.tags.rotate) || ((vs.side_data_list || [])[0] || {}).rotation || 0)); if (rot === 90 || rot === 270) { const t = w; w = h; h = t; }
  return { duration: Number(j.format && j.format.duration) || 0, hasAudio: (j.streams || []).some(s => s.codec_type === "audio"), width: w, height: h };
}

// Mehrere Clips (2.15): alle laden, auf 1080 × 1920 bringen, aneinanderhängen und als neues Original hochladen
async function joinClips(job, dir) {
  const n = Math.max(2, Math.min(6, Number(job.clips) || 2)), files = [];
  for (let k = 1; k <= n; k++) { const f = path.join(dir, "clip" + k); await download(job.base + "/internal/reels/input/" + job.id + (k > 1 ? "/" + k : ""), hdr(job), f); files.push(f); }
  const args = ["-y", "-loglevel", "error"], f = [];
  const infos = [];
  for (const fl of files) infos.push(await probe(fl));
  files.forEach(fl => args.push("-i", fl));
  infos.forEach((inf, i) => {
    f.push("[" + i + ":v]fps=30,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,format=yuv420p[v" + i + "]");
    if (inf.hasAudio) f.push("[" + i + ":a]aresample=44100,aformat=sample_rates=44100:channel_layouts=stereo[a" + i + "]");
    else f.push("anullsrc=r=44100:cl=stereo,atrim=0:" + Math.max(0.1, inf.duration).toFixed(3) + "[a" + i + "]");
  });
  f.push(infos.map((_, i) => "[v" + i + "][a" + i + "]").join("") + "concat=n=" + n + ":v=1:a=1[v][a]");
  const out = path.join(dir, "input");
  args.push("-filter_complex", f.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", out);
  await run("ffmpeg", args);
  await upload(job.base + "/internal/reels/output/" + job.id + "/joined.mp4", hdr(job), out, "video/mp4");
  files.forEach(fl => { try { fs.unlinkSync(fl); } catch (e) {} });
}

// Karte aus einem Bild (2.16): abgerundet, Schatten; Foto mit weißem Rand und leicht schräg, Screenshot mit feinem Rand, Logo frei, Meme mit Text oben
async function makeCard(src, out, art, size, text, dir) {
  const w = size === "gross" ? 860 : size === "klein" ? 420 : 640, R0 = art === "logo" ? 0 : art === "meme" ? 20 : 30;
  const pad = art === "foto" ? 16 : art === "screenshot" ? 3 : 0, padCol = art === "foto" ? "white" : "0xE2E2E2";
  const chain = ["scale=" + (w - 2 * pad) + ":-2", "format=rgba"];
  if (art === "meme" && text) { const tf = path.join(dir, "meme-" + Date.now() + ".txt"); fs.writeFileSync(tf, String(text).toLocaleUpperCase("de-DE").slice(0, 40));
    chain.push("drawtext=fontfile=/usr/share/fonts/Anton-Regular.ttf:textfile=" + tf + ":fontsize=w*0.09:fontcolor=white:borderw=5:bordercolor=black:x=(w-text_w)/2:y=h*0.04"); }
  if (pad) chain.push("pad=iw+" + 2 * pad + ":ih+" + 2 * pad + ":" + pad + ":" + pad + ":color=" + padCol);
  if (R0) chain.push("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(W/2-X),W/2-" + R0 + ")*gt(abs(H/2-Y),H/2-" + R0 + "),if(lte(hypot(" + R0 + "-(W/2-abs(W/2-X))," + R0 + "-(H/2-abs(H/2-Y)))," + R0 + "),alpha(X,Y),0),alpha(X,Y))'");
  chain.push("pad=iw+80:ih+80:40:40:color=black@0");
  let fc = "[0:v]" + chain.join(",") + ",split[c1][c2];[c2]geq=r=0:g=0:b=0:a='alpha(X,Y)*0.45',boxblur=16:4[sh];[sh][c1]overlay=0:-12" + (art === "foto" ? ",rotate=-2*PI/180:c=none:ow=rotw(-2*PI/180):oh=roth(-2*PI/180)" : "") + "[o]";
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-filter_complex", fc, "-map", "[o]", "-frames:v", "1", out]);
  return out;
}

// Querformat → Hochformat (2.18): mittlere Gesichtsposition (0..1 der Breite), sonst null
async function faceX(input, info, dir) {
  if (!(info.width && info.height && info.width / info.height > 0.7)) return null;
  const py = path.join(dir, "facex.py");
  fs.writeFileSync(py, "import sys, cv2\nc=cv2.VideoCapture(sys.argv[1]); n=int(c.get(7) or 0); fps=c.get(5) or 30; step=max(1,int(fps)); xs=[]\ndet=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml')\ni=0\nwhile True:\n  ok=c.grab()\n  if not ok: break\n  if i%step==0:\n    ok,f=c.retrieve()\n    if ok:\n      g=cv2.cvtColor(cv2.resize(f,(640,int(640*f.shape[0]/f.shape[1]))),cv2.COLOR_BGR2GRAY); fs=det.detectMultiScale(g,1.15,5,minSize=(40,40))\n      if len(fs): x,y,w,h=max(fs,key=lambda r:r[2]*r[3]); xs.append((x+w/2)/640)\n  i+=1\n  if len(xs)>=40: break\nxs.sort(); print(xs[len(xs)//2] if xs else -1)\n");
  try { const r = Number(String(await run("python3", [py, input])).trim()); return r > 0 ? r : null; } catch (e) { console.log("Gesichtssuche übersprungen", e.message); return null; }
}
// Titelkarte (2.18): cremefarbener Hintergrund mit bis zu 3 Polaroid-Fotos
async function makeTitleCard(job, keys, dir) {
  const POS = [[[290, 330]], [[90, 300], [480, 560]], [[60, 260], [470, 330], [260, 700]]], files = [];
  for (let i = 0; i < Math.min(3, keys.length); i++) { const f = path.join(dir, "tk" + i); await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(keys[i]), hdr(job), f); files.push(await makeCard(f, path.join(dir, "tkc" + i + ".png"), "foto", "mittel", "", dir)); }
  const out = path.join(dir, "titelkarte.png"), pos = POS[Math.max(0, files.length - 1)] || [], args = ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xF7F1E8:s=1080x1920"];
  files.forEach(f => args.push("-i", f));
  let fc = "", v = "0:v"; files.forEach((f, i) => { const sc = files.length === 1 ? 1 : files.length === 2 ? 0.8 : 0.7; fc += "[" + (i + 1) + ":v]scale=iw*" + sc + ":-1,rotate=" + [-0.1, 0.07, -0.04][i] + ":c=none:ow=rotw(" + [-0.1, 0.07, -0.04][i] + "):oh=roth(" + [-0.1, 0.07, -0.04][i] + ")[p" + i + "];[" + v + "][p" + i + "]overlay=" + pos[i][0] + ":" + pos[i][1] + "[b" + i + "];"; v = "b" + i; });
  args.push("-filter_complex", (fc || "[0:v]null[b0];").replace(/;$/, ""), "-map", "[" + (files.length ? v : "b0") + "]", "-frames:v", "1", out);
  await run("ffmpeg", args); return out;
}

async function getInput(job, dir) {
  const input = path.join(dir, "input");
  if (!fs.existsSync(input)) await download(job.base + "/internal/reels/input/" + job.id, hdr(job), input);
  return input;
}

// ---------- Analyse ----------
async function analyze(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  if (!job.clip && Number(job.clips) > 1) await joinClips(job, dir);
  const input = job.clip ? await cutClip(job, dir) : await getInput(job, dir);
  const info = await probe(input);
  if (info.duration > (job.max_seconds || 185)) throw new Error("too_long");
  let words = [];
  if (info.hasAudio) {
    const audio = path.join(dir, "audio.mp3");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", audio]);
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(audio)], { type: "audio/mpeg" }), "audio.mp3");
    fd.append("model", "whisper-1");
    if (job.vocab) fd.append("prompt", String(job.vocab).slice(0, 800));
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
  return { status: "ready", duration: info.duration, has_audio: info.hasAudio, words, hook_titel: plan.hook_titel || "", bild_ideen: plan.bild_ideen || [], effekte: Array.isArray(plan.effekte) ? plan.effekte.slice(0, 3) : [] };
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
    "7. 'effekte': höchstens 2 grafische Effekte, NUR wenn der gesprochene Text sie wirklich trägt, sonst leere Liste. Typen: " +
    "'checkliste' (der Text zählt 2 bis 4 Schritte oder Punkte nacheinander auf: von, bis, titel, punkte:[{text, wort}] mit der Wortnummer, an der der Punkt gesagt wird; text höchstens 4 Wörter), " +
    "'zahl' (eine Zahl wird gesagt: wort = Wortnummer der Zahl, wert genau wie gesagt, praefix/suffix z. B. '€' oder '%', label höchstens 4 Wörter), " +
    "'kommentar' (Aufruf, ein Wort zu kommentieren: von, bis, stichwort genau wie gesagt in Großbuchstaben, antwort kurz und freundlich), " +
    "'karte' (eine zentrale Kernaussage: von, bis, titel höchstens 3 Wörter, text höchstens 8 Wörter), " +
    "'zitat' (ein besonders starker, zitierfähiger Satz: von, bis, text wörtlich gekürzt auf höchstens 14 Wörter), " +
    "'kapitel' (ein neuer Abschnitt wie 'Schritt 2' oder 'Punkt drei' beginnt: wort, nummer, titel höchstens 4 Wörter), " +
    "'diagramm' (es geht um Wachstum oder Entwicklung: von, bis, titel höchstens 3 Wörter, wert nur wenn gesagt), " +
    "'vergleich' (ein Vorher und ein Nachher werden genannt: von, bis, vorher und nachher je höchstens 5 Wörter), " +
    "'nachricht' (eine Nachricht, Anfrage oder ein Gespräch wird erzählt: von, bis, nachrichten: 2 bis 3 kurze Sätze abwechselnd), " +
    "'emoji' (eine Pointe oder ein starkes Gefühl: wort, emoji genau ein passendes Emoji), " +
    "'gif' (eine Reaktion, Pointe oder Übertreibung, zu der ein bekanntes Reaktions-GIF passt: wort, suche = 1 bis 3 englische Suchwörter wie 'mind blown' oder 'happy dance'). Erfinde keine Zahlen, Namen oder Ergebnisse. Lieber kein Effekt als ein unpassender.\n" +
    "Antworte ausschließlich mit JSON: {\"schnitte\":[[0,0]],\"hook_titel\":\"\",\"betont\":[0],\"zooms\":[0],\"toene\":[{\"i\":0,\"ton\":\"pop\"}],\"bild_ideen\":[{\"i\":0,\"idee\":\"\"}],\"effekte\":[{\"type\":\"zahl\",\"wort\":0,\"wert\":\"\",\"label\":\"\"}]}";
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
// Kontrolle: Rutscht das Gesicht irgendwann in den Untertitel-Bereich? Dann dort die Untertitel über den Kopf setzen.
function faceCheck(layout, segs, map, style) {
  const moves = [];
  if (!layout || !layout.found || !Array.isArray(layout.track) || (style.position && style.position !== "auto")) return moves;
  const cap = layout.zones && layout.zones.captions;
  if (!cap || cap.where !== "unter dem Kinn") return moves;
  const kept = t => segs.some(sg => t >= sg.s && t <= sg.e);
  const raw = layout.track.filter(p => kept(p.t) && p.chin > cap.y - 15)
    .map(p => [Math.max(0, map(p.t) - 0.45), map(p.t) + 0.45, Math.max(230, p.top - 240)]);
  for (const w of raw.sort((a, b) => a[0] - b[0])) {
    const last = moves[moves.length - 1];
    if (last && w[0] <= last[1] + 0.1) { last[1] = Math.max(last[1], w[1]); last[2] = Math.min(last[2], w[2]); } else moves.push(w.slice());
  }
  return moves;
}

const LOCALES = { de: "de-DE", en: "en-US", fr: "fr-FR", it: "it-IT", es: "es-ES", pt: "pt-PT", nl: "nl-NL", sv: "sv-SE", ca: "ca-ES" };
async function render(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  const input = await getInput(job, dir);
  const info = await probe(input);
  const words = (job.words || []).map(w => Object.assign({}, w));
  let segs = R.keptSegments(words, info.duration, (job.style || {}).pausen);
  if (!segs.length && !words.length && info.duration > 0.5) segs = [{ s: 0, e: info.duration }]; // Stimmungs-Reel ohne Sprechen (2.19)
  if (!segs.length) throw new Error("nothing_left");
  const map = R.remapper(segs);
  const style = Object.assign({ accent: "#E6007E", font: "Poppins" }, job.style || {}, { hook_titel: job.hook_titel || "" });
  // 1. Wo ist die Person? Kleine Vorschau in 1080x1920 (wie das Reel), 3 Bilder pro Sekunde
  let layout = null, cropX = null;
  try {
    const proxy = path.join(dir, "proxy.mp4");
    cropX = await faceX(input, info, dir);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", input, "-an", "-vf", "fps=3,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" + (cropX != null ? ":'max(0,min(iw-ow,iw*" + cropX.toFixed(4) + "-ow/2))':0" : ""), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", proxy]);
    layout = JSON.parse(await run("python3", [path.join(__dirname, "layout.py"), proxy]));
  } catch (e) { console.log("Vermessung übersprungen", e.message); }
  // 2. Effekte als durchsichtige Ebenen rendern (HyperFrames)
  const effects = [], hide = [], report = [];
  if (!layout || !layout.found) report.push("Kein Gesicht erkannt: Die Untertitel stehen unten in der Mitte.");
  const planned = E.planEffects((job.style && job.style.effects) || [], words, map, layout);
  const wanted = ((job.style && job.style.effects) || []).filter(x => !x.off && (x.type !== "gif" || x.mp4 || x.src)).length;
  if (wanted > planned.length) report.push((wanted - planned.length) + (wanted - planned.length === 1 ? " Effekt passte" : " Effekte passten") + " zeitlich nicht ins Reel und " + (wanted - planned.length === 1 ? "wurde" : "wurden") + " weggelassen.");
  const cutouts = [];
  for (let i = 0; i < planned.length; i++) {
    const it = planned[i], fxDir = path.join(dir, "fx" + i);
    if (E.CUTOUT.includes(it.fx.type)) { cutouts.push({ it, fxDir }); continue; } // später, nach dem Grundschnitt
    if (it.fx.type === "gif") { // GIF laden und direkt mit ffmpeg einsetzen
      try {
        const sticker = it.fx.art === "sticker" && it.fx.src, src = sticker ? it.fx.src : it.fx.mp4;
        if (!/^https:\/\/media\d?\.giphy\.com\//.test(src || "")) throw new Error("ungültige GIF-Adresse");
        const r = await fetch(src); if (!r.ok) throw new Error("GIF nicht ladbar " + r.status);
        const gf = path.join(dir, "gif" + i + (sticker ? ".gif" : ".mp4")); fs.writeFileSync(gf, Buffer.from(await r.arrayBuffer()));
        effects.push({ file: gf, t0: it.t0, d: it.d, gif: true, sticker: !!sticker, top: it.place.top, width: Number(it.fx.gw) || 620 });
        if (it.place.hideCaptions) hide.push([it.t0, it.t1]);
      } catch (e) { console.log("GIF übersprungen", e.message); report.push("Ein GIF konnte nicht geladen werden und wurde weggelassen."); }
      continue;
    }
    try {
      E.writeProject(fxDir, it, { accent: style.accent, locale: job.locale || LOCALES[job.lang] || "de-DE", fontFile: R.BRAND_FONTS[style.brand_font] || "" }, ASSET_DIR);
      await run(HF_BIN, ["render", fxDir, "--format", "webm", "-o", path.join(fxDir, "out.webm"), "--no-browser-gpu", "--workers", String(Math.max(1, Math.min(4, require("os").cpus().length))), "--quiet"]);
      effects.push({ file: path.join(fxDir, "out.webm"), t0: it.t0, d: it.d });
      if (it.place.hideCaptions) hide.push([it.t0, it.t1]);
    } catch (e) { console.log("Effekt übersprungen", it.fx.type, e.message.slice(0, 300)); report.push("Ein Effekt (" + (E.EFFECTS[it.fx.type] || {}).label + ") konnte nicht erstellt werden und wurde weggelassen."); }
  }
  style.hide_captions = hide;
  const moves = [];
  for (const c of cutouts) if (c.it.fx.type === "greenscreen") moves.push([c.it.t0, c.it.t1, C.greenscreenCaptionY(layout && layout.head)]);
  const faceMoves = faceCheck(layout, segs, map, style);
  if (faceMoves.length) report.push("Untertitel an " + faceMoves.length + (faceMoves.length === 1 ? " Stelle" : " Stellen") + " kurz über deinen Kopf gesetzt, weil dein Gesicht dort tiefer im Bild war.");
  style.caption_moves = moves.concat(faceMoves);
  // Logo der Marke laden (nur Bilder, höchstens 3 MB)
  let logoFile = null;
  if (style.logo_on && /^https:\/\//.test(style.logo || "")) {
    try {
      const r = await fetch(style.logo); const ct = r.headers.get("content-type") || "";
      if (r.ok && /^image\/(png|jpeg|webp)/.test(ct)) { const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 3e6) { logoFile = path.join(dir, "logo." + (ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg")); fs.writeFileSync(logoFile, buf); } }
    } catch (e) { console.log("Logo übersprungen", e.message); }
  }
  R.setFontDir(FONT_DIR);
  const assFile = path.join(dir, "subs.ass");
  if (!style.lang) style.lang = job.lang || "de";
  fs.writeFileSync(assFile, R.buildAss(words, map, style, layout));
  const look = R.LOOKS[style.look] || null;
  // Licht und Haut: zusätzliche Filter zum Look (Licht -2 bis +3, Haut 0 bis 3)
  const licht = Math.max(-2, Math.min(3, Number(style.licht) || 0)), haut = Math.max(0, Math.min(5, Number(style.haut) || 0));
  const extra = [];
  if (licht) extra.push("eq=gamma=" + (1 + 0.09 * licht).toFixed(2) + ":brightness=" + (0.012 * licht).toFixed(3) + ":contrast=" + (1 + 0.015 * Math.abs(licht)).toFixed(3));
  if (haut) extra.push("smartblur=lr=" + Math.min(5, 1.0 + 0.6 * haut).toFixed(1) + ":ls=" + Math.min(1, 0.3 + 0.17 * haut).toFixed(2) + ":lt=" + (3 + 3 * haut));
  extra.push(...R.colorFilters(style));
  const gradeFull = [look ? look.grade : "", extra.join(",")].filter(Boolean).join(",");
  const gradeBase = look ? look.grade : "";
  if (look && !style.caption_style) style.caption_style = look.caption;
  const kept = words.filter(w => !w.cut);
  let zoomWords = kept.filter(w => w.zoom);
  if (look && look.autoZoom) zoomWords = zoomWords.concat(kept.filter(w => w.emph && !w.zoom)).sort((a, b) => a.s - b.s).filter((w, i, arr) => i === 0 || map(w.s) - map(arr[i - 1].s) > 2.2).slice(0, 6);
  const zoomScale = style.zoom_scale == null ? 1 : Number(style.zoom_scale);
  const zoomSet = new Set(zoomWords);
  const zooms = zoomScale > 0 ? R.zoomRanges(kept, w => zoomSet.has(w), map) : [];
  const vfx = R.wordEffects(kept, map, style.accent);
  const sounds = ((look && look.sounds === false) || style.sounds_off ? [] : kept).filter(w => w.sound && R.SOUNDS.includes(w.sound)).map(w => ({ file: path.join(SOUND_DIR, w.sound + ".wav"), t: Math.max(0, map(w.s) - 0.05) }));
  const images = [];
  for (const w of kept.filter(x => x.image && x.image.key)) {
    const f = path.join(dir, "img-" + images.length);
    await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(w.image.key), hdr(job), f);
    const im = { file: f, t: map(w.s), dur: Math.min(4, Math.max(0.8, Number(w.image.dur) || 1.8)), pos: w.image.pos || "oben", size: w.image.size || "mittel" };
    if (w.image.art) { try { im.file = await makeCard(f, path.join(dir, "card-" + images.length + ".png"), w.image.art, im.size, w.image.text, dir); im.card = true; } catch (e) { console.log("Karte übersprungen", e.message); } }
    images.push(im);
  }
  // Ende (2.16): Freebie-Vorschau als Foto-Karte in den letzten Sekunden
  const ende = style.ende || {};
  if (ende.freebie_key && /^jobs\//.test(ende.freebie_key)) { try {
    const f = path.join(dir, "freebie"); await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(ende.freebie_key), hdr(job), f);
    const d = Math.min(Math.max(2, Number(ende.dauer) || 3.5), map.total), file = await makeCard(f, path.join(dir, "freebie.png"), "foto", "klein", "", dir);
    images.push({ file, t: Math.max(0, map.total - d), dur: d, card: true, y: Math.round(R.endeLayout(ende).card / 100 * 1920) - 40 });
  } catch (e) { console.log("Freebie übersprungen", e.message); } }
  // Bild-in-Bild (2.19): zweites Video klein in einer Ecke
  const pips = [];
  for (const w of kept.filter(x => x.pip && x.pip.key)) { try { const f = path.join(dir, "pip-" + pips.length); await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(w.pip.key), hdr(job), f);
    pips.push({ file: f, t: map(w.s), d: Math.min(8, Math.max(1, Number(w.pip.dur) || 3)), pos: w.pip.pos || "oben-rechts", size: w.pip.size || "klein" }); } catch (e) { console.log("Bild-in-Bild übersprungen", e.message); } }
  // Geteilter Bildschirm im Hook und Titelkarte (2.18)
  let split = null, card = null;
  if (style.split && style.split.key) { try { const f = path.join(dir, "split"); await download(job.base + "/internal/reels/asset/" + job.id + "?key=" + encodeURIComponent(style.split.key), hdr(job), f);
    split = { file: f, d: Math.min(map.total, Math.max(1.5, Number(style.split.dauer) || 3)), fy: layout && layout.found ? ((layout.head.top + layout.head.chin) / 2) / 1920 : 0.4 }; } catch (e) { console.log("Geteilter Bildschirm übersprungen", e.message); } }
  const tkd = R.titelkarteDur(style);
  if (tkd) { try { card = { file: await makeTitleCard(job, (style.titelkarte.keys || []).filter(k => /^jobs\//.test(k)), dir), d: tkd }; } catch (e) { console.log("Titelkarte übersprungen", e.message); } }
  // Schleife zum Anfang: erstes Bild für die Überblendung am Ende
  let loopFrame = null;
  if (ende.schleife) { try { loopFrame = path.join(dir, "first.png"); await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", segs[0].s.toFixed(3), "-i", input, "-frames:v", "1", "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" + (cropX != null ? ":'max(0,min(iw-ow,iw*" + cropX.toFixed(4) + "-ow/2))':0" : "") + ",setsar=1" + (gradeFull ? "," + gradeFull : ""), loopFrame]); } catch (e) { loopFrame = null; console.log("Schleife übersprungen", e.message); } }
  // Freistellungs-Effekte: Grundschnitt ohne Untertitel, dann pro Effekt freistellen und Ebenen zusammensetzen
  const underlays = []; let cutoutFailed = 0;
  if (cutouts.length) {
    const focus0 = layout && layout.found ? { x: layout.head.cx / 1080, y: ((layout.head.top + layout.head.chin) / 2) / 1920 } : null;
    const base = path.join(dir, "base.mp4");
    let baseOk = false;
    if (job.replicate_key) {
      try { await run("ffmpeg", R.buildFfmpegArgs({ input, segs, map, zooms, images: [], sounds: [], effects: [], focus: focus0, cropX, grade: gradeFull, zoomStrength: (look ? look.zoom : 1) * (zoomScale || 1), dauerzoom: !!style.dauerzoom && zoomScale > 0, vfx, vignette: !!style.vignette, koernung: !!style.koernung, loopFrame, cropX, voice: style.stimme, split, card, pips, tempo: Number(style.tempo) || 1, assFile: null, fontsDir: FONT_DIR, output: base, hasAudio: false })); baseOk = true; }
      catch (e) { console.log("Grundschnitt fehlgeschlagen", e.message.slice(0, 300)); }
    }
    for (let i = 0; i < cutouts.length; i++) {
      const { it, fxDir } = cutouts[i];
      try {
        if (!baseOk) throw new Error(job.replicate_key ? "kein Grundschnitt" : "kein Replicate-Schlüssel");
        const seg = path.join(dir, "cseg" + i + ".mp4"), small = path.join(dir, "csmall" + i + ".mp4"), mask = path.join(dir, "cmask" + i + ".mp4"), comp = path.join(dir, "ccomp" + i + ".mp4");
        await run("ffmpeg", ["-y", "-loglevel", "error", "-i", base, "-ss", it.t0.toFixed(3), "-t", it.d.toFixed(3), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-r", "30", seg]);
        await run("ffmpeg", ["-y", "-loglevel", "error", "-i", seg, "-vf", "scale=720:1280", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", small]);
        await C.matte(job.replicate_key, small, mask);
        let fxFile = null;
        const needsLayer = !["greenscreen", "popout"].includes(it.fx.type) || it.fx.titel;
        if (needsLayer) {
          E.writeProject(fxDir, it, { accent: style.accent, locale: job.locale || LOCALES[job.lang] || "de-DE", fontFile: R.BRAND_FONTS[style.brand_font] || "", head: layout && layout.head }, ASSET_DIR);
          await run(HF_BIN, ["render", fxDir, "--format", "webm", "-o", path.join(fxDir, "out.webm"), "--no-browser-gpu", "--workers", String(Math.max(1, Math.min(4, require("os").cpus().length))), "--quiet"]);
          fxFile = path.join(fxDir, "out.webm");
        }
        await run("ffmpeg", C.composeArgs({ type: it.fx.type, seg, mask, fx: fxFile, d: it.d, accent: style.accent, out: comp, head: layout && layout.head }));
        underlays.push({ file: comp, t0: it.t0, d: it.d });
      } catch (e) { cutoutFailed++; console.log("Freistellungs-Effekt übersprungen", it.fx.type, e.message.slice(0, 300)); report.push("Der Profi-Effekt „" + (E.EFFECTS[it.fx.type] || {}).label + "“ hat nicht geklappt. Die Credits dafür bekommst du zurück."); }
    }
  }
  const out = path.join(dir, "final.mp4");
  const focus = layout && layout.found ? { x: layout.head.cx / 1080, y: ((layout.head.top + layout.head.chin) / 2) / 1920 } : null;
  const finalArgs = g => R.buildFfmpegArgs({ input, segs, map, zooms, images, sounds, effects, underlays, focus, logo: logoFile, grade: g, zoomStrength: (look ? look.zoom : 1) * (zoomScale || 1), assFile, fontsDir: FONT_DIR, output: out, hasAudio: info.hasAudio });
  try { await run("ffmpeg", finalArgs(gradeFull)); }
  catch (e) { if (!extra.length) throw e; console.log("Licht/Haut-Filter fehlgeschlagen, ohne erneut:", e && e.message); await run("ffmpeg", finalArgs(gradeBase)); }
  const thumb = path.join(dir, "final.jpg");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.4", "-i", out, "-frames:v", "1", "-vf", "scale=360:-2", thumb]);
  await upload(job.base + "/internal/reels/output/" + job.id + "/final.mp4", hdr(job), out, "video/mp4");
  await upload(job.base + "/internal/reels/output/" + job.id + "/final.jpg", hdr(job), thumb, "image/jpeg");
  try { // Kontrollbild: Anfang, Effekt-Momente, Ende
    const TP = Math.max(1, Number(style.tempo) || 1), T = map.total / TP, ts = [Math.min(1.2, T * 0.1)];
    planned.slice(0, 3).forEach(it => ts.push((it.t0 + it.d * 0.55) / TP));
    [0.35, 0.6, 0.85].forEach(f => { if (ts.length < 6) ts.push(T * f); });
    const sheet = path.join(dir, "check.jpg");
    await run("python3", [path.join(__dirname, "sheet.py"), out, sheet, ts.sort((a, b) => a - b).slice(0, 6).map(x => Math.max(0, Math.min(T - 0.1, x)).toFixed(2)).join(",")]);
    await upload(job.base + "/internal/reels/output/" + job.id + "/check.jpg", hdr(job), sheet, "image/jpeg");
  } catch (e) { console.log("Kontrollbild übersprungen", e.message); }
  return { status: "done", length: map.total / Math.max(1, Number(style.tempo) || 1), effects_used: effects.length + underlays.length, cutout_failed: cutoutFailed, report: report.slice(0, 10), layout: layout ? { framing: layout.framing, found: layout.found } : null };
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


// ---------- Video in Reels verwandeln ----------
// Langes Video in 10-Minuten-Stücken mit Wortzeiten abschreiben, in Sätze gliedern, KIRA die besten Stellen wählen lassen
async function clipScan(job) {
  const dir = path.join(WORK, job.id); fs.mkdirSync(dir, { recursive: true });
  const input = await getInput(job, dir);
  const info = await probe(input);
  if (info.duration > (job.max_seconds || 3 * 3600)) throw new Error("too_long");
  if (!info.hasAudio) throw new Error("Das Video enthält keine Tonspur.");
  const CH = 600, n = Math.max(1, Math.ceil(info.duration / CH)), words = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, "c" + i + ".mp3");
    await run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(i * CH), "-t", String(CH), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", f]);
    let tr = null, tries = 0, last = "";
    while (!tr && tries++ < 3) {
      const fd = new FormData();
      fd.append("file", new Blob([fs.readFileSync(f)], { type: "audio/mpeg" }), "c" + i + ".mp3");
      fd.append("model", "whisper-1"); fd.append("response_format", "verbose_json"); fd.append("timestamp_granularities[]", "word");
      if (job.lang) fd.append("language", job.lang);
      const res = await fetch(OPENAI + "/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + job.openai_key }, body: fd });
      if (res.ok) tr = await res.json(); else { last = res.status + " " + (await res.text()).slice(0, 200); await new Promise(r => setTimeout(r, 2000 * tries)); }
    }
    if (!tr) throw new Error("transcribe " + last);
    const ws = (tr.words || []).map(w => ({ w: String(w.word).trim(), s: Number(w.start) + i * CH, e: Number(w.end) + i * CH })).filter(w => w.w);
    if (tr.text) attachPunctuation(ws, tr.text);
    ws.forEach(w => words.push(w));
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const sentences = toSentences(words);
  const clips = sentences.length >= 3 ? await aiClips(job, sentences) : [];
  return { status: "clips_ready", duration: info.duration, sentences: sentences.map(x => ({ t: x.t, s: +x.s.toFixed(2), e: +x.e.toFixed(2) })), clips };
}
function toSentences(words) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ t: cur.map(w => w.w).join(" "), s: cur[0].s, e: cur[cur.length - 1].e }); cur = []; } };
  words.forEach((w, i) => {
    cur.push(w);
    const next = words[i + 1];
    const end = /[.!?…]["»“”']?$/.test(w.w) || (next && next.s - w.e > 1.2) || cur.length >= 45;
    if (end) flush();
  });
  flush(); return out;
}
function mmss(t) { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); }
async function aiClips(job, sentences) {
  let list = sentences.map((x, i) => i + " [" + mmss(x.s) + "] " + x.t).join("\n");
  if (list.length > 150000) list = list.slice(0, 150000);
  const instructions = "Du bist eine erfahrene Social-Media-Cutterin. Du bekommst das Transkript eines langen Videos (Masterclass, Live, Webinar oder Gespräch) Satz für Satz, mit Nummer und Zeitmarke. " +
    "Finde die 5 bis 10 stärksten Stellen, die jeweils FÜR SICH ALLEIN als Instagram-Reel funktionieren. Eine gute Stelle: beginnt mit einem Satz, der sofort neugierig macht oder eine klare Aussage trifft (ohne Vorwissen verständlich), entwickelt EINEN Gedanken (eine Erkenntnis, eine kurze Geschichte, eine klare Meinung, eine Liste oder einen Fehler mit Lösung) und endet an einem natürlichen Schlusspunkt (Pointe, Erkenntnis, Fazit). " +
    "Länge jeweils 20 bis 90 Sekunden, höchstens 120. Keine Stellen, die mitten im Gedanken anfangen oder auf Folien, Bildschirm oder frühere Teile verweisen ('wie ich vorhin sagte', 'auf dieser Folie'). Keine Begrüßung, keine Technik-Probleme, keine Organisationsdinge. Stellen dürfen sich nicht überschneiden. " +
    "Antworte NUR mit JSON: {\"clips\":[{\"von\":0,\"bis\":0,\"titel\":\"Titel für das Reel, höchstens 8 Wörter\",\"hook\":\"der erste Satz der Stelle\",\"warum\":\"1 Satz in einfacher Sprache, warum diese Stelle als Reel funktioniert\",\"typ\":\"wissen|persoenlich|autoritaet|verkauf|leadmagnet\",\"punkte\":8}]} " +
    "von und bis sind Satznummern (inklusive). punkte: 1 bis 10, wie stark die Stelle als Reel ist. Schreibe Titel, Hook und Begründung in der Sprache des Transkripts.";
  const res = await fetch(OPENAI + "/v1/responses", { method: "POST", headers: { Authorization: "Bearer " + job.openai_key, "Content-Type": "application/json" },
    body: JSON.stringify({ model: job.model, instructions, input: [{ role: "user", content: list }], max_output_tokens: 3500 }) });
  if (!res.ok) { console.log("Clip-Auswahl Fehler", res.status, (await res.text()).slice(0, 300)); return []; }
  const data = await res.json();
  let text = data.output_text || ""; if (!text && Array.isArray(data.output)) data.output.forEach(o => (o.content || []).forEach(c => { if (c.type === "output_text") text += c.text; }));
  const usage = data.usage || {}; job.usage = { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0 };
  let d = {}; try { const m = text.match(/\{[\s\S]*\}/); d = m ? JSON.parse(m[0]) : {}; } catch (e) { d = {}; }
  const N = sentences.length, used = [];
  const items = (Array.isArray(d.clips) ? d.clips : []).map(c => {
    let a = Math.max(0, Math.min(N - 1, c.von | 0)), b = Math.max(0, Math.min(N - 1, c.bis | 0)); if (b < a) [a, b] = [b, a];
    return { von: a, bis: b, start: +Math.max(0, sentences[a].s - 0.15).toFixed(2), end: +(sentences[b].e + 0.25).toFixed(2), titel: String(c.titel || "").slice(0, 100), hook: String(c.hook || sentences[a].t).slice(0, 300), warum: String(c.warum || "").slice(0, 300), typ: String(c.typ || "wissen").slice(0, 20), punkte: Math.max(1, Math.min(10, Number(c.punkte) || 5)) };
  }).filter(c => c.end - c.start >= 15 && c.end - c.start <= 150).sort((x, y) => y.punkte - x.punkte)
    .filter(c => { if (used.some(u => c.von <= u.bis && c.bis >= u.von)) return false; used.push(c); return true; });
  return items.slice(0, 10).sort((x, y) => x.start - y.start);
}
// Ausgewählte Stelle direkt aus dem Original schneiden (ohne das ganze Video zu laden) und ins Hochformat um das Gesicht bringen
async function cutClip(job, dir) {
  const url = job.base + "/internal/reels/input/" + job.id, H = "x-internal: " + job.token + "\r\n";
  const s0 = Math.max(0, Number(job.clip.start) || 0), dur = Math.max(5, Math.min(185, (Number(job.clip.end) || 0) - s0));
  const pj = JSON.parse(await run("ffprobe", ["-v", "error", "-headers", H, "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_tags=rotate", "-of", "json", url]));
  const st = (pj.streams || [])[0] || {}; let w = Number(st.width) || 1920, h = Number(st.height) || 1080;
  if (st.tags && /^-?90$|^-?270$/.test(String(st.tags.rotate || ""))) [w, h] = [h, w];
  let vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
  if (w / h > 0.6) {
    // Gesicht in einigen Bildern suchen und den Ausschnitt danach ausrichten
    const frames = [];
    for (let k = 0; k < 6; k++) { const f = path.join(dir, "f" + k + ".jpg"); try { await run("ffmpeg", ["-y", "-loglevel", "error", "-headers", H, "-ss", String(s0 + dur * (k + 0.5) / 6), "-i", url, "-frames:v", "1", "-vf", "scale=960:-2", f]); frames.push(f); } catch (e) {} }
    let cx = 0.5;
    try { const out = await run("python3", ["-c", FACE_PY].concat(frames)); const v = parseFloat(String(out).trim()); if (v >= 0 && v <= 1) cx = v; } catch (e) { console.log("Gesichtssuche", e.message.slice(0, 200)); }
    const cw = Math.min(w, Math.round(h * 9 / 16 / 2) * 2), x = Math.round(Math.max(0, Math.min(w - cw, cx * w - cw / 2)));
    vf = "crop=" + cw + ":" + h + ":" + x + ":0,scale=1080:1920,setsar=1";
  }
  const out = path.join(dir, "input");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-headers", H, "-ss", s0.toFixed(2), "-i", url, "-t", dur.toFixed(2), "-vf", vf, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", "-f", "mp4", out]);
  await upload(job.base + "/internal/reels/output/" + job.id + "/input.mp4", hdr(job), out, "video/mp4");
  return out;
}
const FACE_PY = [
  "import sys, cv2",
  "c = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')",
  "hog = cv2.HOGDescriptor(); hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())",
  "fx, px = [], []",
  "for f in sys.argv[1:]:",
  "    im = cv2.imread(f)",
  "    if im is None: continue",
  "    W = im.shape[1]",
  "    g = cv2.equalizeHist(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY))",
  "    fs = c.detectMultiScale(g, 1.08, 5, minSize=(22, 22))",
  "    if len(fs):",
  "        x, y, w, h = max(fs, key=lambda r: r[2] * r[3]); fx.append((x + w / 2) / W); continue",
  "    rs, _ = hog.detectMultiScale(im, winStride=(8, 8), padding=(8, 8), scale=1.05)",
  "    if len(rs):",
  "        x, y, w, h = max(rs, key=lambda r: r[2] * r[3]); px.append((x + w / 2) / W)",
  "xs = sorted(fx) if fx else sorted(px)",
  "print(xs[len(xs) // 2] if xs else 0.5)"
].join("\n");

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method !== "POST" || !["/analyze", "/render", "/transcribe", "/clips"].includes(req.url)) { res.statusCode = 404; res.end(); return; }
  let body = "";
  req.on("data", d => { body += d; if (body.length > 5e6) req.destroy(); });
  req.on("end", () => {
    let job; try { job = JSON.parse(body); } catch { res.statusCode = 400; res.end(); return; }
    if (!job.id || !/^[0-9a-f-]{36}$/.test(job.id) || !job.base || !job.token) { res.statusCode = 400; res.end(); return; }
    res.statusCode = 202; res.end(JSON.stringify({ accepted: true }));
    const fn = req.url === "/analyze" ? analyze : req.url === "/transcribe" ? transcribe : req.url === "/clips" ? clipScan : render;
    const t0 = Date.now();
    fn(job).then(r => callback(job, Object.assign({ phase: req.url.slice(1), seconds: (Date.now() - t0) / 1000, usage: job.usage || null }, r)))
      .catch(e => { console.log("Fehler", e.stack || e); callback(job, { phase: req.url.slice(1), status: "error", error: String(e.message || e).slice(0, 300) }); });
  });
});
server.listen(PORT, () => console.log("Reel-Werkstatt läuft auf Port " + PORT));
