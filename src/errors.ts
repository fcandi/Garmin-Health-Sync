export class LoginRequiredError extends Error {
	constructor(message = "login_required") {
		super(message);
		this.name = "LoginRequiredError";
	}
}

export function isLoginRequiredError(error: unknown): error is LoginRequiredError {
	return error instanceof LoginRequiredError
		|| (error instanceof Error && error.message === "login_required");
}

/** Carries the HTTP status of a failed Garmin OAuth/API call so the auth state
 *  machine can tell a dead OAuth1 grant (401/403 → needsUserLogin) apart from a
 *  transient failure (429/5xx/network → temporarilyUnavailable + backoff).
 *  `status === 0` is the sentinel for a network-level failure (no HTTP response). */
export class GarminAuthError extends Error {
	readonly status: number;

	constructor(status: number, message?: string) {
		super(message ?? `garmin_auth_error_${status}`);
		this.name = "GarminAuthError";
		this.status = status;
	}
}

export function isGarminAuthError(error: unknown): error is GarminAuthError {
	return error instanceof GarminAuthError;
}

/** Auth failure: the OAuth1 grant / token is no longer accepted by Garmin.
 *  Per the migration concept, Garmin answers 401 OR 403 when the token is
 *  missing or expired — both must pause auto-sync (needsUserLogin). The legacy
 *  code only checked 401; the added 403 is the documented side-finding. */
export function isAuthFailureStatus(status: number): boolean {
	return status === 401 || status === 403;
}

/** Transient failure: retry with backoff, never log out. Covers rate limiting
 *  (429), server-side errors (5xx) and network-level failures (status ≤ 0).
 *  The state machine treats every non-auth-failure as transient by default;
 *  this helper exists for explicit, readable checks. */
export function isTransientStatus(status: number): boolean {
	return status === 429 || status >= 500 || status <= 0;
}
