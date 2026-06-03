import { requestUrl } from "obsidian";
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
	domain: string;          // "garmin.com" | "garmin.cn" — für die OAuth-/connectapi-Endpoints
	ssoEmbed: string;        // CAS-`service` + `login-url` für getOAuth1 (garth-Web-Flow, M1/M2)
	ssoSigninWidget: string; // gauth-widget-Signin-Endpoint, liefert nach Login embed?ticket=ST-…
}

function getRegionUrls(region: ServerRegion): RegionUrls {
	const isChina = region === "china";
	const domain = isChina ? "garmin.cn" : "garmin.com";
	const connectBase = isChina ? "https://connect.garmin.cn" : "https://connect.garmin.com";
	const ssoSignin = isChina
		? "https://sso.garmin.cn/portal/sso/zh-CN/sign-in"
		: "https://sso.garmin.com/portal/sso/en-US/sign-in";
	// garth-Web-Embed-Flow: `service` + `login-url` = …/sso/embed; Login über das
	// gauth-widget-Signin. Nach Login navigiert die Seite auf embed?ticket=ST-….
	const ssoEmbed = `https://sso.${domain}/sso/embed`;
	const ssoSigninWidget = `https://sso.${domain}/sso/signin`;
	return {
		connectBase,
		appBase: `${connectBase}/app`,
		modernBase: `${connectBase}/modern`,
		ssoSignin,
		apiBase: `https://connectapi.${domain}`, // M3: Bearer-API statt Cookie-gc-api
		domain,
		ssoEmbed,
		ssoSigninWidget,
	};
}

/** Robust gegen Electron-Versionen: Navigations-/Redirect-Events liefern die URL
 *  mal als String-Argument, mal als Event-Objekt mit `.url`. */
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
	};
	loadURL: (url: string, options?: { userAgent?: string }) => Promise<void>;
	close: () => void;
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	hide: () => void;
	show: () => void;
	isDestroyed: () => boolean;
};

export class GarminApi {
	// OAuth-Token (M1/M2): langlebiges OAuth1 + kurzlebiges OAuth2. Persistenz via main.ts.
	private oauth1: OAuth1Token | null = null;
	private oauth2: OAuth2Token | null = null;
	private consumer: Consumer | null = null;       // öffentliche Consumer-Keys, gecacht
	private displayName = "";                          // aus socialProfile, gecacht
	private readonly authState = new AuthStateMachine(); // Phase 7: Auth-/Refresh-Zustand
	private requiredEndpoints: string[] | null = null;
	private urls: RegionUrls = getRegionUrls("international");
	private endpoints: Record<string, (displayName: string, date: string) => string> = getEndpoints(this.urls.apiBase);
	// Concurrency guards: in-flight login (F9) and open login window (F12).
	private loginPromise: Promise<{ ok: boolean; detail: string }> | null = null;
	private activeLoginWindow: BrowserWindowType | null = null;

	setRegion(region: ServerRegion): void {
		this.urls = getRegionUrls(region);
		this.endpoints = getEndpoints(this.urls.apiBase);
	}

	/** Setzt die persistierten OAuth-Token (beim Restore/Login). */
	setTokens(oauth1: OAuth1Token | null, oauth2: OAuth2Token | null): void {
		this.oauth1 = oauth1;
		this.oauth2 = oauth2;
	}

	/** Liefert die aktuellen Token zur Persistenz. */
	getTokens(): { oauth1: OAuth1Token | null; oauth2: OAuth2Token | null } {
		return { oauth1: this.oauth1, oauth2: this.oauth2 };
	}

	/** Aktueller Auth-Zustand (für UI/Logik). */
	getAuthState(): AuthState {
		return this.authState.state;
	}

	/** Darf der Auto-Sync jetzt einen Versuch starten? (Backoff/needsUserLogin) */
	shouldAttemptSync(): boolean {
		return this.authState.shouldAttemptSync();
	}

	/** Sets the endpoints to be called on the next fetch */
	setRequiredEndpoints(endpoints: string[]): void {
		this.requiredEndpoints = endpoints;
	}

	/** Gültig = langlebiges OAuth1-Token vorhanden (ersetzt die 30-Tage-Heuristik,
	 *  die Wurzelursache der Auto-Sync-Pausen). */
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

	// === M1: OAuth-Ticket-Abgriff aus dem BrowserWindow (garth-Web-Embed-Flow) ===
	// Lädt das gauth-widget-Signin mit `service=…/sso/embed`. Nach erfolgreichem
	// Login (+ MFA) navigiert die Seite auf `…/sso/embed?ticket=ST-…` — das Ticket
	// steht in der URL (und im HTML). Abgriff über zwei Wege:
	//   (a) Navigations-URL mit `ticket=…`  (Primärweg)
	//   (b) HTML-Scrape der Seite nach `embed?ticket=…`  (Backup)
	// `preauthorized` (getOAuth1) bekommt `login-url=…/sso/embed`, passend zum
	// `service`. Bei Fehlschlag: Navigations-URLs (live geloggt) + HTML-Diagnose.
	// Dies ist der reguläre interaktive Login; OAuth2-Refresh + Datenabruf laufen
	// danach silent ohne BrowserWindow (ensureValidOAuth2/fetchDataForDate).
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

