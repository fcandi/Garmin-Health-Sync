import { isAuthFailureStatus } from "../../errors";

/** Auth states of the Garmin provider. Replaces the binary `autoSyncPaused` and
 *  prevents the core bug "a single failed refresh permanently disables auto-sync".
 *  Only `needsUserLogin` pauses permanently. */
export type AuthState =
	| "unknown"                  // Initial state, not yet checked
	| "ready"                    // Valid OAuth2 (or renewable via OAuth1) — auto-sync running
	| "refreshing"               // OAuth2 is currently being renewed via OAuth1 (transient)
	| "temporarilyUnavailable"   // Transient error (network/429/5xx/empty) — retry with Backoff
	| "needsUserLogin";          // OAuth1 dead/rejected (401/403) — ONLY permanently pausing state

// Backoff (confirmed 2026-06-03): exponential 1min → 2 → 4 → 8 → 16 → 30 (cap),
// NO hard max — auto-sync remains fundamentally active and keeps retrying.
const BACKOFF_BASE_MS = 60_000;      // 1 minute
const BACKOFF_CAP_MS = 30 * 60_000;  // 30 minutes

/** Small state machine for auth/refresh logic. `now` is injectable
 *  (default `Date.now()`) so that transitions remain testable. */
export class AuthStateMachine {
	private _state: AuthState = "unknown";
	private transientCount = 0;
	private _nextRetryAt = 0;

	get state(): AuthState {
		return this._state;
	}

	/** Earliest point in time (epoch ms) for the next auto-sync attempt in
	 *  state `temporarilyUnavailable`. 0 if no Backoff is active. */
	get nextRetryAt(): number {
		return this._nextRetryAt;
	}

	/** An OAuth2 refresh is currently running (transient). Blocks parallel batches
	 *  until it is resolved via onSuccess/onTransientError/onAuthError. */
	beginRefresh(): void {
		if (this._state === "needsUserLogin") return; // must re-login first
		this._state = "refreshing";
	}

	/** Successful refresh or successful data fetch → ready again;
	 *  reset Backoff. */
	onSuccess(): void {
		this._state = "ready";
		this.transientCount = 0;
		this._nextRetryAt = 0;
	}

	/** Fresh interactive login by the user → reset from any state
	 *  (including from needsUserLogin). */
	onLogin(): void {
		this.onSuccess();
	}

	/** Transient error (network/429/5xx/timeout/empty response): do NOT
	 *  log out, increment Backoff, keep auto-sync fundamentally active. */
	onTransientError(now = Date.now()): void {
		if (this._state === "needsUserLogin") return; // permanent state takes priority
		this.transientCount++;
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.transientCount - 1), BACKOFF_CAP_MS);
		this._nextRetryAt = now + delay;
		this._state = "temporarilyUnavailable";
	}

	/** Auth error (401/403 from exchange = OAuth1 permanently dead): ONLY
	 *  state that permanently pauses auto-sync. */
	onAuthError(): void {
		this._state = "needsUserLogin";
		this._nextRetryAt = 0;
	}

	/** Classifies an HTTP status and executes the appropriate transition.
	 *  Keeps the "401/403 → needsUserLogin, else → transient" rule in ONE
	 *  place (incl. the 403 side-finding). */
	onHttpError(status: number, now = Date.now()): void {
		if (isAuthFailureStatus(status)) {
			this.onAuthError();
		} else {
			this.onTransientError(now);
		}
	}

	/** Is auto-sync allowed to start an attempt right now? */
	shouldAttemptSync(now = Date.now()): boolean {
		switch (this._state) {
			case "needsUserLogin":
				return false; // permanently paused until re-login
			case "temporarilyUnavailable":
				return now >= this._nextRetryAt; // only after the Backoff has elapsed
			case "refreshing":
				return false; // a refresh is already running — do not start a second batch
			case "unknown":
			case "ready":
			default:
				return true;
		}
	}

	/** Is auto-sync permanently paused (only needsUserLogin)? For UI/settings,
	 *  replaces the meaning of the old `autoSyncPaused` flag. */
	isPausedForLogin(): boolean {
		return this._state === "needsUserLogin";
	}

	/** Full reset (e.g. after logout). */
	reset(): void {
		this._state = "unknown";
		this.transientCount = 0;
		this._nextRetryAt = 0;
	}
}
