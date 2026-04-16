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
  restrictions – apps get ~30s background time, server becomes unreachable

- **Option B (companion app + custom URI) reserved** as future upgrade for
  users who need full HealthKit access (e.g., workout heart rate data)

- **Vault storage agnostic** – must work with local vault (Obsidian Sync, custom
  sync, or plain local). No iCloud vault requirement.

## Owner Context

- Owner has an active Apple Developer Account (99$/year) – available if
  Option B upgrade is pursued later
- Owner uses custom sync solution (not iCloud, not Obsidian Sync)
- Vault is stored locally on iPhone

## Data Scope (Option C / Shortcuts)

Available via Shortcuts natively:
- Steps, Sleep Duration, Sleep Stages, Resting HR, HRV, SpO2
- Respiratory Rate, Body Temperature, Weight, Body Fat %
- Active/Total Calories, Distance, Floors Climbed
- Workouts: Type, Duration, Distance, Calories (no avg HR)

Not available natively (would need Option B companion app):
- Workout average heart rate, max HR, elevation, pace, route/GPS

## Companion App Candidates (if needed later)

- **Health Auto Export** (~6 EUR, by K-Decimal / HealthyApps) – most popular,
  has Shortcuts actions, REST API export, iCloud Drive automation
- **Health.md** (open source, MIT, github.com/CodyBontecou/health-md) –
  exports HealthKit as Markdown/frontmatter, has macOS companion via
  Multipeer Connectivity

## Architecture: Option C Flow

```
Apple Health
     |
     v
iOS Shortcut (daily automation or manual/Siri trigger)
  1. "Find Health Samples" for each metric
  2. Format as JSON
  3. Call obsidian://health-sync?date=YYYY-MM-DD&data={...}
     |
     v
Obsidian Plugin (registered URI handler)
  1. Parse incoming data
  2. Find/create Daily Note for date
  3. Write frontmatter properties
```

## Open Items

- [ ] Design Shortcut structure (which actions, data formatting)
- [ ] Design plugin URI handler and data mapping
- [ ] Define Shortcut installation/distribution flow
- [ ] Decide if Health Auto Export hybrid approach adds value
- [ ] Plan shared code structure with Garmin Health Sync (frontmatter writer, settings)
