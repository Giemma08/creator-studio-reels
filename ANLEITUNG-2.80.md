# Reel-Editor 2.80

## Warum der letzte Deploy gescheitert ist

Nicht am Code. Der Bau des Containers ist beim Schritt `npm install` abgebrochen.

Ursache: Das Paket `onnxruntime-node` (kommt indirekt über `hyperframes` mit)
lädt beim Installieren zusätzliche CUDA-Dateien für Grafikkarten herunter.
Diese Adresse antwortet inzwischen mit **404 Not Found**, und daran bricht der
ganze Bau ab. Gebraucht werden diese Dateien nicht – im Container gibt es keine
Grafikkarte.

Das ist von außen passiert, ohne Änderung an unserem Code. Deshalb lief der
Deploy am 17. November noch durch und heute nicht mehr.

## Was geändert wurde

Nur im **Dockerfile**, zwei Stellen:

- `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` als Umgebungsvariable
- `--onnxruntime-node-install-cuda=skip` an beiden `npm install`-Aufrufen

Geprüft: Mit dieser Einstellung läuft die Installation durch, 141 Pakete,
`hyperframes` und `gsap` sind vorhanden.

Dazu aus 2.79: Die Karte „Fertiges Video einplanen" steht jetzt an letzter
Stelle statt an dritter.

## Einspielen

Alle Dateien ersetzen, dann wie gewohnt pushen. Der Deploy dauert wegen des
Container-Baus wieder zwei bis drei Minuten.

## Für später, nicht dringend

In `container-package.json` sind `hyperframes` und `gsap` fest auf eine Version
gesetzt – gut. Die Pakete **darunter** sind es nicht. Mit einer mitgelieferten
`package-lock.json` und `npm ci` statt `npm install` wäre der Bau vollständig
reproduzierbar und solche Überraschungen gäbe es nicht mehr.

Dasselbe gilt für die `package.json` des Workers: dort stehen `wrangler: ^4` und
`@cloudflare/containers: ^0.3.7` ohne feste Version.
