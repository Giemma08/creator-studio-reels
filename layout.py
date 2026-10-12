#!/usr/bin/env python3
"""Reel-Werkstatt: Wo ist die Person im Bild?

Liest ein Video (bereits auf 1080x1920 gebracht), schaut etwa 3 Bilder pro Sekunde an,
findet das Gesicht und berechnet daraus:
  - den Kopfbereich (Stirn bis Kinn) über die Zeit, geglättet
  - die freien Zonen für Untertitel und Effekte innerhalb der Instagram-Sicherheitszone
Ausgabe: JSON auf stdout.

Gesichtserkennung: YuNet (OpenCV, MIT-Lizenz), falls das Modell vorhanden ist,
sonst die in OpenCV eingebaute Erkennung als Rückfall.
"""
import json, os, sys
import cv2
import numpy as np

W, H = 1080, 1920
# Sicherheitszone für Reels: oben 220, unten bis y 1470, Seiten 35, rechts 100 ab y 1155 (Knöpfe)
SAFE = {"top": 220, "bottom": 1470, "left": 35, "right": W - 35, "right_low": W - 100, "right_low_from": 1155}
MODEL = os.environ.get("YUNET_MODEL", os.path.join(os.path.dirname(__file__), "models", "yunet.onnx"))


def detector():
    if os.path.exists(MODEL) and os.path.getsize(MODEL) > 10000:
        det = cv2.FaceDetectorYN.create(MODEL, "", (W, H), 0.6, 0.3, 50)
        def find(img):
            det.setInputSize((img.shape[1], img.shape[0]))
            _, faces = det.detect(img)
            if faces is None or not len(faces):
                return None
            f = max(faces, key=lambda r: r[2] * r[3])
            return [float(f[0]), float(f[1]), float(f[2]), float(f[3])]
        return "yunet", find
    casc = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    def find(img):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        faces = casc.detectMultiScale(g, 1.1, 6, minSize=(120, 120))
        if not len(faces):
            return None
        f = max(faces, key=lambda r: r[2] * r[3])
        return [float(v) for v in f]
    return "haar", find


def head_box(face):
    """Aus dem Gesichtsrechteck den Kopf schätzen: Haare über der Stirn, Kinn unter dem Mund."""
    x, y, w, h = face
    top = y - 0.45 * h          # Haare
    chin = y + 1.08 * h         # Kinn
    return {"x0": x - 0.12 * w, "x1": x + w * 1.12, "top": top, "chin": chin, "cx": x + w / 2, "w": w}


def analyse(path, fps_sample=3.0):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    dur = n / fps if n else 0
    kind, find = detector()
    step = max(1, int(round(fps / fps_sample)))
    samples = []
    i = 0
    while True:
        ok = cap.grab()
        if not ok:
            break
        if i % step == 0:
            ok, img = cap.retrieve()
            if ok:
                if img.shape[1] != W or img.shape[0] != H:
                    img = cv2.resize(img, (W, H))
                f = find(img)
                samples.append({"t": round(i / fps, 3), "face": f})
        i += 1
    cap.release()
    found = [s for s in samples if s["face"]]
    if not found:
        return {"detector": kind, "duration": dur, "found": False, "samples": len(samples),
                "safe": SAFE, "zones": default_zones(None), "framing": "unknown"}
    boxes = [head_box(s["face"]) for s in found]
    # robust: 85. Perzentil für das Kinn, 15. für den Kopf oben, damit Bewegung abgedeckt ist
    top = float(np.percentile([b["top"] for b in boxes], 15))
    chin = float(np.percentile([b["chin"] for b in boxes], 85))
    x0 = float(np.percentile([b["x0"] for b in boxes], 15))
    x1 = float(np.percentile([b["x1"] for b in boxes], 85))
    fw = float(np.median([b["w"] for b in boxes]))
    cx = float(np.median([b["cx"] for b in boxes]))
    # Kamerabewegung grob aus der Streuung der Kopfmitte
    spread = float(np.std([b["cx"] for b in boxes]) + np.std([b["top"] for b in boxes]))
    head = {"top": round(top), "chin": round(chin), "x0": round(x0), "x1": round(x1), "cx": round(cx), "face_w": round(fw)}
    framing = "close" if fw > 430 else "medium" if fw > 230 else "wide"
    return {"detector": kind, "duration": dur, "found": True, "coverage": round(len(found) / max(1, len(samples)), 2),
            "head": head, "framing": framing, "movement": "moving" if spread > 60 else "still",
            "safe": SAFE, "zones": default_zones(head),
            "track": [{"t": s["t"], "top": round(head_box(s["face"])["top"]), "chin": round(head_box(s["face"])["chin"]), "cx": round(head_box(s["face"])["cx"])} for s in found]}


def default_zones(head):
    """Freie Bänder für Untertitel und Effekte. Untertitel bevorzugt unter dem Kinn, sonst über dem Kopf."""
    s = SAFE
    if not head:
        return {"captions": {"y": 1180, "h": 260, "where": "unten"}, "above": {"y0": s["top"], "y1": 700}, "below": {"y0": 1100, "y1": s["bottom"]}}
    gap = 30
    below = {"y0": int(min(s["bottom"], head["chin"] + gap)), "y1": s["bottom"]}
    above = {"y0": s["top"], "y1": int(max(s["top"], head["top"] - gap))}
    cap_h = 220
    if below["y1"] - below["y0"] >= cap_h:
        # bevorzugt im unteren Drittel (ab y 1120), aber nie über das Kinn
        y = max(below["y0"], min(1120, below["y1"] - cap_h))
        cap = {"y": int(y), "h": cap_h, "where": "unter dem Kinn"}
    elif above["y1"] - above["y0"] >= cap_h:
        cap = {"y": int(above["y1"] - cap_h), "h": cap_h, "where": "über dem Kopf"}
    else:
        # Nahaufnahme: eine Zeile unten am Rand der Sicherheitszone, kleiner
        cap = {"y": int(s["bottom"] - 150), "h": 150, "where": "unten, einzeilig", "small": True}
    return {"captions": cap, "above": above, "below": below}


if __name__ == "__main__":
    print(json.dumps(analyse(sys.argv[1])))
