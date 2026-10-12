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

// ---------- Untertitel-Stile (eigene Gestaltung, freie Google-Schriften) ----------
// font: Schriftname, size: Größe, upper/lower: Schreibweise, n: Wörter pro Einblendung,
// plate: Hintergrund-Box, active: wie das gesprochene Wort hervorgehoben wird, emph: wie betonte Wörter aussehen
// Schriften, die man in "Meine Brand" wählen kann (Google Fonts, OFL), mit Dateinamen auf dem Server
const BRAND_FONTS = {
  "Playfair Display": "PlayfairDisplay[wght].ttf", "Inter": "Inter[opsz,wght].ttf", "Outfit": "Outfit[wght].ttf", "DM Sans": "DMSans[opsz,wght].ttf",
  "Lora": "Lora[wght].ttf", "Montserrat": "Montserrat[wght].ttf", "Poppins": "Poppins-ExtraBold.ttf", "Cormorant Garamond": "CormorantGaramond[wght].ttf",
  "Space Grotesk": "SpaceGrotesk[wght].ttf", "Syne": "Syne[wght].ttf",
};
const CAPTION_STYLES = {
  marke:       { label: "Meine Marke", font: "@brand", size: 76, n: 3, outline: 6, shadow: 0, active: "accent+grow", emph: "accent", bold: true },
  klar:        { label: "Klar",        font: "Poppins ExtraBold", size: 76, n: 3, outline: 6, shadow: 0, active: "accent+grow", emph: "accent" },
  box:         { label: "Box",         font: "Poppins Bold", size: 62, n: 3, plate: true, outline: 18, active: "accent", emph: "accent" },
  elegant:     { label: "Elegant",     font: "DM Serif Display", size: 86, n: 3, outline: 0, shadow: 3, color: "#FFF8F0", active: "bright", emph: "italic+accent" },
  leise:       { label: "Leise",       font: "Poppins Medium", size: 54, n: 5, lower: true, outline: 0, shadow: 2, active: "bright", emph: "bold" },
  gross:       { label: "Ein Wort",    font: "Anton", size: 150, n: 1, upper: true, outline: 7, shadow: 0, active: "none", emph: "accent", center: true },
  plakat:      { label: "Plakat",      font: "Archivo Black", size: 74, n: 2, upper: true, outline: 6, shadow: 0, active: "accent", emph: "accent" },
  handschrift: { label: "Handschrift", font: "Poppins Bold", size: 66, n: 3, outline: 5, shadow: 0, active: "accent", emph: "script" },
  kino:        { label: "Kino",        font: "Bebas Neue", size: 104, n: 2, upper: true, spacing: 4, outline: 0, shadow: 4, active: "bright", emph: "accent" },
  pop:         { label: "Pop",         font: "Poppins Black", size: 84, n: 3, outline: 6, shadow: 0, reveal: true, pop: true, active: "accent", emph: "accent" },
  karaoke:     { label: "Karaoke",     font: "Poppins Bold", size: 62, n: 4, plate: true, plateColor: "#141417", plateAlpha: "30", outline: 22, active: "accent", emph: "accent" },
  neon:        { label: "Neon",        font: "Poppins ExtraBold", size: 74, n: 3, glow: true, outline: 5, shadow: 0, active: "grow", emph: "bold" },
  editorial:   { label: "Editorial",   font: "Poppins Medium", size: 58, n: 4, lower: true, outline: 0, shadow: 3, active: "bright", emph: "serif" },
  mono:        { label: "Notiz",       font: "Space Mono", size: 56, n: 4, outline: 0, shadow: 3, reveal: true, active: "accent", emph: "accent" },
  pastell:     { label: "Pastell",     font: "Poppins SemiBold", size: 58, n: 3, plate: true, plateColor: "#FCE4EF", plateAlpha: "00", color: "#2A2440", outline: 20, active: "accent", emph: "accent" },
  kontur:      { label: "Kontur",      font: "Anton", size: 96, n: 2, upper: true, hollow: true, outline: 3, shadow: 0, active: "fill", emph: "accent" },
  magazin:     { label: "Magazin",     font: "Abril Fatface", size: 88, n: 2, outline: 0, shadow: 4, color: "#FFF4E6", active: "bright", emph: "accent", pop: true },
};

