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

// ---------- Untertitel einzeln anpassen (2.13): Schrift, Farbe, Hervorhebung, Größe, Position, Unterlegung ----------
// Schriften, die für Untertitel wählbar sind: Name im Studio -> Name für libass und ob fett gesetzt wird
const CAP_FONTS = {
  "Poppins": { ass: "Poppins ExtraBold", bold: 0 }, "Montserrat": { ass: "Montserrat", bold: 1 }, "Inter": { ass: "Inter", bold: 1 }, "DM Sans": { ass: "DM Sans", bold: 1 },
  "Outfit": { ass: "Outfit", bold: 1 }, "Space Grotesk": { ass: "Space Grotesk", bold: 1 }, "Syne": { ass: "Syne", bold: 1 }, "Anton": { ass: "Anton", bold: 0 },
  "Bebas Neue": { ass: "Bebas Neue", bold: 0 }, "Archivo Black": { ass: "Archivo Black", bold: 0 }, "Playfair Display": { ass: "Playfair Display", bold: 1 },
  "DM Serif Display": { ass: "DM Serif Display", bold: 0 }, "Lora": { ass: "Lora", bold: 1 }, "Cormorant Garamond": { ass: "Cormorant Garamond", bold: 1 },
  "Abril Fatface": { ass: "Abril Fatface", bold: 0 }, "Caveat Brush": { ass: "Caveat Brush", bold: 0 }, "Pacifico": { ass: "Pacifico", bold: 0 }, "Space Mono": { ass: "Space Mono", bold: 1 },
};
const hexOk = v => /^#[0-9a-f]{6}$/i.test(String(v || ""));
function lumOf(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return 1; const n = parseInt(m[1], 16); return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; }
// Wirksamer Untertitel-Stil: gewählter Stil plus eigene Anpassungen. Die Vorschau im Editor rechnet genauso.
function captionStyle(style) {
  style = style || {};
  const key = CAPTION_STYLES[style.caption_style] ? style.caption_style : "klar";
  const st = Object.assign({}, CAPTION_STYLES[key]);
  if (st.font === "@brand") { st.font = BRAND_FONTS[style.brand_font] ? (style.brand_font === "Poppins" ? "Poppins ExtraBold" : style.brand_font) : "Poppins ExtraBold"; }
  const cf = CAP_FONTS[style.cap_font];
  if (cf) { st.font = cf.ass; st.bold = !!cf.bold; }
  if (hexOk(style.cap_color)) st.color = style.cap_color;
  const n = Math.round(Number(style.cap_n) || 0); if (n >= 1 && n <= 5) st.n = n;
  if (style.cap_case === "upper") { st.upper = true; st.lower = false; } else if (style.cap_case === "normal") { st.upper = false; st.lower = false; }
  const box = style.cap_box;
  if (box === "none") { if (st.plate) st.outline = 5; st.plate = false; delete st.plateColor; }
  else if (["dark", "light", "accent", "custom"].includes(box)) {
    const col = box === "dark" ? "#141414" : box === "light" ? "#FFFFFF" : box === "accent" ? (hexOk(style.accent) ? style.accent : "#E6007E") : (hexOk(style.cap_box_bg) ? style.cap_box_bg : "#1F2A44");
    if (!st.plate) st.outline = 18;
    st.plate = true; st.plateColor = col; st.plateAlpha = box === "dark" ? "30" : "00"; st.hollow = false; st.glow = false; st.shadow = 0;
    if (!hexOk(style.cap_color)) st.color = lumOf(col) > 0.6 ? "#1A1A1A" : "#FFFFFF";
  }
  // Farbe für das gesprochene und die betonten Wörter
  let hl = hexOk(style.cap_hl) ? style.cap_hl : hexOk(style.accent) ? style.accent : "#E6007E";
  if (!hexOk(style.cap_hl) && st.plate && st.plateColor && st.plateColor.toUpperCase() === hl.toUpperCase()) hl = "#F2C94C";
  const scale = Math.max(0.6, Math.min(1.6, Number(style.cap_scale) || 1));
  const sizeF = style.size === "gross" ? 1.15 : style.size === "klein" ? 0.85 : 1;
  st.size = Math.round(st.size * sizeF * scale);
  return { key, st, hl };
}
// Oberkante der Untertitel (Pixel bei 1920 Höhe)
function captionTop(style, st, layout) {
  const size = st.size, zones = (layout && layout.zones) || null;
  let top;
  if (style.position === "frei") { const y = Number(style.cap_y); top = Math.round((isFinite(y) ? y : 60) / 100 * H); return Math.max(150, Math.min(1640 - size * 2, top)); }
  if (style.position === "oben") top = 330;
  else if (style.position === "mitte") top = 860;
  else if (style.position === "unten") top = 1250;
  else if (zones && zones.captions) top = st.center ? Math.round((zones.below ? (zones.below.y0 + zones.below.y1) / 2 : 1150) - size / 2) : zones.captions.y;
  else top = 1180;
  return Math.max(230, Math.min(1470 - size * 2, top));
}

