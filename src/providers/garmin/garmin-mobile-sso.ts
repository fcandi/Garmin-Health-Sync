/**
 * Browser-free Garmin sign-in (the flow the Garmin Connect mobile app uses).
 *
 * POST sso.<domain>/mobile/api/login      {username, password, ...}  → service ticket | MFA challenge
 * POST sso.<domain>/mobile/api/mfa/verifyCode {mfaVerificationCode, ...} → service ticket
 *
 * The resulting ticket is exchanged by the regular ticket → OAuth1 → OAuth2 path
 * (garmin-oauth.ts), so nothing downstream changes. Needs no Electron/Node APIs, which
 * makes it usable on Obsidian mobile where the BrowserWindow login does not exist.
 *
 * Constraints:
 *   - requestUrl only (no fetch, no cookie jar): the SSO session cookie that links the
 *     password step to the MFA step is carried by hand.
 *   - The password only ever leaves the device towards sso.garmin.com / sso.garmin.cn.
 *     Nothing in this file logs request bodies, tickets or cookie values.
 */

import { requestUrl } from "obsidian";

const ALLOWED_DOMAINS = ["garmin.com", "garmin.cn"];
const CLIENT_ID = "GCM_IOS_DARK";
const LOGIN_UA =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

export type MobileSsoFailure =
	| "invalid_credentials"
	| "blocked"        // HTTP 403 / non-JSON reply: Cloudflare bot protection
	| "rate_limited"   // HTTP 429
	| "captcha"
	| "mfa_failed"
	| "network"
	| "unexpected";

export interface MfaChallenge {
	method: string;
	cookies: Record<string, string>;
}

export type MobileSsoResult =
	| { kind: "ticket"; ticket: string }
	| { kind: "mfa"; challenge: MfaChallenge }
	| { kind: "error"; reason: MobileSsoFailure; detail: string; retryAfter?: number };

/** CAS `service` the mobile client signs in for; ticket exchange must use the same value. */
export function getMobileServiceUrl(domain: string): string {
	return `https://mobile.integration.${domain}/gcm/ios`;
}

function endpoint(domain: string, path: string): string {
	// Domain allowlist: never send credentials to an arbitrary host.
	if (!ALLOWED_DOMAINS.includes(domain)) throw new Error(`unsupported_domain`);
	const qs = new URLSearchParams({
		clientId: CLIENT_ID,
		locale: "en-US",
		service: getMobileServiceUrl(domain),
	});
	return `https://sso.${domain}/mobile/api/${path}?${qs.toString()}`;
}

/** Merges Set-Cookie headers into `jar`. Depending on the platform requestUrl exposes the
 *  header as one string (several cookies folded into one comma-joined value) or as an array
 *  of strings (Node-based desktop stack). The lookahead avoids splitting inside
 *  `Expires=Thu, 01 Jan …`. */
export function collectCookies(headers: Record<string, unknown> | undefined, jar: Record<string, string>): void {
	if (!headers) return;
	const key = Object.keys(headers).find((k) => k.toLowerCase() === "set-cookie");
	const raw = key ? headers[key] : undefined;
	const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const part of value.split(/,(?=\s*[A-Za-z0-9_.-]+=)/)) {
			const pair = part.split(";")[0] ?? "";
			const i = pair.indexOf("=");
			if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
		}
	}
}