// ---------- Looks: Untertitel, Farbstimmung, Zoom-Tempo und Töne als ein Klick ----------
const LOOKS = {
  business:  { label: "Business klar",   caption: "klar",      grade: "eq=contrast=1.06:saturation=1.05,colorbalance=bs=0.02", zoom: 1,   sounds: true,  effects: ["checkliste", "zahl", "karte", "kommentar"] },
  warm:      { label: "Warm & nahbar",   caption: "pastell",   grade: "colorbalance=rs=0.06:gs=0.02:bs=-0.05,eq=saturation=1.06:contrast=1.02:brightness=0.02", zoom: 0.6, sounds: true, effects: ["checkliste", "karte", "kommentar"] },
  editorial: { label: "Editorial",       caption: "editorial", grade: "eq=contrast=1.08:saturation=0.82,vignette=PI/5", zoom: 0.5, sounds: false, effects: ["karte", "zahl"] },
  energie:   { label: "Energie",         caption: "pop",       grade: "eq=saturation=1.22:contrast=1.08", zoom: 1.6, sounds: true, autoZoom: true, effects: ["zahl", "checkliste", "kommentar"] },
  kino:      { label: "Kino",            caption: "kino",      grade: "colorbalance=rs=0.07:bs=-0.06:rh=-0.03:bh=0.05,eq=contrast=1.1:saturation=1.08,vignette=PI/4", zoom: 0.8, sounds: false, effects: ["karte", "zahl"] },
  magazin:   { label: "Magazin",         caption: "magazin",   grade: "eq=brightness=0.03:contrast=0.96:saturation=0.92,colorbalance=rh=0.03:bh=0.02", zoom: 0.7, sounds: true, effects: ["karte", "checkliste", "zahl"] },
};

function caseOf(st, s) { return st.upper ? s.toLocaleUpperCase("de-DE") : st.lower ? s.toLocaleLowerCase("de-DE") : s; }

