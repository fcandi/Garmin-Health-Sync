# iOS Health Sync Plugin – Planning Notes

## Project Context

Sister plugin to Garmin Health Sync that synchronizes Apple Health data into
Obsidian Daily Notes frontmatter. Target: iOS-only (Android discarded).

## Key Decisions

- **Architecture: Option C (iOS Shortcuts)** chosen as best approach
  - Shortcut reads HealthKit data, sends via custom URI to Obsidian plugin
  - Plugin registers `obsidian://health-sync` URI handler
  - Distributable via iCloud Shortcut link (one-click install)
  - No companion iOS app required for MVP
  - Upgrade path to Option B (companion app with custom URI) if demand warrants

- **Option A (local HTTP server) rejected** for mobile due to iOS background
  restrictions – apps get ~30s background time, server becomes unreachable.
  In practice the "magic" experience fails because iOS kills background apps
  aggressively, resulting in frequent "please open companion app" prompts –
  worse UX than Options B or C.

- **Option B (companion app + custom URI) reserved** as future upgrade for
  users who need full HealthKit access (e.g., workout heart rate data).
  UX involves two visible app switches (Obsidian → Companion → Obsidian, ~1-2s).

- **Vault storage agnostic** – must work with local vault (Obsidian Sync, custom
  sync, or plain local). No iCloud vault requirement.

## Owner Context

- Owner has an **active Apple Developer Account** (99$/year) – available if
  Option B upgrade is pursued later
- Owner uses custom sync solution (not iCloud, not Obsidian Sync)
- Vault is stored locally on iPhone

## Data Scope – What Apple Health Provides

### Available via iOS Shortcuts natively:
- Steps, Sleep Duration, Sleep Stages (Deep/REM/Core/Awake), Resting HR, HRV, SpO2
- Respiratory Rate, Body Temperature (Wrist), Weight, Body Fat %
- Active/Total Calories, Distance, Floors Climbed
- Workouts: Type, Duration, Distance, Calories (**no avg HR via Shortcuts**)

### Not available natively (would need Option B companion app):
- Workout average heart rate, max HR, elevation, pace, route/GPS

### Not available in Apple Health at all (Garmin-specific):
- Body Battery, Stress, Training Readiness, Training Status

### Design philosophy:
Obsidian is for **pattern tracking** (how often do I exercise, sleep trends),
not full workout analysis. The Shortcuts data scope is sufficient for this.

## Architecture: Option C Flow

```
Apple Health
     |
     v
iOS Shortcut (daily automation at e.g. 7:00, or manual via Siri/Widget)
  1. "Find Health Samples" for each metric type
  2. "Find Workouts" for today's date
  3. Format everything as URL-encoded JSON
  4. Call obsidian://health-sync?date=YYYY-MM-DD&data={...}
     |
     v
Obsidian Plugin (registered URI handler via registerObsidianProtocolHandler)
  1. Parse incoming JSON from URI parameters
  2. Map to HealthData interface (same as Garmin plugin)
  3. Find/create Daily Note for date
  4. Write frontmatter properties (reuse daily-note.ts logic)
```

## Plugin Architecture – Shared Code Strategy

The plugin should **reuse as much as possible** from Garmin Health Sync.
These modules are fully provider-agnostic and can be shared:

| Module | Reusability | What to share |
|--------|-------------|---------------|
| `providers/provider.ts` | EXACT COPY | HealthData, TrainingEntry, HealthProvider interfaces |
| `daily-note.ts` | EXACT COPY | writeToDailyNote(), frontmatter dedup, recursive search |
| `metrics.ts` | ADAPT | Same structure, different metric catalog for Apple Health |
| `activity-keys.ts` | ADAPT | Apple Health uses HKWorkoutActivityType enum, needs own mapping |
| `units.ts` | EXACT COPY | convertToImperial() |
| `geocoding.ts` | EXACT COPY | reverseGeocode() (if workout location needed later) |
| `i18n/` | ADAPT | Same pattern, new translation keys |
| `sync.ts` | ADAPT | SyncManager reusable but needs URI-based provider |

## Plugin – New Components Needed

1. **URI Handler Provider** – implements HealthProvider interface but receives
   data via `obsidian://health-sync` URI instead of fetching from API
2. **Apple Health Metrics** – metric definitions mapped to Apple Health types
3. **Shortcut Data Parser** – parses the JSON payload from the Shortcut
4. **Settings UI** – similar to Garmin plugin but without login/server region;
   adds Shortcut installation section with iCloud link button
5. **Shortcut Version Check** – optional: check GitHub JSON for Shortcut updates

