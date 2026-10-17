[English](README.md) · **Deutsch** · [中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

Synchronisiere Schritte, Schlaf, Herzfrequenz, Stress, Aktivitäten und mehr automatisch von Garmin Connect in Obsidian Daily Notes — als Frontmatter-Properties, die du mit Dataview abfragen kannst.

> **Funktioniert auf Desktop und Mobilgeräten** (Windows, macOS, Linux, iOS, Android). Dieses Plugin nutzt Garmins interne API — es gibt keine offizielle Drittanbieter-API. Du meldest dich mit deiner Garmin-E-Mail und deinem Passwort an (bei Bestätigung in zwei Schritten zusätzlich mit dem Bestätigungscode). Blockiert Garmin diesen Versuch, steht eine alternative Browser-Anmeldung zur Verfügung.

## Funktionen

- **Auto-Sync beim Start** — prüft die letzten 7 Tage und ergänzt fehlende Gesundheitsdaten
- **Auf-Note-warten-Modus** — der Auto-Sync kann optional warten, bis ein anderes Tool (Templater, Calendar, ein externer Sync) die Daily Note anlegt, statt sie selbst zu erstellen
- **Manueller Sync** — synchronisiere jede geöffnete Daily Note über die Befehlspalette
- **Backfill** — Massen-Sync eines Zeitraums (z.B. die letzten 3 Monate)
- **20+ Metriken** — Schritte, Schlaf-Score, HRV, Stress, Body Battery, SpO2, Gewicht und mehr
- **Aktivitäts-Tracking** — jedes Workout erscheint als gut lesbare Zusammenfassung
- **Workout-Standort** — per Reverse-Geocoding ermittelter Ortsname deiner ersten GPS-Aktivität
- **Intelligente Erkennung** — erkennt automatisch deinen Daily-Notes-Pfad und das Format aus Periodic Notes oder dem eingebauten Daily Notes Plugin
- **Unterordner-Unterstützung** — findet bestehende Daily Notes in verschachtelten Ordnern (z.B. `Journal/2024-07/`) und legt datumsbasierte Unterordner an, wenn das Dateinamen-Format ein `/` enthält (z.B. `YYYY/YYYY-MM-DD` → `Journal/2026/2026-08-04.md`)
- **Automatische Spracherkennung** — die UI-Sprache wird aus deiner Obsidian-Sprache übernommen (EN, DE, ZH, JA, ES, FR)
- **Optionale strukturierte Daten** — maschinenlesbares `trainings`-Feld für erweiterte Dataview-Abfragen

## Frontmatter-Ausgabe

### Metriken

```yaml
---
steps: 15185
resting_hr: 69
sleep_score: 81
sleep_duration: 7h 43min
hrv: 39
stress: 30
vo2_max: 48
workout_location: Bad Honnef, Deutschland
---
```

**Body Battery:** `body_battery` ist Garmins *charged*-Wert, also die Summe aller Body-Battery-Zuwächse des Tages (überwiegend die nächtliche Aufladung), nicht der aktuelle Stand. Für den Tiefst- und Höchststand des Tages, wie ihn die Garmin-App im Verlauf zeigt, `body_battery_min` und `body_battery_max` aktivieren.

### Aktivitäten

Jedes Workout wird als Frontmatter-Key mit einer Zusammenfassungs-Zeichenkette geschrieben:

```yaml
---
hiking: 8.2 km · 157min · Ø105 bpm · 696 kcal
e_bike: 22.1 km · 65min · Ø112 bpm · 420 kcal
---
```

Nur Tage mit tatsächlichen Workouts erhalten Aktivitäts-Keys — das Plugin überschreibt niemals bestehende Inhalte deiner Notizen.

### Trainings (optional, maschinenlesbar)

Aktiviere "Maschinenlesbare Trainings" in den Einstellungen, um ein strukturiertes `trainings`-Feld für Dataview-Abfragen hinzuzufügen:

```yaml
---
trainings:
  - type: hiking
    category: outdoor
    distance_km: 8.2
    duration_min: 157
    avg_hr: 105
    calories: 696
  - type: e_bike
    category: cycling
    distance_km: 22.1
    duration_min: 65
    avg_hr: 112
    calories: 420
---
```

## Voraussetzungen

- **Obsidian** unter Windows, macOS, Linux, iOS oder Android
- **Garmin-Konto** mit Zugriff auf Garmin Connect
- **Daily Notes** oder **Periodic Notes** aktiviert (oder den Pfad manuell in den Einstellungen konfigurieren)

## Installation

### Über Community Plugins (empfohlen)

1. Öffne Obsidian-Einstellungen → Community Plugins → Durchsuchen
2. Suche nach "Garmin Health Sync"
3. Installiere und aktiviere das Plugin
4. Melde dich in den Plugin-Einstellungen bei Garmin Connect an

### Manuell

1. Lade `main.js` und `manifest.json` vom [neuesten Release](https://github.com/fcandi/garmin-health-sync/releases) herunter
2. Erstelle den Ordner `.obsidian/plugins/garmin-health-sync/` in deinem Vault
3. Kopiere beide Dateien in diesen Ordner
4. Aktiviere das Plugin unter Einstellungen → Community Plugins

## Verwendung

### Anmelden

Öffne die Plugin-Einstellungen und wähle **Garmin Connect**, dann gib deine Garmin-E-Mail und dein Passwort ein (und den Bestätigungscode, falls du die Bestätigung in zwei Schritten nutzt). Die Anmeldung funktioniert am Desktop und auf Mobilgeräten gleich.

Garmin kann wiederholte Anmeldeversuche von einem Gerät begrenzen; das Plugin zeigt dann einen Countdown bis zum nächsten Versuch. Ist die Anmeldung blockiert, nutze stattdessen **Browser-Anmeldung verwenden**: Du meldest dich auf Garmins Seite im Browser an, kopierst den Seitentext mit `ST-…` und tippst im Plugin auf die Schaltfläche für die Zwischenablage (oder fügst ihn ins Feld ein). Nach der Anmeldung erneuert das Plugin die Verbindung selbstständig, du musst dich nur selten erneut anmelden.

### Wo die Notizen liegen

Der **Daily-Notes-Pfad** ist der Ordner, das **Daily-Note-Format** der Dateiname in [moment.js](https://momentjs.com/docs/#/displaying/format/)-Syntax — dieselbe Konvention wie im eingebauten Daily Notes Plugin. Das Format darf selbst ein `/` enthalten und die Notizen so in datumsbasierte Unterordner legen; eckige Klammern übernehmen Text wörtlich:

| Pfad | Format | Ergebnis |
| --- | --- | --- |
| `Journal` | `YYYY-MM-DD` | `Journal/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM-DD` | `Journal/2026/2026-08-04.md` |
| `Journal` | `YYYY/YYYY-MM/YYYY-MM-DD` | `Journal/2026/2026-08/2026-08-04.md` |
| `Journal` | `YYYY-MM-DD [Workout]` | `Journal/2026-08-04 Workout.md` |

Fehlende Unterordner werden automatisch angelegt.

### Auto-Sync

Bei jedem Obsidian-Start prüft das Plugin die letzten 7 Tage und ergänzt fehlende Gesundheitsdaten automatisch. Kein manuelles Zutun nötig. Standardmäßig legt es eine fehlende Daily Note selbst an.

Wenn ein anderes Tool deine Daily Notes verwaltet (Templater, das Calendar-Plugin, ein externer Sync), deaktiviere **Daily Note bei Bedarf anlegen** in den Einstellungen. Der Auto-Sync wartet dann, bis eine echte (nicht-leere) Daily Note existiert, und synchronisiert, sobald sie auftaucht — leere 0-Byte-Platzhalter werden ignoriert. Manueller Sync und Backfill legen fehlende Notes unabhängig von dieser Einstellung immer an.

### Manueller Sync

Öffne eine Daily Note und führe **Garmin Health Sync: Aktuelle Notiz synchronisieren** über die Befehlspalette (Cmd/Ctrl+P) aus.

### Historische Daten nachträglich auffüllen (Backfill)

Du hast jahrelange Garmin-Daten? Du kannst einen beliebigen Zeitraum auf einmal synchronisieren:

1. Öffne die Befehlspalette (Cmd/Ctrl+P)
2. Suche nach **„Gesundheitsdaten nachträglich auffüllen"**
3. Wähle ein Start- und Enddatum
4. Das Plugin holt alle Daten für diesen Zeitraum mit Rate-Limiting, um API-Drosselung zu vermeiden

## Normalisierung der Aktivitäts-Keys

Garmins `typeKey`-Werte werden zu sauberen kanonischen Keys normalisiert:

| Provider Key | Kanonischer Key | Kategorie |
|---|---|---|
| `e_bike_fitness` | `e_bike` | cycling |
| `e_bike_mountain` | `e_mtb` | cycling |
| `resort_skiing_snowboarding` | `skiing` | winter |
| `backcountry_skiing_snowboarding` | `backcountry_skiing` | winter |
| `stand_up_paddleboarding` | `sup` | water |
| `fitness_equipment` | `gym_equipment` | gym |

Alle anderen Garmin-Keys werden unverändert übernommen (z.B. `hiking`, `running`, `cycling`, `swimming`, `strength_training`, `yoga`, ...).

### Aktivitäts-Kategorien

Jeder Aktivität wird eine Kategorie zugewiesen:

| Kategorie | Beispiele |
|---|---|
| `cycling` | cycling, e_bike, e_mtb, mountain_biking, indoor_cycling, road_biking |
| `running` | running, trail_running, treadmill, ultra_run |
| `walking` | walking, indoor_walking |
| `outdoor` | hiking, mountaineering, rock_climbing, bouldering |
| `swimming` | swimming, pool_swimming, open_water_swimming |
| `winter` | skiing, backcountry_skiing, cross_country_skiing, snowboarding |
| `water` | sup, rowing, kayaking, surfing, sailing |
| `gym` | strength_training, gym_equipment, elliptical, yoga, pilates, hiit |
| `racket` | tennis, badminton, squash, table_tennis, pickleball |
| `team` | soccer, basketball, volleyball, rugby |
| `other` | golf, meditation, multi_sport |

## Datenschutz

Dieses Plugin stellt Netzwerkverbindungen zu zwei externen Diensten her:

- **Garmin Connect** — du gibst E-Mail und Passwort (und ggf. einen Bestätigungscode) im Plugin ein. Sie werden nur an Garmins Anmeldeserver gesendet (`sso.garmin.com`, bzw. `sso.garmin.cn` für China) und vom Plugin weder gespeichert noch protokolliert. Nach der Anmeldung speichert das Plugin Garmin-Anmeldetokens im Secret Storage von Obsidian. Dieser bleibt auf dem Gerät, sodass die Tokens nicht mit anderen Geräten synchronisiert und nicht in Vault-Backups oder Git aufgenommen werden. Nur wenn der Secret Storage nicht verfügbar ist oder das Schreiben ablehnt, legt das Plugin sie in `data.json` ab. Behandle diese Tokens wie ein Login: Ihre Lebensdauer bestimmt Garmin. Jedes Gerät meldet sich separat an. Blockiert oder begrenzt Garmin die Anmeldung, wird eine Browser-Anmeldung angeboten (du meldest dich auf Garmins Seite im Browser an und fügst das einmalige Ticket ein). Die öffentlichen OAuth-Client-Schlüssel werden von `thegarth.s3.amazonaws.com` geladen (mit mitgelieferten Ersatzschlüsseln, falls der Host nicht erreichbar ist). **Abmelden** löscht die gespeicherten Tokens auf diesem Gerät.
- **Nominatim (OpenStreetMap)** — wenn **Workout-Ort** aktiviert ist, werden die GPS-Koordinaten deiner ersten Aktivität zur Rückwärts-Geokodierung an `nominatim.openstreetmap.org` gesendet. Du kannst dies in den Einstellungen unter **Workout-Ort** deaktivieren.

Es werden keine Daten an andere Server gesendet.

## Entwicklung

```bash
npm install
npm run dev    # Watch-Modus
npm run build  # Produktions-Build
```
