// Reel-Werkstatt: baut aus Wörtern + Plan einen ffmpeg-Auftrag
"use strict";

const W = 1080, H = 1920, FPS = 30;
const SOUNDS = ["kling", "ping", "pop", "whoosh", "klick", "tada"];

// Behaltene Abschnitte aus den nicht geschnittenen Wörtern bilden
function keptSegments(words, duration, pausen) {
  const kept = words.filter(w => !w.cut);
  if (!kept.length) return [];
  // "knapp" (2.14): Pausen ab 0,25 s raus und kürzere Ränder, wie bei Yapping-Reels
  const tight = pausen === "knapp", PAD_IN = tight ? 0.08 : 0.12, PAD_OUT = tight ? 0.12 : 0.18, MAX_GAP = tight ? 0.25 : 0.45;
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

// ---------- Schriftbreiten aus den Schriftdateien (2.19, für abgerundete Balken) ----------
let FONT_DIR = null; const _fm = {};
function setFontDir(d) { FONT_DIR = d; }
function fontFile(name) {
  if (!FONT_DIR) return null; let files; try { files = require("fs").readdirSync(FONT_DIR); } catch (e) { return null; }
  const m = /^Poppins(?: (Medium|SemiBold|Bold|ExtraBold|Black))?$/.exec(name); if (m) return files.includes("Poppins-" + (m[1] || "ExtraBold") + ".ttf") ? FONT_DIR + "/Poppins-" + (m[1] || "ExtraBold") + ".ttf" : null;
  const key = name.replace(/\s+/g, "").toLowerCase(), f = files.find(x => x.toLowerCase().startsWith(key + "-") || x.toLowerCase().startsWith(key + "["));
  return f ? FONT_DIR + "/" + f : null;
}
function metrics(name) {
  if (name in _fm) return _fm[name]; let out = null;
  try { const file = fontFile(name); if (file) { const b = require("fs").readFileSync(file), u16 = o => b.readUInt16BE(o), i16 = o => b.readInt16BE(o), u32 = o => b.readUInt32BE(o), T = {};
    for (let i = 0, n = u16(4); i < n; i++) { const r = 12 + 16 * i; T[b.toString("latin1", r, r + 4)] = u32(r + 8); }
    const upem = u16(T.head + 18), nH = u16(T.hhea + 34), wa = u16(T["OS/2"] + 74), wd = u16(T["OS/2"] + 76), adv = []; for (let i = 0; i < nH; i++) adv.push(u16(T.hmtx + 4 * i));
    const map = {}, cm = T.cmap; let sub = null; for (let i = 0, n = u16(cm + 2); i < n; i++) { const pid = u16(cm + 4 + 8 * i), eid = u16(cm + 6 + 8 * i), off = u32(cm + 8 + 8 * i), fmt = u16(cm + off); if ((pid === 3 && (eid === 10 || eid === 1)) || pid === 0) { if (fmt === 12 || (fmt === 4 && !sub)) sub = cm + off; } }
    if (sub && u16(sub) === 4) { const sc = u16(sub + 6) / 2, ends = sub + 14, starts = ends + 2 * sc + 2, deltas = starts + 2 * sc, ro = deltas + 2 * sc;
      for (let i = 0; i < sc; i++) { const e = u16(ends + 2 * i), st0 = u16(starts + 2 * i), d = i16(deltas + 2 * i), r = u16(ro + 2 * i); if (st0 === 0xFFFF) break;
        for (let c = st0; c <= e && c <= 0x2FFF; c++) { let g; if (!r) g = (c + d) & 0xFFFF; else { const ga = ro + 2 * i + r + 2 * (c - st0); g = u16(ga); if (g) g = (g + d) & 0xFFFF; } map[c] = g; } } }
    else if (sub && u16(sub) === 12) { for (let i = 0, n = u32(sub + 12); i < n; i++) { const g0 = sub + 16 + 12 * i, a = u32(g0), e = u32(g0 + 4), g = u32(g0 + 8); for (let c = a; c <= e && c <= 0x2FFF; c++) map[c] = g + c - a; } }
    out = { scale: 1 / (wa + wd), adv: c => { const g = map[c] || 0; return adv[Math.min(g, adv.length - 1)] || adv[adv.length - 1] || upem / 2; } }; } } catch (e) { out = null; }
  _fm[name] = out; return out;
}
// Breite eines Textes in Pixeln bei Schriftgröße size (libass-Größe)
function textWidth(name, size, txt, spacing) { const m = metrics(name); if (!m) return null; let w = 0; for (const ch of String(txt)) w += m.adv(ch.codePointAt(0)) * size * m.scale + (spacing || 0); return w; }
function roundRect(x0, y0, w, h, r) { const x1 = x0 + w, y1 = y0 + h, f = n => Math.round(n); r = Math.min(r, h / 2, w / 2);
  return "m " + f(x0 + r) + " " + f(y0) + " l " + f(x1 - r) + " " + f(y0) + " b " + f(x1) + " " + f(y0) + " " + f(x1) + " " + f(y0) + " " + f(x1) + " " + f(y0 + r) + " l " + f(x1) + " " + f(y1 - r) + " b " + f(x1) + " " + f(y1) + " " + f(x1) + " " + f(y1) + " " + f(x1 - r) + " " + f(y1)
    + " l " + f(x0 + r) + " " + f(y1) + " b " + f(x0) + " " + f(y1) + " " + f(x0) + " " + f(y1) + " " + f(x0) + " " + f(y1 - r) + " l " + f(x0) + " " + f(y0 + r) + " b " + f(x0) + " " + f(y0) + " " + f(x0) + " " + f(y0) + " " + f(x0 + r) + " " + f(y0); }

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
  const endeA = endeStart(style, map.total);
  // Kasten hinter den Untertiteln: BorderStyle 4 zeichnet einen durchgehenden Kasten pro Einblendung (BackColour).
  // Früher BorderStyle 3: dort entstanden an Farbwechseln dunklere Streifen, weil sich halbtransparente Kästen überlappten.
  const rounded = st.plate && style.cap_round !== false && !!metrics(st.font);
  const border = st.plate && !rounded ? 4 : 1;
  const plateCol = st.plateColor ? "&H" + (st.plateAlpha || "30") + assColor(st.plateColor).slice(4) : "&H50141414&";
  const back = st.plate ? plateCol : "&H64000000&";
  const outlineCol = st.plate ? "&HFF000000&" : st.glow ? accent : "&H00141414&";
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Cap," + st.font + "," + size + "," + (st.hollow ? "&HFF" + base.slice(4) : base) + ",&H000000FF&," + (st.hollow ? base : outlineCol) + "," + back + "," + (st.bold ? 1 : 0) + ",0,0,0,100,100," + (st.spacing || 0) + ",0," + border + "," + (st.outline || 0) + "," + (st.shadow || 0) + ",8,80,80," + top + ",1",
    "Style: Hook," + (style.hook_font && BRAND_FONTS[style.hook_font] ? (style.hook_font === "Poppins" ? "Poppins ExtraBold" : style.hook_font) : (key === "marke" && BRAND_FONTS[style.brand_font] && style.brand_font !== "Poppins" ? style.brand_font : "Poppins ExtraBold")) + "," + ({ klein: 52, gross: 82 }[style.hook_size] || 66) + "," + (style.hook_box === "white" ? "&H00141414&" : "&H00FFFFFF&") + ",&H000000FF&," + (style.hook_box === "black" ? "&H00141414&" : style.hook_box === "white" ? "&H00FFFFFF&" : style.hook_box === "none" ? "&H00141414&" : style.hook_box === "custom" ? hexAss(style.hook_bg) : hookAccent) + "," + (style.hook_box === "black" ? "&H00141414&" : style.hook_box === "white" ? "&H00FFFFFF&" : style.hook_box === "none" ? "&H64000000&" : style.hook_box === "custom" ? hexAss(style.hook_bg) : hookAccent) + "," + (key === "marke" ? 1 : 0) + ",0,0,0,100,100,0,0," + (style.hook_box === "none" ? "1,3,2" : "3,20,0") + "," + ({ mitte: 5, unten: 2 }[style.hook_pos] || 8) + "," + (style.hook_wide ? "50,50," : "110,110,") + ({ oben: 110, mitte: 0, unten: 520 }[style.hook_pos] != null ? { oben: 110, mitte: 0, unten: 520 }[style.hook_pos] : hookTop(layout)) + ",1",
    "Style: TxtO,Poppins ExtraBold,60,&H00FFFFFF&,&H000000FF&,&H00141414&,&H64000000&,0,0,0,0,100,100,0,0,1,0,0,7,90,90,0,1",
    "Style: TxtB,Poppins ExtraBold,60,&H00FFFFFF&,&H000000FF&,&HFF000000&,&H00FFFFFF&,0,0,0,0,100,100,0,0,4,20,0,7,90,90,0,1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
  ];
  const kept = words.filter(w => !w.cut && !w.hide);
  const tkd = titelkarteDur(style);
  if (style.hook !== false && style.hook_titel) {
    const hd = Number(style.hook_dur); const end = Math.min(tkd + (isFinite(hd) && hd >= 1 ? hd : 3.2), map.total);
    lines.push("Dialogue: 1," + assTime(tkd) + "," + assTime(end) + ",Hook,,0,0,0,,{\\fad(120,200)}" + assText(caseOf({}, style.hook_titel)));
  }
  if (style.captions === false) { textEvents(words, map, style).forEach(l => lines.push(l)); return lines.join("\n") + "\n"; }
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
      if (endeA != null && start >= endeA - 0.02) continue;
      if (tkd && start < tkd - 0.02) continue;
      if (rounded) { const mv = moveFor(start), my = /\\pos\((\d+),(\d+)\)/.exec(mv), ty = my ? Number(my[2]) : top;
        let wsum = 0; grp.forEach((x, j) => { if (st.reveal && j > i) return; const f = x.emph && st.emph === "script" ? [scriptFont, size * 1.35] : x.emph && st.emph === "serif" ? [italicFont, size * 1.45] : [st.font, size];
          const sc = j === i && st.active === "accent+grow" ? 1.1 : j === i && st.active === "grow" ? 1.12 : 1; wsum += (textWidth(f[0], f[1], caseOf(st, x.w), st.spacing) || 0) * sc; });
        wsum += (grp.length - 1) * (textWidth(st.font, size, " ", st.spacing) || size * 0.25);
        const pad = st.outline || 16, ln = Math.max(1, Math.ceil(wsum / (W - 160))), bw = Math.min(wsum, W - 160) + 2 * pad, bh = ln * size + 2 * pad, a = (plateCol.match(/&H([0-9A-F]{2})/i) || [0, "00"])[1];
        lines.push("Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Cap,,0,0,0,,{\\an7\\pos(0,0)\\p1\\bord0\\shad0\\1c&H" + plateCol.slice(4, 10) + "&\\1a&H" + a + "&}" + roundRect((W - bw) / 2, ty - pad, bw, bh, Math.round(size * 0.32)) + "{\\p0}"); }
      lines.push("Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Cap,,0,0,0,," + moveFor(start) + glow + pop + parts.join(" "));
    }
  }
  textEvents(words, map, style).forEach(l => lines.push(l));
  return lines.join("\n") + "\n";
}

