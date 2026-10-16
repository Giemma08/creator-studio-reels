// Reel-Werkstatt: Freistellung (Robust Video Matting über Replicate) und Zusammensetzen der Ebenen
// Nur die Sekunden eines Effekts werden freigestellt, nie das ganze Reel.
"use strict";
const fs = require("fs");
const path = require("path");

const API = "https://api.replicate.com/v1";
const MODEL = "arielreplicate/robust_video_matting";
const W = 1080, H = 1920;
let cachedVersion = null;

async function rq(key, url, opts) {
  const r = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: "Bearer " + key }, (opts && opts.headers) || {}) }));
  const txt = await r.text(); let d = null; try { d = JSON.parse(txt); } catch (e) {}
  if (!r.ok) throw new Error("Replicate " + r.status + ": " + txt.slice(0, 200));
  return d;
}

// Freistellungs-Maske für ein kurzes Video holen (weiß = Person, schwarz = Hintergrund)
async function matte(key, segFile, outFile) {
  if (!cachedVersion) {
    const m = await rq(key, API + "/models/" + MODEL);
    cachedVersion = m && m.latest_version && m.latest_version.id;
    if (!cachedVersion) throw new Error("Modellversion nicht gefunden");
  }
  // 1. Video hochladen
  const fd = new FormData();
  fd.append("content", new Blob([fs.readFileSync(segFile)], { type: "video/mp4" }), "segment.mp4");
  const up = await rq(key, API + "/files", { method: "POST", body: fd });
  const fileUrl = up && up.urls && up.urls.get; if (!fileUrl) throw new Error("Hochladen fehlgeschlagen");
  // 2. Auftrag starten und warten
  let pr = await rq(key, API + "/predictions", { method: "POST", headers: { "Content-Type": "application/json", Prefer: "wait=60" },
    body: JSON.stringify({ version: cachedVersion, input: { input_video: fileUrl, output_type: "alpha-mask" } }) });
  const until = Date.now() + 240000;
  while (pr && !["succeeded", "failed", "canceled"].includes(pr.status)) {
    if (Date.now() > until) throw new Error("Freistellung dauert zu lange");
    await new Promise(r => setTimeout(r, 2500));
    pr = await rq(key, pr.urls.get);
  }
  if (!pr || pr.status !== "succeeded") throw new Error("Freistellung fehlgeschlagen: " + (pr && pr.error || "unbekannt"));
  const outUrl = Array.isArray(pr.output) ? pr.output[0] : pr.output;
  const r = await fetch(outUrl); if (!r.ok) throw new Error("Maske nicht ladbar " + r.status);
  fs.writeFileSync(outFile, Buffer.from(await r.arrayBuffer()));
  // aufräumen: hochgeladene Datei bei Replicate löschen
  try { if (up.id) await fetch(API + "/files/" + up.id, { method: "DELETE", headers: { Authorization: "Bearer " + key } }); } catch (e) {}
  return { seconds: pr.metrics && pr.metrics.predict_time };
}

