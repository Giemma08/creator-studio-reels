// Reel-Werkstatt: baut aus Wörtern + Plan einen ffmpeg-Auftrag
"use strict";

const W = 1080, H = 1920, FPS = 30;
const SOUNDS = ["kling", "ping", "pop", "whoosh", "klick", "tada"];

// Behaltene Abschnitte aus den nicht geschnittenen Wörtern bilden
function keptSegments(words, duration) {
  const kept = words.filter(w => !w.cut);
  if (!kept.length) return [];
  const PAD_IN = 0.12, PAD_OUT = 0.18, MAX_GAP = 0.45;
  const segs = [];
  let cur = { s: Math.max(0, kept[0].s - PAD_IN), e: kept[0].e + PAD_OUT, first: words.indexOf(kept[0]) };
  for (let i = 1; i < kept.length; i++) {
    const w = kept[i], prev = kept[i - 1];
    const contiguous = words.indexOf(w) === words.indexOf(prev) + 1;
    if (contiguous && w.s - prev.e <= MAX_GAP) { cur.e = w.e + PAD_OUT; }
    else { segs.push(cur); cur = { s: Math.max(0, w.s - PAD_IN), e: w.e + PAD_OUT }; }
  }
  segs.push(cur);
  // Überlappungen glätten und an die Videolänge anpassen
  const out = [];
  for (const sg of segs) {
    sg.e = Math.min(sg.e, duration || sg.e);
    if (out.length && sg.s <= out[out.length - 1].e) out[out.length - 1].e = Math.max(out[out.length - 1].e, sg.e);
    else if (sg.e - sg.s > 0.05) out.push({ s: sg.s, e: sg.e });
  }
  return out;
}

// Zeit im Original -> Zeit im geschnittenen Video
function remapper(segs) {
  const starts = []; let acc = 0;
  for (const sg of segs) { starts.push(acc); acc += sg.e - sg.s; }
  const fn = t => {
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].s - 1e-6 && t <= segs[i].e + 1e-6) return starts[i] + (t - segs[i].s);
      if (t < segs[i].s) return starts[i];
    }
    return acc;
  };
  fn.total = acc;
  return fn;
}

function assColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const h = m ? m[1] : "FFFFFF";
  return "&H00" + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2) + "&";
}
function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = Math.floor(t) % 60, cs = Math.floor((t - Math.floor(t)) * 100);
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(cs).padStart(2, "0");
}
function assText(s) { return String(s || "").replace(/[{}\\]/g, "").replace(/\n/g, " ").trim(); }

// Untertitel in Gruppen von bis zu 3 Wörtern, aktuelles Wort hervorgehoben
function buildAss(words, map, style) {
  const accent = assColor(style.accent || "#E6007E");
  const white = "&H00FFFFFF&";
  const font = style.font || "Poppins";
  const capSize = style.size === "gross" ? 92 : style.size === "klein" ? 64 : 78;
  const capMarginV = style.position === "mitte" ? 860 : style.position === "oben" ? 1300 : 520;
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap," + font + "," + capSize + "," + white + ",&H000000FF&,&H00141414&,&H64000000&,-1,0,0,0,100,100,0,0,1,6,0,2,90,90," + capMarginV + ",1",
    "Style: Hook," + font + ",70," + white + ",&H000000FF&," + accent + "," + accent + ",-1,0,0,0,100,100,0,0,3,22,0,8,110,110,250,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const kept = words.filter(w => !w.cut);
  if (style.hook !== false && style.hook_titel) {
    const end = Math.min(3.2, map.total);
    lines.push("Dialogue: 1," + assTime(0) + "," + assTime(end) + ",Hook,,0,0,0,,{\\fad(120,200)}" + assText(style.hook_titel));
  }
  if (style.captions === false) return lines.join("\n") + "\n";
  // Gruppen bilden
  const groups = []; let g = [];
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i]; g.push(w);
    const next = kept[i + 1];
    const endsSentence = /[.!?…:]$/.test(w.w.trim());
    const pause = next ? map(next.s) - map(w.e) > 0.35 : true;
    if (g.length >= 3 || endsSentence || pause || !next) { groups.push(g); g = []; }
  }
  for (const grp of groups) {
    for (let i = 0; i < grp.length; i++) {
      const w = grp[i];
      const start = map(w.s);
      const end = i + 1 < grp.length ? map(grp[i + 1].s) : map(w.e) + 0.12;
      if (end - start < 0.03) continue;
      const parts = grp.map((x, j) => {
        const txt = assText(x.w);
        if (j === i) return "{\\c" + accent + "\\fscx108\\fscy108}" + txt + "{\\c" + white + "\\fscx100\\fscy100}";
        if (x.emph) return "{\\c" + accent + "}" + txt + "{\\c" + white + "}";
        return txt;
      });
      lines.push("Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Cap,,0,0,0,," + parts.join(" "));
    }
  }
  return lines.join("\n") + "\n";
}

