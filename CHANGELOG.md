# Changelog

## 0.9.11

### Internal

- Resolve a community-directory review finding: the manual-login ticket field now uses a translatable, sentence-case placeholder instead of a hardcoded one, removing a disallowed lint-rule exception. No change to how the login works.

## 0.9.10

A reliability release focused on the Garmin login.

### Added

- **Sign in via browser** — a guided login that completes the sign-in in your normal web browser and hands the result back to the plugin. Start it from the plugin settings, or let the plugin open it for you automatically when the in-app login window can't finish. After you sign in, **Sign in from clipboard** completes the login in one click — no copy-pasting of tokens.

### Fixed

- The Garmin login is much more robust (issue #6). The in-app login window now identifies as a normal desktop browser, keeps the sign-in in its own session, and reads the login ticket directly from the network — so it completes on setups where it previously stalled or jumped to an external browser. Where the embedded window still can't finish, the guided browser login takes over instead of failing.
- If the public OAuth key endpoint is blocked on your network, the plugin falls back to bundled keys instead of failing the login.
- Empty API responses (for example heart-rate variability on a day with no reading) no longer raise an error during sync.

## 0.9.10-beta.7

### Fixed

- Login (issue #6): capture the SSO service ticket at the network layer, not just
  via DOM/navigation events. The login window's session now watches
  `webRequest.onBeforeRedirect`/`onCompleted` for the `302 → /sso/embed?ticket=ST-…`
  and reads the ticket straight from the redirect — so it is captured even when the
  embedded window fires no `did-navigate` and even if the follow-up navigation
  escapes to the system browser. The same hook logs each `/sso/signin` request's
  HTTP status, which pins down whether the sign-in stalls on a capture problem or a
  Cloudflare block. Registration is guarded so it can never disturb the existing
  capture paths.

### Changed

- The guided browser login is now a clearly offered path rather than a dead end:
  the "Sign in via browser" button has an explanatory tooltip, and when the in-app
  sign-in produces no ticket the plugin shows a short notice before opening the
  guided browser login instead of popping the dialog wordlessly.

## 0.9.10-beta.6

### Fixed

- Login (issue #6): on setups where the embedded sign-in never hands the ticket
  to the login window (it stalls on the form or escapes to the system browser),
  the plugin could only fail. The login window now presents a stock desktop-Chrome
  User-Agent (no `obsidian`/`Electron` markers) and uses its own persistent
  session, so Garmin treats it like the regular browser in which the manual login
  already works. And if no ticket is captured, the plugin now automatically opens
  the guided browser login instead of reporting a bare failure.

### Added

- Manual login: a "Sign in from clipboard" button that reads the `ST-…` ticket
  (or the full result-page address) straight from the clipboard, so completing
  the guided browser login is a single click — no manual pasting.

## 0.9.10-beta.5

### Fixed

- Login (issue #6): for accounts where Garmin delivers the sign-in ticket by
  opening the service URL in a *new* window, Obsidian forwarded that open to the
  system browser and the one-time ticket was lost. The login window now
  intercepts the new-window hand-off at the Electron main-process level
  (`setWindowOpenHandler`), reads the ticket straight from the URL, and keeps it
  inside the plugin — so the login completes even if a browser window still
  briefly appears.
- Tolerate empty API responses (e.g. heart-rate variability on a day with no
  reading): an empty `200` body no longer raises a JSON parse error mid-fetch.

## 0.9.10-beta.4

### Fixed

- Two more ways the embedded login could escape to the system browser on
  credential submit (issue #6): a programmatic `form.submit()` carrying a
  `target` (fires no submit event, so the previous listener never saw it) and a
  `<base target>` default browsing context. The login window now strips every
  `target` attribute proactively (including dynamically added ones) and patches
  `form.submit()` directly.

### Internal

- The login window now logs all navigation events and in-page interception
  diagnostics (`GHS_DIAG`, ticket-redacted, no query strings) to the developer
  console, so bug reports can name the exact escape vector.

## 0.9.10-beta.3

### Added

- Manual login fallback (issue #6): if the embedded Garmin login window never
  completes the sign-in — it silently stalls on the form for some accounts, or
  escapes to the system browser — you can now finish the login yourself. The new
  **Manual login** button in settings (or the "Log in with service ticket" command)
  opens the Garmin sign-in page in your browser; after signing in you paste the
  resulting `ticket=ST-…` address back into the plugin and the regular token
  exchange takes over. Verified end-to-end by an affected tester (7/7 days synced).

### Fixed

- Login no longer fails on networks where AWS S3 is blocked (issue #6): the public
  OAuth consumer keys were fetched exclusively from a third-party S3 bucket, making
  it a single point of failure even when Garmin itself was reachable. The plugin
  now falls back to bundled keys (identical, long-stable values) whenever that
  fetch fails.

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
