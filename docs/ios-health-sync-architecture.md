# iOS Health Sync — Vollständige Technische Architektur

Erstellt: 2026-04-16
Basiert auf: [ios-health-sync-planning.md](./ios-health-sync-planning.md)
Status: Finalisiert — alle Designentscheidungen getroffen (2026-04-16)

---

## Inhaltsverzeichnis

1. [Ziele und Randbedingungen](#1-ziele-und-randbedingungen)
2. [Metriken-Katalog mit Garmin-Kompatibilitäts-Mapping](#2-metriken-katalog)
3. [Workout-Type-Mapping (HKWorkoutActivityType)](#3-workout-type-mapping)
4. [URI Handler und JSON Schema](#4-uri-handler-und-json-schema)
5. [iOS Shortcut Design](#5-ios-shortcut-design)
6. [Plugin-Architektur und Shared Code](#6-plugin-architektur)
7. [Settings UI](#7-settings-ui)
8. [Implementierungsphasen](#8-implementierungsphasen)
9. [Offene Designentscheidungen](#9-offene-designentscheidungen)

---

## 1. Ziele und Randbedingungen

### Ziel

Ein Obsidian-Plugin das Apple Health Daten via iOS Shortcuts in Daily Notes
Frontmatter schreibt. Schwester-Plugin zu Garmin Health Sync mit maximaler
Property-Kompatibilität — wer von Garmin auf Apple Health wechselt, behält
die gleichen Frontmatter-Keys und kann Dataview-Queries weiterverwenden.

### Randbedingungen

| Constraint | Detail |
|---|---|
| Plattform | Obsidian Mobile (iOS), `isDesktopOnly: false` |
| Datenquelle | Apple HealthKit via iOS Shortcuts |
| Kein Companion App | MVP braucht keine eigene iOS App |
| Kein Server | Kein lokaler HTTP-Server (iOS killt Background-Prozesse) |
| Vault-agnostisch | Funktioniert mit Obsidian Sync, iCloud, lokaler Sync, Custom Sync |
| Separates Repository | Eigene Plugin-ID, eigenes Manifest, eigener Release-Zyklus |
| Apple Developer Account | Vorhanden (99$/Jahr) — Option B Upgrade möglich |

### Architekturentscheidung

**Option C (iOS Shortcuts)** — der Shortcut liest HealthKit-Daten, sendet sie
per `obsidian://health-sync` Custom URI an das Plugin. Kein Companion App,
kein Server, 1-Tap Installation via iCloud Link.

---

## 2. Metriken-Katalog

### 2.1 Kompatible Metriken (gleicher Key wie Garmin)

Diese Metriken existieren in beiden Systemen und verwenden **identische Property-Keys**,
damit Frontmatter und Dataview-Queries beim Wechsel weiterhin funktionieren.

| Property-Key | Garmin-Quelle | Apple Health (HealthKit) | Shortcuts-Action | Aggregation |
|---|---|---|---|---|
| `steps` | totalSteps | `HKQuantityType.stepCount` | Find Health Samples → Steps | Tages-Summe |
| `sleep_duration` | sleepTimeSeconds | `HKCategoryType.sleepAnalysis` | Find Health Samples → Sleep Analysis | Summe aller Asleep-Samples |
| `resting_hr` | restingHeartRate | `HKQuantityType.restingHeartRate` | Find Health Samples → Resting Heart Rate | Letzter Wert des Tages |
| `hrv` | hrvSummary.lastNightAvg | `HKQuantityType.heartRateVariabilitySDNN` | Find Health Samples → Heart Rate Variability | Letzter Wert (Nacht) |
| `spo2` | averageSpo2 | `HKQuantityType.oxygenSaturation` | Find Health Samples → Blood Oxygen | Durchschnitt |
| `respiration_rate` | avgWakingRespirationValue | `HKQuantityType.respiratoryRate` | Find Health Samples → Respiratory Rate | Durchschnitt |
| `calories_total` | totalKilocalories | Active + Basal Energy | Find Health Samples → Active + Basal Energy | Summe beider |
| `calories_active` | activeKilocalories | `HKQuantityType.activeEnergyBurned` | Find Health Samples → Active Energy | Tages-Summe |
| `distance_km` | totalDistanceMeters / 1000 | `HKQuantityType.distanceWalkingRunning` + `distanceCycling` | Find Health Samples → Distance | Tages-Summe (m → km) |
| `floors` | floorsAscended | `HKQuantityType.flightsClimbed` | Find Health Samples → Flights Climbed | Tages-Summe |
| `intensity_min` | moderate + vigorous minutes | `HKQuantityType.appleExerciseTime` | Find Health Samples → Exercise Minutes | Tages-Summe |
| `sleep_deep` | deepSleepSeconds | `.asleepDeep` (iOS 16+) | Sleep Analysis → filter Deep | Summe Dauer |
| `sleep_light` | lightSleepSeconds | `.asleepCore` (iOS 16+) | Sleep Analysis → filter Core | Summe Dauer |
| `sleep_rem` | remSleepSeconds | `.asleepREM` (iOS 16+) | Sleep Analysis → filter REM | Summe Dauer |
| `sleep_awake` | awakeSleepSeconds | `.awake` | Sleep Analysis → filter Awake | Summe Dauer |
| `weight_kg` | weight / 1000 | `HKQuantityType.bodyMass` | Find Health Samples → Weight | Letzter Wert |
| `body_fat_pct` | bodyFat | `HKQuantityType.bodyFatPercentage` | Find Health Samples → Body Fat % | Letzter Wert |

**Hinweis `sleep_light` ↔ Core Sleep:** Apple nennt die mittlere Schlafphase "Core"
(nicht "Light" wie Garmin). Wir mappen `asleepCore → sleep_light`, damit der
Property-Key kompatibel bleibt. Die Settings UI zeigt je nach Plugin den
korrekten Namen ("Light sleep" bei Garmin, "Core sleep" bei Apple Health).
→ Siehe [Designentscheidung D1](#d1-sleep_light-vs-sleep_core)

### 2.2 Nur bei Garmin verfügbare Metriken (nicht in Apple Health)

| Property-Key | Warum nicht verfügbar |
|---|---|
| `sleep_score` | Garmin-proprietär — Apple hat kein Sleep Score |
| `stress` | Garmin-proprietär (Firstbeat Analytics) |
| `body_battery` | Garmin-proprietär (Firstbeat) |
| `training_readiness` | Garmin-proprietär |
| `training_status` | Garmin-proprietär |
| `stress_high` | Garmin-proprietär |
| `recovery_high` | Garmin-proprietär |

### 2.3 Nur bei Apple Health verfügbare Metriken (neu)

| Property-Key | HealthKit Type | Typ | Kategorie | Shortcut | Hinweis |
|---|---|---|---|---|---|
| `vo2max` | `HKQuantityType.vo2Max` | number | extended | Find Health Samples → VO2 Max | Geschätzt von Apple Watch |
| `walking_hr_avg` | `HKQuantityType.walkingHeartRateAverage` | number | extended | Find Health Samples → Walking HR Avg | Tages-Durchschnitt |
| `stand_hours` | `HKCategoryType.appleStandHour` | number | extended | Find Health Samples → Stand Hours | Anzahl Stunden "gestanden" |
| `wrist_temp` | `HKQuantityType.appleSleepingWristTemperature` | number | extended | Find Health Samples → Wrist Temperature | Abweichung in °C, Watch Series 8+ |
| `mindful_min` | `HKCategoryType.mindfulSession` | number | extended | Find Health Samples → Mindful Minutes | Summe Minuten |

→ Siehe [Designentscheidung D2](#d2-apple-exklusive-metriken-scope)

### 2.4 Metriken-Definitionen (metrics.ts)

```typescript
// Kompatibel mit Garmin Health Sync — gleiche Keys, gleiche Typen
export const METRICS: MetricDefinition[] = [
  // Standard (enabled by default) — Subset der Garmin-Standards
  { key: "steps",          type: "number", category: "standard", defaultEnabled: true },
  { key: "sleep_duration", type: "string", category: "standard", defaultEnabled: true },
  { key: "resting_hr",     type: "number", category: "standard", defaultEnabled: true },
  { key: "hrv",            type: "number", category: "standard", defaultEnabled: true },
  { key: "calories_active",type: "number", category: "standard", defaultEnabled: true },
  { key: "intensity_min",  type: "number", category: "standard", defaultEnabled: true },

  // Extended — kompatibel mit Garmin
  { key: "spo2",             type: "number", category: "extended", defaultEnabled: false },
  { key: "respiration_rate", type: "number", category: "extended", defaultEnabled: false },
  { key: "calories_total",   type: "number", category: "extended", defaultEnabled: false },
  { key: "distance_km",     type: "number", category: "extended", defaultEnabled: false },
  { key: "floors",           type: "number", category: "extended", defaultEnabled: false },
  { key: "sleep_deep",      type: "string", category: "extended", defaultEnabled: false },
  { key: "sleep_light",     type: "string", category: "extended", defaultEnabled: false },
  { key: "sleep_rem",       type: "string", category: "extended", defaultEnabled: false },
  { key: "sleep_awake",     type: "string", category: "extended", defaultEnabled: false },
  { key: "weight_kg",       type: "number", category: "extended", defaultEnabled: false },
  { key: "body_fat_pct",    type: "number", category: "extended", defaultEnabled: false },

  // Extended — Apple Health exklusiv
  { key: "vo2max",          type: "number", category: "extended", defaultEnabled: false },
  { key: "walking_hr_avg",  type: "number", category: "extended", defaultEnabled: false },
  { key: "stand_hours",     type: "number", category: "extended", defaultEnabled: false },
  { key: "wrist_temp",      type: "number", category: "extended", defaultEnabled: false },
  { key: "mindful_min",     type: "number", category: "extended", defaultEnabled: false },
];
```

**Abweichungen zu Garmin Standard-Metriken:**
- `sleep_score` und `stress` entfallen (nicht in Apple Health)
- Stattdessen `calories_active` und `intensity_min` als Standard (universell nützlich)

---

## 3. Workout-Type-Mapping

### 3.1 HKWorkoutActivityType → Kanonische Keys

Apple Health verwendet `HKWorkoutActivityType` (Enum mit ~80 Werten).
In der iOS Shortcuts-Ausgabe erscheint der Typ als lesbarer String
(z.B. "Running", "Traditional Strength Training").

Das Plugin mappt diese auf die gleichen kanonischen Keys und Kategorien
wie `activity-keys.ts` im Garmin-Plugin:

```typescript
/**
 * Mapping: Apple Health Workout-Typ → kanonischer Key
 *
 * Verwendet die gleichen Ziel-Keys wie Garmin activity-keys.ts.
 * Der Shortcut sendet den HKWorkoutActivityType-String (z.B. "Running").
 * Unbekannte Typen werden als lowercase+underscore durchgereicht.
 */
const APPLE_WORKOUT_MAP: Record<string, string> = {
  // Running
  "running":                        "running",
  "trail running":                  "trail_running",
  "treadmill running":              "treadmill",   // Garmin: treadmill

  // Cycling
  "cycling":                        "cycling",
  "indoor cycling":                 "indoor_cycling",
  "hand cycling":                   "cycling",

  // Walking
  "walking":                        "walking",
  "indoor walking":                 "indoor_walking",

  // Hiking / Outdoor
  "hiking":                         "hiking",
  "climbing":                       "rock_climbing",

  // Swimming
  "swimming":                       "swimming",
  "pool swim":                      "pool_swimming",
  "open water swim":                "open_water_swimming",

  // Winter Sports
  "downhill skiing":                "skiing",
  "cross country skiing":           "cross_country_skiing",
  "snowboarding":                   "snowboarding",
  "snowshoeing":                    "snowshoeing",
  "skating sports":                 "ice_skating",

  // Water Sports
  "paddle sports":                  "kayaking",
  "rowing":                         "rowing",
  "indoor rowing":                  "indoor_rowing",
  "surfing sports":                 "surfing",
  "sailing":                        "sailing",

  // Gym / Fitness
  "traditional strength training":  "strength_training",
  "functional strength training":   "strength_training",
  "core training":                  "strength_training",
  "high intensity interval training": "hiit",
  "elliptical":                     "elliptical",
  "yoga":                           "yoga",
  "pilates":                        "pilates",
  "jump rope":                      "jump_rope",
  "stair climbing":                 "stair_stepper",
  "mixed cardio":                   "cardio",
  "barre":                          "gym_equipment",
  "flexibility":                    "yoga",
  "cooldown":                       "gym_equipment",

  // Racket Sports
  "tennis":                         "tennis",
  "badminton":                      "badminton",
  "squash":                         "squash",
  "table tennis":                   "table_tennis",
  "pickleball":                     "pickleball",
  "racquetball":                    "squash",

  // Combat / Martial Arts
  "boxing":                         "boxing",
  "kickboxing":                     "boxing",
  "martial arts":                   "martial_arts",
  "wrestling":                      "martial_arts",

  // Team Sports
  "soccer":                         "soccer",
  "basketball":                     "basketball",
  "volleyball":                     "volleyball",
  "rugby":                          "rugby",
  "baseball":                       "baseball",
  "softball":                       "softball",
  "cricket":                        "cricket",
  "hockey":                         "hockey",
  "lacrosse":                       "lacrosse",
  "american football":              "american_football",

  // Other
  "golf":                           "golf",
  "equestrian sports":              "horseback_riding",
  "dance":                          "dancing",
  "mind and body":                  "meditation",
  "social dance":                   "dancing",
  "other":                          "workout",
};
```

### 3.2 Kategorie-Mapping

Das bestehende `CATEGORY_MAP` aus `activity-keys.ts` wird 1:1 wiederverwendet.
Alle kanonischen Keys oben sind bereits darin enthalten. Neue Keys wie
`workout` (Fallback) bekommen Kategorie `"other"`.

### 3.3 Workout-Daten im Shortcut

Was iOS Shortcuts pro Workout liefern kann:

| Feld | Verfügbar via Shortcuts | Hinweis |
|---|---|---|
| Typ | Ja | HKWorkoutActivityType als String |
| Dauer (min) | Ja | Duration |
| Distanz (km) | Ja | totalDistance (wenn GPS) |
| Kalorien | Ja | totalEnergyBurned |
| Durchschnitts-HR | **Nein** | Nur via HealthKit API (Option B) |
| Max-HR | **Nein** | Nur via HealthKit API |
| Pace | **Nein** | Berechenbar aus Distanz/Dauer |
| GPS/Route | **Nein** | Nur via HealthKit API |

→ **Kein `avg_hr` im Shortcut-MVP.** Das `TrainingEntry`-Interface setzt `avg_hr`
als optional — bleibt einfach leer. Wird in der Activity-Display-Zeile weggelassen.

→ **Kein `startLocation`/Reverse Geocoding im MVP.** Workouts haben zwar Koordinaten
in HealthKit, aber Shortcuts können diese nicht extrahieren.

---

## 4. URI Handler und JSON Schema

### 4.1 URI Format

```
obsidian://apple-health-sync?date=YYYY-MM-DD&data=<URL-encoded JSON>&v=1
```

| Parameter | Pflicht | Beschreibung |
|---|---|---|
| `date` | Ja | ISO-Datum (YYYY-MM-DD) |
| `data` | Ja | URL-encoded JSON (siehe Schema unten) |
| `v` | Ja | Schema-Version (aktuell: `1`) |

### 4.2 JSON Schema (Shortcut → Plugin)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["metrics"],
  "properties": {
    "metrics": {
      "type": "object",
      "description": "Key-Value Pairs der Gesundheitsmetriken",
      "properties": {
        "steps":            { "type": "number" },
        "sleep_duration":   { "type": "string", "pattern": "^\\d+h \\d+min$" },
        "resting_hr":       { "type": "number" },
        "hrv":              { "type": "number" },
        "spo2":             { "type": "number" },
        "respiration_rate": { "type": "number" },
        "calories_total":   { "type": "number" },
        "calories_active":  { "type": "number" },
        "distance_km":      { "type": "number" },
        "floors":           { "type": "number" },
        "intensity_min":    { "type": "number" },
        "sleep_deep":       { "type": "string", "pattern": "^\\d+h \\d+min$" },
        "sleep_light":      { "type": "string", "pattern": "^\\d+h \\d+min$" },
        "sleep_rem":        { "type": "string", "pattern": "^\\d+h \\d+min$" },
        "sleep_awake":      { "type": "string", "pattern": "^\\d+h \\d+min$" },
        "weight_kg":        { "type": "number" },
        "body_fat_pct":     { "type": "number" },
        "vo2max":           { "type": "number" },
        "walking_hr_avg":   { "type": "number" },
        "stand_hours":      { "type": "number" },
        "wrist_temp":       { "type": "number" },
        "mindful_min":      { "type": "number" }
      },
      "additionalProperties": true
    },
    "workouts": {
      "type": "array",
      "description": "Liste der Workouts des Tages",
      "items": {
        "type": "object",
        "required": ["type"],
        "properties": {
          "type":         { "type": "string", "description": "HKWorkoutActivityType als String" },
          "duration_min": { "type": "number" },
          "distance_km":  { "type": "number" },
          "calories":     { "type": "number" }
        }
      }
    }
  }
}
```

### 4.3 Beispiel-Payload

```json
{
  "metrics": {
    "steps": 8432,
    "sleep_duration": "7h 12min",
    "resting_hr": 58,
    "hrv": 42,
    "spo2": 97,
    "calories_active": 520,
    "distance_km": 6.2,
    "floors": 12,
    "intensity_min": 45,
    "sleep_deep": "1h 30min",
    "sleep_light": "3h 45min",
    "sleep_rem": "1h 20min",
    "sleep_awake": "0h 37min"
  },
  "workouts": [
    {
      "type": "Running",
      "duration_min": 45,
      "distance_km": 6.2,
      "calories": 520
    },
    {
      "type": "Traditional Strength Training",
      "duration_min": 30,
      "calories": 250
    }
  ]
}
```

**URL-Länge:** Dieser Payload ist ~550 Bytes, URL-encoded ~700 Bytes.
Selbst mit allen 22 Metriken + 5 Workouts bleibt man unter ~1500 Bytes.
iOS URL-Limit (~8000 Bytes) wird nie erreicht.

### 4.4 URI Handler Implementation

```typescript
// In main.ts — onload()
this.registerObsidianProtocolHandler("apple-health-sync", async (params) => {
  const { date, data, v } = params;

  // Validierung
  if (!date || !data) {
    new Notice(t("noticeInvalidData", this.settings.language));
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    new Notice(t("noticeInvalidDate", this.settings.language));
    return;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(data));
    const healthData = this.parseShortcutPayload(payload, v ?? "1");
    await this.writeHealthData(date, healthData);
    new Notice(t("noticeSyncSuccess", this.settings.language));
  } catch (error) {
    console.error("Apple Health Sync: URI parse error", error);
    new Notice(t("noticeSyncError", this.settings.language));
  }
});
```

### 4.5 Payload-Parser

```typescript
/**
 * Parst den JSON Payload vom iOS Shortcut und erzeugt ein HealthData-Objekt.
 * Filtert auf aktivierte Metriken und mappt Workout-Typen.
 */
function parseShortcutPayload(
  payload: { metrics?: Record<string, unknown>; workouts?: unknown[] },
  version: string
): HealthData {
  const metrics: Record<string, number | string> = {};
  const activities: Record<string, string> = {};
  const trainings: TrainingEntry[] = [];

  // Metrics — nur aktivierte durchlassen
  if (payload.metrics) {
    for (const [key, value] of Object.entries(payload.metrics)) {
      if (value == null) continue;
      // Typ-Validierung: number oder string
      if (typeof value === "number" || typeof value === "string") {
        metrics[key] = value;
      }
    }
  }

  // Workouts — mappen auf kanonische Keys
  if (Array.isArray(payload.workouts)) {
    for (const raw of payload.workouts) {
      const w = raw as Record<string, unknown>;
      const rawType = String(w.type ?? "workout");
      const normalizedType = normalizeAppleWorkoutType(rawType);
      const category = getActivityCategory(normalizedType);

      // Human-readable display string (wie Garmin-Plugin)
      const parts: string[] = [];
      if (w.distance_km) parts.push(`${round1(Number(w.distance_km))} km`);
      if (w.duration_min) parts.push(`${Math.round(Number(w.duration_min))}min`);
      if (w.calories) parts.push(`${Math.round(Number(w.calories))} kcal`);

      if (parts.length > 0) {
        // Gruppierung bei mehreren gleichen Typen
        if (activities[normalizedType]) {
          activities[normalizedType] += ` + ${parts.join(" · ")}`;
        } else {
          activities[normalizedType] = parts.join(" · ");
        }
      }

      const entry: TrainingEntry = { type: normalizedType, category };
      if (w.distance_km) entry.distance_km = round1(Number(w.distance_km));
      if (w.duration_min) entry.duration_min = Math.round(Number(w.duration_min));
      if (w.calories) entry.calories = Math.round(Number(w.calories));
      trainings.push(entry);
    }
  }

  return { metrics, activities, trainings };
}
```

---

## 5. iOS Shortcut Design

### 5.1 Überblick

Der Shortcut besteht aus 4 Abschnitten:
1. **Konfiguration** — Datum bestimmen
2. **Metriken sammeln** — HealthKit Queries für jede Metrik
3. **Workouts sammeln** — Workout-Query und Formatierung
4. **Senden** — JSON bauen, URL-encoden, Obsidian aufrufen

### 5.2 Konfiguration (Aktionen 1-3)

```
1. [Date]  Datum = Einstellbare Shortcut-Variable
            Standard: "Gestern" (Current Date - 1 Day)
            → Erlaubt manuelles Override via Shortcut Input

2. [Date]  startOfDay = Datum, Start of Day (00:00)
3. [Date]  endOfDay   = Datum, End of Day (23:59:59)
```

### 5.3 Metriken sammeln (Aktionen 4-50)

Jede Metrik folgt einem von drei Patterns:

**Pattern A: Tages-Summe** (steps, calories, distance, floors, intensity_min)
```
[Find Health Samples]
  Type: Steps
  Start Date: is after startOfDay
  Start Date: is before endOfDay
  Group By: Day
[Get: Sum]
→ Variable: val_steps
```

**Pattern B: Letzter Wert** (resting_hr, hrv, spo2, weight_kg, body_fat_pct, vo2max)
```
[Find Health Samples]
  Type: Resting Heart Rate
  Start Date: is after startOfDay
  Start Date: is before endOfDay
  Sort By: Start Date, Latest First
  Limit: 1
[Get: Value]
→ Variable: val_resting_hr
```

**Pattern C: Sleep Analysis** (sleep_duration, sleep_deep, sleep_light, sleep_rem, sleep_awake)
```
[Find Health Samples]
  Type: Sleep Analysis
  Start Date: is after (startOfDay - 12 hours)  ← Schlaf beginnt am Vorabend
  End Date: is before (endOfDay + 3 hours)       ← Schlaf endet am Morgen
→ Variable: allSleepSamples

[Repeat with Each] sample in allSleepSamples
  [Get Details of Health Sample]
    → sampleValue (In Bed / Asleep / Core / Deep / REM / Awake)
    → sampleStart, sampleEnd
  [Calculate]
    duration = (sampleEnd - sampleStart) in minutes
  [If] sampleValue is "Asleep" or "Core" or "Deep" or "REM"
    totalSleepMin = totalSleepMin + duration
  [If] sampleValue is "Deep"
    deepMin = deepMin + duration
  [If] sampleValue is "Core"
    coreMin = coreMin + duration
  [If] sampleValue is "REM"
    remMin = remMin + duration
  [If] sampleValue is "Awake"
    awakeMin = awakeMin + duration
[End Repeat]

[Calculate] sleep_hours = floor(totalSleepMin / 60)
[Calculate] sleep_remaining_min = totalSleepMin mod 60
→ val_sleep_duration = "{sleep_hours}h {sleep_remaining_min}min"

(Gleiche Berechnung für deep, core/light, rem, awake)
```

**Komplette Metriken-Liste mit Aktions-Pattern:**

| Variable | Pattern | HealthKit Action |
|---|---|---|
| `val_steps` | A (Summe) | Find Health Samples → Steps |
| `val_resting_hr` | B (Letzter) | Find Health Samples → Resting Heart Rate |
| `val_hrv` | B (Letzter) | Find Health Samples → Heart Rate Variability |
| `val_spo2` | B (Letzter) | Find Health Samples → Blood Oxygen |
| `val_resp_rate` | B (Letzter) | Find Health Samples → Respiratory Rate |
| `val_cal_active` | A (Summe) | Find Health Samples → Active Energy |
| `val_cal_basal` | A (Summe) | Find Health Samples → Basal Energy |
| `val_cal_total` | Berechnung | val_cal_active + val_cal_basal |
| `val_distance_m` | A (Summe) | Find Health Samples → Walking+Running Distance |
| `val_distance_km` | Berechnung | Round(val_distance_m / 1000, 1) |
| `val_floors` | A (Summe) | Find Health Samples → Flights Climbed |
| `val_intensity` | A (Summe) | Find Health Samples → Exercise Minutes |
| `val_weight` | B (Letzter) | Find Health Samples → Weight |
| `val_body_fat` | B (Letzter) | Find Health Samples → Body Fat Percentage |
| `val_vo2max` | B (Letzter) | Find Health Samples → VO2 Max |
| `val_walking_hr` | B (Letzter) | Find Health Samples → Walking Heart Rate Average |
| `val_stand` | A (Summe) | Find Health Samples → Stand Hours |
| `val_wrist_temp` | B (Letzter) | Find Health Samples → Wrist Temperature |
| `val_mindful` | A (Summe) | Find Health Samples → Mindful Minutes |
| Sleep-Variablen | C (Sleep) | Siehe oben |

### 5.4 Workouts sammeln (Aktionen 51-70)

```
[Find Workouts]  (Shortcut-Standardaktion ab iOS 16)
  Start Date: is after startOfDay
  Start Date: is before endOfDay
→ Variable: todayWorkouts

[Set Variable] workoutArray = []

[Repeat with Each] workout in todayWorkouts
  [Get Details of Workout]
    → workoutType (z.B. "Running")
    → workoutDuration (Sekunden)
    → workoutDistance (Meter, optional)
    → workoutCalories (kcal)

  [Calculate] durationMin = Round(workoutDuration / 60)
  [Calculate] distanceKm = Round(workoutDistance / 1000, 1)

  [Dictionary]
    type: workoutType
    duration_min: durationMin
    distance_km: distanceKm     (nur wenn > 0)
    calories: workoutCalories   (nur wenn > 0)

  [Add to Variable] workoutArray += Dictionary
[End Repeat]
```

### 5.5 JSON bauen und senden (Aktionen 71-80)

```
[Dictionary] metricsDict =
  steps: val_steps
  sleep_duration: val_sleep_duration
  resting_hr: val_resting_hr
  hrv: val_hrv
  spo2: val_spo2
  ... (alle nicht-leeren Variablen)

[Dictionary] payload =
  metrics: metricsDict
  workouts: workoutArray

[Get: Text] jsonText = payload (als JSON formatiert)

[URL Encode] encodedData = jsonText

[Text] dateStr = Datum im Format YYYY-MM-DD

[Open URL]
  obsidian://apple-health-sync?date={dateStr}&data={encodedData}&v=1
```

### 5.6 Shortcut-Varianten

| Variante | Beschreibung | Verteilung |
|---|---|---|
| **Full** | Alle Metriken + Workouts + Sleep | iCloud Link (Standard) |
| **Lite** | Nur Basis-Metriken (Steps, HR, HRV, Sleep Duration, Calories) | iCloud Link |
| **Custom** | User dupliziert Full und entfernt nicht benötigte Aktionen | Anleitung im README |

→ Siehe [Designentscheidung D3](#d3-shortcut-varianten)

### 5.7 Automatisierung

```
Shortcuts App → Automations → Personal Automation:
  Trigger: Time of Day (z.B. 07:00)
  Action: "Run Shortcut" → Apple Health Sync
  Ask Before Running: OFF (verfügbar seit iOS 15.4)
```

**Verhalten:** Der Shortcut läuft, öffnet Obsidian kurz (~1-2s), Daten werden
geschrieben, User sieht es beim nächsten Öffnen der Daily Note. Keine
Interaktion nötig.

---

## 6. Plugin-Architektur

### 6.1 Dateistruktur (neues Repository)

```
apple-health-sync/
├── src/
│   ├── main.ts                      # Plugin-Einstiegspunkt + URI Handler
│   ├── settings.ts                  # Settings Tab UI
│   ├── sync.ts                      # SyncManager (vereinfacht: kein Batch/Backfill)
│   ├── daily-note.ts                # ★ KOPIE von Garmin (writeToDailyNote etc.)
│   ├── geocoding.ts                 # ★ KOPIE von Garmin (für spätere Option B)
│   ├── metrics.ts                   # Apple Health Metriken-Definitionen
│   ├── activity-keys.ts             # Apple → kanonische Keys + CATEGORY_MAP
│   ├── units.ts                     # ★ KOPIE von Garmin (convertToImperial)
│   ├── shortcut-parser.ts           # NEU: JSON Payload → HealthData
│   ├── i18n/
│   │   ├── t.ts                     # ★ KOPIE von Garmin
│   │   ├── en.ts                    # Angepasst (neue Keys, Apple-spezifisch)
│   │   └── de.ts                    # Angepasst
│   └── providers/
│       └── provider.ts              # ★ KOPIE von Garmin (Interfaces)
├── manifest.json
├── package.json
├── versions.json
├── version-bump.mjs                 # ★ KOPIE von Garmin
├── esbuild.config.mjs               # ★ KOPIE von Garmin
├── tsconfig.json
├── eslint.config.mts
├── styles.css
└── .github/workflows/
    ├── release.yml                  # ★ KOPIE von Garmin
    └── lint.yml                     # ★ KOPIE von Garmin
```

### 6.2 Shared Code Strategie

| Modul | Strategie | Änderungen |
|---|---|---|
| `providers/provider.ts` | **Exakte Kopie** | Keine — HealthData, TrainingEntry, HealthProvider bleiben identisch |
| `daily-note.ts` | **Exakte Kopie** | Keine — writeToDailyNote(), deduplicateFrontmatter(), formatDate() |
| `units.ts` | **Exakte Kopie** | Keine — convertToImperial() |
| `geocoding.ts` | **Exakte Kopie** | Keine — für spätere Nutzung (Option B mit GPS) |
| `i18n/t.ts` | **Exakte Kopie** | Keine |
| `metrics.ts` | **Angepasst** | Andere Metrik-Liste (siehe 2.4), gleiche MetricDefinition-Interfaces |
| `activity-keys.ts` | **Angepasst** | Apple-Workout-Map statt Garmin KEY_CLEANUP, gleiche CATEGORY_MAP |
| `sync.ts` | **Stark vereinfacht** | Kein Batch-Delay, kein API-Fetch — empfängt Daten via URI |
| `settings.ts` | **Neu geschrieben** | Kein Login/Logout, kein Server Region — Shortcut-Install stattdessen |
| `main.ts` | **Neu geschrieben** | URI Handler statt BrowserWindow, kein Auto-Sync Timer |

### 6.3 Provider-Interface

Das `HealthProvider`-Interface wird **nicht implementiert** — es gibt keinen
aktiven Provider der Daten fetcht. Stattdessen empfängt der URI Handler
Daten passiv. Das Interface bleibt als Typ-Definition für `HealthData`,
`TrainingEntry` etc. erhalten.

```typescript
// Kein Provider-Objekt nötig — Daten kommen via URI
// HealthData-Interface wird direkt vom shortcut-parser.ts erzeugt
```

### 6.4 Vereinfachter SyncManager

```typescript
export class SyncManager {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /** Write received health data to the daily note */
  async writeData(
    date: string,
    data: HealthData,
    settings: HealthSyncSettings
  ): Promise<boolean> {
    const hasData = Object.keys(data.metrics).length > 0
                 || Object.keys(data.activities).length > 0;
    if (!hasData) return false;

    // Filter auf aktivierte Metriken
    const filteredMetrics: Record<string, number | string> = {};
    for (const [key, value] of Object.entries(data.metrics)) {
      if (settings.enabledMetrics[key]) {
        filteredMetrics[key] = value;
      }
    }
    const filteredData: HealthData = {
      ...data,
      metrics: filteredMetrics,
    };

    // Imperial-Konvertierung
    const outputData = settings.unitSystem === "imperial"
      ? convertToImperial(filteredData)
      : filteredData;

    await writeToDailyNote(this.app, date, outputData, {
      dailyNotePath: settings.dailyNotePath,
      dailyNoteFormat: settings.dailyNoteFormat,
      prefix: settings.usePrefix ? "ohs_" : "",
      template: settings.dailyNoteTemplate,
      writeTrainings: settings.writeTrainings,
      writeWorkoutLocation: false, // Kein GPS im Shortcut-MVP
    });

    return true;
  }
}
```

### 6.5 Main Plugin Klasse

```typescript
export default class AppleHealthSyncPlugin extends Plugin {
  settings: HealthSyncSettings;
  private syncManager: SyncManager;

  async onload() {
    await this.loadSettings();
    this.autoDetectDailyNotePath(); // Gleiche Logik wie Garmin

    this.syncManager = new SyncManager(this.app);

    // URI Handler — Kernstück des Plugins
    this.registerObsidianProtocolHandler("apple-health-sync", (params) => {
      void this.handleHealthSyncUri(params);
    });

    // Command: Manual Sync (öffnet Shortcut via URL)
    this.addCommand({
      id: "trigger-health-sync",
      name: t("commandTriggerSync", this.settings.language),
      callback: () => this.triggerShortcut(),
    });

    // Settings Tab
    this.addSettingTab(new HealthSyncSettingTab(this.app, this));
  }

  private async handleHealthSyncUri(params: Record<string, string>) {
    const { date, data, v } = params;

    if (!date || !data) {
      new Notice(t("noticeInvalidData", this.settings.language));
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      new Notice(t("noticeInvalidDate", this.settings.language));
      return;
    }

    try {
      const payload = JSON.parse(data); // Obsidian decodes URI params
      const healthData = parseShortcutPayload(payload, v ?? "1");
      const success = await this.syncManager.writeData(
        date, healthData, this.settings
      );

      if (success) {
        this.settings.lastSyncDate = date;
        this.settings.lastSyncTime = Date.now();
        await this.saveSettings();
        new Notice(
          t("noticeSyncSuccess", this.settings.language)
            .replace("{date}", date)
        );
      } else {
        new Notice(t("noticeSyncNoData", this.settings.language));
      }
    } catch (error) {
      console.error("Apple Health Sync: URI handler error", error);
      new Notice(t("noticeSyncError", this.settings.language));
    }
  }

  /** Opens the iOS Shortcut via URL scheme */
  private triggerShortcut() {
    const shortcutName = this.settings.shortcutName || "Apple Health Sync";
    const encoded = encodeURIComponent(shortcutName);
    window.open(`shortcuts://run-shortcut?name=${encoded}`);
  }
}
```

---

## 7. Settings UI

### 7.1 Sektionen

```
┌─────────────────────────────────────────────┐
│  Apple Health Sync — Settings               │
├─────────────────────────────────────────────┤
│                                             │
│  SPRACHE                                    │
│  [Dropdown: English ▼]                      │
│                                             │
│  ─── iOS Shortcut ───                       │
│                                             │
│  📥 Install Shortcut                        │
│  [Button: "Install Full Shortcut"]          │
│  [Button: "Install Lite Shortcut"]          │
│  Letzter Sync: 2026-04-15 07:00            │
│                                             │
│  Shortcut Name                              │
│  [Text: "Apple Health Sync"]                │
│  Name des installierten Shortcuts           │
│  (für den "Trigger Sync" Command)           │
│                                             │
│  ─── Daily Notes ───                        │
│                                             │
│  Daily Notes Pfad     [Text: "Journal"]     │
│  Daily Note Format    [Text: "YYYY-MM-DD"]  │
│  Vorlage neue Notizen [TextArea: ...]       │
│                                             │
│  ─── Darstellung ───                        │
│                                             │
│  Einheitensystem      [Dropdown: Metrisch]  │
│  Property-Präfix      [Toggle: OFF]         │
│  Maschinenlesbare     [Toggle: OFF]         │
│  Trainings                                  │
│                                             │
│  ─── Standard-Metriken ───                  │
│                                             │
│  Steps                [Toggle: ON]          │
│  Sleep duration       [Toggle: ON]          │
│  Resting heart rate   [Toggle: ON]          │
│  Heart rate var.      [Toggle: ON]          │
│  Active calories      [Toggle: ON]          │
│  Exercise minutes     [Toggle: ON]          │
│                                             │
│  ▸ Zusätzliche Metriken (klicken)          │
│    SpO2               [Toggle: OFF]         │
│    Respiratory rate    [Toggle: OFF]         │
│    Total calories      [Toggle: OFF]         │
│    Distance (km)       [Toggle: OFF]         │
│    Flights climbed     [Toggle: OFF]         │
│    Deep sleep          [Toggle: OFF]         │
│    Core sleep          [Toggle: OFF]  ← !   │
│    REM sleep           [Toggle: OFF]         │
│    Awake time          [Toggle: OFF]         │
│    Weight (kg)         [Toggle: OFF]         │
│    Body fat %          [Toggle: OFF]         │
│    VO2 Max             [Toggle: OFF]  ← Apple│
│    Walking HR avg      [Toggle: OFF]  ← Apple│
│    Stand hours         [Toggle: OFF]  ← Apple│
│    Wrist temperature   [Toggle: OFF]  ← Apple│
│    Mindful minutes     [Toggle: OFF]  ← Apple│
│                                             │
└─────────────────────────────────────────────┘
```

### 7.2 Settings Interface

```typescript
export interface HealthSyncSettings {
  // Shortcut
  shortcutName: string;           // Name des installierten Shortcuts
  shortcutIcloudUrl: string;      // iCloud Link (für Updates)
  lastSyncDate: string;           // Letztes Sync-Datum
  lastSyncTime: number;           // Letzter Sync-Timestamp (epoch ms)

  // Daily Notes (identisch mit Garmin)
  dailyNotePath: string;
  dailyNoteFormat: string;
  dailyNoteTemplate: string;

  // Darstellung (identisch mit Garmin)
  usePrefix: boolean;
  unitSystem: UnitSystem;
  enabledMetrics: Record<string, boolean>;
  writeTrainings: boolean;

  // UI
  language: string;
}
```

### 7.3 Unterschiede zu Garmin Settings

| Feature | Garmin | Apple Health |
|---|---|---|
| Login/Logout | BrowserWindow + Session | **Entfällt** |
| Server Region | International / China | **Entfällt** |
| Auto-Sync | Timer-basiert im Plugin | **Entfällt** (Shortcut Automation) |
| Auto-Sync Paused | Ja | **Entfällt** |
| Workout Location | Toggle + Reverse Geocoding | **Entfällt** (kein GPS im Shortcut) |
| Shortcut Install | — | **Neu**: iCloud Link Button |
| Shortcut Name | — | **Neu**: Konfigurierbarer Name |
| Letzter Sync | — | **Neu**: Datum/Zeit-Anzeige |

---

## 8. Implementierungsphasen

### Phase 1: Plugin-Gerüst + Basis-Metriken (2-3 Tage)

**Ziel:** Plugin empfängt Daten via URI und schreibt sie in Frontmatter.

- [ ] Repository erstellen (GitHub, Lizenz, CI/CD)
- [ ] Shared Code kopieren (daily-note.ts, units.ts, geocoding.ts, provider.ts, i18n/t.ts)
- [ ] metrics.ts mit Apple Health Metriken
- [ ] shortcut-parser.ts (JSON → HealthData)
- [ ] main.ts mit URI Handler
- [ ] settings.ts (Basis-Settings ohne Shortcut-Install)
- [ ] Einfacher Test-Shortcut (nur Steps + Resting HR)
- [ ] Manueller Test: Shortcut → Plugin → Frontmatter

**Ergebnis:** Ende-zu-Ende-Flow funktioniert mit 2-3 Metriken.

### Phase 2: Vollständiger Shortcut + alle Metriken (2-3 Tage)

**Ziel:** Alle 22 Metriken + Sleep Analysis funktionieren.

- [ ] Shortcut: Alle Pattern-A-Metriken (Summen)
- [ ] Shortcut: Alle Pattern-B-Metriken (Letzte Werte)
- [ ] Shortcut: Sleep Analysis (Pattern C, komplex)
- [ ] Plugin: Validierung aller Metrik-Typen
- [ ] Test: Vollständiger Shortcut → alle Properties in Frontmatter
- [ ] Shortcut auf iCloud hochladen (Full + Lite Variante)

### Phase 3: Workouts + Activity Mapping (1-2 Tage)

**Ziel:** Workouts werden korrekt gemappt und angezeigt.

- [ ] activity-keys.ts mit Apple Workout Mapping
- [ ] Shortcut: Workout-Sammlung (Find Workouts)
- [ ] Plugin: Workout-Display-Strings + TrainingEntry
- [ ] Test: Mehrere Workout-Typen am gleichen Tag

### Phase 4: Settings UI + UX Polish (1-2 Tage)

**Ziel:** Komplette Settings-Seite, Shortcut-Install-Flow, Notices.

- [ ] Settings UI komplett (alle Sektionen)
- [ ] Shortcut-Install-Button (öffnet iCloud Link)
- [ ] "Trigger Sync" Command (öffnet Shortcut)
- [ ] i18n: Englisch + Deutsch
- [ ] Letzter-Sync-Anzeige in Settings
- [ ] Error Notices für ungültige Daten

### Phase 5: Testing + Store Submission (2-3 Tage)

**Ziel:** Plugin ist Store-ready.

- [ ] Test auf iPhone mit echten Apple Health Daten
- [ ] Test: Garmin → Apple Health Migration (gleiche Properties)
- [ ] Test: Imperial Units
- [ ] Test: Prefix (ohs_)
- [ ] Test: Shortcut Automation (täglicher Timer)
- [ ] README.md (EN + DE)
- [ ] manifest.json (`isDesktopOnly: false`)
- [ ] Community Plugin Submission PR
- [ ] ESLint-Compliance (Obsidian Review Bot Anforderungen)

**Geschätzter Gesamtaufwand: 8-13 Tage** bei fokussierter Arbeit.

---

## 9. Offene Designentscheidungen

### D1: `sleep_light` vs `sleep_core`
<a name="d1-sleep_light-vs-sleep_core"></a>

**Problem:** Apple Health nennt die mittlere Schlafphase "Core Sleep",
Garmin nennt sie "Light Sleep". Die Daten sind physiologisch vergleichbar
(NREM Stage 1+2), aber nicht identisch benannt.

**Option A — Gleicher Key `sleep_light`:**
- Pro: Maximale Kompatibilität, Dataview-Queries funktionieren ohne Änderung
- Pro: User die wechseln behalten durchgängige Daten
- Contra: "Core" und "Light" sind nicht exakt dasselbe (Apple misst anders als Garmin)
- Settings-Label zeigt "Core sleep" (nicht "Light sleep")

**Option B — Separater Key `sleep_core`:**
- Pro: Technisch korrekt, kein Daten-Mismatch
- Contra: Dataview-Queries wie `sleep_light > "2h"` brechen bei Wechsel
- Contra: User müssen alte Entries manuell migrieren

**Empfehlung:** Option A. Der Unterschied zwischen "Core" und "Light" ist
in der Praxis irrelevant für Pattern-Tracking in Obsidian.

**Entscheidung:** ✅ Option A — `sleep_light` für beide Plugins

---

### D2: Apple-exklusive Metriken — Scope
<a name="d2-apple-exklusive-metriken-scope"></a>

**Problem:** Sollen Apple-exklusive Metriken (VO2 Max, Walking HR, Stand Hours,
Wrist Temperature, Mindful Minutes) im MVP enthalten sein?

**Option A — Alle 5 im MVP:**
- Pro: Vollständiges Feature-Set, Apple Watch User wollen diese Daten
- Contra: Mehr Shortcut-Aktionen, längerer Shortcut

**Option B — Nur VO2 Max und Mindful Minutes im MVP:**
- Pro: Die zwei nützlichsten, restliche können nachgereicht werden
- Contra: Stand Hours und Wrist Temperature sind beliebte Apple Watch Metriken

**Option C — Keine im MVP, alles in Phase 2:**
- Pro: Schnellster MVP, Shortcut bleibt kurz
- Contra: Verpasste Differenzierung zu Garmin

**Empfehlung:** Option A — der Aufwand pro Metrik ist minimal (1 Find Health
Samples Action + 1 Variable), und es differenziert das Plugin sinnvoll.

**Entscheidung:** ✅ Option A — Alle 5 Apple-exklusive Metriken im MVP

---

### D3: Shortcut-Varianten
<a name="d3-shortcut-varianten"></a>

**Problem:** Soll es mehrere Shortcut-Varianten geben (Full, Lite, Custom)?

**Option A — Nur Full:**
- Pro: Einfachste Wartung, eine iCloud URL
- Contra: Shortcut ist lang (~80 Aktionen), nicht-genutzte Metriken produzieren leere Werte

**Option B — Full + Lite:**
- Pro: Lite für Einsteiger, Full für Power User
- Contra: Zwei Shortcuts warten, zwei iCloud URLs

**Option C — Nur Full, Plugin ignoriert nicht-aktivierte Metriken:**
- Pro: Ein Shortcut, User konfiguriert im Plugin was angezeigt wird
- Pro: Shortcut muss nie aktualisiert werden wenn User Metriken umschaltet
- Contra: Shortcut macht unnötige HealthKit-Queries

**Empfehlung:** Option C. Der Shortcut sammelt immer alles, das Plugin
filtert. HealthKit-Queries sind billig (kein Netzwerk), der Overhead ist
vernachlässigbar.

**Entscheidung:** ✅ Option C — Ein Full-Shortcut, Plugin filtert via Settings

---

### D4: Plugin-Name und ID
<a name="d4-plugin-name"></a>

**Problem:** Wie soll das Plugin heißen?

| Option | Plugin-ID | Repository |
|---|---|---|
| A | `apple-health-sync` | Apple-Health-Sync |
| B | `health-sync-ios` | Health-Sync-iOS |
| C | `ios-health-sync` | iOS-Health-Sync |

**Empfehlung:** Option A — konsistent mit `garmin-health-sync`, klar
erkennbar im Community Plugin Store. "Apple Health" ist der offizielle
Name des Dienstes.

**Markenrecht-Hinweis:** Apple erlaubt "Apple Health" in Drittanbieter-Apps
wenn klar ist, dass es keine Apple-App ist. Obsidian-Plugins sind keine
Apps im Store-Sinne, aber der Name sollte nicht suggerieren, es sei ein
offizielles Apple-Produkt. Alternative: "Health Sync for iOS".

**Entscheidung:** ✅ Option A — `apple-health-sync` / `Apple-Health-Sync`

---

### D5: Property-Prefix Kompatibilität
<a name="d5-prefix"></a>

**Problem:** Garmin Health Sync verwendet den Prefix `ohs_` (Obsidian Health Sync).
Soll das Apple-Plugin denselben Prefix verwenden?

**Option A — Gleicher Prefix `ohs_`:**
- Pro: Maximale Kompatibilität bei Wechsel
- Pro: Dataview-Queries mit `ohs_steps` funktionieren mit beiden Plugins

**Option B — Eigener Prefix `ahs_` (Apple Health Sync):**
- Pro: Unterscheidbar wenn beide Plugins gleichzeitig laufen
- Contra: Bricht Queries beim Wechsel

**Empfehlung:** Option A. Es ist unwahrscheinlich, dass jemand beide
Plugins gleichzeitig nutzt (verschiedene Plattformen). Der Prefix steht
für "Obsidian Health Sync", nicht "Garmin".

**Entscheidung:** ✅ Option A — `ohs_` Prefix für beide Plugins

---

### D6: URI Namespace
<a name="d6-uri-namespace"></a>

**Problem:** Der URI-Handler `obsidian://health-sync` ist global in Obsidian.
Was passiert wenn beide Plugins installiert sind?

**Option A — Gleicher URI `health-sync`:**
- Pro: Einfach
- Contra: Konflikt wenn beide Plugins installiert (unwahrscheinlich aber möglich)

**Option B — Plugin-spezifischer URI `apple-health-sync`:**
- Pro: Kein Konflikt möglich
- Contra: Shortcut muss zum Plugin passen

**Empfehlung:** Option B. Safety first — `obsidian://apple-health-sync` als
URI. Kosten: Null. Risiko bei Option A: Plugin-Crash wenn Garmin-Plugin den
Handler zuerst registriert.

**Entscheidung:** ✅ Option B — `obsidian://apple-health-sync`

---

### D7: Shortcut-Update-Mechanismus
<a name="d7-shortcut-update"></a>

**Problem:** Wenn der Shortcut aktualisiert werden muss (neue Metriken,
Bugfixes), wie erfährt der User davon?

**Option A — Plugin prüft GitHub JSON:**
- Plugin fetcht `shortcut-version.json` vom GitHub Repo
- Vergleicht mit lokal gespeicherter Version
- Zeigt "Update available" in Settings

**Option B — Manuelle Info im Changelog:**
- README/Changelog erwähnt Shortcut-Updates
- User muss selbst den neuen iCloud Link aufrufen

**Option C — Versionierter iCloud Link:**
- Jeder Shortcut enthält eine Version-Variable
- Plugin liest die Version aus dem `v`-Parameter
- Zeigt Hinweis wenn veraltet

**Empfehlung:** Option C. Der `v`-Parameter im URI existiert bereits.
Plugin vergleicht `v` mit der erwarteten Version und zeigt bei Mismatch
einen dezenten Hinweis in den Settings.

**Entscheidung:** ✅ Option C — Versions-Check via `v`-Parameter im URI

---

### D8: Daten-Deduplizierung
<a name="d8-dedup"></a>

**Problem:** Was passiert wenn der Shortcut mehrmals am Tag läuft
(z.B. morgens automatisch + abends manuell)?

**Aktuelles Verhalten (von Garmin geerbt):** `updateFrontmatter()` überschreibt
existierende Keys. Der letzte Sync gewinnt.

**Das ist korrekt** — spätere Daten sind vollständiger (z.B. Schritte am Abend
höher als morgens). Keine Änderung nötig.

**Entscheidung:** ✅ Kein Handlungsbedarf — Überschreiben ist das gewünschte Verhalten.

---

## Anhang A: Garmin-Kompatibilitäts-Matrix

Vollständige Übersicht welche Frontmatter-Properties bei welchem Plugin
geschrieben werden:

```
Property           Garmin   Apple   Kompatibel?
─────────────────────────────────────────────
steps              ✅       ✅      ✅ gleicher Key
sleep_duration     ✅       ✅      ✅ gleicher Key, gleiches Format "Xh Ymin"
sleep_score        ✅       ❌      — Garmin-exklusiv
resting_hr         ✅       ✅      ✅ gleicher Key
hrv                ✅       ✅      ✅ gleicher Key
stress             ✅       ❌      — Garmin-exklusiv
body_battery       ✅       ❌      — Garmin-exklusiv
spo2               ✅       ✅      ✅ gleicher Key
respiration_rate   ✅       ✅      ✅ gleicher Key
calories_total     ✅       ✅      ✅ gleicher Key
calories_active    ✅       ✅      ✅ gleicher Key
distance_km        ✅       ✅      ✅ gleicher Key
floors             ✅       ✅      ✅ gleicher Key
intensity_min      ✅       ✅      ✅ gleicher Key
sleep_deep         ✅       ✅      ✅ gleicher Key
sleep_light        ✅       ✅      ⚠️ Garmin=Light, Apple=Core (D1)
sleep_rem          ✅       ✅      ✅ gleicher Key
sleep_awake        ✅       ✅      ✅ gleicher Key
training_readiness ✅       ❌      — Garmin-exklusiv
training_status    ✅       ❌      — Garmin-exklusiv
weight_kg          ✅       ✅      ✅ gleicher Key
body_fat_pct       ✅       ✅      ✅ gleicher Key
stress_high        ✅       ❌      — Garmin-exklusiv
recovery_high      ✅       ❌      — Garmin-exklusiv
vo2max             ❌       ✅      — Apple-exklusiv
walking_hr_avg     ❌       ✅      — Apple-exklusiv
stand_hours        ❌       ✅      — Apple-exklusiv
wrist_temp         ❌       ✅      — Apple-exklusiv
mindful_min        ❌       ✅      — Apple-exklusiv
workout_location   ✅       ❌      — Garmin hat GPS, Shortcut nicht
trainings          ✅       ✅      ✅ gleiche Struktur (ohne avg_hr)
```

**Kompatibilität:** 17 von 22 gemeinsamen Metriken haben identische Keys.
Garmin hat 7 exklusive, Apple hat 5 exklusive Metriken. Ein User der
wechselt, behält alle gemeinsamen Dataview-Queries.

---

## Anhang B: Shared-Code-Strategie

### Keine Verbindung zwischen Repositories

Die Shared Files werden als **einfache Kopien** ins neue Repository übernommen.
Kein Git Submodule, kein Monorepo, kein Package-Link. Änderungen in einem
Repo werden nicht automatisch im anderen übernommen.

**Warum:** Die geteilte Codebasis ist klein (~300 Zeilen in 6 Dateien) und
ändert sich selten. Die Komplexität eines Monorepos oder Submodules wäre
unverhältnismäßig.

### Zu kopierende Dateien

Diese Dateien werden 1:1 aus `fcandi/Garmin-Health-Sync` kopiert:

| Datei | Zeilen | Letzte Änderung |
|---|---|---|
| `src/providers/provider.ts` | ~45 | HealthData, TrainingEntry, HealthProvider Interfaces |
| `src/daily-note.ts` | ~200 | writeToDailyNote(), deduplicateFrontmatter(), formatDate() |
| `src/units.ts` | ~45 | convertToImperial() |
| `src/geocoding.ts` | ~65 | reverseGeocode() — für spätere Option B |
| `src/i18n/t.ts` | ~13 | Translation-Funktion |
| `version-bump.mjs` | ~30 | Bumpt package.json, manifest.json, versions.json |

---

## Anhang C: Session-Handoff — Implementation starten

### Neues Repository aufsetzen

1. GitHub Repo erstellen: `fcandi/Apple-Health-Sync`
2. Lokal klonen: `git clone git@github.com:fcandi/Apple-Health-Sync.git`
3. In dem neuen Repo eine neue Claude Code Session starten

### Prompt für die erste Session im neuen Repo

```
Lies die technische Architektur für dieses Plugin:
git show origin/claude/ios-health-sync-planning-2TxcW:docs/ios-health-sync-architecture.md

Das Dokument ist im Repo fcandi/Garmin-Health-Sync auf dem Branch
claude/ios-health-sync-planning-2TxcW unter docs/.

Dort findest du auch die Planning Notes:
git show origin/claude/ios-health-sync-planning-2TxcW:docs/ios-health-sync-planning.md

Zusätzlich brauchst du den Quellcode des Garmin-Plugins als Referenz
für die Shared Files. Das Repo liegt lokal unter:
/Users/anditravel/DEV/garmin-health-sync/src/

Beginne mit Phase 1: Plugin-Gerüst + Basis-Metriken.
Kopiere die Shared Files, erstelle die neuen Module, und baue
den Ende-zu-Ende-Flow (URI Handler → Parser → Frontmatter).
```