	private async doLoginViaOAuth(opts: { silent?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
		const silent = opts.silent ?? false;
		const BrowserWindow = this.getBrowserWindowConstructor();
		const embed = this.urls.ssoEmbed;
		// Bewiesene Konfiguration (Gate + E2E): embedWidget=true mit service=…/sso/embed
		// liefert zuverlässig den embed?ticket=ST-…-Redirect. Das `cssUrl` lädt Garmins
		// Branding-Stylesheet (gestyltes Formular, Titel „GARMIN Authentication
		// Application"). Das Logo-Banner gehört zur Host-Seiten-Chrome und erscheint im
		// eigenständig geladenen Widget nicht — bekanntes kosmetisches Limit (embedWidget
		// false/true ändert daran nichts; getestet 2026-06-03).
		const signinUrl = this.buildUrl(this.urls.ssoSigninWidget, {
			id: "gauth-widget",
			embedWidget: "true",
			gauthHost: embed,
			service: embed,
			source: embed,
			redirectAfterAccountLoginUrl: embed,
			redirectAfterAccountCreationUrl: embed,
			cssUrl: `https://connect.${this.urls.domain}/gauth-custom-v1.2-min.css`,
		});

		const win: BrowserWindowType = new BrowserWindow({
			width: 500,
			height: 700,
			show: !silent,
			title: "Garmin Connect Login",
			webPreferences: { nodeIntegration: false, contextIsolation: false },
		});
		this.activeLoginWindow = win;   // F12: handle for closeActiveLogin() on plugin unload

		// JS, das Seite/URL nach einem ST-Ticket durchsucht (kein Regex-Backslash → templatesicher).
		const scrapeJs =
			`(function(){try{` +
			`var loc=(location&&location.search)||"";` +
			`if(loc.indexOf("ticket=")>=0){var p=new URLSearchParams(loc).get("ticket");if(p)return p;}` +
			`var h=document.documentElement?document.documentElement.outerHTML:"";` +
			`var key="embed?ticket=";var i=h.indexOf(key);if(i<0){key="ticket=";i=h.indexOf(key);}` +
			`if(i<0)return "";var rest=h.slice(i+key.length);var end=rest.search(/[^A-Za-z0-9._-]/);` +
			`return end<0?rest:rest.slice(0,end);}catch(e){return "";}})()`;

		const timeoutMs = silent ? 30000 : 120000;

		try {
			const ticket = await new Promise<{ value: string; via: string } | null>((resolve) => {
				let done = false;
				const finish = (t: { value: string; via: string } | null): void => {
					if (done) return;
					done = true;
					// Ticket gegriffen → Fenster sofort verstecken, damit die Garmin-
					// Embed-Ticket-Seite (rohe JSON-Antwort) nicht aufblitzt, während
					// getOAuth1/exchange im Hintergrund laufen.
					if (t && !win.isDestroyed()) { try { win.hide(); } catch { /* ignore */ } }
					resolve(t);
				};

				// (a) Ticket aus einer Navigations-URL (jede URL mit ?ticket=…).
				const onNav = (...args: unknown[]): void => {
					const url = findUrlInArgs(args);
					if (done || !url || !url.includes("ticket=")) return;
					try {
						const tk = new URL(url).searchParams.get("ticket");
						if (tk && tk.length > 4) {
							console.debug(`Garmin Health Sync: M1 — ticket in nav URL (${new URL(url).host}):`, tk.slice(0, 14) + "…");
							finish({ value: tk, via: "redirect" });
						}
					} catch { /* keine gültige URL */ }
				};
				for (const ev of ["will-redirect", "did-redirect-navigation", "did-navigate", "did-navigate-in-page", "did-start-navigation"]) {
					win.webContents.on(ev, onNav);
				}

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
					}).catch(() => { /* Fenster navigiert gerade */ });
				};
				for (const ev of ["did-stop-loading", "dom-ready"]) {
					win.webContents.on(ev, scrapeOnce);
				}

				// If the user closes the login window, resolve immediately (the poll
				// used to detect this via isDestroyed; without it we need the event).
				win.on("closed", () => finish(null));

				// Timeout: knappe Breadcrumb, auf welcher Seite der Login hängenblieb
				// (ohne Query/Ticket, ohne HTML-Dump).
				setTimeout(() => {
					if (done) return;
					void win.webContents.executeJavaScript(
						`(function(){return JSON.stringify({url:(location.href||"").split("?")[0],title:document.title});})()`
					).then((raw: unknown) => {
						console.debug("Garmin Health Sync: login timed out without a ticket. Page:", typeof raw === "string" ? raw : "(none)");
					}).catch(() => { /* Fenster evtl. zerstört */ }).then(() => finish(null));
				}, timeoutMs);

				// Laden NACH der Handler-Registrierung.
				void win.loadURL(signinUrl).catch((e: unknown) => {
					console.debug("Garmin Health Sync: M1 sign-in load failed:", e);
				});
			});

