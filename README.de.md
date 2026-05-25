[English](README.md) · **Deutsch** · [中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

Synchronisiere Schritte, Schlaf, Herzfrequenz, Stress, Aktivitäten und mehr automatisch von Garmin Connect in Obsidian Daily Notes — als Frontmatter-Properties, die du mit Dataview abfragen kannst.

> **Nur Desktop.** Dieses Plugin nutzt Electrons BrowserWindow zur Garmin-Connect-Authentifizierung und funktioniert nicht auf Mobilgeräten.

## Funktionen

- **Auto-Sync beim Start** — prüft die letzten 7 Tage und ergänzt fehlende Gesundheitsdaten
- **Manueller Sync** — synchronisiere jede geöffnete Daily Note über die Befehlspalette
- **Backfill** — Massen-Sync eines Zeitraums (z.B. die letzten 3 Monate)
- **20+ Metriken** — Schritte, Schlaf-Score, HRV, Stress, Body Battery, SpO2, Gewicht und mehr
- **Aktivitäts-Tracking** — jedes Workout erscheint als gut lesbare Zusammenfassung
- **Workout-Standort** — per Reverse-Geocoding ermittelter Ortsname deiner ersten GPS-Aktivität
- **Intelligente Erkennung** — erkennt automatisch deinen Daily-Notes-Pfad und das Format aus Periodic Notes oder dem eingebauten Daily Notes Plugin
- **Unterordner-Unterstützung** — findet bestehende Daily Notes in verschachtelten Ordnern (z.B. `Journal/2024-07/`)
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

### Auto-Sync

Bei jedem Obsidian-Start prüft das Plugin die letzten 7 Tage und ergänzt fehlende Gesundheitsdaten automatisch. Kein manuelles Zutun nötig.

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

## Entwicklung

```bash
npm install
npm run dev    # Watch-Modus
npm run build  # Produktions-Build
```