// Untertitel bauen. layout (optional) kommt aus layout.py: Kopf, Kinn und freie Zonen
function buildAss(words, map, style, layout) {
  const eff = captionStyle(style), key = eff.key, st = eff.st;
  const accent = assColor(eff.hl);
  const hookAccent = assColor(style.accent || "#E6007E");
  const base = assColor(st.color || "#FFFFFF");
  const dim = "&H40" + base.slice(4);           // leicht durchsichtig für noch nicht gesprochene Wörter
  const size = st.size;
  const top = captionTop(style, st, layout);
  // Kasten hinter den Untertiteln: BorderStyle 4 zeichnet einen durchgehenden Kasten pro Einblendung (BackColour).
  // Früher BorderStyle 3: dort entstanden an Farbwechseln dunklere Streifen, weil sich halbtransparente Kästen überlappten.
  const border = st.plate ? 4 : 1;
  const plateCol = st.plateColor ? "&H" + (st.plateAlpha || "30") + assColor(st.plateColor).slice(4) : "&H50141414&";
  const back = st.plate ? plateCol : "&H64000000&";
  const outlineCol = st.plate ? "&HFF000000&" : st.glow ? accent : "&H00141414&";
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap," + st.font + "," + size + "," + (st.hollow ? "&HFF" + base.slice(4) : base) + ",&H000000FF&," + (st.hollow ? base : outlineCol) + "," + back + "," + (st.bold ? 1 : 0) + ",0,0,0,100,100," + (st.spacing || 0) + ",0," + border + "," + (st.outline || 0) + "," + (st.shadow || 0) + ",8,80,80," + top + ",1",
    "Style: Hook," + (style.hook_font && BRAND_FONTS[style.hook_font] ? (style.hook_font === "Poppins" ? "Poppins ExtraBold" : style.hook_font) : (key === "marke" && BRAND_FONTS[style.brand_font] && style.brand_font !== "Poppins" ? style.brand_font : "Poppins ExtraBold")) + "," + ({ klein: 52, gross: 82 }[style.hook_size] || 66) + "," + (style.hook_box === "white" ? "&H00141414&" : "&H00FFFFFF&") + ",&H000000FF&," + (style.hook_box === "black" ? "&H00141414&" : style.hook_box === "white" ? "&H00FFFFFF&" : style.hook_box === "none" ? "&H00141414&" : style.hook_box === "custom" ? hexAss(style.hook_bg) : hookAccent) + "," + (style.hook_box === "black" ? "&H00141414&" : style.hook_box === "white" ? "&H00FFFFFF&" : style.hook_box === "none" ? "&H64000000&" : style.hook_box === "custom" ? hexAss(style.hook_bg) : hookAccent) + "," + (key === "marke" ? 1 : 0) + ",0,0,0,100,100,0,0," + (style.hook_box === "none" ? "1,3,2" : "3,20,0") + "," + ({ mitte: 5, unten: 2 }[style.hook_pos] || 8) + "," + (style.hook_wide ? "50,50," : "110,110,") + ({ oben: 110, mitte: 0, unten: 520 }[style.hook_pos] != null ? { oben: 110, mitte: 0, unten: 520 }[style.hook_pos] : hookTop(layout)) + ",1",
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
  const moves = (style.caption_moves || []).map(r => [Number(r[0]), Number(r[1]), Number(r[2])]);
  const moveFor = t => { const mv = moves.find(r => t >= r[0] && t < r[1]); return mv ? "{\\an8\\pos(" + (W / 2) + "," + Math.round(mv[2]) + ")}" : ""; };
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
      lines.push("Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Cap,,0,0,0,," + moveFor(start) + glow + pop + parts.join(" "));
    }
  }
  return lines.join("\n") + "\n";
}

// Hook-Titel oben: über dem Kopf, wenn dort Platz ist, sonst oben in der Sicherheitszone
function hexAss(hex) { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "")); return m ? "&H00" + (m[3] + m[2] + m[1]).toUpperCase() + "&" : "&H00141414&"; }
function hookTop(layout) {
  const z = layout && layout.zones;
  if (z && z.above && z.above.y1 - z.above.y0 >= 140) return Math.max(250, z.above.y1 - 140);
  return 250;
}

