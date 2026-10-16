// Reel-Werkstatt: Effekte als durchsichtige Ebenen (HyperFrames, Apache 2.0)
// Jeder Effekt wird als eigenes kurzes Video mit Transparenz gerendert und später von ffmpeg über das Reel gelegt.
// Eigene Gestaltung: AI is Female Creator Studio.
"use strict";
const fs = require("fs");
const path = require("path");

const W = 1080, H = 1920;
const EFFECTS = {
  checkliste: { label: "Checkliste", needs: "2 bis 4 Punkte, die nacheinander gesagt werden", minDur: 2.2, maxDur: 7 },
  zahl:       { label: "Zahl zählt hoch", needs: "eine Zahl, die wirklich gesagt wird", minDur: 1.8, maxDur: 3.5 },
  kommentar:  { label: "Kommentar-Blase", needs: "ein Stichwort zum Kommentieren", minDur: 2.4, maxDur: 3.6 },
  karte:      { label: "Info-Karte", needs: "eine kurze Kernaussage", minDur: 1.8, maxDur: 4 },
  zitat:      { label: "Zitat-Karte", needs: "ein starker Satz", minDur: 2.2, maxDur: 5 },
  kapitel:    { label: "Kapitel-Titel", needs: "ein neuer Abschnitt beginnt", minDur: 1.4, maxDur: 2.4 },
  diagramm:   { label: "Wachsendes Diagramm", needs: "eine Entwicklung oder ein Wachstum", minDur: 2.2, maxDur: 4 },
  vergleich:  { label: "Vorher/Nachher-Karte", needs: "ein Vorher und ein Nachher", minDur: 2.6, maxDur: 5 },
  nachricht:  { label: "Nachrichten-Verlauf", needs: "ein Gespräch oder eine Anfrage", minDur: 2.6, maxDur: 5 },
  emoji:      { label: "Emoji-Sticker", needs: "ein Gefühl oder eine Pointe", minDur: 1, maxDur: 1.8 },
  gif:        { label: "GIF", needs: "eine Reaktion oder Pointe", minDur: 1.6, maxDur: 2.6 },
  // Effekte mit Freistellung (brauchen einen Replicate-Schlüssel, kosten Credits pro Schnitt)
  hinter:      { label: "Wörter hinter dir", needs: "ein kurzer Satz mit 1 bis 3 starken Wörtern", minDur: 1.8, maxDur: 4, cutout: true },
  spotlight:   { label: "Spotlight", needs: "ein Satz, der auf eine Pointe hinausläuft", minDur: 1.6, maxDur: 3.5, cutout: true },
  greenscreen: { label: "Green Screen", needs: "du sprichst über etwas, das man zeigen kann", minDur: 2.2, maxDur: 5, cutout: true },
  popout:      { label: "Pop-out", needs: "ein Moment, der herausstechen soll", minDur: 1.8, maxDur: 4, cutout: true },
  lichtaus:    { label: "Licht aus", needs: "ein Satz, der auf ein starkes Wort hinausläuft", minDur: 1.4, maxDur: 3, cutout: true },
};
const CUTOUT = Object.keys(EFFECTS).filter(k => EFFECTS[k].cutout);

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Platz für den Effekt: über dem Kopf, wenn genug frei ist, sonst unter dem Kinn oberhalb der Untertitel
function placement(layout, needH) {
  const z = (layout && layout.zones) || {};
  const above = z.above || { y0: 220, y1: 700 };
  const below = z.below || { y0: 1100, y1: 1470 };
  const cap = z.captions || { y: 1180, h: 220 };
  if (above.y1 - above.y0 >= needH) return { top: Math.max(230, above.y1 - needH), zone: "above", hideCaptions: false };
  const belowTop = below.y0 + 10;
  const belowRoom = Math.max(0, cap.y - 20 - belowTop);
  if (belowRoom >= needH) return { top: belowTop, zone: "below", hideCaptions: false };
  // Kein Platz neben dem Untertitel-Band: Effekt nutzt das Band, Untertitel pausieren solange
  return { top: Math.max(belowTop, Math.min(1470 - needH, below.y0 + 10)), zone: "below", hideCaptions: true };
}

