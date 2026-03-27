const CONNECT_BASE = "https://connect.garmin.com";
const APP_BASE = `${CONNECT_BASE}/app`;
const MODERN_BASE = `${CONNECT_BASE}/modern`;

const SSO_SIGNIN = "https://sso.garmin.com/portal/sso/en-US/sign-in";
const SIGNIN_PARAMS: Record<string, string> = {
	clientId: "GarminConnect",
	service: APP_BASE,
};

const API_BASE = `${CONNECT_BASE}/gc-api`;

/** Direct API endpoint URLs — called via electron.net instead of BrowserWindow interceptor */
const ENDPOINTS: Record<string, (displayName: string, date: string) => string> = {
	dailySummary: (dn, date) => `${API_BASE}/usersummary-service/usersummary/daily/${dn}?calendarDate=${date}`,
	sleep: (dn, date) => `${API_BASE}/wellness-service/wellness/dailySleepData/${dn}?date=${date}&nonSleepBufferMinutes=60`,
	hrv: (_, date) => `${API_BASE}/hrv-service/hrv/${date}`,
	bodyBattery: (_, date) => `${API_BASE}/wellness-service/wellness/bodyBattery/reports/daily?startDate=${date}&endDate=${date}`,
	activities: (_, date) => `${API_BASE}/activitylist-service/activities/search/activities?startDate=${date}&endDate=${date}&limit=20`,
	weight: (_, date) => `${API_BASE}/weight-service/weight/dateRange?startDate=${date}&endDate=${date}`,
	spo2: (_, date) => `${API_BASE}/wellness-service/wellness/daily/spo2/${date}`,
	respiration: (_, date) => `${API_BASE}/wellness-service/wellness/daily/respiration/${date}`,
	trainingStatus: (_, date) => `${API_BASE}/metrics-service/metrics/maxmet/daily/${date}/${date}`,
	trainingReadiness: (_, date) => `${API_BASE}/metrics-service/metrics/trainingreadiness/${date}`,
};

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
	trainingStatus: ["training_status"],
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

export interface GarminSession {
	displayName: string;
	timestamp: number;
}

type BrowserWindowType = {
	webContents: {
		session: { cookies: { get: (filter: { domain: string }) => Promise<Array<{ name: string; value: string }>> } };
		executeJavaScript: (code: string) => Promise<string>;
		getURL: () => string;
		insertCSS: (css: string) => Promise<string>;
		on: (event: string, handler: (...args: unknown[]) => void) => void;
	};
	loadURL: (url: string) => Promise<void>;
	close: () => void;
	on: (event: string, handler: (...args: unknown[]) => void) => void;
	hide: () => void;
	show: () => void;
	isDestroyed: () => boolean;
};

export class GarminApi {
	private session: GarminSession | null = null;
	private browserWindow: BrowserWindowType | null = null;
	private requiredEndpoints: string[] | null = null;

	setSession(session: GarminSession | null): void {
		this.session = session;
	}

	getSession(): GarminSession | null {
		return this.session;
	}

	/** Sets the endpoints to be called on the next fetch */
	setRequiredEndpoints(endpoints: string[]): void {
		this.requiredEndpoints = endpoints;
	}

	isSessionValid(): boolean {
		if (!this.session) return false;
		const thirtyDays = 30 * 24 * 60 * 60 * 1000;
		return Date.now() - this.session.timestamp < thirtyDays;
	}

	isBrowserReady(): boolean {
		return this.browserWindow !== null && !this.browserWindow.isDestroyed();
	}

	closeBrowser(): void {
		if (this.isBrowserReady()) {
			this.browserWindow!.close();
		}
		this.browserWindow = null;
	}

