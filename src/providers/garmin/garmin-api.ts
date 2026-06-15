import { requestUrl, Platform } from "obsidian";
import type { ServerRegion } from "../../settings";
import { LoginRequiredError, GarminAuthError, isGarminAuthError, isAuthFailureStatus } from "../../errors";
import { getConsumer, getOAuth1, exchange, OAUTH_UA, type OAuth1Token, type OAuth2Token, type Consumer } from "./garmin-oauth";
import { AuthStateMachine, type AuthState } from "./auth-state";

interface RegionUrls {
	connectBase: string;
	appBase: string;
	modernBase: string;
	ssoSignin: string;
	apiBase: string;
	domain: string;          // "garmin.com" | "garmin.cn" — for the OAuth/connectapi endpoints
	ssoEmbed: string;        // CAS `service` + `login-url` for getOAuth1 (garth web flow, M1/M2)
	ssoSigninWidget: string; // gauth-widget signin endpoint, returns embed?ticket=ST-… after login
}

function getRegionUrls(region: ServerRegion): RegionUrls {
	const isChina = region === "china";
	const domain = isChina ? "garmin.cn" : "garmin.com";
	const connectBase = isChina ? "https://connect.garmin.cn" : "https://connect.garmin.com";
	const ssoSignin = isChina
		? "https://sso.garmin.cn/portal/sso/zh-CN/sign-in"
		: "https://sso.garmin.com/portal/sso/en-US/sign-in";
	// garth web embed flow: `service` + `login-url` = …/sso/embed; login via the
	// gauth-widget signin. After login the page navigates to embed?ticket=ST-….
	const ssoEmbed = `https://sso.${domain}/sso/embed`;
	const ssoSigninWidget = `https://sso.${domain}/sso/signin`;
	return {
		connectBase,
		appBase: `${connectBase}/app`,
		modernBase: `${connectBase}/modern`,
		ssoSignin,
		apiBase: `https://connectapi.${domain}`, // M3: Bearer API instead of cookie-based gc-api
		domain,
		ssoEmbed,
		ssoSigninWidget,
	};
}

/** Robust across Electron versions: navigation/redirect events deliver the URL
 *  sometimes as a string argument, sometimes as an event object with `.url`. */
function findUrlInArgs(args: unknown[]): string {
	for (const a of args) {
		if (typeof a === "string" && a.startsWith("http")) return a;
	}
	for (const a of args) {
		if (a && typeof a === "object" && "url" in a) {
			const u = (a as { url: unknown }).url;
			if (typeof u === "string") return u;
		}
	}
	return "";
}

function getEndpoints(apiBase: string): Record<string, (displayName: string, date: string) => string> {
	return {
		dailySummary: (dn, date) => `${apiBase}/usersummary-service/usersummary/daily/${dn}?calendarDate=${date}`,
		sleep: (dn, date) => `${apiBase}/wellness-service/wellness/dailySleepData/${dn}?date=${date}&nonSleepBufferMinutes=60`,
		hrv: (_, date) => `${apiBase}/hrv-service/hrv/${date}`,
		bodyBattery: (_, date) => `${apiBase}/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`,
		activities: (_, date) => `${apiBase}/activitylist-service/activities/search/activities?startDate=${date}&endDate=${date}&limit=20`,
		weight: (_, date) => `${apiBase}/weight-service/weight/dateRange?startDate=${date}&endDate=${date}`,
		spo2: (_, date) => `${apiBase}/wellness-service/wellness/daily/spo2/${date}`,
		respiration: (_, date) => `${apiBase}/wellness-service/wellness/daily/respiration/${date}`,
		trainingStatus: (_, date) => `${apiBase}/metrics-service/metrics/maxmet/daily/${date}/${date}`,
		trainingReadiness: (_, date) => `${apiBase}/metrics-service/metrics/trainingreadiness/${date}`,
	};
}

