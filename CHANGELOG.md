# Changelog

## 0.9.10-beta.2

### Fixed

- Garmin login could fail with the sign-in window stuck on the Sign In screen while
  the ticket page opened in your external browser instead (issue #6). Garmin
  sometimes completes the login in a new window, which Obsidian forwards to the
  system browser — out of the plugin's reach. The plugin now keeps that final step
  inside its own login window, picks the ticket up from Garmin's in-page success
  event as an additional path, and captures (then closes) any popup that still
  slips through.

## 0.9.10-beta.1

### Fixed

- Garmin login could fail right after entering your credentials, leaving you on a
  page showing `{serviceUrl: …, serviceTicket: 'ST-…'}` (issue #6). Your sign-in had
  actually succeeded — the plugin just didn't recognise the login ticket in that
  form. Ticket detection is now broader and re-checks on in-page navigations, so the
  login completes reliably.

### Internal

- Login logs now include the plugin version and a redacted diagnostic breadcrumb to
  make bug reports easier to act on.

## 0.9.9

Maintenance release. No functional changes — internal cleanups to comply with the Obsidian plugin guidelines.

### If you're updating from before 0.9.8

Carried over from 0.9.8: the plugin now signs in to Garmin with official sign-in tokens instead of a browser session, so your connection stays alive far longer and refreshes itself in the background. **You'll need to log in to Garmin once** after updating — after that it just keeps going. (Full details in the 0.9.8 notes below.)

### Changed

- Raised the minimum required Obsidian version to 1.5.4. The plugin already relied on APIs introduced in that version (`Vault.createFolder`), so this only makes the existing requirement explicit.
- Internal: use `activeDocument` and `window.setTimeout` instead of the global `document` / `setTimeout` for popout-window compatibility.

## 0.9.8

This update changes how the plugin signs in to Garmin. Instead of a browser session that quietly expired after a couple of hours, it now uses Garmin's official sign-in tokens — so your connection stays alive far longer and keeps refreshing itself in the background.

### What changed for you

- **You stay connected much longer.** The old browser session expired after a few hours, which is what caused the recurring "auto-sync paused" messages. Now you sign in once and the plugin quietly renews the connection on its own.
- **A one-time sign-in.** Because the sign-in method changed, you'll need to log in to Garmin once after installing this update. After that it just keeps going.
- **Clearer messages.** If Garmin ever genuinely needs you to sign in again, the plugin shows a clear message with a "Log in again" button instead of silently pausing.
- **Fewer false alarms.** Temporary Garmin or network hiccups no longer pause auto-sync — the plugin waits and retries on its own.

### Privacy note

To keep you signed in, the plugin stores Garmin sign-in tokens locally in Obsidian's plugin data. It does not store your Garmin password. Use **Logout** in the plugin settings to clear them on this device.

## 0.9.7

This update makes Garmin auto-sync more reliable when Garmin sessions expire or need to be refreshed.

### Improved

- Auto-sync now checks first whether there is actually anything to sync before touching the Garmin session. This avoids unnecessary login/session checks while everything is still in cooldown.
- If Garmin requires a fresh login, auto-sync now pauses with a clear persistent message and a direct "Log in again" button.
- Auto-sync no longer opens a surprise Garmin login window in the background while you are just opening a daily note.
- Saved Garmin browser sessions are restored more reliably, so you should need to log in less often.

### Fixed

- Fixed cases where expired Garmin cookies could make the plugin think the session was still fresh.
- Fixed a race condition during login that could incorrectly report a login timeout.
- Reduced false auto-sync pauses when only some Garmin endpoints temporarily reject a request.

### Privacy note

Garmin session cookies may be stored locally in Obsidian's plugin data so the plugin can restore your session. The plugin does not store your Garmin password. Use **Logout** in the plugin settings to clear the saved Garmin session on this device.
