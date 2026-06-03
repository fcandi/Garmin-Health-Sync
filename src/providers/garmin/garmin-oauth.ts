/**
 * Garmin OAuth1/OAuth2 Token-Layer (M2 der OAuth-Migration).
 *
 * Kapselt den vollständigen OAuth1-signierten Austausch mit den Garmin-APIs:
 *   - RFC-3986-Encoding und HMAC-SHA1-Signatur (WebCrypto, async)
 *   - Consumer-Keys laden (öffentlicher S3-Endpunkt)
 *   - Service-Ticket → langlebiges OAuth1-Token (preauthorized-Endpunkt)
 *   - OAuth1-Token → kurzlebiges OAuth2-Token (exchange-Endpunkt)
 *
 * Bewusste Einschränkungen:
 *   - Kein Node-crypto, kein fetch → WebCrypto + Obsidians requestUrl (mobile-tauglich, CORS-frei)
 *   - Kein process.env → domain kommt als Parameter
 *   - requestUrl wird mit throw:false aufgerufen; HTTP-Status wird explizit ausgewertet
 */

import { requestUrl } from "obsidian";
import { GarminAuthError } from "../../errors";

// URL des öffentlichen Consumer-Key-Endpunkts (garth-Stil, kein Auth nötig)
const CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json";

// User-Agent für alle OAuth-Aufrufe (Android-Client, Garmin-Erwartung).
// Exportiert, damit garmin-api.ts denselben String für die Bearer-Aufrufe nutzt
// (single source of truth statt doppelter Konstante).
export const OAUTH_UA = "com.garmin.android.apps.connectmobile";

// ---------------------------------------------------------------------------
// Exportierte Interfaces
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
	/** Ablaufzeitpunkt in Epoch-Sekunden; von withExpirations gesetzt */
	expires_at: number;
	/** Ablaufzeitpunkt des Refresh-Tokens in Epoch-Sekunden; optional */
	refresh_token_expires_at?: number;
	token_type?: string;
	scope?: string;
}

// ---------------------------------------------------------------------------
// RFC-3986-Encoding
// ---------------------------------------------------------------------------

/**
 * Percent-encodiert einen String nach RFC 3986.
 * encodeURIComponent lässt `! * ' ( )` uncodiert — diese werden nachträglich ersetzt.
 */