// Untertitel bauen. layout (optional) kommt aus layout.py: Kopf, Kinn und freie Zonen
function buildAss(words, map, style, layout) {
  const key = CAPTION_STYLES[style.caption_style] ? style.caption_style : "klar";
  let st = CAPTION_STYLES[key];
  if (st.font === "@brand") st = Object.assign({}, st, { font: BRAND_FONTS[style.brand_font] ? (style.brand_font === "Poppins" ? "Poppins ExtraBold" : style.brand_font) : "Poppins ExtraBold" });
  const accent = assColor(style.accent || "#E6007E");
  const base = assColor(st.color || "#FFFFFF");
  const dim = "&H40" + base.slice(4);           // leicht durchsichtig für noch nicht gesprochene Wörter
  const sizeF = style.size === "gross" ? 1.15 : style.size === "klein" ? 0.85 : 1;
  const size = Math.round(st.size * sizeF);
  const zones = (layout && layout.zones) || null;
  // Position: manuell gewählt oder automatisch aus der Vermessung (oberer Rand des Untertitel-Bands)
  let top;
  if (style.position === "oben") top = 330;
  else if (style.position === "mitte") top = 860;
  else if (style.position === "unten") top = 1250;
  else if (zones && zones.captions) top = st.center ? Math.round((zones.below ? (zones.below.y0 + zones.below.y1) / 2 : 1150) - size / 2) : zones.captions.y;
  else top = 1180;
  top = Math.max(230, Math.min(1470 - size * 2, top));
  const border = st.plate ? 3 : 1;
  const back = st.plate ? "&H50141414&" : "&H64000000&";
  const plateCol = st.plateColor ? "&H" + (st.plateAlpha || "30") + assColor(st.plateColor).slice(4) : "&H50141414&";
  const outlineCol = st.plate ? plateCol : st.glow ? assColor(style.accent || "#E6007E") : "&H00141414&";
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap," + st.font + "," + size + "," + (st.hollow ? "&HFF" + base.slice(4) : base) + ",&H000000FF&," + (st.hollow ? base : outlineCol) + "," + back + "," + (st.bold ? 1 : 0) + ",0,0,0,100,100," + (st.spacing || 0) + ",0," + border + "," + (st.outline || 0) + "," + (st.shadow || 0) + ",8,80,80," + top + ",1",
    "Style: Hook," + (key === "marke" && BRAND_FONTS[style.brand_font] && style.brand_font !== "Poppins" ? style.brand_font : "Poppins ExtraBold") + ",66," + "&H00FFFFFF&" + ",&H000000FF&," + accent + "," + accent + "," + (key === "marke" ? 1 : 0) + ",0,0,0,100,100,0,0,3,20,0,8,110,110," + hookTop(layout) + ",1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const kept = words.filter(w => !w.cut);
  if (style.hook !== false && style.hook_titel) {
    const end = Math.min(3.2, map.total);
    lines.push("Dialogue: 1," + assTime(0) + "," + assTime(end) + ",Hook,,0,0,0,,{\\fad(120,200)}" + assText(caseOf({}, style.hook_titel)));
  }
  if (style.captions === false) return lines.join("\n") + "\n";
  const hidden = (style.hide_captions || []).map(r => [Number(r[0]), Number(r[1])]);
  const isHidden = t => hidden.some(r => t >= r[0] && t < r[1]);
  // Gruppen bilden
  const groups = []; let g = [];
  for (let i = 0; i < kept.length; i++) {
    const w = kept[i]; g.push(w);
    const next = kept[i + 1];
    const endsSentence = /[.!?…:]$/.test(w.w.trim());
    const pause = next ? map(next.s) - map(w.e) > 0.35 : true;
    if (g.length >= st.n || endsSentence || pause || !next) { groups.push(g); g = []; }
  }
  const scriptFont = "Caveat Brush", italicFont = "DM Serif Display";
  const fmtWord = (x, isActive) => {
    let txt = assText(caseOf(st, x.w));
    let pre = "", post = "";
    if (x.emph) {
      if (st.emph === "accent" || st.emph === "italic+accent") { pre += "{\\c" + accent + "}"; post = "{\\c" + base + "}" + post; }
      if (st.emph === "italic+accent") { pre += "{\\i1}"; post = "{\\i0}" + post; }
      if (st.emph === "bold") { pre += "{\\b1}"; post = "{\\b0}" + post; }
      if (st.emph === "script") { pre += "{\\fn" + scriptFont + "\\fs" + Math.round(size * 1.35) + "\\c" + accent + "}"; post = "{\\fn" + st.font + "\\fs" + size + "\\c" + base + "}" + post; }
      if (st.emph === "serif") { pre += "{\\fn" + italicFont + "\\i1\\fs" + Math.round(size * 1.45) + "\\c" + accent + "}"; post = "{\\fn" + st.font + "\\i0\\fs" + size + "\\c" + base + "}" + post; }
    }
    if (isActive) {
      if (st.active === "accent") { pre = "{\\c" + accent + "}" + pre; post += "{\\c" + base + "}"; }
      if (st.active === "accent+grow") { pre = "{\\c" + accent + "\\fscx110\\fscy110}" + pre; post += "{\\c" + base + "\\fscx100\\fscy100}"; }
      if (st.active === "grow") { pre = "{\\fscx112\\fscy112}" + pre; post += "{\\fscx100\\fscy100}"; }
      if (st.active === "fill") { pre = "{\\1a&H00&\\1c" + accent + "\\3c" + accent + "}" + pre; post += "{\\1a&HFF&\\3c" + base + "}"; }
      if (st.pop) { pre = "{\\fscx72\\fscy72\\t(0,110,\\fscx100\\fscy100)}" + pre; }
    }
    return pre + txt + post;
  };
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi];
    const nextStart = gi + 1 < groups.length ? map(groups[gi + 1][0].s) : Infinity;
    for (let i = 0; i < grp.length; i++) {
      const w = grp[i];
      const start = map(w.s);
      const end = i + 1 < grp.length ? map(grp[i + 1].s) : Math.min(map(w.e) + 0.12, nextStart);
      if (end - start < 0.03 || isHidden(start)) continue;
      const parts = grp.map((x, j) => {
        if (st.reveal && j > i) return null; // Wort für Wort einblenden
        if (st.active === "bright") return (j <= i ? "" : "{\\1a&HA0&}") + fmtWord(x, false) + (j <= i ? "" : "{\\1a&H00&}");
        return fmtWord(x, j === i);
      }).filter(x => x !== null);
      const pop = i === 0 && !st.pop ? "{\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)}" : "";
      const glow = st.glow ? "{\\blur6}" : "";
      lines.push("Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Cap,,0,0,0,," + glow + pop + parts.join(" "));
    }
  }
  return lines.join("\n") + "\n";
}

// Hook-Titel oben: über dem Kopf, wenn dort Platz ist, sonst oben in der Sicherheitszone
function hookTop(layout) {
  const z = layout && layout.zones;
  if (z && z.above && z.above.y1 - z.above.y0 >= 140) return Math.max(250, z.above.y1 - 140);
  return 250;
}

