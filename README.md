**English** · [Deutsch](README.de.md) · [中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md)

# Garmin Health Sync

Sync steps, sleep, heart rate, stress, activities and more from Garmin Connect into Obsidian Daily Notes — as frontmatter properties you can query with Dataview.

> **Desktop only.** This plugin uses Electron's BrowserWindow for Garmin Connect authentication and does not work on mobile.

> **Note:** This plugin uses Garmin Connect's internal web API through an Electron browser session — there is no official third-party API available.

## Features

- **Auto-sync on startup** — checks the last 7 days and fills in any missing health data
- **Manual sync** — sync any open Daily Note via command palette
- **Backfill** — bulk-sync a date range (e.g. the last 3 months)
- **20+ metrics** — steps, sleep score, HRV, stress, body battery, SpO2, weight, and more
- **Activity tracking** — each workout appears as a human-readable summary
- **Workout location** — reverse-geocoded place name from your first GPS activity
- **Smart detection** — automatically picks up your Daily Notes path and format from Periodic Notes or the core Daily Notes plugin
- **Subdirectory support** — finds existing Daily Notes in nested folders (e.g. `Journal/2024-07/`)
- **Language auto-detection** — UI language is set from your Obsidian language (EN, DE, ZH, JA, ES, FR)
- **Optional structured data** — machine-readable `trainings` field for advanced Dataview queries
- **Property prefix** — optionally adds an `ohs_` prefix to all frontmatter properties to avoid naming conflicts with other plugins

## Frontmatter Output

### Metrics

```yaml
---
steps: 15185
resting_hr: 69
sleep_score: 81
sleep_duration: 7h 43min
hrv: 39
stress: 30
vo2_max: 48
workout_location: Bad Honnef, Germany
---
```

### Activities

Each workout is written as a frontmatter key with a summary string:

```yaml
---
hiking: 8.2 km · 157min · Ø105 bpm · 696 kcal
e_bike: 22.1 km · 65min · Ø112 bpm · 420 kcal
---
```

Only days with actual workouts get activity keys. The plugin never touches your note content — it only adds or updates frontmatter properties.

### Trainings (optional, machine-readable)

Enable "Machine-readable trainings" in settings to add a structured `trainings` field for Dataview queries:

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

## Requirements

- **Obsidian Desktop** (Windows, macOS, Linux) — the plugin does not work on mobile
- **Garmin account** with access to Garmin Connect
- **Daily Notes** or **Periodic Notes** plugin enabled (or configure the path manually in settings)

## Installation

### From Community Plugins (recommended)

1. Open Obsidian Settings → Community Plugins → Browse
2. Search for "Garmin Health Sync"
3. Install and enable the plugin
4. Log in to Garmin Connect in the plugin settings

### Manual

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/fcandi/garmin-health-sync/releases)
2. Create a folder `.obsidian/plugins/garmin-health-sync/` in your vault
3. Copy both files into that folder
4. Enable the plugin in Settings → Community Plugins

## Usage

### Auto-sync

On every Obsidian startup, the plugin checks the last 7 days and fills in any missing health data automatically. No action needed.

### Manual sync

Open a Daily Note and run **Garmin Health Sync: Sync current note** from the Command Palette (Cmd/Ctrl+P).

### Backfill historical data

Have years of Garmin data? You can bulk-sync any date range:

1. Open the Command Palette (Cmd/Ctrl+P)
2. Search for **"Backfill health data"**
3. Pick a start and end date
4. The plugin fetches all data for that range with rate-limiting to avoid API throttling

## Activity Key Normalization

Garmin's `typeKey` values are normalized to cleaner canonical keys:

| Provider Key | Canonical Key | Category |
|---|---|---|
| `e_bike_fitness` | `e_bike` | cycling |
| `e_bike_mountain` | `e_mtb` | cycling |
| `resort_skiing_snowboarding` | `skiing` | winter |
| `backcountry_skiing_snowboarding` | `backcountry_skiing` | winter |
| `stand_up_paddleboarding` | `sup` | water |
| `fitness_equipment` | `gym_equipment` | gym |

All other Garmin keys pass through unchanged (e.g. `hiking`, `running`, `cycling`, `swimming`, `strength_training`, `yoga`, ...).

### Activity Categories

Each activity is assigned a category:

| Category | Examples |
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

## Data & Privacy

This plugin makes network requests to two external services:

- **Garmin Connect** — a browser window authenticates with Garmin Connect using your credentials. No password is stored by the plugin. Local plugin data may store Garmin session data, including session cookies, so the plugin can restore the browser session without asking you to log in again. Treat this session data like a login token: its lifetime is controlled by Garmin, and it may be included in backups or sync tools if they include Obsidian plugin data. Using **Logout** clears the stored Garmin session data on this device.
- **Nominatim (OpenStreetMap)** — if the "Workout location" feature is enabled, the GPS coordinates of your first activity are sent to `nominatim.openstreetmap.org` for reverse geocoding. You can disable this in settings under *Workout location*.

No data is sent to any other server.

## Development

```bash
npm install
npm run dev    # watch mode
npm run build  # production build
```
