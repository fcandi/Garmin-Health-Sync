/**
 * Garmin OAuth1/OAuth2 token layer (M2 of the OAuth migration).
 *
 * Encapsulates the complete OAuth1-signed exchange with the Garmin APIs:
 *   - RFC-3986-Encoding and HMAC-SHA1 signature (WebCrypto, async)
 *   - Loading consumer keys (public S3 endpoint)
 *   - Service ticket → long-lived OAuth1 token (preauthorized endpoint)
 *   - OAuth1 token → short-lived OAuth2 token (exchange endpoint)
 *
 * Deliberate constraints:
 *   - No Node-crypto, no fetch → WebCrypto + Obsidian's requestUrl (mobile-compatible, CORS-free)
 *   - No process.env → domain is passed as a parameter
 *   - requestUrl is called with throw:false; HTTP status is evaluated explicitly
 */

import { requestUrl } from "obsidian";
import { GarminAuthError } from "../../errors";

// URL of the public consumer key endpoint (garth-style, no auth required)
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

// User-Agent for all OAuth calls (Android client, expected by Garmin).
// Exported so garmin-api.ts uses the same string for the Bearer calls
// (single source of truth instead of a duplicated constant).
export const OAUTH_UA = "com.garmin.android.apps.connectmobile";

// ---------------------------------------------------------------------------
// Exported interfaces
// ---------------------------------------------------------------------------

export interface Consumer {
	consumer_key: string;
	consumer_secret: string;
}

export interface OAuth1Token {
	oauth_token: string;
	oauth_token_secret: string;
	mfa_token?: string;
}

export interface OAuth2Token {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	refresh_token_expires_in?: number;
	/** Expiry timestamp in epoch seconds; set by withExpirations */
	expires_at: number;
	/** Expiry timestamp of the refresh token in epoch seconds; optional */
	refresh_token_expires_at?: number;
	token_type?: string;
	scope?: string;
}

// ---------------------------------------------------------------------------
// RFC-3986-Encoding
// ---------------------------------------------------------------------------

/**
 * Percent-encodes a string according to RFC 3986.
 * encodeURIComponent leaves `! * ' ( )` unencoded — these are replaced afterwards.
 */