## iOS Shortcut – Design

The Shortcut needs to:
1. Get yesterday's date (or configurable)
2. For each health metric: "Find Health Samples Where Type is X AND Start Date is yesterday"
3. Extract the value (last sample, sum, or average depending on type)
4. "Find Workouts" where Start Date is yesterday
5. Build a JSON object with all data
6. URL-encode the JSON
7. Open URL: `obsidian://health-sync?date=YYYY-MM-DD&data=<encoded-json>`

### JSON Payload Format (Shortcut → Plugin):
```json
{
  "metrics": {
    "steps": 8432,
    "sleep_duration": "7h 12min",
    "resting_hr": 58,
    "hrv": 42,
    "spo2": 97,
    "weight_kg": 78.5
  },
  "workouts": [
    {
      "type": "running",
      "duration_min": 45,
      "distance_km": 6.2,
      "calories": 520
    }
  ]
}
```

## UX Flows

### First-time Setup (< 2 minutes):
1. Install plugin via Obsidian Community Plugins
2. Open plugin settings → tap "Install iOS Shortcut" button
3. Shortcuts app opens → tap "Add Shortcut"
4. (Optional) Set up daily automation in Shortcuts app

### Daily Sync – Automatic:
- iOS Shortcut Automation fires at configured time (e.g. 7:00 AM)
- Since iOS 15.4: runs without user confirmation for time-based triggers
- Obsidian opens briefly, data is written, user sees it next time they open a note

### Daily Sync – Manual:
- User says "Hey Siri, Health Sync" or taps Home Screen widget
- Shortcuts overlay runs 2-3s, then Obsidian opens with data

### Shortcut Distribution:
- iCloud link: `https://www.icloud.com/shortcuts/abc123...`
- Linked from: Plugin settings button, GitHub README, plugin docs
- One tap install, no technical knowledge needed
- Updates: new iCloud link, plugin settings shows "Update available"

## Companion App Candidates (if Option B later)

- **Health Auto Export** (~6 EUR, by K-Decimal / HealthyApps) – most popular,
  has Shortcuts actions, REST API export, iCloud Drive automation.
  Cannot call custom URI schemes directly, but its Shortcuts actions can be
  used in a hybrid Shortcut (HAE reads data → Shortcut sends via URI).
- **Health.md** (open source, MIT, github.com/CodyBontecou/health-md) –
  exports HealthKit as Markdown/frontmatter, has macOS companion via
  Multipeer Connectivity. Potential fork candidate.

## Repository Strategy

**Recommendation: Separate repository** for the iOS Health Sync plugin.

Reasons:
- Different Obsidian plugin ID, manifest, release cycle
- `isDesktopOnly: false` (mobile-compatible) vs Garmin's `isDesktopOnly: true`
- Different Community Plugin Store listing
- Shared code can be copy-adapted (small surface area, ~5 files)
- Avoids monorepo complexity for two independent Obsidian plugins

Suggested repo name: `Apple-Health-Sync` or `Health-Sync-iOS`
(mirror naming of `Garmin-Health-Sync`)

Planning docs stay HERE in Garmin-Health-Sync/docs/ until development starts.

## Open Items – Next Session

- [ ] Create new repository for iOS Health Sync plugin
- [ ] Design complete Shortcut step-by-step (every action, every variable)
- [ ] Design plugin URI handler with full JSON schema
- [ ] Design Settings UI mockup (sections, toggles, Shortcut install button)
- [ ] Define Apple Health metric catalog (map HealthKit types to our keys)
- [ ] Define Apple Health workout type mapping (HKWorkoutActivityType → normalized keys)
- [ ] Write i18n strings (en, de minimum)
- [ ] Plan implementation phases (Phase 1: metrics only, Phase 2: workouts, Phase 3: automation guide)

## Option Comparison Summary (Final)

| | Option A: HTTP Server | Option B: Custom URI App | Option C: Shortcuts |
|---|---|---|---|
| **iOS Reality** | Fragil (App stirbt) | Stabil (2x App-Wechsel) | **Am besten** (iOS-nativ) |
| **Aufwand** | 3-4 Wochen + App | 2-3 Wochen + App | **3-5 Tage** |
| **Dev Account nötig** | Ja | Ja | **Nein** |
| **User-Installation** | App Store Download | App Store Download | **iCloud Link, 1 Tap** |
| **Automatisierung** | Fragil | Fragil | **Stabil (iOS 15.4+)** |
| **Datenumfang** | Komplett | Komplett | Reicht für Use Case |
| **Empfehlung** | Verworfen | Upgrade-Pfad | **MVP** |