export function rfc3986(s: string): string {
	return encodeURIComponent(s).replace(
		/[!*'()]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

// ---------------------------------------------------------------------------
// OAuth1-HMAC-SHA1-Signatur (WebCrypto, async)
// ---------------------------------------------------------------------------

/**
 * Erzeugt den OAuth1-Authorization-Header (HMAC-SHA1).
 *
 * Signaturmechanik (bit-identisch zum verifizierten Prototyp):
 *   1. Alle Parameter (Query + Body + oauth_*) nach Schlüssel sortieren
 *   2. Basis-URL ohne Query zusammensetzen
 *   3. Base-String: METHOD & rfc3986(baseUrl) & rfc3986(paramString)
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

	// Nonce aus 16 zufälligen Bytes (hex-kodiert)
	const nonceBytes = new Uint8Array(16);
	crypto.getRandomValues(nonceBytes);
	const nonce = Array.from(nonceBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	// OAuth-Pflichtparameter
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

	// Alle Parameter zusammenführen: Query + Body + oauth_*
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

	// Parameter-String: sortiert, RFC-3986-codiert
	const paramString = Object.keys(all)
		.sort()
		.map((k) => `${rfc3986(k)}=${rfc3986(all[k] ?? "")}`)
		.join("&");

	// Basis-URL ohne Query/Fragment
	const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;

	// Signatur-Basis-String
	const baseString = [
		method.toUpperCase(),
		rfc3986(baseUrl),
		rfc3986(paramString),
	].join("&");

	// Signing-Key: consumer_secret & token_secret (leer falls kein Token)
	const signingKey =
		`${rfc3986(consumer.consumer_secret)}&${rfc3986(token?.oauth_token_secret ?? "")}`;

	// HMAC-SHA1 via WebCrypto (async, mobile-tauglich)
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

	// Authorization-Header zusammensetzen (sortiert)
	return (
		"OAuth " +
		Object.keys(oauth)
			.sort()
			.map((k) => `${rfc3986(k)}="${rfc3986(oauth[k] ?? "")}"`)
			.join(", ")
	);
}

// ---------------------------------------------------------------------------
// Consumer-Keys laden
// ---------------------------------------------------------------------------

/**
 * Lädt die öffentlichen Consumer-Keys vom Garmin-S3-Endpunkt.
 * Kein Auth nötig; öffentlich zugänglich.
 */
export async function getConsumer(): Promise<Consumer> {
	let response;
	try {
		response = await requestUrl({ url: CONSUMER_URL, throw: false });
	} catch (e: unknown) {
		// Netzwerkfehler (DNS, Timeout etc.) → GarminAuthError mit Status 0
		const msg = e instanceof Error ? e.message : String(e);
		throw new GarminAuthError(0, `Consumer-Keys laden fehlgeschlagen (Netzwerk): ${msg}`);
	}
	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`Consumer-Keys laden fehlgeschlagen: HTTP ${response.status}`,
		);
	}
	return response.json as Consumer;
}

// ---------------------------------------------------------------------------
// Ablaufzeiten setzen
// ---------------------------------------------------------------------------

/**
 * Setzt expires_at und ggf. refresh_token_expires_at anhand von nowSeconds.
 *
 * nowSeconds als Parameter übergeben (Testbarkeit); Aufrufer darf
 * Math.floor(Date.now() / 1000) verwenden.
 */
export function withExpirations(token: OAuth2Token, nowSeconds: number): OAuth2Token {
	// Kopie statt In-place-Mutation: ein erneuter Aufruf auf demselben Objekt
	// würde sonst expires_at doppelt verlängern (now + bereits-absolutes expires_at).
	const result: OAuth2Token = { ...token, expires_at: nowSeconds + token.expires_in };
	if (token.refresh_token_expires_in !== undefined) {
		result.refresh_token_expires_at = nowSeconds + token.refresh_token_expires_in;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Service-Ticket → OAuth1-Token
// ---------------------------------------------------------------------------

/**
 * Tauscht ein SSO-Service-Ticket gegen ein langlebiges OAuth1-Token.
 *
 * Endpunkt: GET connectapi.<domain>/oauth-service/oauth/preauthorized
 * Antwort: x-www-form-urlencoded → OAuth1Token
 */
export async function getOAuth1(
	ticket: string,
	consumer: Consumer,
	domain: string,
	loginUrl?: string,
): Promise<OAuth1Token> {
	// login-url MUSS zum `service` passen, für den das Ticket ausgestellt wurde.
	// Web-Embed-Flow (garth-Stil, BrowserWindow): https://sso.<domain>/sso/embed.
	const effectiveLoginUrl = loginUrl ?? `https://sso.${domain}/sso/embed`;
	const url =
		`https://connectapi.${domain}/oauth-service/oauth/preauthorized` +
		`?ticket=${encodeURIComponent(ticket)}` +
		`&login-url=${encodeURIComponent(effectiveLoginUrl)}` +
		`&accepts-mfa-tokens=true`;

	// OAuth1-Header für GET ohne Token (nur Consumer)
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
		throw new GarminAuthError(0, `preauthorized fehlgeschlagen (Netzwerk): ${msg}`);
	}

	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`preauthorized fehlgeschlagen: HTTP ${response.status}`,
		);
	}

	// Antwort ist x-www-form-urlencoded
	const parsed = new URLSearchParams(response.text);
	const oauth_token = parsed.get("oauth_token");
	const oauth_token_secret = parsed.get("oauth_token_secret");

	if (!oauth_token || !oauth_token_secret) {
		throw new GarminAuthError(
			response.status,
			"preauthorized: oauth_token oder oauth_token_secret fehlt in der Antwort",
		);
	}

	const result: OAuth1Token = { oauth_token, oauth_token_secret };
	const mfa = parsed.get("mfa_token");
	if (mfa) result.mfa_token = mfa;
	return result;
}

// ---------------------------------------------------------------------------
// OAuth1-Token → OAuth2-Token (Silent-Refresh-Kern)
// ---------------------------------------------------------------------------

/**
 * Tauscht ein OAuth1-Token gegen ein kurzlebiges OAuth2-Access-Token.
 *
 * Endpunkt: POST connectapi.<domain>/oauth-service/oauth/exchange/user/2.0
 * Body: x-www-form-urlencoded (identisch mit dem signierten Body)
 *
 * opts.login = true → fügt audience=GARMIN_CONNECT_MOBILE_ANDROID_DI hinzu
 *   (nur beim ersten Login nötig; Silent-Refresh ohne diesen Parameter)
 */
export async function exchange(
	oauth1: OAuth1Token,
	consumer: Consumer,
	domain: string,
	opts?: { login?: boolean },
): Promise<OAuth2Token> {
	const url = `https://connectapi.${domain}/oauth-service/oauth/exchange/user/2.0`;

	// Body-Parameter aufbauen (müssen signiert UND gesendet werden — gleicher Inhalt!)
	const body: Record<string, string> = {};
	if (opts?.login === true) {
		body["audience"] = "GARMIN_CONNECT_MOBILE_ANDROID_DI";
		// mfa_token NUR beim initialen Login mitsenden. Garmin behandelt es als
		// einmalig; bei jedem Silent-Refresh mitgeschickt würde es 401/403
		// provozieren und den Nutzer fälschlich ausloggen (garth-Semantik).
		if (oauth1.mfa_token) {
			body["mfa_token"] = oauth1.mfa_token;
		}
	}

	// OAuth1-Header für POST MIT Token und Body-Parametern
	const authHeader = await oauth1Header("POST", url, body, consumer, oauth1);

	// Body als x-www-form-urlencoded-String (identisch mit dem signierten Inhalt)
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
		throw new GarminAuthError(0, `exchange fehlgeschlagen (Netzwerk): ${msg}`);
	}

	if (response.status < 200 || response.status >= 300) {
		throw new GarminAuthError(
			response.status,
			`exchange fehlgeschlagen: HTTP ${response.status}`,
		);
	}

	const json = response.json as OAuth2Token;
	return withExpirations(json, Math.floor(Date.now() / 1000));
}