// ---------- Text-Einblendungen (2.14): Stichpunkt, Kapitel, Checkliste, große Zahl, Zitat, Banner, Notiz ----------
// Die Vorschau im Editor rechnet mit denselben Werten (Größen, Positionen, Zeiten, Animationen).
const TEXT_ARTS = {
  punkt:   { y: 20, font: "Poppins ExtraBold", size: 62, an: 7 },
  kapitel: { y: 9,  font: "DM Serif Display", size: 96, an: 8 },
  liste:   { y: 13, font: "Poppins Bold", size: 46, an: 7 },
  zahl:    { y: 16, font: "Anton", size: 300, an: 8 },
  zitat:   { y: 18, font: "DM Serif Display", size: 64, an: 8 },
  banner:  { y: 20, font: "Poppins ExtraBold", size: 84, an: 8 },
  notiz:   { y: 22, font: "Caveat Brush", size: 96, an: 8 },
  ende_klein: { y: 58, font: "Poppins ExtraBold", size: 54, an: 8 },
  ende_gross: { y: 63, font: "Anton", size: 140, an: 8 },
  ende_text:  { y: 73, font: "Poppins Bold", size: 50, an: 8 },
  karte_titel: { y: 66, font: "Caveat Brush", size: 130, an: 8 },
  poesie: { y: 42, font: "DM Serif Display", size: 92, an: 8 },
};
const TEXT_ANIMS = ["einblenden", "hoch", "pop", "schreiben", "marker"];
const SHAPES = { pfeil: "m 0 18 l 46 18 l 46 4 l 70 24 l 46 44 l 46 30 l 0 30", haken: "m 0 24 l 10 14 l 22 26 l 48 0 l 58 10 l 22 46", pfeilunten: "m 30 0 l 42 0 l 42 52 l 60 34 l 68 42 l 36 74 l 4 42 l 12 34 l 30 52" };
function quoteMarks(lang) { return lang === "de" ? ["„", "“"] : lang === "fr" ? ["« ", " »"] : ["“", "”"]; }
// Zeitfenster eines Textes in Schnittzeit
function textWindow(t, words, map) {
  const a = words[t.von], b = words[t.bis != null ? t.bis : t.von] || a; if (!a) return null;
  const start = map(Math.max(0, a.s - 0.05));
  const end = Math.min(Math.max(map(b.e) + 0.5, start + 1.6), start + 15, map.total);
  return end - start > 0.3 ? { start, end } : null;
}
// Animations-Tags; x/y = Ankerpunkt
function animTags(kind, x, y) {
  if (kind === "hoch") return "\\move(" + x + "," + (y + 70) + "," + x + "," + y + ",0,300)\\fad(150,200)";
  const pos = "\\pos(" + x + "," + y + ")";
  if (kind === "pop") return pos + "\\fscx40\\fscy40\\t(0,220,\\fscx100\\fscy100)\\fad(60,200)";
  if (kind === "marker") return pos + "\\clip(0,0,0,1920)\\t(0,450,\\clip(0,0,1080,1920))\\fad(0,200)";
  if (kind === "schreiben") return pos + "\\fad(0,200)";
  return pos + "\\fad(200,200)";
}
// Schreibmaschine: Zeitpunkte, an denen der nächste Buchstabe erscheint
function typeSteps(text, start, end) {
  const ch = Array.from(text), n = ch.length, D = Math.min(1.0, 0.045 * n, (end - start) * 0.6), out = [];
  for (let j = 1; j <= n; j++) { const t0 = start + D * (j - 1) / n, t1 = j < n ? start + D * j / n : end; if (t1 - t0 > 0.005) out.push({ t0, t1, txt: ch.slice(0, j).join("") }); }
  return out;
}
// Ende des Reels (2.16): Kommentar-Stichwort und Freebie als Texte in den letzten Sekunden
const ENDE_WORTE = { de: ["KOMMENTIERE", "GRATIS FÜR DICH"], en: ["COMMENT", "FREE FOR YOU"], fr: ["COMMENTE", "GRATUIT POUR TOI"], it: ["COMMENTA", "GRATIS PER TE"], es: ["COMENTA", "GRATIS PARA TI"], pt: ["COMENTA", "GRÁTIS PARA TI"], nl: ["REAGEER MET", "GRATIS VOOR JOU"], sv: ["KOMMENTERA", "GRATIS TILL DIG"], ca: ["COMENTA", "GRATIS PER A TU"] };
function endeLayout(e) { const fb = !!(e && (e.freebie_key || e.freebie_titel)); return { label: 9, titel: 13.5, card: e && e.freebie_titel ? 18.5 : 14, k1: fb ? 58 : 40, k2: fb ? 63 : 45, k3: fb ? 73 : 55 }; }
// Titelkarte am Anfang (2.18): Dauer in Sekunden oder 0
function titelkarteDur(style) { const t = style.titelkarte; if (!t || !(t.titel || (t.keys && t.keys.length))) return 0; return Math.max(1, Math.min(4, Number(t.dauer) || 2)); }
// Beginn des Endes in Schnittzeit (oder null): dort pausieren die Untertitel
function endeStart(style, total) { const e = style.ende || {}; if (!(e.kommentar || e.freebie_key || e.freebie_titel)) return null; return Math.max(0, total - Math.min(Math.max(2, Number(e.dauer) || 3.5), total)); }
function endeTexts(style, total) {
  const e = style.ende || {}, d = Math.min(Math.max(2, Number(e.dauer) || 3.5), total), a = Math.max(0, total - d), L = endeLayout(e), W2 = ENDE_WORTE[style.lang] || ENDE_WORTE.de, out = [];
  const abs = { start: a, end: total + 0.05 };
  if (e.freebie_key || e.freebie_titel) { out.push({ art: "ende_klein", text: W2[1], y: L.label, anim: "pop", abs });
    if (e.freebie_titel) out.push({ art: "ende_text", text: e.freebie_titel, y: L.titel, anim: "hoch", abs }); }
  if (e.kommentar) { out.push({ art: "ende_klein", text: W2[0], y: L.k1, anim: "pop", abs }); out.push({ art: "ende_gross", text: String(e.kommentar).toLocaleUpperCase("de-DE"), y: L.k2, anim: "pop", abs });
    if (e.kommentar_text) out.push({ art: "ende_text", text: e.kommentar_text, y: L.k3, anim: "hoch", abs }); }
  return out;
}
function textEvents(words, map, style) {
  const out = [], acc = hexAss(style.accent || "#E6007E"), lang = style.lang || "de";
  const tk = titelkarteDur(style);
  const list = (Array.isArray(style.texts) ? style.texts.slice(0, 12) : []).concat(endeTexts(style, map.total)).concat(tk && style.titelkarte.titel ? [{ art: "karte_titel", text: style.titelkarte.titel, y: 66, anim: "einblenden", abs: { start: 0, end: tk } }] : []);
  const dlg = (t0, t1, sty, mL, mR, tags, txt) => out.push("Dialogue: 2," + assTime(t0) + "," + assTime(t1) + "," + sty + ",," + mL + "," + mR + ",0,,{" + tags + "}" + txt);
  const shape = (t0, t1, kind, x, y, name, col, extra) => dlg(t0, t1, "TxtO", 0, 0, "\\an7" + animTags(kind, x, y) + "\\p1\\bord" + (extra || 0) + "\\shad0\\1c" + col + "\\3c&H141414&", SHAPES[name] + "{\\p0}");
  list.forEach(t => {
    if (!t || t.off || !TEXT_ARTS[t.art]) return;
    const A = TEXT_ARTS[t.art], win = t.abs || (t.at != null ? { start: map(Number(t.at)), end: Math.min(map.total, map(Number(t.at) + (Number(t.dur) || 2.5))) } : textWindow(t, words, map)); if (!win || win.end - win.start < 0.2) return;
    const kind = TEXT_ANIMS.includes(t.anim) ? t.anim : "einblenden";
    const y = Math.round((isFinite(Number(t.y)) ? Number(t.y) : A.y) / 100 * H);
    let text = t.art === "poesie" ? String(t.text || "").replace(/[{}\\]/g, "").trim() : assText(t.text || ""); if (!text && t.art !== "liste") return;
    if (t.art === "banner") text = text.toLocaleUpperCase("de-DE");
    if (t.art === "zitat") { const q = quoteMarks(lang); text = q[0] + text + q[1]; }
    const put = (sty, mL, mR, x, tagsBase, txt) => {
      if (kind === "schreiben") typeSteps(txt, win.start, win.end).forEach(st => dlg(st.t0, st.t1, sty, mL, mR, "\\an" + A.an + "\\pos(" + x + "," + y + ")" + (st.t1 >= win.end - 0.001 ? "\\fad(0,200)" : "") + tagsBase, st.txt));
      else dlg(win.start, win.end, sty, mL, mR, "\\an" + A.an + animTags(kind, x, y) + tagsBase, txt);
    };
    if (t.art === "punkt") {
      shape(win.start, win.end, kind === "schreiben" ? "einblenden" : kind, 90, y + 7, "pfeil", acc, 3);
      put("TxtO", 180, 90, 180, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\3c&H141414&\\bord5\\shad0", text);
    } else if (t.art === "kapitel") {
      put("TxtO", 90, 90, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\bord0\\shad4\\4c&H000000&\\4a&H64&", text);
    } else if (t.art === "zahl") {
      put("TxtO", 60, 60, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c" + acc + "\\3c&H141414&\\bord8\\shad0", text);
      const lab = assText(t.text2 || ""); if (lab) dlg(win.start, win.end, "TxtO", 90, 90, "\\an8" + animTags(kind === "schreiben" ? "einblenden" : kind, 540, y + A.size + 10) + "\\fnPoppins ExtraBold\\fs56\\b0\\c&H00FFFFFF&\\3c&H141414&\\bord5\\shad0", lab);
    } else if (t.art === "zitat") {
      put("TxtB", 150, 150, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H001A1A1A&\\4c&H00FFFFFF&\\4a&H00&\\bord40\\shad0", text);
    } else if (t.art === "banner") {
      put("TxtB", 110, 110, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\4c" + acc + "\\4a&H00&\\bord24\\shad0", text);
    } else if (t.art === "notiz") {
      put("TxtO", 120, 120, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H004CC9F2&\\3c&H141414&\\bord4\\shad0\\frz-4", text);
      shape(win.start, win.end, kind === "schreiben" ? "einblenden" : kind, 504, y + A.size + 14, "pfeilunten", "&H004CC9F2&", 3);
    } else if (t.art === "ende_klein") {
      put("TxtB", 120, 120, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H001A1A1A&\\4c&H00FFFFFF&\\4a&H00&\\bord18\\shad0", text);
    } else if (t.art === "ende_gross") {
      put("TxtB", 90, 90, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\4c" + acc + "\\4a&H00&\\bord26\\shad0", text);
    } else if (t.art === "poesie") {
      put("TxtO", 90, 90, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\bord0\\shad3\\4c&H000000&\\4a&H60&", String(text).replace(/\*([^*]+)\*/g, "{\\c" + acc + "\\i1\\fs" + Math.round(A.size * 1.25) + "}$1{\\c&H00FFFFFF&\\i0\\fs" + A.size + "}"));
    } else if (t.art === "karte_titel") {
      put("TxtO", 90, 90, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H001A1A1A&\\bord0\\shad0\\frz-3", text);
    } else if (t.art === "ende_text") {
      put("TxtO", 110, 110, 540, "\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H00FFFFFF&\\3c&H141414&\\bord5\\shad0", text);
    } else if (t.art === "liste") {
      const items = (Array.isArray(t.items) ? t.items : String(t.text || "").split(/\n|;/)).map(x => assText(x)).filter(Boolean).slice(0, 6); if (!items.length) return;
      const n = items.length, step = (win.end - win.start) * 0.8 / n;
      items.forEach((it, i) => {
        const ti = win.start + i * step, tn = i + 1 < n ? win.start + (i + 1) * step : win.end, yi = y + i * 92;
        const base = "\\an7\\fn" + A.font + "\\fs" + A.size + "\\b0\\c&H001A1A1A&\\bord16\\shad0\\4a&H00&";
        dlg(ti, tn, "TxtB", 162, 90, base + animTags(kind === "schreiben" || kind === "marker" ? "einblenden" : kind, 162, yi).replace(/\\fad\(\d+,\d+\)/, "\\fad(" + (kind === "pop" ? 60 : 150) + ",0)") + "\\4c&H004CC9F2&", it);
        if (i + 1 < n) { dlg(tn, win.end, "TxtB", 162, 90, base + "\\pos(162," + yi + ")\\fad(0,200)\\4c&H00FFFFFF&", it); shape(tn, win.end, "einblenden", 76, yi + 4, "haken", acc, 3); }
      });
    }
  });
  return out;
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
    const t = kept[i].zt || "sanft";
    let j = i; while (j + 1 < kept.length && isZoom(kept[j + 1]) && (kept[j + 1].zt || "sanft") === t) j++;
    const a = map(kept[i].s), b = Math.max(map(kept[j].e), a + (t === "ruck" ? 0.6 : ZOOM_MIN_HOLD));
    const last = out[out.length - 1];
    if (last && last.t === t && a < last.b + ZOOM_OUT) last.b = Math.max(last.b, b); else out.push({ a, b, t });
    i = j;
  }
  return out;
}
// Zoom-Term je Art (2.15)
function zoomTerm(r, zs) {
  const a = r.a.toFixed(3), b = r.b.toFixed(3), len = Math.max(0.2, r.b - r.a);
  if (r.t === "ruck") return (zs * 1.4).toFixed(3) + "*(clip((it-" + a + ")/0.08,0,1)-clip((it-" + b + ")/0.25,0,1))";
  if (r.t === "raus") return (zs * 1.5).toFixed(3) + "*between(it," + a + "," + b + ")*(1-" + easeExpr("(it-" + a + ")/" + len.toFixed(3)) + ")";
  const k = r.t === "wackeln" ? 0.6 : r.t === "schwenk" ? 1.2 : 1, din = Math.min(ZOOM_IN, Math.max(0.3, len / 2)).toFixed(3);
  return (zs * k).toFixed(3) + "*(" + easeExpr("(it-" + a + ")/" + din) + "-" + easeExpr("(it-" + b + ")/" + ZOOM_OUT.toFixed(3)) + ")";
}
function panTerms(rs) {
  let x = "", y = "";
  rs.forEach(r => { const a = r.a.toFixed(3), b = r.b.toFixed(3), len = Math.max(0.2, r.b - r.a).toFixed(3);
    if (r.t === "schwenk") x += "+between(it," + a + "," + b + ")*((it-" + a + ")/" + len + "-0.5)*iw*0.06";
    if (r.t === "wackeln") { x += "+between(it," + a + "," + b + ")*sin(it*47)*iw*0.006"; y += "+between(it," + a + "," + b + ")*cos(it*53)*ih*0.004"; } });
  return { x, y };
}
// Wort-Effekte (2.15): Glitch, weißer Blitz, Wischblende, Unschärfe
function wordEffects(kept, map, accent) { return kept.filter(w => w.vfx).map(w => ({ t: w.vfx, a: Math.max(0, map(w.s) - 0.04), accent: accent || "#E6007E" })); }
const VFX_DUR = { glitch: 0.22, blitz: 0.14, wisch: 0.35, unschaerfe: 0.3 };
function vfxFilters(list) {
  const out = [];
  (list || []).forEach(e => { const a = e.a, b = a + (VFX_DUR[e.t] || 0.25), en = "enable='between(t," + a.toFixed(3) + "," + b.toFixed(3) + ")'";
    if (e.t === "blitz") { out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.85:t=fill:enable='between(t," + a.toFixed(3) + "," + (a + 0.06).toFixed(3) + ")'"); out.push("drawbox=x=0:y=0:w=iw:h=ih:color=white@0.4:t=fill:enable='between(t," + (a + 0.06).toFixed(3) + "," + b.toFixed(3) + ")'"); }
    if (e.t === "glitch") { out.push("rgbashift=rh=-16:bh=16:rv=6:" + en); out.push("noise=alls=40:allf=t:" + en); }
    if (e.t === "unschaerfe") out.push("gblur=sigma=16:" + en);
    /* Wischblende läuft als eigene Ebene, siehe buildFfmpegArgs */ });
  return out;
}
// Farbkorrektur und Filter (2.15)
const COLOR_PRESETS = { warm: "colorbalance=rs=0.06:gs=0.01:bs=-0.05,eq=saturation=1.05", kuehl: "colorbalance=rs=-0.04:bs=0.06,eq=saturation=0.95", hell: "eq=brightness=0.04:gamma=1.08:saturation=0.95",
  kontrast: "eq=contrast=1.15:saturation=1.1", sw: "hue=s=0,eq=contrast=1.1", vintage: "colorbalance=rs=0.05:gs=0.02:bs=-0.06,eq=saturation=0.8:contrast=0.95" };
function colorFilters(style) {
  const out = [], n = (k, a, b) => Math.max(a, Math.min(b, Number(style[k]) || 0));
  if (COLOR_PRESETS[style.filter]) out.push(COLOR_PRESETS[style.filter]);
  const k = n("kontrast", -2, 2), sa = n("saettigung", -2, 2), w = n("waerme", -2, 2), sh = n("schaerfe", 0, 3);
  if (k || sa) out.push("eq=contrast=" + (1 + 0.07 * k).toFixed(3) + ":saturation=" + (1 + 0.15 * sa).toFixed(3));
  if (w) out.push("colorbalance=rs=" + (0.035 * w).toFixed(3) + ":bs=" + (-0.035 * w).toFixed(3) + ":rm=" + (0.02 * w).toFixed(3) + ":bm=" + (-0.02 * w).toFixed(3));
  if (sh) out.push("unsharp=5:5:" + (0.35 * sh).toFixed(2));
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
  fxs.forEach(fx => { if (fx.sticker) args.push("-ignore_loop", "0", "-i", fx.file); else if (fx.gif) args.push("-stream_loop", "-1", "-i", fx.file); else args.push("-c:v", "libvpx-vp9", "-i", fx.file); }); // vp9-Decoder behält die Transparenz
  let nIn = 1 + o.images.length + o.sounds.length + (o.logo ? 1 : 0) + unders.length + fxs.length;
  if (o.split && o.split.file) { o.splitIdx = nIn++; args.push("-loop", "1", "-t", (o.split.d + 0.1).toFixed(2), "-i", o.split.file); }
  if (o.card && o.card.file) { o.cardIdx = nIn++; args.push("-loop", "1", "-t", (o.card.d + 0.1).toFixed(2), "-i", o.card.file); }
  (o.pips || []).forEach(pp => { pp.idx = nIn++; args.push("-t", (pp.d + 0.2).toFixed(2), "-i", pp.file); });
  if (o.loopFrame) { o.loopIdx = nIn++; args.push("-loop", "1", "-t", "0.45", "-i", o.loopFrame); }
  const sel = o.segs.map(s => "between(t," + s.s.toFixed(3) + "," + s.e.toFixed(3) + ")").join("+");
  const f = [];
  f.push("[0:v]fps=" + FPS + ",scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + (o.cropX != null ? ":'max(0,min(iw-ow,iw*" + Number(o.cropX).toFixed(4) + "-ow/2))':0" : "") + ",setsar=1,select='" + sel + "',setpts=N/" + FPS + "/TB" + (o.grade ? "," + o.grade : "") + "[v0]");
  let v = "v0";
  if (o.zooms.length || o.dauerzoom) {
    const zs = 0.10 * (o.zoomStrength || 1);
    const rs = o.zooms.map(z => typeof z === "number" ? { a: z, b: z + ZOOM_MIN_HOLD, t: "sanft" } : z);
    const parts = rs.map(r => zoomTerm(r, zs)); if (o.dauerzoom) parts.push("0.08*min(1,it/" + Math.max(1, o.map.total).toFixed(3) + ")");
    const terms = parts.join("+"), pt = panTerms(rs);
    const fx = o.focus ? Math.max(0.2, Math.min(0.8, o.focus.x)) : 0.5, fy = o.focus ? Math.max(0.15, Math.min(0.7, o.focus.y)) : 0.5;
    f.push("[" + v + "]zoompan=z='1+" + terms + "':d=1:x='max(0,min(iw-iw/zoom," + fx.toFixed(3) + "*iw-iw/zoom/2" + pt.x + "))':y='max(0,min(ih-ih/zoom," + fy.toFixed(3) + "*ih-ih/zoom/2" + pt.y + "))':s=" + W + "x" + H + ":fps=" + FPS + "[vz]");
    v = "vz";
  }
  const vf = vfxFilters(o.vfx); if (vf.length) { f.push("[" + v + "]" + vf.join(",") + "[vx]"); v = "vx"; }
  (o.vfx || []).filter(e => e.t === "wisch").forEach((e, i) => { const a = e.a.toFixed(3), d = VFX_DUR.wisch;
    f.push("color=c=" + String(e.accent || "#E6007E").replace("#", "0x") + ":s=" + W + "x" + H + ":r=" + FPS + ":d=" + d + ",setpts=PTS+" + a + "/TB[wc" + i + "]");
    f.push("[" + v + "][wc" + i + "]overlay=x='(t-" + a + ")/" + d + "*2*W-W':y=0:eof_action=pass:enable='between(t," + a + "," + (e.a + d).toFixed(3) + ")'[vw" + i + "]"); v = "vw" + i; });
  o.images.forEach((im, i) => {
    const idx = 1 + i;
    const wpx = im.size === "gross" ? 860 : im.size === "klein" ? 420 : 640;
    const y = im.y != null ? String(Math.round(im.y)) : im.card ? (im.pos === "unten" ? "H*0.52-40" : im.pos === "mitte" ? "(H-h)/2" : "H*0.16-40") : (im.pos === "unten" ? "H*0.52" : im.pos === "mitte" ? "(H-h)/2" : "H*0.16");
    const d = im.dur, fo = Math.max(0, d - 0.18).toFixed(2);
    f.push("[" + idx + ":v]" + (im.card ? "" : "scale=" + wpx + ":-1,") + "format=rgba,fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=" + fo + ":d=0.18:alpha=1,setpts=PTS-STARTPTS+" + im.t.toFixed(3) + "/TB[im" + i + "]");
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
    (o.pips || []).forEach((pp, i) => { const w = pp.size === "mittel" ? 520 : 380, x = /links/.test(pp.pos) ? 60 : W - w - 16 - 60, y = /unten/.test(pp.pos) ? Math.round(H * 0.5) : 260;
      f.push("[" + pp.idx + ":v]fps=" + FPS + ",scale=" + w + ":-2,setsar=1,pad=iw+16:ih+16:8:8:white,format=yuva420p,fade=t=in:st=0:d=0.2:alpha=1,fade=t=out:st=" + Math.max(0, pp.d - 0.2).toFixed(3) + ":d=0.2:alpha=1,setpts=PTS-STARTPTS+" + pp.t.toFixed(3) + "/TB[pip" + i + "]");
      f.push("[" + v + "][pip" + i + "]overlay=" + x + ":" + y + ":eof_action=pass:enable='between(t," + pp.t.toFixed(3) + "," + (pp.t + pp.d).toFixed(3) + ")'[vpip" + i + "]"); v = "vpip" + i; });
    if (o.splitIdx != null) { const d = o.split.d.toFixed(3), fy = Math.max(0, Math.min(960, Math.round((o.split.fy || 0.45) * 1920 - 480)));
      f.push("[" + v + "]split[sp0][sp1]"); f.push("[sp1]crop=1080:960:0:" + fy + "[spb]");
      f.push("[" + o.splitIdx + ":v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960,setsar=1,format=rgba[spt]");
      f.push("[sp0][spt]overlay=0:0:eof_action=repeat:enable='lt(t," + d + ")'[spx]"); f.push("[spx][spb]overlay=0:960:enable='lt(t," + d + ")'[vsp]"); f.push("[vsp]drawbox=x=0:y=956:w=iw:h=8:color=white:t=fill:enable='lt(t," + d + ")'[vsp2]"); v = "vsp2"; }
    if (o.cardIdx != null) { f.push("[" + o.cardIdx + ":v]format=rgba,fade=t=out:st=" + Math.max(0, o.card.d - 0.3).toFixed(3) + ":d=0.3:alpha=1[tkc]"); f.push("[" + v + "][tkc]overlay=0:0:eof_action=pass:enable='lt(t," + o.card.d.toFixed(3) + ")'[vtk]"); v = "vtk"; }
    if (o.loopIdx != null) { const T = o.map.total, a0 = Math.max(0, T - 0.4);
      f.push("[" + o.loopIdx + ":v]format=rgba,fade=t=in:st=0:d=0.35:alpha=1,setpts=PTS-STARTPTS+" + a0.toFixed(3) + "/TB[lp]");
      f.push("[" + v + "][lp]overlay=0:0:eof_action=pass:enable='gte(t," + a0.toFixed(3) + ")'[vlp]"); v = "vlp"; }
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
      f.push("[" + (fxBase + i) + ":v]fps=" + FPS + ",trim=duration=" + fx.d.toFixed(3) + ",setpts=PTS-STARTPTS,scale=" + w + ":-2," + (fx.sticker ? "format=rgba," : "pad=iw+16:ih+16:8:8:white,format=yuva420p,") + "fade=t=in:st=0:d=0.18:alpha=1,fade=t=out:st=" + Math.max(0, fx.d - 0.22).toFixed(3) + ":d=0.22:alpha=1,setpts=PTS+" + fx.t0.toFixed(3) + "/TB[fx" + i + "]");
      f.push("[" + v + "][fx" + i + "]overlay=x=(W-w)/2:y=" + (fx.top || 300) + ":eof_action=pass:enable='between(t," + fx.t0.toFixed(3) + "," + (fx.t0 + fx.d).toFixed(3) + ")'[vf" + i + "]");
      v = "vf" + i; return;
    }
    f.push("[" + (fxBase + i) + ":v]format=yuva420p,setpts=PTS-STARTPTS+" + fx.t0.toFixed(3) + "/TB[fx" + i + "]");
    f.push("[" + v + "][fx" + i + "]overlay=0:0:eof_action=pass:enable='between(t," + fx.t0.toFixed(3) + "," + (fx.t0 + fx.d).toFixed(3) + ")'[vf" + i + "]");
    v = "vf" + i;
  });
  const tempo = Math.max(1, Math.min(1.25, Number(o.tempo) || 1));
  const fin = [o.vignette ? "vignette=PI/5" : "", o.koernung ? "noise=alls=7:allf=t" : ""].filter(Boolean); if (fin.length) { f.push("[" + v + "]" + fin.join(",") + "[vfin]"); v = "vfin"; }
  f.push("[" + v + "]" + (tempo !== 1 ? "setpts=PTS/" + tempo.toFixed(3) : "null") + "[vout]");
  // Ton
  let a = null;
  if (o.hasAudio) {
    const voice = o.voice === "stark" ? ",highpass=f=90,afftdn=nf=-30:tn=1,acompressor=threshold=0.12:ratio=3:attack=10:release=200,loudnorm=I=-15:TP=-1.5:LRA=9" : o.voice === "sanft" ? ",highpass=f=70,afftdn=nf=-22,loudnorm=I=-16:TP=-1.5:LRA=11" : "";
    f.push("[0:a]aselect='" + sel + "',asetpts=N/SR/TB" + voice + ",aformat=sample_rates=44100:channel_layouts=stereo[a0]");
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
  if (o.loopFrame) { f.push("[" + a + "]afade=t=out:st=" + Math.max(0, o.map.total - 0.3).toFixed(3) + ":d=0.3[alp]"); a = "alp"; }
  if (tempo !== 1) { f.push("[" + a + "]atempo=" + tempo.toFixed(3) + "[atp]"); a = "atp"; }
  args.push("-filter_complex", f.join(";"), "-map", "[vout]", "-map", "[" + a + "]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-t", (o.map.total / tempo).toFixed(3), o.output);
  return args;
}

module.exports = { setFontDir, textWidth, roundRect, titelkarteDur, endeStart, endeTexts, endeLayout, ENDE_WORTE, colorFilters, wordEffects, vfxFilters, COLOR_PRESETS, textEvents, textWindow, typeSteps, TEXT_ARTS, TEXT_ANIMS, SHAPES, keptSegments, remapper, buildAss, buildFfmpegArgs, captionStyle, captionTop, zoomRanges, SOUNDS, CAPTION_STYLES, CAP_FONTS, LOOKS, BRAND_FONTS, W, H, FPS };
