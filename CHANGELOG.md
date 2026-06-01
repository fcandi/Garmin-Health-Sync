# Changelog

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
