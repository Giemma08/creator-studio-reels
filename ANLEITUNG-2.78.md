# Reel-Editor 2.78 – Fertiges Video einplanen

## Was neu ist

In der Startauswahl des Reel-Editors gibt es eine vierte Karte: **„Fertiges Video einplanen“**.

Damit lädt deine Kundin ein Video hoch, das schon fertig ist – aus HeyGen, Canva,
CapCut oder direkt von der Kamera. Es wird **nicht geschnitten, nicht neu berechnet
und kostet keine Credits**. Danach öffnet sich die gewohnte Ansicht mit dem Video
und dem Kasten „Veröffentlichen“, über den es sofort gepostet oder in den
Postkalender eingeplant werden kann.

Vorher musste dafür einmal „Fertiges Reel erstellen“ durchlaufen – das hat einen
Durchlauf verbraucht und das Video unnötig neu gerechnet.

## Was sich technisch geändert hat

- Neue Art `fertig` bei den Reel-Aufträgen (neben `reel`, `clips`, `transcript`)
- `/api/reels/start` nimmt `kind: "fertig"` an: keine Credit-Prüfung, Größe bis zur
  Speichergrenze des Tarifs
- `/api/reels/complete` setzt bei `fertig` den Status direkt auf `done`, ohne die
  Schnitt-Werkstatt zu starten
- Das Original wird als fertiges Video ausgeliefert, damit das Einplanen greift
- `/api/reels/image` kann das Vorschaubild unter festem Namen ablegen (`as=thumb`);
  der Browser schneidet dafür ein Standbild aus dem Video
- „Fertiges Reel erstellen“ ist für diese Videos gesperrt, mit klarer Meldung

## Einspielen

Alle Dateien dieses Pakets ersetzen die bisherigen im Reel-Editor-Verzeichnis
(Worker 5). Es ist **keine Änderung an der Datenbank nötig** – die Spalte `kind`
gibt es bereits.

1. Dateien hochladen bzw. im Repository ersetzen
2. Deploy wie gewohnt (GitHub-Workflow oder `wrangler deploy`)
3. Testen: Reel-Editor öffnen → „Fertiges Video einplanen“ → ein kurzes mp4 hochladen
   → es muss ohne Wartezeit in der Ansicht mit „Veröffentlichen“ landen

## Noch offen für später

- Eigene Ansicht statt der Editor-Ansicht, in der die Schnitt-Bereiche gar nicht
  erst auftauchen
- Dasselbe für fertige Bilder und Karussells