	/** Login via Electron BrowserWindow */
	async loginViaBrowser(): Promise<boolean> {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef, @typescript-eslint/no-unsafe-assignment
		const electron = require("electron");
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
		const { BrowserWindow } = electron.remote || electron;

		const signinUrl = this.buildUrl(SSO_SIGNIN, SIGNIN_PARAMS);

		return new Promise<boolean>((resolve) => {
			// Start hidden if session is known (auto-login expected)
			const hasSession = this.session !== null;
			// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
		const authWindow: BrowserWindowType = new BrowserWindow({
				width: 500,
				height: 700,
				show: !hasSession,
				title: "Garmin Connect Login",
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: false,
				},
			});

			let resolved = false;
			let pollInterval: ReturnType<typeof setInterval> | null = null;

			// Global timeouts — always active, regardless of the loaded page.
			// Fix: when session cookies expire, Garmin loads the SSO page instead of
			// the app. isConnectPage would be false → timeouts never set → promise hangs forever.
			const showTimer = setTimeout(() => {
				if (!resolved && !authWindow.isDestroyed()) {
					console.debug("Health Sync: Auto-login taking long, showing window...");
					authWindow.show();
				}
			}, 10000);

			const globalTimeout = setTimeout(() => {
				if (!resolved) {
					if (pollInterval) clearInterval(pollInterval);
					resolved = true;
					console.error("Health Sync: Login timeout");
					if (!authWindow.isDestroyed()) authWindow.close();
					resolve(false);
				}
			}, 120000);

			// On every page: inject padding + interceptor
			authWindow.webContents.on("dom-ready", () => {
				void authWindow.webContents.insertCSS("body { padding: 12px !important; }");
				this.injectInterceptor(authWindow);
			});

			// Wait until Connect is loaded, then extract displayName from app traffic
			authWindow.webContents.on("did-finish-load", () => {
				const url = authWindow.webContents.getURL();
				console.debug("Health Sync: Page loaded:", url);

				const isConnectPage = url.startsWith(APP_BASE) || url.startsWith(MODERN_BASE);
				if (isConnectPage && !resolved) {
					// Polling: wait until the app reveals the displayName in a URL
					pollInterval = setInterval(() => {
						if (resolved) { clearInterval(pollInterval!); return; }
						void (async () => {
						try {
							const name = await authWindow.webContents.executeJavaScript(
								`window.__hs_displayName || ""`
							);
							if (name) {
								clearInterval(pollInterval!);
								resolved = true;
								clearTimeout(showTimer);
								clearTimeout(globalTimeout);
								this.session = { displayName: name, timestamp: Date.now() };
								this.browserWindow = authWindow;
								authWindow.hide();
								console.debug("Health Sync: Login successful, displayName:", name);
								resolve(true);
							} else {
								console.debug("Health Sync: Waiting for displayName...");
							}
						} catch {
							// Window might be navigating
						}
						})();
					}, 2000);
				}
			});

			authWindow.on("closed", () => {
				clearTimeout(showTimer);
				clearTimeout(globalTimeout);
				if (pollInterval) clearInterval(pollInterval);
				if (this.browserWindow === authWindow) this.browserWindow = null;
				if (!resolved) { resolved = true; resolve(false); }
			});

			void authWindow.loadURL(signinUrl);
		});
	}

	/** Inject interceptor into the page — captures displayName and API responses */
	private injectInterceptor(win: BrowserWindowType): void {
		win.webContents.executeJavaScript(`
			(function() {
				if (window.__hs_injected) return;
				window.__hs_injected = true;
				window.__hs_displayName = "";
				window.__hs_responses = {};
				window.__hs_apiHeaders = null;

				// Intercept fetch
				const origFetch = window.fetch;
				window.fetch = function(input, init) {
					const url = typeof input === "string" ? input : (input?.url || "");

					// Capture API headers (especially connect-csrf-token for direct fetch)
					if (url.includes("/gc-api/") || url.includes("/proxy/")) {
						try {
							var h = {};
							if (init && init.headers) {
								if (init.headers instanceof Headers) {
									init.headers.forEach(function(v, k) { h[k] = v; });
								} else if (typeof init.headers === "object") {
									Object.keys(init.headers).forEach(function(k) { h[k] = init.headers[k]; });
								}
							}
							if (typeof input === "object" && input instanceof Request && input.headers) {
								input.headers.forEach(function(v, k) { h[k] = v; });
							}
							if (Object.keys(h).length > 0) {
								window.__hs_apiHeaders = h;
							}
						} catch(e) {}
					}
					const result = origFetch.apply(this, arguments);

					// Extract displayName from URLs
					const nameMatch = url.match(/\\/device-info\\/all\\/([^?/]+)/)
						|| url.match(/\\/usersummary\\/daily\\/([^?/]+)/)
						|| url.match(/\\/socialProfile\\/([^?/]+)/)
						|| url.match(/\\/personal-information\\/([^?/]+)/);
					if (nameMatch && nameMatch[1] && nameMatch[1] !== "undefined") {
						window.__hs_displayName = nameMatch[1];
					}

					// Capture API responses
					if (url.includes("/gc-api/") || url.includes("/proxy/")) {
						result.then(r => r.clone().json()).then(data => {
							if (url.includes("usersummary/daily/") && url.includes("calendarDate"))
								window.__hs_responses.dailySummary = data;
							if (url.includes("dailySleepData"))
								window.__hs_responses.sleep = data?.dailySleepDTO || data;
							if (url.includes("hrv-service/hrv"))
								window.__hs_responses.hrv = data;
							if (url.includes("bodyBattery"))
								window.__hs_responses.bodyBattery = data;
							if (url.includes("activities/search/activities"))
								window.__hs_responses.activities = data;
							if (url.includes("weight-service/weight"))
								window.__hs_responses.weight = data;
							if (url.includes("spo2-service") || url.includes("daily/spo2"))
								window.__hs_responses.spo2 = data;
							if (url.includes("respiration"))
								window.__hs_responses.respiration = data;
							if (url.includes("maxmet"))
								window.__hs_responses.trainingStatus = data;
							if (url.includes("trainingreadiness"))
								window.__hs_responses.trainingReadiness = Array.isArray(data) ? data[0] : data;
						}).catch(() => {});
					}

					return result;
				};

				// Also intercept XHR (Garmin uses both)
				const origOpen = XMLHttpRequest.prototype.open;
				const origSend = XMLHttpRequest.prototype.send;
				XMLHttpRequest.prototype.open = function(method, url) {
					this.__hs_url = url;
					return origOpen.apply(this, arguments);
				};
				XMLHttpRequest.prototype.send = function() {
					const url = this.__hs_url || "";
					const nameMatch = url.match(/\\/device-info\\/all\\/([^?/]+)/);
					if (nameMatch && nameMatch[1] && nameMatch[1] !== "undefined") {
						window.__hs_displayName = nameMatch[1];
					}
					this.addEventListener("load", function() {
						try {
							if (url.includes("graphql") && this.responseText) {
								// GraphQL responses can also contain data
								const data = JSON.parse(this.responseText);
								if (data?.data) window.__hs_responses.graphql = data.data;
							}
						} catch {}
					});
					return origSend.apply(this, arguments);
				};
			})();
		`).catch((e: unknown) => { console.debug("Health Sync: Interceptor injection failed:", e); });
	}

	/** Ensure BrowserWindow is ready */
	async ensureBrowser(): Promise<boolean> {
		if (this.isBrowserReady()) return true;
		return this.loginViaBrowser();
	}

	// --- Data fetching ---

	/** Fetch data for a date: first try direct fetch in BrowserWindow context, fall back to navigation */
	async fetchDataForDate(date: string): Promise<Record<string, unknown>> {
		if (!this.session?.displayName) {
			throw new Error("Not logged in");
		}

		// Ensure BrowserWindow is ready (login if needed)
		if (!this.isBrowserReady()) {
			console.debug("Health Sync: Browser not ready, opening...");
			const ok = await this.loginViaBrowser();
			if (!ok) throw new Error("Could not open browser session");
		}

		// Fast path: parallel fetch() in BrowserWindow context (~1-2s)
		try {
			const data = await this.fetchDirectInBrowser(date);
			if (Object.keys(data).length > 0) {
				console.debug("Health Sync: Direct fetch OK ✓ keys:", Object.keys(data).join(", "));
				return data;
			}
			console.debug("Health Sync: Direct fetch returned no data, falling back to navigation");
		} catch (e) {
			console.debug("Health Sync: Direct fetch failed, falling back to navigation:", e);
		}

		// Slow path: page navigation + interceptor (~10-15s)
		return this.fetchViaNavigation(date);
	}

	/** Call all required endpoints in parallel via fetch() in the BrowserWindow context */
	private async fetchDirectInBrowser(date: string): Promise<Record<string, unknown>> {
		const dn = this.session!.displayName;
		const endpointKeys = this.requiredEndpoints ?? Object.keys(ENDPOINTS);
		if (endpointKeys.length === 0) return {};

		// Check if we captured API headers (especially CSRF token) from the app
		const headersJson = await this.browserWindow!.webContents.executeJavaScript(
			`JSON.stringify(window.__hs_apiHeaders || null)`
		);
		if (!headersJson || headersJson === "null") {
			console.debug("Health Sync: No CSRF token captured yet — skipping direct fetch");
			return {};
		}

		// Execute all fetch calls with the captured headers
		const fetchCalls = endpointKeys.map(key => {
			const buildUrl = ENDPOINTS[key];
			if (!buildUrl) return `Promise.resolve({ key: ${JSON.stringify(key)}, status: 0, data: null })`;
			const url = buildUrl(dn, date);
			return `fetch(${JSON.stringify(url)}, { headers: Object.assign({}, window.__hs_apiHeaders, { "NK": "NT", "Accept": "application/json" }) })
				.then(r => r.ok ? r.json().then(d => ({ key: ${JSON.stringify(key)}, status: r.status, data: d }))
					: ({ key: ${JSON.stringify(key)}, status: r.status, data: null }))
				.catch(e => ({ key: ${JSON.stringify(key)}, status: -1, data: null, error: String(e) }))`;
		});

		const code = `Promise.all([${fetchCalls.join(",")}]).then(r => JSON.stringify(r))`;

		// Timeout: in case BrowserWindow hangs
		const BROWSER_FETCH_TIMEOUT_MS = 15000;
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`BrowserWindow fetch timeout ${BROWSER_FETCH_TIMEOUT_MS}ms`)), BROWSER_FETCH_TIMEOUT_MS));

		const rawJson = await Promise.race([
			this.browserWindow!.webContents.executeJavaScript(code),
			timeout
		]);

		const entries = JSON.parse(rawJson) as Array<{ key: string; status: number; data: unknown; error?: string }>;
		const results: Record<string, unknown> = {};
		const failed: string[] = [];

		for (const entry of entries) {
			if (entry.data != null && typeof entry.data === "object" && Object.keys(entry.data as Record<string, unknown>).length > 0) {
				results[entry.key] = this.transformResponse(entry.key, entry.data);
			} else if (entry.status !== 200) {
				failed.push(`${entry.key}:${entry.status}`);
			}
		}

		if (failed.length > 0) {
			console.debug("Health Sync: Direct fetch — failed endpoints:", failed.join(", "));
		}

		return results;
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

	/** Fallback: navigate BrowserWindow to the daily summary page + interceptor */
	private async fetchViaNavigation(date: string): Promise<Record<string, unknown>> {
		// Reset collected responses
		await this.browserWindow!.webContents.executeJavaScript(`window.__hs_responses = {};`);

		// Re-inject interceptor (in case page context was lost)
		this.injectInterceptor(this.browserWindow!);

		// Navigate to daily summary page for the requested date
		const url = `${APP_BASE}/daily-summary/${date}`;
		console.debug("Health Sync: Navigating to", url);
		await this.browserWindow!.loadURL(url).catch(() => {});

		// Wait until the app has made its API calls
		const maxWait = 15000;
		const pollMs = 1000;
		let waited = 0;

		while (waited < maxWait) {
			await new Promise(r => setTimeout(r, pollMs));
			waited += pollMs;

			try {
				const hasData = await this.browserWindow!.webContents.executeJavaScript(`
					Object.keys(window.__hs_responses || {}).length
				`);
				if (Number(hasData) >= 3) {
					await new Promise(r => setTimeout(r, 3000));
					break;
				}
			} catch {
				// Window navigating
			}
		}

		// Read all collected responses
		const rawJson = await this.browserWindow!.webContents.executeJavaScript(`
			JSON.stringify(window.__hs_responses || {})
		`);

		const responses = JSON.parse(rawJson) as Record<string, unknown>;
		console.debug("Health Sync: Navigation fetch keys:", Object.keys(responses).join(", "));

		for (const [key, value] of Object.entries(responses)) {
			console.debug(`Health Sync: Navigation [${key}]`, JSON.stringify(value).substring(0, 150));
		}

		return responses;
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

	private async getCachedOrFetch(date: string): Promise<Record<string, unknown>> {
		if (this.cachedDate === date && Object.keys(this.cachedData).length > 0) {
			return this.cachedData;
		}

		// Lock: if a fetch is already running for the same date, wait for it
		if (this.fetchPromise && this.pendingDate === date) {
			return this.fetchPromise;
		}

		const FETCH_TIMEOUT_MS = 30000;
		const withTimeout = Promise.race([
			this.fetchDataForDate(date),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("fetch timeout")), FETCH_TIMEOUT_MS)
			),
		]);

		this.pendingDate = date;
		this.fetchPromise = withTimeout.then(data => {
			this.cachedData = data;
			this.cachedDate = date;
			this.fetchPromise = null;
			this.pendingDate = "";
			return data;
		}).catch(e => {
			this.fetchPromise = null;
			this.pendingDate = "";
			throw e;
		});

		return this.fetchPromise;
	}

	/** Clear the cache (e.g. after sync) */
	clearCache(): void {
		this.cachedDate = "";
		this.cachedData = {};
	}

	// --- Helpers ---

	async refreshDisplayName(): Promise<string> {
		return this.session?.displayName || "";
	}

	private buildUrl(base: string, params: Record<string, string>): string {
		const url = new URL(base);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}
}