function cookieHeader(jar: Record<string, string>): string {
	return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function post(
	domain: string,
	path: string,
	body: Record<string, unknown>,
	jar: Record<string, string>,
): Promise<MobileSsoResult | { kind: "json"; json: Record<string, unknown>; status: number }> {
	const headers: Record<string, string> = {
		"User-Agent": LOGIN_UA,
		Accept: "application/json, text/plain, */*",
		"Content-Type": "application/json",
		Origin: `https://sso.${domain}`,
	};
	if (Object.keys(jar).length > 0) headers["Cookie"] = cookieHeader(jar);

	let res;
	try {
		res = await requestUrl({
			url: endpoint(domain, path),
			method: "POST",
			headers,
			body: JSON.stringify(body),
			throw: false,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return { kind: "error", reason: "network", detail: `${path}: network error (${msg})` };
	}

	try {
		collectCookies(res.headers, jar);
	} catch { /* a cookie we cannot parse must not abort the sign-in */ }

	if (res.status === 429) {
		const key = Object.keys(res.headers).find((k) => k.toLowerCase() === "retry-after");
		const hint = key ? Number(res.headers[key]) : NaN;
		return {
			kind: "error",
			reason: "rate_limited",
			detail: `${path}: HTTP 429${Number.isFinite(hint) ? `, retry-after=${hint}s` : ""}`,
			...(Number.isFinite(hint) ? { retryAfter: hint } : {}),
		};
	}
	if (res.status === 403) return { kind: "error", reason: "blocked", detail: `${path}: HTTP 403` };

	let json: Record<string, unknown> | null = null;
	try {
		json = res.json as Record<string, unknown> | null;
	} catch {
		json = null;
	}
	if (!json || typeof json !== "object") {
		return { kind: "error", reason: "blocked", detail: `${path}: HTTP ${res.status}, non-JSON reply` };
	}
	return { kind: "json", json, status: res.status };
}

function statusType(json: Record<string, unknown>): string {
	const rs = json["responseStatus"];
	if (rs && typeof rs === "object") {
		const type = (rs as Record<string, unknown>)["type"];
		if (typeof type === "string") return type;
	}
	return "";
}

function ticketOf(json: Record<string, unknown>): string {
	const t = json["serviceTicketId"];
	return typeof t === "string" ? t : "";
}

/** Step 1: email + password. Resolves to a ticket, an MFA challenge or a typed error. */
export async function mobileLogin(domain: string, email: string, password: string): Promise<MobileSsoResult> {
	const jar: Record<string, string> = {};
	const r = await post(
		domain,
		"login",
		{ username: email, password, rememberMe: true, captchaToken: "" },
		jar,
	);
	if (r.kind !== "json") return r;

	const type = statusType(r.json);
	const ticket = ticketOf(r.json);
	if (type === "SUCCESSFUL" && ticket) return { kind: "ticket", ticket };
	if (type === "MFA_REQUIRED") {
		const info = r.json["customerMfaInfo"];
		const last = info && typeof info === "object" ? (info as Record<string, unknown>)["mfaLastMethodUsed"] : undefined;
		return { kind: "mfa", challenge: { method: typeof last === "string" ? last : "email", cookies: jar } };
	}
	if (type === "INVALID_USERNAME_PASSWORD") {
		return { kind: "error", reason: "invalid_credentials", detail: `login: ${type}` };
	}
	if (type === "CAPTCHA_REQUIRED") return { kind: "error", reason: "captcha", detail: `login: ${type}` };
	return { kind: "error", reason: "unexpected", detail: `login: HTTP ${r.status}, responseStatus=${type || "none"}` };
}

/** Step 2 (only after an MFA challenge): the code Garmin sent by email/SMS. */
export async function mobileVerifyMfa(domain: string, challenge: MfaChallenge, code: string): Promise<MobileSsoResult> {
	const r = await post(
		domain,
		"mfa/verifyCode",
		{
			mfaMethod: challenge.method,
			mfaVerificationCode: code.trim(),
			rememberMyBrowser: true,
			reconsentList: [],
			mfaSetup: false,
		},
		challenge.cookies,
	);
	if (r.kind !== "json") return r;

	const type = statusType(r.json);
	const ticket = ticketOf(r.json);
	if (type === "SUCCESSFUL" && ticket) return { kind: "ticket", ticket };
	// No session cookie visible on this platform: the code can't be verified, which is not a typo.
	const noCookies = Object.keys(challenge.cookies).length === 0;
	return {
		kind: "error",
		reason: noCookies ? "unexpected" : "mfa_failed",
		detail: `mfa: HTTP ${r.status}, responseStatus=${type || "none"}${noCookies ? ", no session cookies" : ""}`,
	};
}