export function rfc3986(s: string): string {
	return encodeURIComponent(s).replace(
		/[!*'()]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

// ---------------------------------------------------------------------------
// OAuth1 HMAC-SHA1 signature (WebCrypto, async)
// ---------------------------------------------------------------------------

/**
 * Builds the OAuth1 Authorization header (HMAC-SHA1).
 *
 * Signature mechanics (bit-identical to the verified prototype):
 *   1. Sort all parameters (Query + Body + oauth_*) by key
 *   2. Assemble the base URL without query string
 *   3. Base string: METHOD & rfc3986(baseUrl) & rfc3986(paramString)
 *   4. signing_key = rfc3986(consumer_secret) & rfc3986(token_secret || "")
 *   5. HMAC-SHA1 via WebCrypto → base64
 */
export async function oauth1Header(
	method: string,
	url: string,
	bodyParams: Record<string, string> | null,
	consumer: Consumer,
	token: OAuth1Token | null,
): Promise<string> {
	const u = new URL(url);

	// Nonce from 16 random bytes (hex-encoded)
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Array.from(nonceBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// Required OAuth parameters
	const oauth: Record<string, string> = {
		oauth_consumer_key: consumer.consumer_key,
		oauth_nonce: nonce,
		oauth_signature_method: "HMAC-SHA1",
		oauth_timestamp: String(Math.floor(Date.now() / 1000)),
		oauth_version: "1.0",
	};
	if (token?.oauth_token) {
		oauth["oauth_token"] = token.oauth_token;
	}

	// Merge all parameters: Query + Body + oauth_*
	const all: Record<string, string> = {};
	for (const [k, v] of u.searchParams) {
		all[k] = v;
	}
	for (const k in bodyParams ?? {}) {
		const val = (bodyParams ?? {})[k];
		if (val !== undefined) all[k] = val;
	}
	for (const k in oauth) {
		const val = oauth[k];
		if (val !== undefined) all[k] = val;
	}

	// Parameter string: sorted, RFC-3986-encoded
	const paramString = Object.keys(all)
		.sort()
		.map((k) => `${rfc3986(k)}=${rfc3986(all[k] ?? "")}`)
		.join("&");

	// Base URL without query string or fragment
	const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;

	// Signature base string
	const baseString = [
		method.toUpperCase(),
		rfc3986(baseUrl),
		rfc3986(paramString),
	].join("&");

	// Signing key: consumer_secret & token_secret (empty if no token present)
	const signingKey =
		`${rfc3986(consumer.consumer_secret)}&${rfc3986(token?.oauth_token_secret ?? "")}`;

	// HMAC-SHA1 via WebCrypto (async, mobile-compatible)
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingKey),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const sigBuffer = await crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(baseString),
	);

	// ArrayBuffer → base64
	oauth["oauth_signature"] = btoa(
		String.fromCharCode(...new Uint8Array(sigBuffer)),
	);

	// Assemble the Authorization header (sorted)
	return (
		"OAuth " +
		Object.keys(oauth)
			.sort()
			.map((k) => `${rfc3986(k)}="${rfc3986(oauth[k] ?? "")}"`)
			.join(", ")
	);
}

// ---------------------------------------------------------------------------
// Loading consumer keys
// ---------------------------------------------------------------------------

/**
 * Fetches the public consumer keys from the Garmin S3 endpoint.
 * No auth required; publicly accessible.
 */
export async function getConsumer(): Promise<Consumer> {
	let response;
	try {
		response = await requestUrl({ url: CONSUMER_URL, throw: false });
	} catch (e: unknown) {
		// Network error (DNS, timeout, etc.) → GarminAuthError with status 0
		const msg = e instanceof Error ? e.message : String(e);
		throw new GarminAuthError(0, `Loading consumer keys failed (network): ${msg}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`Loading consumer keys failed: HTTP ${response.status}`,
		);
	}
	return response.json as Consumer;
}

// ---------------------------------------------------------------------------
// Setting expiry times
// ---------------------------------------------------------------------------

/**
 * Sets expires_at and optionally refresh_token_expires_at based on nowSeconds.
 *
 * nowSeconds is passed as a parameter (for testability); the caller should use
 * Math.floor(Date.now() / 1000).
 */
export function withExpirations(token: OAuth2Token, nowSeconds: number): OAuth2Token {
	// Return a copy instead of mutating in place: calling this again on the same
	// object would otherwise double-extend expires_at (now + already-absolute expires_at).
	const result: OAuth2Token = { ...token, expires_at: nowSeconds + token.expires_in };
	if (token.refresh_token_expires_in !== undefined) {
		result.refresh_token_expires_at = nowSeconds + token.refresh_token_expires_in;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Service ticket → OAuth1 token
// ---------------------------------------------------------------------------

/**
 * Exchanges an SSO service ticket for a long-lived OAuth1 token.
 *
 * Endpoint: GET connectapi.<domain>/oauth-service/oauth/preauthorized
 * Response: x-www-form-urlencoded → OAuth1Token
 */
export async function getOAuth1(
	ticket: string,
	consumer: Consumer,
	domain: string,
	loginUrl?: string,
): Promise<OAuth1Token> {
	// login-url MUST match the `service` for which the ticket was issued.
	// Web embed flow (garth-style, BrowserWindow): https://sso.<domain>/sso/embed.
	const effectiveLoginUrl = loginUrl ?? `https://sso.${domain}/sso/embed`;
	const url =
		`https://connectapi.${domain}/oauth-service/oauth/preauthorized` +
		`?ticket=${encodeURIComponent(ticket)}` +
		`&login-url=${encodeURIComponent(effectiveLoginUrl)}` +
		`&accepts-mfa-tokens=true`;

	// OAuth1 header for GET without a token (consumer only)
	const authHeader = await oauth1Header("GET", url, null, consumer, null);

	let response;
	try {
		response = await requestUrl({
			url,
			method: "GET",
			headers: {
				"User-Agent": OAUTH_UA,
				Authorization: authHeader,
			},
			throw: false,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new GarminAuthError(0, `preauthorized failed (network): ${msg}`);
	}

	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`preauthorized failed: HTTP ${response.status}`,
		);
	}

	// Response is x-www-form-urlencoded
	const parsed = new URLSearchParams(response.text);
	const oauth_token = parsed.get("oauth_token");
	const oauth_token_secret = parsed.get("oauth_token_secret");

	if (!oauth_token || !oauth_token_secret) {
		throw new GarminAuthError(
			response.status,
			"preauthorized: oauth_token or oauth_token_secret missing from response",
		);
	}

	const result: OAuth1Token = { oauth_token, oauth_token_secret };
	const mfa = parsed.get("mfa_token");
	if (mfa) result.mfa_token = mfa;
	return result;
}

// ---------------------------------------------------------------------------
// OAuth1 token → OAuth2 token (silent-refresh core)
// ---------------------------------------------------------------------------

/**
 * Exchanges an OAuth1 token for a short-lived OAuth2 access token.
 *
 * Endpoint: POST connectapi.<domain>/oauth-service/oauth/exchange/user/2.0
 * Body: x-www-form-urlencoded (identical to the signed body)
 *
 * opts.login = true → appends audience=GARMIN_CONNECT_MOBILE_ANDROID_DI
 *   (only needed on the initial login; silent refresh omits this parameter)
 */
export async function exchange(
	oauth1: OAuth1Token,
	consumer: Consumer,
	domain: string,
	opts?: { login?: boolean },
): Promise<OAuth2Token> {
	const url = `https://connectapi.${domain}/oauth-service/oauth/exchange/user/2.0`;

	// Build body parameters (must be signed AND sent — identical content!)
	const body: Record<string, string> = {};
	if (opts?.login === true) {
		body["audience"] = "GARMIN_CONNECT_MOBILE_ANDROID_DI";
		// Send mfa_token ONLY on the initial login. Garmin treats it as
		// single-use; sending it on every silent refresh would trigger 401/403
		// and wrongly log the user out (garth semantics).
		if (oauth1.mfa_token) {
			body["mfa_token"] = oauth1.mfa_token;
		}
	}

	// OAuth1 header for POST with token and body parameters
	const authHeader = await oauth1Header("POST", url, body, consumer, oauth1);

	// Body as x-www-form-urlencoded string (identical to the signed content)
	const bodyString = new URLSearchParams(body).toString();

	let response;
	try {
		response = await requestUrl({
			url,
			method: "POST",
			headers: {
				"User-Agent": OAUTH_UA,
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: authHeader,
			},
			body: bodyString,
			throw: false,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new GarminAuthError(0, `exchange failed (network): ${msg}`);
	}

	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`exchange failed: HTTP ${response.status}`,
		);
	}

	const json = response.json as OAuth2Token;
	return withExpirations(json, Math.floor(Date.now() / 1000));
}
