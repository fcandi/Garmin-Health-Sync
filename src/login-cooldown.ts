import type { App } from "obsidian";

/** Client-side pause between credential sign-in attempts after Garmin pushed back
 *  (HTTP 429 / 403 / CAPTCHA). Garmin publishes no cooldown length and its bot protection
 *  also reacts to client fingerprint, so these waits are estimates: escalating and persisted
 *  per device so repeated retries do not dig the hole deeper. Observed on a real device: a
 *  429 from the sign-in endpoint was still active more than 8 minutes after the first block,
 *  so the first step is deliberately long. */
const STORAGE_KEY = "garmin-health-sync-login-cooldown";
const STEPS_SECONDS = [300, 900, 1800, 3600];
const MAX_WAIT_SECONDS = 3600;
/** Strikes older than this are forgotten. */
const STRIKE_MEMORY_MS = 2 * 60 * 60 * 1000;

interface CooldownState {
	until: number;
	strikes: number;
	lastAttemptAt: number;
	lastStrikeAt: number;
}

const EMPTY: CooldownState = { until: 0, strikes: 0, lastAttemptAt: 0, lastStrikeAt: 0 };

/** Escalating wait for the n-th consecutive block (1-based), in seconds. */
export function backoffSeconds(strikes: number): number {
	const i = Math.min(Math.max(strikes, 1), STEPS_SECONDS.length) - 1;
	return STEPS_SECONDS[i] ?? 3600;
}

export function formatCountdown(totalSeconds: number): string {
	const s = Math.max(0, Math.ceil(totalSeconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class LoginCooldown {
	constructor(private readonly app: App, private readonly now: () => number = Date.now) {}

	private load(): CooldownState {
		try {
			const raw: unknown = this.app.loadLocalStorage(STORAGE_KEY);
			if (raw && typeof raw === "object") {
				const r = raw as Partial<CooldownState>;
				return {
					until: Number(r.until) || 0,
					strikes: Number(r.strikes) || 0,
					lastAttemptAt: Number(r.lastAttemptAt) || 0,
					lastStrikeAt: Number(r.lastStrikeAt) || 0,
				};
			}
		} catch { /* storage unavailable: behave as if no cooldown */ }
		return { ...EMPTY };
	}

	private save(state: CooldownState): void {
		try { this.app.saveLocalStorage(STORAGE_KEY, state); } catch { /* best effort */ }
	}

	remainingSeconds(): number {
		// Clamp so a clock that moved backwards (or a bad stored value) cannot lock sign-in for long.
		return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.ceil((this.load().until - this.now()) / 1000)));
	}

	strikes(): number {
		return this.load().strikes;
	}

	/** Records an attempt; returns seconds since the previous one (null if none known). */
	noteAttempt(): number | null {
		const state = this.load();
		const ago = state.lastAttemptAt > 0 ? Math.round((this.now() - state.lastAttemptAt) / 1000) : null;
		this.save({ ...state, lastAttemptAt: this.now() });
		return ago;
	}

	/** Garmin refused the attempt: start (or extend) the wait. `retryAfterSeconds` is the
	 *  server's own hint, used when it asks for more than our estimate. Returns the wait. */
	registerBlock(retryAfterSeconds?: number): number {
		const state = this.load();
		const stale = this.now() - state.lastStrikeAt > STRIKE_MEMORY_MS;
		const strikes = (stale ? 0 : state.strikes) + 1;
		const hint = retryAfterSeconds && retryAfterSeconds > 0 ? Math.min(retryAfterSeconds, MAX_WAIT_SECONDS) : 0;
		const wait = Math.max(backoffSeconds(strikes), hint);
		this.save({
			until: this.now() + wait * 1000,
			strikes,
			lastAttemptAt: state.lastAttemptAt,
			lastStrikeAt: this.now(),
		});
		return wait;
	}

	/** Successful sign-in: forget everything. */
	reset(): void {
		this.save({ ...EMPTY });
	}
}
