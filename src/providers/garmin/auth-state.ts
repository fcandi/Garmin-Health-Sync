import { isAuthFailureStatus } from "../../errors";

/** Auth-Zustände des Garmin-Providers. Ersetzt das binäre `autoSyncPaused` und
 *  verhindert den Kern-Bug „ein einzelner missglückter Refresh schaltet den
 *  Auto-Sync dauerhaft ab". Nur `needsUserLogin` pausiert dauerhaft. */
export type AuthState =
	| "unknown"                  // Startzustand, noch nicht geprüft
	| "ready"                    // gültiges OAuth2 (oder per OAuth1 erneuerbar) — Auto-Sync läuft
	| "refreshing"               // OAuth2 wird gerade via OAuth1 erneuert (transient)
	| "temporarilyUnavailable"   // transienter Fehler (Netzwerk/429/5xx/leer) — Retry mit Backoff
	| "needsUserLogin";          // OAuth1 tot/abgelehnt (401/403) — EINZIGER dauerhaft pausierende Zustand

// Backoff (bestätigt 2026-06-03): exponentiell 1min → 2 → 4 → 8 → 16 → 30 (Cap),
// KEIN Hard-Max — der Auto-Sync bleibt grundsätzlich aktiv und versucht es weiter.
const BACKOFF_BASE_MS = 60_000;      // 1 Minute
const BACKOFF_CAP_MS = 30 * 60_000;  // 30 Minuten

/** Kleine Zustandsmaschine für die Auth-/Refresh-Logik. `now` ist injizierbar
 *  (Default `Date.now()`), damit die Übergänge testbar bleiben. */
export class AuthStateMachine {
	private _state: AuthState = "unknown";
	private transientCount = 0;
	private _nextRetryAt = 0;

	get state(): AuthState {
		return this._state;
	}

	/** Frühester Zeitpunkt (epoch ms) für den nächsten Auto-Sync-Versuch im
	 *  Zustand `temporarilyUnavailable`. 0, wenn kein Backoff aktiv. */
	get nextRetryAt(): number {
		return this._nextRetryAt;
	}

	/** Ein OAuth2-Refresh läuft gerade (transient). Blockt parallele Batches,
	 *  bis er per onSuccess/onTransientError/onAuthError aufgelöst wird. */
	beginRefresh(): void {
		if (this._state === "needsUserLogin") return; // erst neu anmelden
		this._state = "refreshing";
	}

	/** Erfolgreicher Refresh oder erfolgreicher Datenabruf → wieder einsatzbereit;
	 *  Backoff zurücksetzen. */
	onSuccess(): void {
		this._state = "ready";
		this.transientCount = 0;
		this._nextRetryAt = 0;
	}

	/** Frischer interaktiver Login durch den Nutzer → Reset aus jedem Zustand
	 *  (auch aus needsUserLogin heraus). */
	onLogin(): void {
		this.onSuccess();
	}

	/** Transienter Fehler (Netzwerk/429/5xx/Timeout/leere Antwort): NICHT
	 *  ausloggen, Backoff hochzählen, Auto-Sync grundsätzlich aktiv lassen. */
	onTransientError(now = Date.now()): void {
		if (this._state === "needsUserLogin") return; // dauerhafter Zustand hat Vorrang
		this.transientCount++;
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.transientCount - 1), BACKOFF_CAP_MS);
		this._nextRetryAt = now + delay;
		this._state = "temporarilyUnavailable";
	}

	/** Auth-Fehler (401/403 vom exchange = OAuth1 endgültig tot): EINZIGER
	 *  Zustand, der den Auto-Sync dauerhaft pausiert. */
	onAuthError(): void {
		this._state = "needsUserLogin";
		this._nextRetryAt = 0;
	}

	/** Klassifiziert einen HTTP-Status und führt den passenden Übergang aus.
	 *  Hält die „401/403 → needsUserLogin, sonst → transient"-Regel an EINER
	 *  Stelle (inkl. des 403-Nebenbefunds). */
	onHttpError(status: number, now = Date.now()): void {
		if (isAuthFailureStatus(status)) {
			this.onAuthError();
		} else {
			this.onTransientError(now);
		}
	}

	/** Darf der Auto-Sync jetzt einen Versuch starten? */
	shouldAttemptSync(now = Date.now()): boolean {
		switch (this._state) {
			case "needsUserLogin":
				return false; // dauerhaft pausiert bis zum Re-Login
			case "temporarilyUnavailable":
				return now >= this._nextRetryAt; // erst nach Ablauf des Backoffs
			case "refreshing":
				return false; // ein Refresh läuft bereits — keinen zweiten Batch starten
			case "unknown":
			case "ready":
			default:
				return true;
		}
	}

	/** Pausiert der Auto-Sync dauerhaft (nur needsUserLogin)? Für UI/Settings,
	 *  ersetzt die Bedeutung des alten `autoSyncPaused`-Flags. */
	isPausedForLogin(): boolean {
		return this._state === "needsUserLogin";
	}

	/** Vollständiger Reset (z.B. nach Logout). */
	reset(): void {
		this._state = "unknown";
		this.transientCount = 0;
		this._nextRetryAt = 0;
	}
}
