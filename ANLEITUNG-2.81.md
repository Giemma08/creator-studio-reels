# Reel-Editor 2.81: Raum-Wechsel

## Was neu ist

Im Reel-Editor gibt es unter **Effekte** einen neuen Bereich **🏠 Raum-Wechsel**. Damit setzt KIRA dich hinter einen anderen Hintergrund, ohne dass du anders filmst. Du sitzt vor deiner Wand, und im fertigen Reel bist du in Räumen im Look deiner Marke, auch mehrere nacheinander.

**Neuen Raum erstellen:**
- Es gibt fünf Vorlagen: Ruhiges Studio, Salon, Arbeitsplatz, Leseecke und Fensterlicht. KIRA beschreibt den Raum mit den Farben und dem Fotostil aus **Meine Brand → Dein Look**.
- Du kannst auch einen eigenen Wunsch eingeben, zum Beispiel „Küche mit Kräutern am Fenster“.
- Jeder neue Raum kostet einmalig **6 Credits**, wie ein KI-Bild.
- Danach liegt er in der **Raum-Bibliothek** und steht in jedem Reel wieder zur Verfügung. Die Bibliothek fasst höchstens 40 Räume.

**Räume im Reel nutzen:**
- **Ausgewählten Raum ab hier:** Der Raum gilt ab der aktuellen Stelle bis zum nächsten Raum, höchstens 20 Sekunden.
- **Auf das ganze Reel verteilen:** Mehrere Räume antippen, die Nummern legen die Reihenfolge fest. KIRA teilt das Reel in gleich lange Abschnitte und wechselt den Raum. Ein Abschnitt dauert höchstens 20 Sekunden.
- **Eigenes Raumfoto hochladen** geht auch.
- **Text für Runway kopieren:** Wer statt KIRA die Video-KI Runway nutzen möchte, bekommt dort die passende Beschreibung. Runway passt das Licht realistischer an, kostet aber extra.

**Kosten im Reel:** Jeder Raum-Abschnitt ist ein Profi-Effekt wie „Bildwand hinter dir“, also **8 Credits pro Abschnitt** beim Erstellen. Klappt ein Abschnitt nicht, gibt es die Credits wie bisher zurück.

**Andere Effekte:**
- Grafik-Effekte wie Zahl, Info-Karte oder Zitat laufen weiterhin **über** dem Raum.
- Andere Profi-Effekte wie Spotlight oder Pop-out können nicht gleichzeitig mit einem Raum laufen und werden in diesem Abschnitt weggelassen.
- Insgesamt sind jetzt bis zu 8 Effekte pro Reel möglich, vorher waren es 4.

**Ohne Raum-Wechsel bleibt alles wie vorher.** Ich habe die Zeitplanung der Effekte mit 3000 zufälligen Kombinationen gegen die alte Version geprüft, das Ergebnis war jedes Mal gleich.

## Was die Werkstatt dafür nutzt

Die Freistellung läuft wie bei „Bildwand hinter dir“ über Replicate, nur für die gewählten Abschnitte. Der Raum wird leicht unscharf gezeigt, wie bei einer echten Kamera mit wenig Schärfentiefe, und die Kante um dich herum wird weich verblendet.

**Ehrlicher Hinweis zur Qualität:** Das Licht auf dir bleibt das Licht aus deiner Aufnahme. Am natürlichsten wirkt es mit weichem Tageslicht von vorn, mit Stativ und mit etwas Abstand zur Wand. Haare vor einer unruhigen Wand sind am schwierigsten.

## Geänderte Dateien

`index.js`, `ui.js`, `effects.cjs`, `cutout.cjs`, `server.cjs`. Alle anderen Dateien sind unverändert. Du kannst aber wie gewohnt alle ersetzen.

## Einspielen

1. In GitHub das Repository `creator-studio-reels` öffnen.
2. **Alle Dateien aus diesem Paket hochladen** und die vorhandenen ersetzen. Das geht über „Add file → Upload files“, dort alles hineinziehen und mit „Commit changes“ bestätigen.
3. Der Deploy startet von selbst. Er dauert wegen des Container-Baus zwei bis drei Minuten.
4. In Supabase musst du nichts ändern. Die Raum-Erstellung nutzt die vorhandene Credit-Aktion `ki_bild`.
5. Prüfen:
   - Ein Reel öffnen und unter **Effekte → Raum-Wechsel** einen Raum erstellen.
   - Ihn mit „Ab hier“ oder „Auf das ganze Reel verteilen“ einsetzen.
   - Das Reel erstellen.
