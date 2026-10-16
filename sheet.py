#!/usr/bin/env python3
"""Kontrollbild: 6 Momente aus dem fertigen Reel nebeneinander (3 x 2), mit Zeitangabe."""
import sys, cv2, numpy as np
video, out = sys.argv[1], sys.argv[2]
times = [float(x) for x in sys.argv[3].split(",") if x][:6]
cap = cv2.VideoCapture(video)
tiles = []
for t in times:
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, img = cap.read()
    if not ok: img = np.zeros((1920, 1080, 3), np.uint8)
    img = cv2.resize(img, (300, 533))
    cv2.rectangle(img, (0, 0), (74, 26), (255, 255, 255), -1)
    cv2.putText(img, "%.1f s" % t, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (40, 30, 30), 1, cv2.LINE_AA)
    tiles.append(img)
while len(tiles) < 6: tiles.append(np.full((533, 300, 3), 245, np.uint8))
gap = np.full((533, 8, 3), 255, np.uint8)
row = lambda a: np.hstack([a[0], gap, a[1], gap, a[2]])
sheet = np.vstack([row(tiles[:3]), np.full((8, 916, 3), 255, np.uint8), row(tiles[3:6])])
cv2.imwrite(out, sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