function brandFace(theme) {
  return theme && theme.fontFile ? "@font-face{font-family:'Marke';font-weight:100 900;src:url('fonts/" + theme.fontFile.replace(/'/g, "") + "')}" : "";
}
function fontFaces() {
  return "@font-face{font-family:'Poppins';font-weight:600;src:url('fonts/Poppins-SemiBold.ttf')}" +
    "@font-face{font-family:'Poppins';font-weight:800;src:url('fonts/Poppins-ExtraBold.ttf')}" +
    "@font-face{font-family:'Poppins';font-weight:900;src:url('fonts/Poppins-Black.ttf')}" +
    "@font-face{font-family:'DM Serif Display';src:url('fonts/DMSerifDisplay-Regular.ttf')}";
}

// Ein Effekt -> HTML-Komposition (Dauer d, Zeiten relativ zum Effektbeginn)
function compose(fx, d, place, theme) {
  const accent = theme.accent || "#E6007E";
  const ink = "#1A1F3D";
  const top = place.top;
  let body = "", script = "", css = "";
  if (fx.type === "checkliste") {
    const items = (fx.punkte || []).slice(0, 4);
    css = ".card{position:absolute;left:80px;right:80px;top:" + top + "px;padding:34px 40px;border-radius:34px;background:rgba(255,255,255,.94);box-shadow:0 30px 80px rgba(26,31,61,.28);opacity:0}" +
      ".eb{font-weight:800;font-size:26px;letter-spacing:.14em;color:" + accent + ";text-transform:uppercase;margin-bottom:14px}" +
      ".row{display:flex;align-items:center;gap:22px;padding:13px 0;font-weight:800;font-size:44px;color:" + ink + ";opacity:.3}" +
      ".box{width:52px;height:52px;border-radius:15px;border:4px solid " + accent + ";display:grid;place-items:center;flex:none}" +
      ".tk{width:28px;height:28px;background:" + accent + ";border-radius:8px;transform:scale(0)}";
    body = "<div class='card' id='c'>" + (fx.titel ? "<div class='eb'>" + esc(fx.titel) + "</div>" : "") +
      items.map((p, i) => "<div class='row' id='r" + i + "'><div class='box'><div class='tk'></div></div><span>" + esc(p.text) + "</span></div>").join("") + "</div>";
    script = "tl.fromTo('#c',{opacity:0,y:40,scale:.96},{opacity:1,y:0,scale:1,duration:.35,ease:'back.out(1.6)'},0.02);" +
      items.map((p, i) => { const t = Math.max(0.35, Math.min(d - 0.6, Number(p.at) || (0.5 + i * 0.7))); return "tl.to('#r" + i + "',{opacity:1,duration:.15}," + (t - 0.1).toFixed(2) + ");tl.to('#r" + i + " .tk',{scale:1,duration:.22,ease:'back.out(3)'}," + t.toFixed(2) + ");"; }).join("") +
      "tl.to('#c',{opacity:0,y:-30,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "zahl") {
    const val = Number(String(fx.wert).replace(/[^\d.,-]/g, "").replace(/\./g, "").replace(",", ".")) || 0;
    css = ".num{position:absolute;left:0;right:0;top:" + top + "px;text-align:center;opacity:0}" +
      ".big{font-weight:900;font-size:200px;line-height:1;color:#fff;text-shadow:0 10px 40px rgba(0,0,0,.45);letter-spacing:-.02em}" +
      ".lbl{display:inline-block;margin-top:16px;background:" + accent + ";color:#fff;font-weight:800;font-size:40px;padding:10px 26px;border-radius:999px}";
    body = "<div class='num' id='n'><div class='big'><span>" + esc(fx.praefix || "") + "</span><span id='v'>0</span><span>" + esc(fx.suffix || "") + "</span></div>" + (fx.label ? "<div class='lbl'>" + esc(fx.label) + "</div>" : "") + "</div>";
    const dec = /[.,]\d/.test(String(fx.wert)) && val % 1 !== 0 ? 1 : 0;
    script = "tl.fromTo('#n',{opacity:0,scale:.8},{opacity:1,scale:1,duration:.3,ease:'back.out(2)'},0.02);" +
      "const c={v:0};tl.to(c,{v:" + val + ",duration:" + Math.min(1.3, d - 0.8).toFixed(2) + ",ease:'power2.out',onUpdate:()=>{document.getElementById('v').textContent=c.v.toLocaleString('" + (theme.locale || "de-DE") + "',{minimumFractionDigits:" + dec + ",maximumFractionDigits:" + dec + "});}},0.15);" +
      "tl.to('#n',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "kommentar") {
    const word = String(fx.stichwort || "").slice(0, 24);
    css = ".cm{position:absolute;left:70px;right:70px;top:" + top + "px;opacity:0}" +
      ".bb{display:flex;gap:22px;align-items:flex-start;background:#fff;border-radius:30px;padding:26px 30px;box-shadow:0 24px 60px rgba(0,0,0,.25)}" +
      ".av{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#F5A0C4," + accent + ");flex:none}" +
      ".who{font-weight:800;font-size:30px;color:" + ink + "}.tx{font-size:44px;font-weight:600;color:" + ink + ";min-height:54px}" +
      ".rp{margin:20px 0 0 90px;opacity:0}.rp .bb{background:" + accent + "}.rp .who,.rp .tx{color:#fff}";
    body = "<div class='cm' id='cm'><div class='bb'><div class='av'></div><div><div class='who'>" + esc(fx.wer || "deine_followerin") + "</div><div class='tx' id='ty'></div></div></div>" +
      "<div class='rp' id='rp'><div class='bb'><div class='av' style='background:#fff'></div><div><div class='who'>" + esc(fx.du || "Du") + "</div><div class='tx'>" + esc(fx.antwort || "Schau in deine Nachrichten") + "</div></div></div></div></div>";
    script = "tl.fromTo('#cm',{opacity:0,y:30},{opacity:1,y:0,duration:.3},0.02);" +
      "const w=" + JSON.stringify(word) + ";const ty={n:0};tl.to(ty,{n:w.length,duration:" + Math.min(0.7, 0.08 * word.length + 0.2).toFixed(2) + ",ease:'none',onUpdate:()=>{document.getElementById('ty').textContent=w.slice(0,Math.round(ty.n));}},0.3);" +
      "tl.fromTo('#rp',{opacity:0,y:20},{opacity:1,y:0,duration:.3,ease:'back.out(2)'}," + Math.min(d - 1, 1.2).toFixed(2) + ");" +
      "tl.to('#cm',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "karte") {
    css = ".k{position:absolute;left:90px;right:90px;top:" + top + "px;padding:30px 36px;border-radius:30px;background:" + accent + ";color:#fff;box-shadow:0 24px 60px rgba(0,0,0,.25);opacity:0}" +
      ".kt{font-weight:800;font-size:28px;letter-spacing:.12em;text-transform:uppercase;opacity:.85;margin-bottom:8px}.kx{font-weight:800;font-size:50px;line-height:1.15}";
    body = "<div class='k' id='k'>" + (fx.titel ? "<div class='kt'>" + esc(fx.titel) + "</div>" : "") + "<div class='kx'>" + esc(fx.text || "") + "</div></div>";
    script = "tl.fromTo('#k',{opacity:0,y:30,rotation:-2},{opacity:1,y:0,rotation:0,duration:.35,ease:'back.out(1.8)'},0.02);tl.to('#k',{opacity:0,y:-20,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  }
  else if (fx.type === "zitat") {
    css = ".q{position:absolute;left:80px;right:80px;top:" + top + "px;padding:44px 46px 40px;border-radius:30px;background:rgba(255,250,246,.95);box-shadow:0 26px 70px rgba(26,31,61,.25);opacity:0}" +
      ".qm{font-family:'DM Serif Display',Georgia,serif;font-size:150px;line-height:.6;color:" + accent + ";height:56px}.qt{font-family:'DM Serif Display',Georgia,serif;font-size:56px;line-height:1.15;color:" + ink + "}.qa{margin-top:16px;font-weight:800;font-size:28px;color:" + accent + ";letter-spacing:.06em;text-transform:uppercase}";
    body = "<div class='q' id='q'><div class='qm'>\u201C</div><div class='qt'>" + esc(fx.text || "") + "</div>" + (fx.titel ? "<div class='qa'>" + esc(fx.titel) + "</div>" : "") + "</div>";
    script = "tl.fromTo('#q',{opacity:0,y:30,scale:.97},{opacity:1,y:0,scale:1,duration:.4,ease:'power3.out'},0.02);tl.to('#q',{opacity:0,y:-20,duration:.3}," + (d - 0.35).toFixed(2) + ");";
  } else if (fx.type === "kapitel") {
    css = ".ch{position:absolute;left:70px;top:" + top + "px;display:flex;align-items:center;gap:22px;opacity:0}.cn{width:110px;height:110px;border-radius:30px;background:" + accent + ";color:#fff;font-weight:900;font-size:64px;display:grid;place-items:center;box-shadow:0 18px 44px rgba(0,0,0,.25)}" +
      ".ct{background:#fff;color:" + ink + ";font-weight:800;font-size:46px;padding:20px 30px;border-radius:24px;box-shadow:0 18px 44px rgba(0,0,0,.2)}";
    body = "<div class='ch' id='ch'><div class='cn' id='cn'>" + esc(fx.nummer || "1") + "</div><div class='ct' id='ct'>" + esc(fx.titel || "") + "</div></div>";
    script = "tl.set('#ch',{opacity:1},0);tl.fromTo('#cn',{scale:0,rotation:-20},{scale:1,rotation:0,duration:.35,ease:'back.out(2.2)'},0.02);tl.fromTo('#ct',{opacity:0,x:-40},{opacity:1,x:0,duration:.35,ease:'power3.out'},0.18);tl.to('#ch',{opacity:0,x:-30,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "diagramm") {
    css = ".ga{position:absolute;left:80px;right:80px;top:" + top + "px;padding:30px 34px;border-radius:30px;background:rgba(255,255,255,.94);box-shadow:0 26px 70px rgba(26,31,61,.25);opacity:0}" +
      ".gt{font-weight:800;font-size:30px;color:" + ink + ";margin-bottom:10px}.gv{font-weight:900;font-size:56px;color:" + accent + "}svg{display:block;width:100%;height:260px}";
    body = "<div class='ga' id='ga'><div class='gt'>" + esc(fx.titel || "") + " <span class='gv' id='gv'></span></div><svg viewBox='0 0 840 260' preserveAspectRatio='none'><path id='gl' d='M10 240 C 160 230, 260 215, 380 190 S 600 120, 830 18' fill='none' stroke='" + accent + "' stroke-width='12' stroke-linecap='round'/><circle id='gd' cx='830' cy='18' r='18' fill='" + accent + "' opacity='0'/></svg></div>";
    script = "const P=document.getElementById('gl');const L=P.getTotalLength();P.style.strokeDasharray=L;P.style.strokeDashoffset=L;" +
      "tl.fromTo('#ga',{opacity:0,y:30},{opacity:1,y:0,duration:.35},0.02);tl.to(P,{strokeDashoffset:0,duration:" + Math.min(1.4, d - 1).toFixed(2) + ",ease:'power2.in'},0.25);tl.to('#gd',{opacity:1,duration:.1}," + Math.min(1.65, d - 0.75).toFixed(2) + ");" +
      "tl.fromTo('#gd',{attr:{r:8}},{attr:{r:18},duration:.25,ease:'back.out(3)'}," + Math.min(1.65, d - 0.75).toFixed(2) + ");tl.call(()=>{document.getElementById('gv').textContent=" + JSON.stringify(String(fx.wert || "")) + ";},null," + Math.min(1.7, d - 0.7).toFixed(2) + ");" +
      "tl.to('#ga',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "vergleich") {
    css = ".vg{position:absolute;left:60px;right:60px;top:" + top + "px;display:grid;grid-template-columns:1fr 1fr;gap:18px}.vc{border-radius:28px;padding:28px 26px;box-shadow:0 22px 60px rgba(0,0,0,.22);opacity:0}" +
      ".v1{background:rgba(255,255,255,.92);color:#6b6f80}.v2{background:" + accent + ";color:#fff}.vh{font-weight:900;font-size:28px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:10px}.vx{font-weight:800;font-size:42px;line-height:1.15}";
    body = "<div class='vg'><div class='vc v1' id='v1'><div class='vh'>✕ " + esc(fx.titel || "Vorher") + "</div><div class='vx'>" + esc(fx.vorher || "") + "</div></div><div class='vc v2' id='v2'><div class='vh'>✓ " + esc(fx.titel2 || "Nachher") + "</div><div class='vx'>" + esc(fx.nachher || "") + "</div></div></div>";
    script = "tl.fromTo('#v1',{opacity:0,x:-40},{opacity:1,x:0,duration:.35,ease:'power3.out'},0.02);tl.fromTo('#v2',{opacity:0,x:40,scale:.95},{opacity:1,x:0,scale:1,duration:.4,ease:'back.out(1.8)'}," + Math.min(1.1, d / 3).toFixed(2) + ");tl.to('#v1,#v2',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "nachricht") {
    const msgs = (fx.nachrichten || []).slice(0, 3);
    css = ".ms{position:absolute;left:70px;right:70px;top:" + top + "px;display:grid;gap:14px}.m{max-width:78%;padding:20px 26px;border-radius:30px;font-weight:600;font-size:40px;line-height:1.2;box-shadow:0 16px 40px rgba(0,0,0,.2);opacity:0}" +
      ".m.a{background:#fff;color:" + ink + ";justify-self:start;border-bottom-left-radius:8px}.m.b{background:" + accent + ";color:#fff;justify-self:end;border-bottom-right-radius:8px}";
    body = "<div class='ms'>" + msgs.map((m, i) => "<div class='m " + (i % 2 ? "b" : "a") + "' id='m" + i + "'>" + esc(m) + "</div>").join("") + "</div>";
    script = msgs.map((m, i) => "tl.fromTo('#m" + i + "',{opacity:0,y:24,scale:.92},{opacity:1,y:0,scale:1,duration:.3,ease:'back.out(2)'}," + (0.05 + i * Math.max(0.6, (d - 1) / Math.max(1, msgs.length))).toFixed(2) + ");").join("") +
      "tl.to('.m',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "emoji") {
    css = ".em{position:absolute;left:0;right:0;top:" + top + "px;text-align:center;font-size:230px;line-height:1;opacity:0;font-family:'Noto Color Emoji',sans-serif}";
    body = "<div class='em' id='em'>" + esc(fx.emoji || "✨") + "</div>";
    script = "tl.fromTo('#em',{opacity:0,scale:.3,rotation:-25},{opacity:1,scale:1,rotation:0,duration:.35,ease:'back.out(3)'},0.02);tl.to('#em',{rotation:8,duration:.18,yoyo:true,repeat:1},0.4);tl.to('#em',{opacity:0,scale:.6,duration:.22}," + (d - 0.25).toFixed(2) + ");";
  }
  else if (fx.type === "hinter") {
    // Riesige Wörter hinter der Person, wechseln auf dem gesagten Wort
    const ws = (fx.woerter || []).slice(0, 3); const head = theme.head || { top: 350, chin: 640 };
    const cy = Math.max(380, Math.round((head.top + head.chin) / 2) - 40);
    css = ".hw{position:absolute;left:0;right:0;top:" + (cy - 170) + "px;height:340px;display:grid;place-items:center;opacity:0}" +
      ".hw span{font-weight:900;font-size:300px;line-height:.9;letter-spacing:-.03em;text-transform:uppercase;color:" + accent + ";text-align:center;white-space:nowrap}";
    body = ws.map((w, i) => "<div class='hw' id='h" + i + "'><span id='hs" + i + "'>" + esc(w.text) + "</span></div>").join("");
    script = "document.querySelectorAll('.hw span').forEach(s=>{const k=Math.min(1,1000/s.scrollWidth);s.style.fontSize=Math.round(300*k)+'px';});" +
      ws.map((w, i) => { const at = Math.max(0.05, Math.min(d - 0.4, Number(w.at) || i * 0.9)); const next = i + 1 < ws.length ? Math.max(at + 0.3, Number(ws[i + 1].at) || (i + 1) * 0.9) : d - 0.25;
        return "tl.fromTo('#h" + i + "',{opacity:0,scale:1.25},{opacity:1,scale:1,duration:.18,ease:'power3.out'}," + at.toFixed(2) + ");tl.to('#h" + i + "',{opacity:0,duration:.12}," + Math.max(at + 0.2, next - 0.06).toFixed(2) + ");"; }).join("");
  } else if (fx.type === "lichtaus") {
    const head = theme.head || { top: 350, chin: 640 };
    const cy = Math.max(380, Math.round((head.top + head.chin) / 2) - 60);
    css = ".la{position:absolute;left:0;right:0;top:" + (cy - 170) + "px;height:340px;display:grid;place-items:center;opacity:0}.la span{font-weight:900;font-size:300px;line-height:.9;letter-spacing:-.03em;text-transform:uppercase;color:#fff;text-shadow:0 0 50px " + accent + ";white-space:nowrap}";
    body = "<div class='la' id='la'><span id='las'>" + esc(fx.text || "") + "</span></div>";
    script = "(function(){const s=document.getElementById('las');const k=Math.min(1,1000/s.scrollWidth);s.style.fontSize=Math.round(300*k)+'px';})();" +
      "tl.fromTo('#la',{opacity:0,scale:1.3},{opacity:1,scale:1,duration:.16,ease:'power4.out'}," + Math.max(0.25, Math.min(d - 0.8, Number(fx.at) || d * 0.45)).toFixed(2) + ");tl.to('#la',{opacity:0,duration:.12}," + (d - 0.2).toFixed(2) + ");";
  } else if (fx.type === "popout") {
    css = ".po{position:absolute;left:60px;right:60px;top:250px;text-align:center;opacity:0}.po span{display:inline-block;background:#fff;color:" + ink + ";font-weight:900;font-size:52px;padding:14px 26px;border-radius:20px;box-shadow:0 14px 40px rgba(0,0,0,.25)}";
    body = fx.titel ? "<div class='po' id='po'><span>" + esc(fx.titel) + "</span></div>" : "";
    script = fx.titel ? "tl.fromTo('#po',{opacity:0,y:-20},{opacity:1,y:0,duration:.3,ease:'back.out(2)'},0.2);tl.to('#po',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");" : "";
  } else if (fx.type === "spotlight") {
    const head = theme.head || { top: 350 };
    css = ".sp{position:absolute;left:40px;right:40px;top:" + Math.max(240, head.top - 230) + "px;text-align:center;opacity:0}.sp span{font-weight:900;font-size:120px;line-height:1;color:#fff;text-shadow:0 0 40px " + accent + "}";
    body = "<div class='sp' id='sp'><span>" + esc(fx.text || "") + "</span></div>";
    script = "tl.fromTo('#sp',{opacity:0,y:20,scale:.9},{opacity:1,y:0,scale:1,duration:.3,ease:'back.out(2)'}," + Math.min(0.6, d / 3).toFixed(2) + ");tl.to('#sp',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");";
  } else if (fx.type === "greenscreen") {
    css = ".gs{position:absolute;left:60px;right:60px;top:250px;padding:26px 30px;border-radius:26px;background:rgba(255,255,255,.94);opacity:0}.gs b{display:block;font-weight:900;font-size:58px;line-height:1.1;color:" + ink + "}.gs small{display:block;margin-top:8px;font-weight:700;font-size:30px;color:" + accent + "}";
    body = fx.titel ? "<div class='gs' id='gs'><b>" + esc(fx.titel) + "</b>" + (fx.text ? "<small>" + esc(fx.text) + "</small>" : "") + "</div>" : "";
    script = fx.titel ? "tl.fromTo('#gs',{opacity:0,y:-20},{opacity:1,y:0,duration:.35},0.15);tl.to('#gs',{opacity:0,duration:.25}," + (d - 0.3).toFixed(2) + ");" : "";
  }
  return "<!doctype html><html><head><meta charset='utf-8'><style>html,body{margin:0;background:transparent}" + fontFaces() + brandFace(theme) +
    "#root{position:relative;width:" + W + "px;height:" + H + "px;overflow:hidden;background:transparent;font-family:" + (theme.fontFile ? "'Marke'," : "") + "'Poppins',system-ui,sans-serif}" + css +
    "</style></head><body><div id='root' data-composition-id='root' data-width='" + W + "' data-height='" + H + "' data-start='0' data-duration='" + d.toFixed(2) + "'>" + body +
    "<script src='gsap.min.js'></script><script>const tl=gsap.timeline({paused:true});" + script + "window.__timelines=window.__timelines||{};window.__timelines['root']=tl;</script></div></body></html>";
}