// Zoom-Bereiche (2.13.1): aufeinanderfolgende Zoom-Wörter bilden einen Bereich. Langsam hinein, halten, langsam wieder heraus.
const ZOOM_IN = 0.6, ZOOM_OUT = 1.1, ZOOM_MIN_HOLD = 1.2;
function zoomRanges(kept, isZoom, map) {
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    if (!isZoom(kept[i])) continue;
    let j = i; while (j + 1 < kept.length && isZoom(kept[j + 1])) j++;
    const a = map(kept[i].s), b = Math.max(map(kept[j].e), a + ZOOM_MIN_HOLD);
    const last = out[out.length - 1];
    if (last && a < last.b + ZOOM_OUT) last.b = Math.max(last.b, b); else out.push({ a, b });
    i = j;
  }
  return out;
}
// Weiche Kurve 0..1 (smoothstep) als ffmpeg-Ausdruck
function easeExpr(x) { const c = "clip(" + x + ",0,1)"; return "(" + c + "*" + c + "*(3-2*" + c + "))"; }

// ffmpeg-Argumente für den kompletten Render-Durchlauf
function buildFfmpegArgs(o) {
  // o: { input, segs, map, zooms:[t], images:[{file,t,dur,pos,size}], sounds:[{file,t,vol}], assFile, fontsDir, output, hasAudio }
  const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", o.input];
  o.images.forEach(im => { args.push("-loop", "1", "-t", String(im.dur.toFixed(2)), "-i", im.file); });
  o.sounds.forEach(sd => { args.push("-i", sd.file); });
  const fxs = o.effects || [];
  const unders = o.underlays || []; // freigestellte Abschnitte (deckend), liegen unter Untertiteln und Grafiken
  if (o.logo) args.push("-i", o.logo);
  unders.forEach(u => { args.push("-i", u.file); });
  fxs.forEach(fx => { if (fx.gif) args.push("-stream_loop", "-1", "-i", fx.file); else args.push("-c:v", "libvpx-vp9", "-i", fx.file); }); // vp9-Decoder behält die Transparenz
  const sel = o.segs.map(s => "between(t," + s.s.toFixed(3) + "," + s.e.toFixed(3) + ")").join("+");
  const f = [];
  f.push("[0:v]fps=" + FPS + ",scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",setsar=1,select='" + sel + "',setpts=N/" + FPS + "/TB" + (o.grade ? "," + o.grade : "") + "[v0]");
  let v = "v0";
  if (o.zooms.length) {
    const zs = (0.10 * (o.zoomStrength || 1)).toFixed(3);
    const rs = o.zooms.map(z => typeof z === "number" ? { a: z, b: z + ZOOM_MIN_HOLD } : z);
    const terms = rs.map(r => { const din = Math.min(ZOOM_IN, Math.max(0.3, (r.b - r.a) / 2)).toFixed(3);
      return zs + "*(" + easeExpr("(it-" + r.a.toFixed(3) + ")/" + din) + "-" + easeExpr("(it-" + r.b.toFixed(3) + ")/" + ZOOM_OUT.toFixed(3)) + ")"; }).join("+");
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
  // Reihenfolge der Eingänge: Video, Bilder, Töne, Logo, freigestellte Abschnitte, Effekt-Ebenen
  const underBase = 1 + o.images.length + o.sounds.length + (o.logo ? 1 : 0);
  unders.forEach((u, i) => {
    f.push("[" + (underBase + i) + ":v]scale=" + W + ":" + H + ",setsar=1,setpts=PTS-STARTPTS+" + u.t0.toFixed(3) + "/TB[un" + i + "]");
    f.push("[" + v + "][un" + i + "]overlay=0:0:eof_action=pass:enable='between(t," + u.t0.toFixed(3) + "," + (u.t0 + u.d - 0.001).toFixed(3) + ")'[vu" + i + "]");
    v = "vu" + i;
  });
  if (o.assFile) {
    const assPath = o.assFile.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "");
    f.push("[" + v + "]ass='" + assPath + "':fontsdir='" + o.fontsDir + "'[vass]");
    v = "vass";
  }
  // Effekt-Ebenen (durchsichtig) über Video und Untertitel legen
  const logoIdx = 1 + o.images.length + o.sounds.length;
  const fxBase = logoIdx + (o.logo ? 1 : 0) + unders.length;
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

module.exports = { keptSegments, remapper, buildAss, buildFfmpegArgs, captionStyle, captionTop, zoomRanges, SOUNDS, CAPTION_STYLES, CAP_FONTS, LOOKS, BRAND_FONTS, W, H, FPS };