// ffmpeg-Argumente für den kompletten Render-Durchlauf
function buildFfmpegArgs(o) {
  // o: { input, segs, map, zooms:[t], images:[{file,t,dur,pos,size}], sounds:[{file,t,vol}], assFile, fontsDir, output, hasAudio }
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", o.input];
  o.images.forEach(im => { args.push("-loop", "1", "-t", String(im.dur.toFixed(2)), "-i", im.file); });
  o.sounds.forEach(sd => { args.push("-i", sd.file); });
  const fxs = o.effects || [];
  if (o.logo) args.push("-i", o.logo);
  fxs.forEach(fx => { if (fx.gif) args.push("-stream_loop", "-1", "-i", fx.file); else args.push("-c:v", "libvpx-vp9", "-i", fx.file); }); // vp9-Decoder behält die Transparenz
  const sel = o.segs.map(s => "between(t," + s.s.toFixed(3) + "," + s.e.toFixed(3) + ")").join("+");
  const f = [];
  f.push("[0:v]fps=" + FPS + ",scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",setsar=1,select='" + sel + "',setpts=N/" + FPS + "/TB" + (o.grade ? "," + o.grade : "") + "[v0]");
  let v = "v0";
  if (o.zooms.length) {
    const zs = (0.12 * (o.zoomStrength || 1)).toFixed(3);
    const terms = o.zooms.map(z => zs + "*min(1,(it-" + z.toFixed(3) + ")/0.15)*between(it," + z.toFixed(3) + "," + (z + 1.4).toFixed(3) + ")").join("+");
    const fx = o.focus ? Math.max(0.2, Math.min(0.8, o.focus.x)) : 0.5, fy = o.focus ? Math.max(0.15, Math.min(0.7, o.focus.y)) : 0.5;
    f.push("[" + v + "]zoompan=z='1+" + terms + "':d=1:x='max(0,min(iw-iw/zoom," + fx.toFixed(3) + "*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom," + fy.toFixed(3) + "*ih-ih/zoom/2))':s=" + W + "x" + H + ":fps=" + FPS + "[vz]");
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
  f.push("[" + v + "]ass='" + assPath + "':fontsdir='" + o.fontsDir + "'[vass]");
  v = "vass";
  // Effekt-Ebenen (durchsichtig) über Video und Untertitel legen
  const logoIdx = 1 + o.images.length + o.sounds.length;
  const fxBase = logoIdx + (o.logo ? 1 : 0);
  if (o.logo) { // Logo klein oben links, innerhalb der Sicherheitszone
    f.push("[" + logoIdx + ":v]scale=150:150:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.92[lg]");
    f.push("[" + v + "][lg]overlay=x=48:y=236[vlg]"); v = "vlg";
  }
  fxs.forEach((fx, i) => {
    if (fx.gif) { // GIF als Karte mit weißem Rand, sanft ein- und ausgeblendet, mittig über dem Platz
      const w = fx.width || 620;
      f.push("[" + (fxBase + i) + ":v]fps=" + FPS + ",trim=duration=" + fx.d.toFixed(3) + ",setpts=PTS-STARTPTS,scale=" + w + ":-2,pad=iw+16:ih+16:8:8:white,format=yuva420p,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=" + Math.max(0, fx.d - 0.22).toFixed(3) + ":d=0.22:alpha=1,setpts=PTS+" + fx.t0.toFixed(3) + "/TB[fx" + i + "]");
      f.push("[" + v + "][fx" + i + "]overlay=x=(W-w)/2:y=" + (fx.top || 300) + ":eof_action=pass:enable='between(t," + fx.t0.toFixed(3) + "," + (fx.t0 + fx.d).toFixed(3) + ")'[vf" + i + "]");
      v = "vf" + i; return;
    }
    f.push("[" + (fxBase + i) + ":v]format=yuva420p,setpts=PTS-STARTPTS+" + fx.t0.toFixed(3) + "/TB[fx" + i + "]");
    f.push("[" + v + "][fx" + i + "]overlay=0:0:eof_action=pass:enable='between(t," + fx.t0.toFixed(3) + "," + (fx.t0 + fx.d).toFixed(3) + ")'[vf" + i + "]");
    v = "vf" + i;
  });
  f.push("[" + v + "]null[vout]");
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

module.exports = { keptSegments, remapper, buildAss, buildFfmpegArgs, SOUNDS, CAPTION_STYLES, LOOKS, BRAND_FONTS, W, H, FPS };