			if (!ticket) {
				console.debug("Garmin Health Sync: M1 — no service ticket captured (timeout or sign-in incomplete)");
				return { ok: false, detail: "no_ticket" };
			}
			console.debug(`Garmin Health Sync: M1 — service ticket captured via ${ticket.via}:`, ticket.value.slice(0, 14) + "…");

			// Ticket → OAuth1 → OAuth2 (beweist M1 + M2 end-to-end gegen echte Garmin-Server).
			// login-url = …/sso/embed, passend zum `service` des Tickets.
			const consumer = await this.getConsumerCached();
			const oauth1 = await getOAuth1(ticket.value, consumer, this.urls.domain, this.urls.ssoEmbed);
			this.oauth1 = oauth1;
			console.debug("Garmin Health Sync: OAuth1 token obtained (oauth_token:", oauth1.oauth_token.slice(0, 10) + "…)");
			const oauth2 = await exchange(oauth1, consumer, this.urls.domain, { login: true });
			this.oauth2 = oauth2;
			this.displayName = "";          // bei (Re-)Login neu auflösen
			this.authState.onLogin();        // frischer Login → ready, Backoff zurücksetzen
			console.debug("Garmin Health Sync: OAuth2 token obtained, expires_in:", oauth2.expires_in, "s");
			return { ok: true, detail: `via=${ticket.via}; oauth1 ok; oauth2 ok; expires_in=${oauth2.expires_in}s` };
		} catch (e: unknown) {
			console.error("Garmin Health Sync: M1 — OAuth login failed:", e);
			const status = e && typeof e === "object" && "status" in e ? (e as { status: number }).status : undefined;
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, detail: `error${status != null ? " status=" + status : ""}: ${msg}` };
		} finally {
			if (!win.isDestroyed()) win.close();
			this.activeLoginWindow = null;
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

	/** Lädt die öffentlichen Consumer-Keys einmal und cacht sie. */
	private async getConsumerCached(): Promise<Consumer> {
		if (!this.consumer) this.consumer = await getConsumer();
		return this.consumer;
	}

	/** Phase 7: stellt ein gültiges OAuth2-Access-Token sicher. Refresht es bei
	 *  Bedarf SILENT via OAuth1 (reiner HTTPS-POST, kein BrowserWindow). Wirft bei
	 *  fehlendem OAuth1 LoginRequiredError; bei 401/403 vom exchange GarminAuthError
	 *  (→ needsUserLogin); transiente Fehler → temporarilyUnavailable + Backoff. */
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
		// 60s Puffer, damit ein knapp gültiges Token nicht mitten im Batch abläuft.
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
			// Alles andere (Netzwerk/429/5xx/Timeout) ist transient → Backoff-Retry.
			this.authState.onTransientError();
			throw e;
		}
	}

	/** Bearer-GET gegen connectapi (ersetzt den Cookie-/Interceptor-Datenpfad). */
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
		return { status: res.status, data: ok ? res.json : null };
	}

	/** Holt den displayName (für die nutzerspezifischen Endpoints) aus socialProfile. */
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

	// --- Data fetching (M3: Bearer gegen connectapi) ---

	/** Holt die benötigten Endpoints für ein Datum via Bearer gegen connectapi.
	 *  Stellt vor dem Batch ein gültiges OAuth2 sicher (Phase 7) und refresht
	 *  einmalig bei einem mid-batch-401/403. */
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
			// Mid-batch-Auth-Fehler: einmal frisch refreshen und die fehlenden erneut holen.
			console.debug("Garmin Health Sync: mid-batch auth failure → refreshing OAuth2 once");
			this.oauth2 = null; // erzwingt Refresh (wirft bei 401/403 → needsUserLogin)
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

	/** Ruft eine Endpoint-Liste parallel via Bearer ab. Liefert die transformierten
	 *  Ergebnisse und ob ein Auth-Fehler (401/403) auftrat. */
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
					console.debug(`Garmin Health Sync: endpoint ${key} → status ${status}${data == null ? " (leer)" : ""} (übersprungen)`);
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
				setTimeout(() => reject(new Error("fetch timeout")), FETCH_TIMEOUT_MS)
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