/** Which metrics require which endpoint */
const ENDPOINT_METRIC_MAP: Record<string, string[]> = {
	dailySummary: ["steps", "resting_hr", "stress", "calories_total", "calories_active", "distance_km", "floors", "intensity_min"],
	sleep: ["sleep_duration", "sleep_score", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"],
	hrv: ["hrv"],
	bodyBattery: ["body_battery"],
	activities: [], // Always load — dynamic frontmatter keys
	weight: ["weight_kg", "body_fat_pct"],
	spo2: ["spo2"],
	respiration: ["respiration_rate"],
	trainingStatus: ["training_status", "vo2_max"],
	trainingReadiness: ["training_readiness"],
};

/** Determines which endpoints are required for the enabled metrics */
export function getRequiredEndpoints(enabledMetrics: string[]): string[] {
	const enabled = new Set(enabledMetrics);
	const endpoints: string[] = ["activities"]; // Always load

	for (const [endpoint, metrics] of Object.entries(ENDPOINT_METRIC_MAP)) {
		if (endpoint === "activities") continue;
		if (metrics.some(m => enabled.has(m))) {
			endpoints.push(endpoint);
		}
	}

	return endpoints;
}

/** Calculates recommended delay between dates in batch operations (ms) */
export function calculateBatchDelay(endpointCount: number): number {
	const maxDatesPerMinute = Math.floor(50 / Math.max(endpointCount, 1));
	const cycleTimeMs = Math.ceil(60000 / maxDatesPerMinute);
	// Subtract ~2s estimated fetch duration, minimum 1s
	return Math.max(cycleTimeMs - 2000, 1000);
}

type BrowserWindowType = {
	webContents: {
		executeJavaScript: (code: string) => Promise<string>;
		getURL: () => string;
		insertCSS: (css: string) => Promise<string>;
		setUserAgent?: (ua: string) => void;
		on: (event: string, handler: (...args: unknown[]) => void) => void;
		setWindowOpenHandler?: (handler: (details: { url?: string }) => { action: string }) => void;
		session?: {
			webRequest?: {
				onBeforeRedirect?: (filter: { urls: string[] } | null, listener?: (details: { url: string; redirectURL: string; statusCode: number }) => void) => void;
				onCompleted?: (filter: { urls: string[] } | null, listener?: (details: { url: string; statusCode: number; method: string }) => void) => void;
			};
		};
	};
	loadURL: (url: string, options?: { userAgent?: string }) => Promise<void>;
	close: () => void;
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	hide: () => void;
	show: () => void;
	isDestroyed: () => boolean;
};

// Desktop-Chrome User-Agent for the login window (issue #6). The embedded sign-in
// otherwise carries Obsidian's `obsidian/…` + `Electron/…` UA tokens; on some
// accounts/sessions Garmin's SSO then hands the service ticket over in a way that
// escapes or stalls the embedded window, while the identical sign-in in a real browser
// completes (the manual flow is the proof). A stock Chrome UA (no Electron/obsidian
// markers) makes Garmin treat the window like a normal browser. Platform-matched via
// Obsidian's Platform API so the string stays plausible on each desktop OS.
function getLoginUserAgent(): string {
	const chrome = "Chrome/137.0.0.0";
	if (Platform.isMacOS) {
		return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
	}
	if (Platform.isLinux) {
		return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
	}
	// Windows and any other desktop — the most common desktop UA.
	return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
}

export class GarminApi {
	// OAuth tokens (M1/M2): long-lived OAuth1 + short-lived OAuth2. Persisted via main.ts.
	private oauth1: OAuth1Token | null = null;
	private oauth2: OAuth2Token | null = null;
	private consumer: Consumer | null = null;       // public consumer keys, cached
	private displayName = "";                          // from socialProfile, cached
	private readonly authState = new AuthStateMachine(); // Phase 7: auth/refresh state machine
	private requiredEndpoints: string[] | null = null;
	private urls: RegionUrls = getRegionUrls("international");
	private endpoints: Record<string, (displayName: string, date: string) => string> = getEndpoints(this.urls.apiBase);
	// Concurrency guards: in-flight login (F9) and open login window (F12).
	private loginPromise: Promise<{ ok: boolean; detail: string }> | null = null;
	private activeLoginWindow: BrowserWindowType | null = null;
	// Plugin version for self-identifying login/diagnostic logs (set from main.ts).
	private pluginVersion = "";

	setRegion(region: ServerRegion): void {
		this.urls = getRegionUrls(region);
		this.endpoints = getEndpoints(this.urls.apiBase);
	}

	/** Records the plugin version so login debug logs are self-identifying in bug reports. */
	setVersion(version: string): void {
		this.pluginVersion = version;
	}

	/** Sets the persisted OAuth tokens (on restore/login). */
	setTokens(oauth1: OAuth1Token | null, oauth2: OAuth2Token | null): void {
		this.oauth1 = oauth1;
		this.oauth2 = oauth2;
	}

	/** Returns the current tokens for persistence. */
	getTokens(): { oauth1: OAuth1Token | null; oauth2: OAuth2Token | null } {
		return { oauth1: this.oauth1, oauth2: this.oauth2 };
	}

	/** Current auth state (for UI/logic). */
	getAuthState(): AuthState {
		return this.authState.state;
	}

	/** Is auto-sync allowed to attempt a run right now? (backoff/needsUserLogin) */
	shouldAttemptSync(): boolean {
		return this.authState.shouldAttemptSync();
	}

	/** Sets the endpoints to be called on the next fetch */
	setRequiredEndpoints(endpoints: string[]): void {
		this.requiredEndpoints = endpoints;
	}

	/** Valid = long-lived OAuth1 token present (replaces the 30-day heuristic
	 *  that was the root cause of auto-sync pauses). */
	isSessionValid(): boolean {
		return this.oauth1 != null;
	}

	async clearSession(): Promise<void> {
		this.oauth1 = null;
		this.oauth2 = null;
		this.displayName = "";
		this.consumer = null;   // F13: do not cache consumer keys across a logout
		this.authState.reset();
		this.clearCache();
	}

	// === M1: OAuth ticket capture from the BrowserWindow (garth web embed flow) ===
	// Loads the gauth-widget signin with `service=…/sso/embed`. After a successful
	// login (+ MFA) the page navigates to `…/sso/embed?ticket=ST-…` — the ticket
	// is in the URL (and in the HTML). Captured via four paths:
	//   (a) Navigation URL containing `ticket=…`  (primary path)
	//   (b) HTML scrape of the page for `embed?ticket=…`  (fallback)
	//   (c) postMessage success event, mirrored into the page title  (issue #6)
	//   (d) URL of a popup window the widget opens  (issue #6)
	// Some widget variants open the service URL in a NEW browsing context
	// (window.open / target="_blank") instead of navigating in place; Obsidian
	// forwards new-window opens to the system browser, where the ticket is lost.
	// An in-page patch therefore rewires window.open to an in-place navigation
	// and strips `target` attributes, keeping the final step inside this window.
	// `preauthorized` (getOAuth1) receives `login-url=…/sso/embed`, matching the
	// `service`. On failure: navigation URLs (logged live) + HTML diagnostics.
	// This is the regular interactive login; OAuth2 refresh + data fetching run
	// silently afterwards without a BrowserWindow (ensureValidOAuth2/fetchDataForDate).
	async loginViaOAuth(opts: { silent?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
		// F9: concurrent login calls (settings button + notice button) share ONE
		// window/result instead of opening two BrowserWindows racing for the tokens.
		if (this.loginPromise) return this.loginPromise;
		this.loginPromise = this.doLoginViaOAuth(opts);
		try {
			return await this.loginPromise;
		} finally {
			this.loginPromise = null;
		}
	}

	/** The gauth-widget sign-in URL for the configured region.
	 *
	 *  Proven configuration (gate + E2E): embedWidget=true with service=…/sso/embed
	 *  reliably produces the embed?ticket=ST-… redirect. The `cssUrl` loads Garmin's
	 *  branding stylesheet (styled form, title "GARMIN Authentication
	 *  Application"). The logo banner belongs to the host-page chrome and does not
	 *  appear in the standalone widget — known cosmetic limitation (embedWidget
	 *  false/true makes no difference; tested 2026-06-03).
	 *
	 *  Also surfaced in the manual-ticket fallback (issue #6): completing the same
	 *  sign-in in an external browser lands on …/sso/embed?ticket=ST-…, which the
	 *  user pastes back into the plugin. */
	getSigninUrl(): string {
		const embed = this.urls.ssoEmbed;
		return this.buildUrl(this.urls.ssoSigninWidget, {
			id: "gauth-widget",
			embedWidget: "true",
			gauthHost: embed,
			service: embed,
			source: embed,
			redirectAfterAccountLoginUrl: embed,
			redirectAfterAccountCreationUrl: embed,
			cssUrl: `https://connect.${this.urls.domain}/gauth-custom-v1.2-min.css`,
		});
	}

	private async doLoginViaOAuth(opts: { silent?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
		const silent = opts.silent ?? false;
		console.debug(`Garmin Health Sync: starting OAuth login (plugin v${this.pluginVersion || "?"}, region=${this.urls.domain}, silent=${silent})`);
		const BrowserWindow = this.getBrowserWindowConstructor();
		const signinUrl = this.getSigninUrl();

		// Dedicated, persistent session for the login window (issue #6): isolates Garmin's
		// SSO/Cloudflare cookies from Obsidian's default session and lets a cf_clearance
		// cookie survive across attempts. Combined with a stock desktop-Chrome UA so Garmin
		// treats the window like a normal browser (the manual flow proves a real browser
		// completes the sign-in where the Electron-marked window stalls/escapes).
		const loginUa = getLoginUserAgent();
		const win: BrowserWindowType = new BrowserWindow({
			width: 500,
			height: 700,
			show: !silent,
			title: "Garmin Connect Login",
			webPreferences: { nodeIntegration: false, contextIsolation: false, partition: "persist:ghs-login" },
		});
		this.activeLoginWindow = win;   // F12: handle for closeActiveLogin() on plugin unload
		try { win.webContents.setUserAgent?.(loginUa); } catch { /* ignore */ }
		console.debug("Garmin Health Sync: M1 — login window UA:", loginUa);

		// JS that searches the page/URL for a CAS service ticket. Garmin surfaces the
		// ticket in several shapes depending on account/region/MFA: the embed redirect
		// `…/sso/embed?ticket=ST-…`, an `embed?ticket=ST-…` link in the page HTML, or a
		// raw success payload `{serviceUrl: …, serviceTicket: 'ST-…'}` (issue #6). A single
		// `ST-…` regex over the URL + serialized DOM matches all of them — more robust
		// than the previous `ticket=` substring scan, which missed the JSON form.
		// (Char-class regex only, no backslash escapes → safe inside this template.)
		const scrapeJs =
			`(function(){try{` +
			`var loc=(location&&location.search)||"";` +
			`if(loc.indexOf("ticket=")>=0){var p=new URLSearchParams(loc).get("ticket");if(p&&p.indexOf("ST-")===0)return p;}` +
			`var h=document.documentElement?document.documentElement.outerHTML:"";` +
			`var m=h.match(/ST-[0-9A-Za-z._-]+/);` +
			`return m?m[0]:"";}catch(e){return "";}})()`;

		// In-page patch (issue #6): keep the final ticket navigation INSIDE this
		// window. Some accounts get a widget variant that opens the service URL in
		// a new browsing context (window.open / target="_blank"); Obsidian forwards
		// new-window opens to the system browser, where the ticket is lost. The
		// patch rewires window.open to an in-place navigation, strips `target`
		// attributes on click/submit, and mirrors any postMessage carrying a ticket
		// into the page title (picked up via "page-title-updated" below — fires
		// even when no navigation happens at all). Idempotent per document.
		//
		// beta.4 hardening (issue #6, tester still escaped to the system browser
		// on credential submit despite the beta.2 patch) — two vectors the
		// event-listener approach cannot see:
		//   - programmatic form.submit() fires NO submit event → patch
		//     HTMLFormElement.prototype.submit to strip `target` first (synchronous,
		//     so a set-target-then-submit() sequence cannot win the race);
		//   - <base target> sets a default browsing context for every link/form
		//     WITHOUT its own target attribute → strip all target attributes
		//     (including <base>) at install time and keep stripping via a
		//     MutationObserver.
		// Every interception logs a "GHS_DIAG …" console line (URLs without
		// query/hash); the main side forwards them via "console-message" so
		// testers' reports name the exact escape vector.
		const patchJs =
			`(function(){try{if(window.__ghsPatched)return;window.__ghsPatched=true;` +
			`var log=function(m){try{console.log("GHS_DIAG "+m);}catch(e){}};` +
			`var clean=function(u){try{return String(u).split("?")[0].split("#")[0];}catch(e){return "";}};` +
			`window.open=function(u){log("window.open -> in-place: "+clean(u));try{if(u)location.href=String(u);}catch(e){}return null;};` +
			`var stripAll=function(root){try{if(root&&root.querySelectorAll){var els=root.querySelectorAll("[target]");for(var i=0;i<els.length;i++){log("target-strip: "+els[i].tagName+" "+els[i].getAttribute("target"));els[i].removeAttribute("target");}}}catch(e){}};` +
			`stripAll(document);` +
			`try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var m=ms[i];` +
			`if(m.type==="attributes"&&m.target&&m.target.getAttribute&&m.target.getAttribute("target")){log("target-strip(mut): "+m.target.tagName);m.target.removeAttribute("target");}` +
			`else if(m.addedNodes){for(var j=0;j<m.addedNodes.length;j++){var n=m.addedNodes[j];if(n&&n.nodeType===1){if(n.getAttribute&&n.getAttribute("target")){log("target-strip(add): "+n.tagName);n.removeAttribute("target");}stripAll(n);}}}}})` +
			`.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["target"]});}catch(e){}` +
			`try{var ns=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){try{if(this.getAttribute&&this.getAttribute("target")){log("form.submit target-strip: "+this.getAttribute("target"));this.removeAttribute("target");}log("form.submit action="+clean(this.action));}catch(e){}return ns.apply(this,arguments);};}catch(e){}` +
			`document.addEventListener("click",function(ev){var n=ev.target;while(n&&n.getAttribute){if(n.getAttribute("target")){log("click target-strip: "+n.tagName);n.removeAttribute("target");}n=n.parentNode;}},true);` +
			`document.addEventListener("submit",function(ev){var f=ev.target;try{if(f&&f.getAttribute&&f.getAttribute("target")){log("submit target-strip: "+f.getAttribute("target"));f.removeAttribute("target");}log("submit action="+clean(f&&f.action));}catch(e){}},true);` +
			`window.addEventListener("message",function(ev){try{var d=ev?ev.data:null;var s=typeof d==="string"?d:JSON.stringify(d);var m=s?s.match(/ST-[0-9A-Za-z._-]+/):null;if(m)document.title="GHS_TICKET "+m[0];}catch(e){}});` +
			`log("patch installed on "+clean(location.href));` +
			`}catch(e){}})()`;

		const timeoutMs = silent ? 30000 : 120000;
		// Network-level capture listeners are registered on the (persistent) login
		// session inside the promise; this holder lets finish()/finally remove them.
		let removeWebRequestListeners: () => void = () => { /* set on registration */ };

		try {
			const ticket = await new Promise<{ value: string; via: string } | null>((resolve) => {
				let done = false;
				const finish = (t: { value: string; via: string } | null): void => {
					if (done) return;
					done = true;
					removeWebRequestListeners();   // stop network capture as soon as we're done
					// Ticket captured → hide the window immediately so the Garmin
					// embed ticket page (raw JSON response) does not flash while
					// getOAuth1/exchange run in the background.
					if (t && !win.isDestroyed()) { try { win.hide(); } catch { /* ignore */ } }
					resolve(t);
				};

				// (a) Ticket from a navigation URL. Accept both the documented redirect
				// `?ticket=ST-…` and a bare `ST-…` token anywhere in the URL — some flows
				// carry the ticket outside the `ticket` query parameter (issue #6).
				// Every event is logged (URL without query/ticket) — the affected
				// testers' logs showed NO navigation at all after submit, so a
				// complete nav trace is the discriminator between "widget never
				// navigates" and "navigation happens but carries no ticket".
				const onNav = (evName: string, ...args: unknown[]): void => {
					if (done) return;
					const url = findUrlInArgs(args);
					if (!url) return;
					console.debug(`Garmin Health Sync: M1 nav [${evName}]:`, url.split("?")[0]);
					let tk: string | null = null;
					try {
						tk = new URL(url).searchParams.get("ticket");
					} catch { /* not a valid URL */ }
					if (!tk) {
						const m = url.match(/ST-[0-9A-Za-z._-]+/);
						if (m) tk = m[0];
					}
					if (tk && tk.length > 4) {
						let host = "";
						try { host = new URL(url).host; } catch { /* keep empty */ }
						console.debug(`Garmin Health Sync: M1 — ticket in nav URL (${host}):`, tk.slice(0, 14) + "…");
						finish({ value: tk, via: "redirect" });
					}
				};
				for (const ev of ["will-navigate", "will-redirect", "did-redirect-navigation", "did-navigate", "did-navigate-in-page", "did-start-navigation"]) {
					win.webContents.on(ev, (...args: unknown[]) => onNav(ev, ...args));
				}

				// (f) Network-level capture (issue #6, the layer not tried before). The
				// credential POST to /sso/signin and its `302 → …/sso/embed?ticket=ST-…`
				// run on THIS window's persistent session; webRequest sees that redirect at
				// the HTTP layer even when no `did-navigate` fires and even if the follow-up
				// navigation escapes to the system browser. onBeforeRedirect / onCompleted
				// are pure observers (no synchronous return value), so — unlike
				// setWindowOpenHandler — they work reliably over @electron/remote.
				// onCompleted additionally logs the POST's HTTP status (query-stripped, no
				// ticket leak): `302` → we read the Location; `403`/cf-mitigated →
				// Cloudflare blocks it; `200` → ticket only in the body; no event → the
				// request hangs. That status is the diagnostic that finally tells apart
				// "capture problem" from "Cloudflare block".
				const ssoFilter = { urls: ["*://sso.garmin.com/*", "*://sso.garmin.cn/*"] };
				try {
					const webRequest = win.webContents.session?.webRequest;
					if (webRequest?.onBeforeRedirect && webRequest?.onCompleted) {
						webRequest.onBeforeRedirect(ssoFilter, (d) => {
							onNav("webRequest-redirect", d.redirectURL, d.url);
						});
						webRequest.onCompleted(ssoFilter, (d) => {
							console.debug(`Garmin Health Sync: M1 webRequest [${d.method}] ${(d.url || "").split("?")[0]} → ${d.statusCode}`);
							if (done) return;
							const m = (d.url || "").match(/ST-[0-9A-Za-z._-]+/);
							if (m) {
								console.debug("Garmin Health Sync: M1 — ticket via webRequest:", m[0].slice(0, 14) + "…");
								finish({ value: m[0], via: "webRequest" });
							}
						});
						removeWebRequestListeners = () => {
							try { webRequest.onBeforeRedirect?.(null); webRequest.onCompleted?.(null); } catch { /* session already gone */ }
						};
					} else {
						console.debug("Garmin Health Sync: M1 — webRequest unavailable on login session (remote proxy); relying on nav/DOM capture");
					}
				} catch (e) {
					// A throw while wiring webRequest over @electron/remote must NOT abort the
					// proven nav/DOM capture paths (e/c/d/b) registered below — degrade to them.
					console.debug("Garmin Health Sync: M1 — webRequest registration failed over remote; relying on nav/DOM capture:", e);
				}

				// (e) Main-process new-window interception (issue #6 escape variant).
				// Some accounts get a widget variant that delivers the ticket by OPENING
				// the service URL in a NEW browsing context (window.open / target=_blank).
				// Obsidian forwards new-window opens to the SYSTEM browser, where the
				// ticket is lost — the escape the renderer-side patches couldn't stop.
				// Setting our own handler on this webContents pre-empts Obsidian's: it
				// runs in the MAIN process (so it fires regardless of in-page patch
				// timing), pulls the ticket straight out of the requested URL via onNav,
				// and denies the open so nothing reaches the system browser. Crucially,
				// even if the `deny` return is dropped over @electron/remote, the handler
				// has ALREADY read details.url — so the ticket is captured either way and
				// the login completes in-plugin even if a browser window still flashes.
				try {
					win.webContents.setWindowOpenHandler?.((details: { url?: string }) => {
						if (details && typeof details.url === "string") {
							console.debug("Garmin Health Sync: M1 — window-open intercepted:", details.url.split("?")[0]);
							onNav("window-open", details.url);
						}
						return { action: "deny" };
					});
				} catch { /* runtime without a settable handler over remote — other paths still apply */ }

				// Forward the in-page patch's GHS_DIAG lines into the plugin console
				// (redacted), so a tester's normal-login attempt names the exact
				// escape vector without a custom build. Electron delivers
				// console-message args either positionally (level, message, …) or as
				// a details object with `message`.
				win.webContents.on("console-message", (...args: unknown[]) => {
					let msg = "";
					for (const a of args) {
						if (typeof a === "string" && a.indexOf("GHS_DIAG") >= 0) { msg = a; break; }
						if (a && typeof a === "object" && "message" in a) {
							const m = (a as { message: unknown }).message;
							if (typeof m === "string" && m.indexOf("GHS_DIAG") >= 0) { msg = m; break; }
						}
					}
					if (msg) console.debug("Garmin Health Sync: login-page diag —", msg.replace(/ST-[0-9A-Za-z._-]+/g, "ST-<redacted>"));
				});

				// (d) Should a popup still get created despite the in-page patch
				// (e.g. window.open captured before the patch ran), pull the ticket
				// straight from the popup URL — `did-create-window` delivers a
				// details object with `url`, which findUrlInArgs picks up — and
				// close the popup once the ticket is secured.
				win.webContents.on("did-create-window", (...args: unknown[]) => {
					onNav("did-create-window", ...args);
					const child = args[0] as { close?: () => void } | undefined;
					if (done && child && typeof child.close === "function") {
						try { child.close(); } catch { /* already closed */ }
					}
				});

				// (c) Ticket surfaced via postMessage: the in-page patch mirrors it
				// into the document title as "GHS_TICKET ST-…".
				win.webContents.on("page-title-updated", (...args: unknown[]) => {
					if (done) return;
					for (const a of args) {
						if (typeof a === "string" && a.indexOf("GHS_TICKET") >= 0) {
							const m = a.match(/ST-[0-9A-Za-z._-]+/);
							if (m) {
								console.debug("Garmin Health Sync: M1 — ticket via postMessage:", m[0].slice(0, 14) + "…");
								finish({ value: m[0], via: "postMessage" });
								return;
							}
						}
					}
				});

				win.webContents.on("dom-ready", () => {
					void win.webContents.insertCSS("body { padding: 12px !important; }").catch(() => undefined);
				});

				// (b) HTML scrape as a fallback, in case the ticket is only in the page HTML.
				// Event-driven instead of continuous polling: runs once per fully loaded
				// page instead of blocking the renderer thread every second with a
				// synchronous remote executeJavaScript (outerHTML serialization) —
				// that caused the '[Violation] setInterval handler took …ms'.
				const scrapeOnce = (): void => {
					if (done || win.isDestroyed()) return;
					void win.webContents.executeJavaScript(scrapeJs).then((tk: unknown) => {
						if (typeof tk === "string" && tk.startsWith("ST-")) {
							console.debug("Garmin Health Sync: M1 — ticket via HTML scrape:", tk.slice(0, 14) + "…");
							finish({ value: tk, via: "scrape" });
						}
					}).catch(() => { /* window is navigating */ });
				};
				// Re-applies the in-page patch after each navigation (new document →
				// the __ghsPatched guard is gone, so it installs again).
				const patchOnce = (): void => {
					if (done || win.isDestroyed()) return;
					void win.webContents.executeJavaScript(patchJs).catch(() => { /* window is navigating */ });
				};
				// Re-scrape on navigation as well, not only on load completion: some flows
				// reveal the ticket via an in-page navigation that fires neither
				// did-stop-loading nor dom-ready again (issue #6). Still strictly
				// event-driven — no continuous polling, so the old setInterval violation
				// (the reason this replaced the 1s poll) stays gone.
				for (const ev of ["did-stop-loading", "dom-ready", "did-navigate", "did-navigate-in-page"]) {
					win.webContents.on(ev, patchOnce);
					win.webContents.on(ev, scrapeOnce);
				}

				// If the user closes the login window, resolve immediately (the poll
				// used to detect this via isDestroyed; without it we need the event).
				win.on("closed", () => finish(null));

				// Timeout: brief breadcrumb showing which page the login stalled on
				// (without query/ticket, without HTML dump).
				window.setTimeout(() => {
					if (done) return;
					// Diagnostic breadcrumb: URL (no query), title, and a redacted body
					// snippet so bug reports show WHICH page the login stalled on (e.g. the
					// issue #6 serviceTicket JSON) without leaking the ticket itself.
					void win.webContents.executeJavaScript(
						`(function(){try{var b=document.body?(document.body.innerText||""):"";` +
						`b=b.replace(/ST-[0-9A-Za-z._-]+/g,"ST-<redacted>").slice(0,300);` +
						`return JSON.stringify({url:(location.href||"").split("?")[0],title:document.title,body:b});}catch(e){return "";}})()`
					).then((raw: unknown) => {
						console.debug(`Garmin Health Sync: login timed out without a ticket (plugin v${this.pluginVersion || "?"}). Page:`, typeof raw === "string" ? raw : "(none)");
					}).catch(() => { /* window may already be destroyed */ }).then(() => finish(null));
				}, timeoutMs);

				// Load AFTER the event handlers are registered. Pass the UA on loadURL too
				// (belt-and-braces with setUserAgent) so the very first request carries it.
				void win.loadURL(signinUrl, { userAgent: loginUa }).catch((e: unknown) => {
					console.debug("Garmin Health Sync: M1 sign-in load failed:", e);
				});
			});

			if (!ticket) {
				console.debug("Garmin Health Sync: M1 — no service ticket captured (timeout or sign-in incomplete)");
				return { ok: false, detail: `no_ticket (plugin v${this.pluginVersion || "?"})` };
			}
			console.debug(`Garmin Health Sync: M1 — service ticket captured via ${ticket.via}:`, ticket.value.slice(0, 14) + "…");
			return await this.exchangeTicket(ticket.value, ticket.via);
		} catch (e: unknown) {
			console.error("Garmin Health Sync: M1 — OAuth login failed:", e);
			const status = e && typeof e === "object" && "status" in e ? (e as { status: number }).status : undefined;
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, detail: `error${status != null ? " status=" + status : ""} (plugin v${this.pluginVersion || "?"}): ${msg}` };
		} finally {
			removeWebRequestListeners();   // backstop: ensure listeners are off the persistent session
			if (!win.isDestroyed()) win.close();
			this.activeLoginWindow = null;
		}
	}

	/** Ticket → OAuth1 → OAuth2 (proves M1 + M2 end-to-end against real Garmin servers).
	 *  login-url = …/sso/embed, matching the `service` of the ticket. */
	private async exchangeTicket(ticket: string, via: string): Promise<{ ok: boolean; detail: string }> {
		const consumer = await this.getConsumerCached();
		const oauth1 = await getOAuth1(ticket, consumer, this.urls.domain, this.urls.ssoEmbed);
		this.oauth1 = oauth1;
		console.debug("Garmin Health Sync: OAuth1 token obtained (oauth_token:", oauth1.oauth_token.slice(0, 10) + "…)");
		const oauth2 = await exchange(oauth1, consumer, this.urls.domain, { login: true });
		this.oauth2 = oauth2;
		this.displayName = "";          // resolve fresh on (re-)login
		this.authState.onLogin();        // fresh login → ready, reset backoff
		console.debug("Garmin Health Sync: OAuth2 token obtained, expires_in:", oauth2.expires_in, "s");
		return { ok: true, detail: `via=${via}; oauth1 ok; oauth2 ok; expires_in=${oauth2.expires_in}s` };
	}

	/** Manual-ticket login fallback (issue #6): some Garmin SSO widget variants
	 *  never surface the service ticket inside the embedded window — the sign-in
	 *  either stalls silently or escapes to the system browser. Completing the
	 *  same sign-in (getSigninUrl) in an external browser lands on
	 *  `…/sso/embed?ticket=ST-…`; the user pastes that URL (or the bare `ST-…`
	 *  ticket, or the success-JSON containing it) and the regular
	 *  ticket→OAuth1→OAuth2 exchange runs unchanged. */
	async loginWithTicket(input: string): Promise<{ ok: boolean; detail: string }> {
		const m = input.match(/ST-[0-9A-Za-z._-]+/);
		if (!m) {
			console.debug("Garmin Health Sync: manual login — no ST- ticket found in input");
			return { ok: false, detail: "no_ticket_in_input" };
		}
		console.debug(`Garmin Health Sync: manual ticket login (plugin v${this.pluginVersion || "?"}, region=${this.urls.domain}):`, m[0].slice(0, 14) + "…");
		try {
			return await this.exchangeTicket(m[0], "manual");
		} catch (e: unknown) {
			console.error("Garmin Health Sync: manual ticket login failed:", e);
			const status = e && typeof e === "object" && "status" in e ? (e as { status: number }).status : undefined;
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, detail: `error${status != null ? " status=" + status : ""} (plugin v${this.pluginVersion || "?"}): ${msg}` };
		}
	}

	/** Closes any still-open login window (F12: invoked from onunload so no orphaned
	 *  BrowserWindow stays open when the plugin is disabled). */
	closeActiveLogin(): void {
		if (this.activeLoginWindow && !this.activeLoginWindow.isDestroyed()) {
			try { this.activeLoginWindow.close(); } catch { /* ignore */ }
		}
		this.activeLoginWindow = null;
	}

	/** Loads the public consumer keys once and caches them. */
	private async getConsumerCached(): Promise<Consumer> {
		if (!this.consumer) this.consumer = await getConsumer();
		return this.consumer;
	}

	/** Phase 7: ensures a valid OAuth2 access token. Refreshes it silently when
	 *  needed via OAuth1 (plain HTTPS POST, no BrowserWindow). Throws LoginRequiredError
	 *  if OAuth1 is missing; GarminAuthError on 401/403 from exchange
	 *  (→ needsUserLogin); transient errors → temporarilyUnavailable + backoff. */
	/** Centralizes the "OAuth1 grant is permanently dead" reaction (401/403): set the
	 *  state to needsUserLogin, discard the tokens (isSessionValid becomes false) and
	 *  signal a LoginRequiredError so callers show the re-login notice.
	 *  Always throws — return type `never`. */
	private failAuth(): never {
		this.authState.onAuthError();
		this.oauth1 = null;
		this.oauth2 = null;
		throw new LoginRequiredError();
	}

	private async ensureValidOAuth2(): Promise<OAuth2Token> {
		if (!this.oauth1) {
			this.failAuth(); // Review-B: go through failAuth uniformly (also clears oauth2)
		}
		const nowSeconds = Math.floor(Date.now() / 1000);
		// 60s buffer so a token that is barely valid does not expire mid-batch.
		if (this.oauth2 && this.oauth2.expires_at - 60 > nowSeconds) {
			return this.oauth2;
		}
		this.authState.beginRefresh();
		try {
			const consumer = await this.getConsumerCached();
			const oauth2 = await exchange(this.oauth1, consumer, this.urls.domain);
			this.oauth2 = oauth2;
			this.authState.onSuccess();
			console.debug("Garmin Health Sync: OAuth2 silently refreshed, expires_in:", oauth2.expires_in, "s");
			return oauth2;
		} catch (e: unknown) {
			if (isGarminAuthError(e) && isAuthFailureStatus(e.status)) {
				this.failAuth();
			}
			// Everything else (network/429/5xx/timeout) is transient → backoff retry.
			this.authState.onTransientError();
			throw e;
		}
	}

	/** Bearer GET against connectapi (replaces the cookie/interceptor data path). */
	private async apiGet(url: string, oauth2: OAuth2Token): Promise<{ status: number; data: unknown }> {
		const res = await requestUrl({
			url,
			method: "GET",
			headers: {
				"User-Agent": OAUTH_UA,
				Authorization: `Bearer ${oauth2.access_token}`,
				"Di-Backend": `connectapi.${this.urls.domain}`,
			},
			throw: false,
		});
		const ok = res.status >= 200 && res.status < 300;
		// Garmin returns 200 with an EMPTY body for endpoints that have no data for
		// the day (e.g. hrv on an account/day without readings). res.json then throws
		// "Unexpected end of JSON input" — guard it and treat an unparseable body as
		// "no data" instead of letting the SyntaxError bubble into the fetch.
		let data: unknown = null;
		if (ok) {
			try { data = res.json; } catch { data = null; }
		}
		return { status: res.status, data };
	}

	/** Fetches the displayName (for user-specific endpoints) from socialProfile. */
	private async ensureDisplayName(oauth2: OAuth2Token): Promise<string> {
		if (this.displayName) return this.displayName;
		const url = `${this.urls.apiBase}/userprofile-service/socialProfile`;
		const { status, data } = await this.apiGet(url, oauth2);
		if (status >= 200 && status < 300 && data && typeof data === "object") {
			const d = data as Record<string, unknown>;
			const dn = (typeof d.displayName === "string" && d.displayName)
				|| (typeof d.userName === "string" && d.userName) || "";
			if (dn) {
				this.displayName = dn;
				return dn;
			}
		}
		throw new GarminAuthError(status, "socialProfile lieferte keinen displayName");
	}

	private getBrowserWindowConstructor(): new (opts: object) => BrowserWindowType {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron must be loaded via require() at runtime in Obsidian plugins
		const electron = require("electron") as { remote?: { BrowserWindow: new (opts: object) => BrowserWindowType }; BrowserWindow: new (opts: object) => BrowserWindowType };
		return (electron.remote ?? electron).BrowserWindow;
	}

	// --- Data fetching (M3: Bearer against connectapi) ---

	/** Fetches the required endpoints for a date via Bearer against connectapi.
	 *  Ensures a valid OAuth2 before the batch (Phase 7) and refreshes
	 *  once on a mid-batch 401/403. */
	async fetchDataForDate(date: string, seq?: number): Promise<Record<string, unknown>> {
		let oauth2 = await this.ensureValidOAuth2();

		// F4: the socialProfile call is the first API call after the refresh. An
		// auth/transient error here must reach the state machine — otherwise state
		// stays ready and the error gets swallowed in the provider (warnOrRethrowAuth).
		let dn: string;
		try {
			dn = await this.ensureDisplayName(oauth2);
		} catch (e: unknown) {
			if (isGarminAuthError(e)) {
				if (isAuthFailureStatus(e.status)) this.failAuth();
				this.authState.onTransientError();
			}
			throw e;
		}

		const keys = this.requiredEndpoints ?? Object.keys(this.endpoints);

		const first = await this.fetchEndpoints(keys, dn, date, oauth2);
		const results = first.results;

		if (first.authFailed) {
			// Mid-batch auth failure: refresh once and re-fetch the missing endpoints.
			console.debug("Garmin Health Sync: mid-batch auth failure → refreshing OAuth2 once");
			this.oauth2 = null; // forces a refresh (throws on 401/403 → needsUserLogin)
			oauth2 = await this.ensureValidOAuth2();
			const missing = keys.filter(k => !(k in results));
			const retry = await this.fetchEndpoints(missing, dn, date, oauth2);
			Object.assign(results, retry.results);
			// F5: if the retry hits 401/403 again, OAuth1 is dead → needsUserLogin
			// instead of a false onSuccess.
			if (retry.authFailed) this.failAuth();
		}

		// F2: only report success if this run is still the current one. A fetch
		// orphaned after the getCachedOrFetch timeout (or superseded by clearSession/a
		// newer run) must not flip needsUserLogin back to ready.
		if (seq === undefined || seq === this.currentFetchSeq) {
			this.authState.onSuccess();
		}
		console.debug("Garmin Health Sync: fetch OK ✓ keys:", Object.keys(results).join(", ") || "(none)");
		return results;
	}

	/** Fetches a list of endpoints in parallel via Bearer. Returns the transformed
	 *  results and whether an auth failure (401/403) occurred. */
	private async fetchEndpoints(
		keys: string[], dn: string, date: string, oauth2: OAuth2Token,
	): Promise<{ results: Record<string, unknown>; authFailed: boolean }> {
		const results: Record<string, unknown> = {};
		let authFailed = false;
		await Promise.all(keys.map(async (key) => {
			const build = this.endpoints[key];
			if (!build) return;
			try {
				const { status, data } = await this.apiGet(build(dn, date), oauth2);
				if (status >= 200 && status < 300 && data != null) {
					results[key] = this.transformResponse(key, data);
				} else if (isAuthFailureStatus(status)) {
					authFailed = true;
					console.debug(`Garmin Health Sync: endpoint ${key} → auth failure ${status}`);
				} else {
					// F11: also covers the empty 200 body (Garmin occasionally returns
					// 200 + null for missing daily data) — legitimate, but now logged.
					console.debug(`Garmin Health Sync: endpoint ${key} → status ${status}${data == null ? " (empty)" : ""} (skipped)`);
				}
			} catch (e) {
				console.debug(`Garmin Health Sync: endpoint ${key} fetch error:`, e);
			}
		}));
		return { results, authFailed };
	}

	/** Same response transformations as the BrowserWindow interceptor */
	private transformResponse(key: string, data: unknown): unknown {
		if (key === "sleep") {
			return (data as Record<string, unknown>)?.dailySleepDTO || data;
		}
		if (key === "trainingReadiness") {
			return Array.isArray(data) ? data[0] : data;
		}
		return data;
	}

	// --- Legacy API methods (now bundled via fetchDataForDate) ---

	async fetchDailySummary(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.dailySummary || {}) as Record<string, unknown>;
	}

	async fetchSleepData(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.sleep || {}) as Record<string, unknown>;
	}

	async fetchHrv(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.hrv || {}) as Record<string, unknown>;
	}

	async fetchBodyBattery(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		const bb = data.bodyBattery;
		if (!bb || typeof bb !== "object") return {};
		return (Array.isArray(bb) ? bb[0] : bb) as Record<string, unknown> ?? {};
	}

	async fetchActivities(date: string): Promise<Record<string, unknown>[]> {
		const data = await this.getCachedOrFetch(date);
		const acts = data.activities;
		return Array.isArray(acts) ? acts as Record<string, unknown>[] : [];
	}

	async fetchTrainingStatus(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.trainingStatus || {}) as Record<string, unknown>;
	}

	async fetchTrainingReadiness(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.trainingReadiness || {}) as Record<string, unknown>;
	}

	async fetchWeight(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.weight || {}) as Record<string, unknown>;
	}

	async fetchRespiration(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.respiration || {}) as Record<string, unknown>;
	}

	async fetchSpO2(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.spo2 || {}) as Record<string, unknown>;
	}

	async fetchHeartRate(date: string): Promise<Record<string, unknown>> {
		// Heart rate comes from the daily summary
		return this.fetchDailySummary(date);
	}

	// --- Cache + lock: navigate only once per date ---

	private cachedDate = "";
	private cachedData: Record<string, unknown> = {};
	private fetchPromise: Promise<Record<string, unknown>> | null = null;
	private pendingDate = "";
	private fetchSeq = 0;          // hands out a unique id per started fetch
	private currentFetchSeq = 0;   // id of the currently valid fetch (F2/F8)

	private async getCachedOrFetch(date: string): Promise<Record<string, unknown>> {
		if (this.cachedDate === date && Object.keys(this.cachedData).length > 0) {
			return this.cachedData;
		}

		// Lock: if a fetch is already running for the same date, wait for it
		if (this.fetchPromise && this.pendingDate === date) {
			return this.fetchPromise;
		}

		const seq = ++this.fetchSeq;
		this.currentFetchSeq = seq;
		const FETCH_TIMEOUT_MS = 30000;
		const withTimeout = Promise.race([
			this.fetchDataForDate(date, seq),
			new Promise<never>((_, reject) =>
				window.setTimeout(() => reject(new Error("fetch timeout")), FETCH_TIMEOUT_MS)
			),
		]);

		this.pendingDate = date;
		this.fetchPromise = withTimeout.then(data => {
			// F8: after clearCache/clearSession (or a newer run) do NOT write to the
			// cache anymore — otherwise an orphaned fetch repopulates the cache with
			// data from the logged-out/previous user.
			if (seq === this.currentFetchSeq) {
				this.cachedData = data;
				this.cachedDate = date;
				this.fetchPromise = null;
				this.pendingDate = "";
			}
			return data;
		}).catch(e => {
			if (seq === this.currentFetchSeq) {
				this.fetchPromise = null;
				this.pendingDate = "";
			}
			throw e;
		});

		return this.fetchPromise;
	}

	/** Clear the cache (e.g. after sync) */
	clearCache(): void {
		// Invalidates running fetches (F2/F8): their seq != currentFetchSeq, so their
		// onSuccess/cache-write effects no longer take hold afterwards.
		this.currentFetchSeq = ++this.fetchSeq;
		this.cachedDate = "";
		this.cachedData = {};
		this.fetchPromise = null;
		this.pendingDate = "";
	}

	// --- Helpers ---

	private buildUrl(base: string, params: Record<string, string>): string {
		const url = new URL(base);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}
}