// ffmpeg-Argumente, um einen Abschnitt aus Hintergrund, Grafik und Person zusammenzusetzen
function composeArgs(o) {
  // o: type, seg, mask, fx (durchsichtige Grafik, optional), d, accent, out, head
  const args = ["-y", "-loglevel", "error", "-i", o.seg, "-i", o.mask];
  if (o.fx) args.push("-c:v", "libvpx-vp9", "-i", o.fx);
  const f = [];
  f.push("[1:v]scale=" + W + ":" + H + ",format=gray,setsar=1[m]");
  const fxIn = o.fx ? "[2:v]format=yuva420p,setsar=1[fx];" : "";
  if (o.type === "hinter") {
    f.push("[0:v]setsar=1,split[a][b]");
    if (o.fx) f.push(fxIn.slice(0, -1), "[a][fx]overlay=0:0[bg]"); else f.push("[a]null[bg]");
    f.push("[b][m]alphamerge[p]", "[bg][p]overlay=0:0,format=yuv420p[v]");
  } else if (o.type === "spotlight") {
    const d = o.d;
    f.push("[0:v]setsar=1,split=3[a][b][c]");
    f.push("[a]eq=brightness=-0.3:saturation=0.5,gblur=sigma=12,format=yuva420p,fade=t=in:st=0:d=0.25:alpha=1,fade=t=out:st=" + Math.max(0, d - 0.3).toFixed(2) + ":d=0.3:alpha=1[dk]");
    f.push("[c][dk]overlay=0:0[bg0]");
    if (o.fx) f.push(fxIn.slice(0, -1), "[bg0][fx]overlay=0:0[bg]"); else f.push("[bg0]null[bg]");
    f.push("[b][m]alphamerge[p]", "[bg][p]overlay=0:0,format=yuv420p[v]");
  } else if (o.type === "lichtaus") {
    const d = o.d;
    f.push("[0:v]setsar=1,split=3[a][b][c]");
    f.push("[a]eq=brightness=-0.62:saturation=0.25,format=yuva420p,fade=t=in:st=0:d=0.12:alpha=1,fade=t=out:st=" + Math.max(0, d - 0.15).toFixed(2) + ":d=0.15:alpha=1[dk]");
    f.push("[c][dk]overlay=0:0[bg0]");
    if (o.fx) f.push(fxIn.slice(0, -1), "[bg0][fx]overlay=0:0[bg]"); else f.push("[bg0]null[bg]");
    f.push("[b][m]alphamerge[p]", "[bg][p]overlay=0:0,format=yuv420p[v]");
  } else if (o.type === "popout") {
    // Video wird zur Karte, der Kopf ragt oben heraus
    const k = 0.82, sw = Math.round(W * k / 2) * 2, sh = Math.round(H * k / 2) * 2, x0 = Math.round((W - sw) / 2);
    const head = o.head || { top: 350, chin: 640 };
    const ct = Math.round(k * (head.top + 0.45 * (head.chin - head.top)) / 2) * 2; // Kartenrand auf Augenhöhe
    const y0 = Math.max(120, 470 - ct);
    const cc = String(o.accent || "#E6007E").replace("#", "0x");
    args.push("-f", "lavfi", "-i", "gradients=s=" + W + "x" + H + ":c0=0x1A1F3D:c1=" + cc + ":x0=0:y0=0:x1=" + W + ":y1=" + H + ":d=" + o.d.toFixed(2) + ":r=30");
    const bgIdx = o.fx ? 3 : 2;
    f.length = 0;
    f.push("[1:v]scale=" + sw + ":" + sh + ",format=gray,setsar=1[m]");
    f.push("[0:v]scale=" + sw + ":" + sh + ",setsar=1,split[s1][s2]");
    f.push("[s1]crop=" + sw + ":" + (sh - ct) + ":0:" + ct + ",pad=iw+24:ih+24:12:12:white[card]");
    f.push("[s2][m]alphamerge[p]");
    f.push("[" + bgIdx + ":v]setsar=1[bg0]");
    f.push("[bg0][card]overlay=x=" + (x0 - 12) + ":y=" + (y0 + ct - 12) + "[b1]");
    f.push("[b1][p]overlay=x=" + x0 + ":y=" + y0 + "[b2]");
    if (o.fx) f.push(fxIn.slice(0, -1), "[b2][fx]overlay=0:0,format=yuv420p[v]"); else f.push("[b2]format=yuv420p[v]");
  } else if (o.type === "greenscreen") {
    // Hintergrund: Verlauf in der Markenfarbe; Person verkleinert unten in der Mitte
    const c = String(o.accent || "#E6007E").replace("#", "0x");
    args.push("-f", "lavfi", "-i", "gradients=s=" + W + "x" + H + ":c0=" + c + ":c1=0x1A1F3D:x0=0:y0=0:x1=" + W + ":y1=" + H + ":d=" + o.d.toFixed(2) + ":r=30");
    const bgIdx = o.fx ? 3 : 2;
    f.push("[" + bgIdx + ":v]setsar=1[bg0]");
    if (o.fx) f.push(fxIn.slice(0, -1), "[bg0][fx]overlay=0:0[bg]"); else f.push("[bg0]null[bg]");
    f.push("[0:v][m]alphamerge,scale=iw*0.62:-2[p]", "[bg][p]overlay=x=(W-w)/2:y=H-h,format=yuv420p[v]");
  }
  args.push("-filter_complex", f.join(";"), "-map", "[v]", "-t", o.d.toFixed(3), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-r", "30", o.out);
  return args;
}

// Wo die Untertitel während Green Screen stehen sollen: über dem verkleinerten Kopf
function greenscreenCaptionY(head) {
  const top = H - Math.round(H * 0.62);
  const headTop = top + Math.round(0.62 * ((head && head.top) || 350));
  return Math.max(450, headTop - 230);
}

module.exports = { matte, composeArgs, greenscreenCaptionY };