// ffmpeg-Argumente für den kompletten Render-Durchlauf
function buildFfmpegArgs(o) {
  // o: { input, segs, map, zooms:[t], images:[{file,t,dur,pos,size}], sounds:[{file,t,vol}], assFile, fontsDir, output, hasAudio }
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", o.input];
  o.images.forEach(im => { args.push("-loop", "1", "-t", String(im.dur.toFixed(2)), "-i", im.file); });
  o.sounds.forEach(sd => { args.push("-i", sd.file); });
  const sel = o.segs.map(s => "between(t," + s.s.toFixed(3) + "," + s.e.toFixed(3) + ")").join("+");
  const f = [];
  f.push("[0:v]fps=" + FPS + ",scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",setsar=1,select='" + sel + "',setpts=N/" + FPS + "/TB[v0]");
  let v = "v0";
  if (o.zooms.length) {
    const terms = o.zooms.map(z => "0.12*min(1,(it-" + z.toFixed(3) + ")/0.15)*between(it," + z.toFixed(3) + "," + (z + 1.4).toFixed(3) + ")").join("+");
    f.push("[" + v + "]zoompan=z='1+" + terms + "':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=" + W + "x" + H + ":fps=" + FPS + "[vz]");
    v = "vz";
  }
  o.images.forEach((im, i) => {
    const idx = 1 + i;
    const wpx = im.size === "gross" ? 860 : im.size === "klein" ? 420 : 640;
    const y = im.pos === "unten" ? "H*0.52" : im.pos === "mitte" ? "(H-h)/2" : "H*0.16";
    const d = im.dur, fo = Math.max(0, d - 0.18).toFixed(2);
    f.push("[" + idx + ":v]scale=" + wpx + ":-1,format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=" + fo + ":d=0.18:alpha=1,setpts=PTS-STARTPTS+" + im.t.toFixed(3) + "/TB[im" + i + "]");
    f.push("[" + v + "][im" + i + "]overlay=x=(W-w)/2:y=" + y + ":eof_action=pass:enable='between(t," + im.t.toFixed(3) + "," + (im.t + d).toFixed(3) + ")'[vi" + i + "]");
    v = "vi" + i;
  });
  const assPath = o.assFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "");
  f.push("[" + v + "]ass='" + assPath + "':fontsdir='" + o.fontsDir + "'[vout]");
  // Ton
  let a = null;
  if (o.hasAudio) {
    f.push("[0:a]aselect='" + sel + "',asetpts=N/SR/TB,aformat=sample_rates=44100:channel_layouts=stereo[a0]");
    a = "a0";
  } else {
    f.push("anullsrc=r=44100:cl=stereo,atrim=0:" + o.map.total.toFixed(3) + "[a0]");
    a = "a0";
  }
  if (o.sounds.length) {
    const sIdx = 1 + o.images.length;
    const labels = ["[a0]"];
    o.sounds.forEach((sd, i) => {
      const ms = Math.max(0, Math.round(sd.t * 1000));
      f.push("[" + (sIdx + i) + ":a]aformat=sample_rates=44100:channel_layouts=stereo,volume=" + (sd.vol || 0.55) + ",adelay=" + ms + "|" + ms + "[s" + i + "]");
      labels.push("[s" + i + "]");
    });
    f.push(labels.join("") + "amix=inputs=" + labels.length + ":normalize=0:duration=first[aout]");
    a = "aout";
  }
  args.push("-filter_complex", f.join(";"), "-map", "[vout]", "-map", "[" + a + "]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", o.map.total.toFixed(3), o.output);
  return args;
}

module.exports = { keptSegments, remapper, buildAss, buildFfmpegArgs, SOUNDS, W, H, FPS };