// Höhe, die ein Effekt ungefähr braucht (für die Platzierung)
function neededHeight(fx) {
  if (fx.type === "checkliste") return 120 + 78 * Math.min(4, (fx.punkte || []).length) + (fx.titel ? 50 : 0);
  if (fx.type === "zahl") return fx.label ? 300 : 220;
  if (fx.type === "kommentar") return 300;
  if (fx.type === "zitat") return 120 + 70 * Math.ceil(String(fx.text || "").length / 26);
  if (fx.type === "kapitel") return 130;
  if (fx.type === "diagramm") return 380;
  if (fx.type === "vergleich") return 110 + 52 * Math.ceil(Math.max(String(fx.vorher || "").length, String(fx.nachher || "").length) / 14);
  if (fx.type === "nachricht") return 30 + 120 * Math.min(3, (fx.nachrichten || []).length);
  if (fx.type === "emoji") return 240;
  if (fx.type === "gif") return Math.round(620 * (Number(fx.h) || 270) / (Number(fx.w) || 480)) + 16;
  return 180;
}

// Effekte aus Wort-Markierungen in Zeiten des geschnittenen Reels umrechnen
function planEffects(effects, words, map, layout) {
  const out = [];
  let lastEnd = -1;
  for (const fx of (effects || []).slice(0, 3)) {
    if (!EFFECTS[fx.type] || fx.off || (fx.type === "gif" && !fx.mp4)) continue;
    const startW = words[fx.von] || words[fx.wort];
    if (!startW || startW.cut) continue;
    const endW = words[fx.bis] || startW;
    let t0 = Math.max(0, map(startW.s) - 0.1);
    let t1 = Math.max(t0 + EFFECTS[fx.type].minDur, map(endW.e) + 1.2);
    t1 = Math.min(t1, t0 + EFFECTS[fx.type].maxDur, map.total - 0.05);
    if (t0 < lastEnd + 0.3) { // nie überlappen: kurz nach hinten schieben, solange der Satz noch läuft
      t0 = lastEnd + 0.3;
      t1 = Math.min(Math.max(t1, t0 + EFFECTS[fx.type].minDur), t0 + EFFECTS[fx.type].maxDur, map.total - 0.05);
      if (t0 > map(endW.e) + 0.3) continue;
    }
    if (t1 - t0 < 1.2) continue;
    const place = placement(layout, neededHeight(fx));
    const copy = Object.assign({}, fx);
    if (fx.type === "checkliste") copy.punkte = (fx.punkte || []).map(p => ({ text: p.text, at: words[p.wort] && !words[p.wort].cut ? map(words[p.wort].s) - t0 : null }));
    if (fx.type === "lichtaus" && words[fx.bis] && !words[fx.bis].cut) copy.at = map(words[fx.bis].s) - t0;
    if (fx.type === "hinter") copy.woerter = (fx.woerter || []).map(w => ({ text: w.text, at: words[w.wort] && !words[w.wort].cut ? map(words[w.wort].s) - t0 : null }));
    out.push({ fx: copy, t0, t1, d: t1 - t0, place });
    lastEnd = t1;
  }
  return out;
}

// Projektordner für einen Effekt schreiben (HTML + GSAP + Schriften)
function writeProject(dir, item, theme, assetsDir) {
  fs.mkdirSync(path.join(dir, "fonts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), compose(item.fx, item.d, item.place, theme));
  fs.copyFileSync(path.join(assetsDir, "gsap.min.js"), path.join(dir, "gsap.min.js"));
  for (const f of ["Poppins-SemiBold.ttf", "Poppins-ExtraBold.ttf", "Poppins-Black.ttf", "DMSerifDisplay-Regular.ttf"].concat(theme.fontFile ? [theme.fontFile] : [])) {
    const src = path.join(assetsDir, "fonts", f); if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, "fonts", f));
  }
}

module.exports = { EFFECTS, CUTOUT, planEffects, compose, writeProject, placement };
