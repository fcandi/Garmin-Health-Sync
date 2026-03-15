const CONNECT_BASE = "https://connect.garmin.com";
const APP_BASE = `${CONNECT_BASE}/app`;
const MODERN_BASE = `${CONNECT_BASE}/modern`;

const SSO_SIGNIN = "https://sso.garmin.com/portal/sso/en-US/sign-in";
const SIGNIN_PARAMS: Record<string, string> = {
	clientId: "GarminConnect",
	service: APP_BASE,
};

const API_BASE = `${CONNECT_BASE}/gc-api`;

/** Direct API endpoint URLs — aufgerufen via electron.net statt BrowserWindow-Interceptor */
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
	hydration: (_, date) => `${API_BASE}/usersummary-service/usersummary/hydration/daily/${date}`,
};

/** Welche Metriken brauchen welchen Endpoint */
const ENDPOINT_METRIC_MAP: Record<string, string[]> = {
	dailySummary: ["steps", "resting_hr", "stress", "calories_total", "calories_active", "distance_km", "floors", "intensity_min"],
	sleep: ["sleep_duration", "sleep_score", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"],
	hrv: ["hrv"],
	bodyBattery: ["body_battery"],
	activities: [], // Immer laden — dynamische Frontmatter-Keys
	weight: ["weight_kg", "body_fat_pct"],
	spo2: ["spo2"],
	respiration: ["respiration_rate"],
	trainingStatus: ["training_status"],
	trainingReadiness: ["training_readiness"],
	hydration: ["hydration_ml"],
};

/** Bestimmt welche Endpoints fuer die aktivierten Metriken noetig sind */
export function getRequiredEndpoints(enabledMetrics: string[]): string[] {
	const enabled = new Set(enabledMetrics);
	const endpoints: string[] = ["activities"]; // Immer laden

	for (const [endpoint, metrics] of Object.entries(ENDPOINT_METRIC_MAP)) {
		if (endpoint === "activities") continue;
		if (metrics.some(m => enabled.has(m))) {
			endpoints.push(endpoint);
		}
	}

	return endpoints;
}

/** Berechnet empfohlene Pause zwischen Daten bei Batch-Operationen (ms) */
export function calculateBatchDelay(endpointCount: number): number {
	const maxDatesPerMinute = Math.floor(50 / Math.max(endpointCount, 1));
	const cycleTimeMs = Math.ceil(60000 / maxDatesPerMinute);
	// Minus ~2s geschaetzte Fetch-Dauer, mindestens 1s
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

	/** Setzt die Endpoints die beim naechsten Fetch aufgerufen werden */
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
		const electron = require("electron");
		const { BrowserWindow } = electron.remote || electron;

		const signinUrl = this.buildUrl(SSO_SIGNIN, SIGNIN_PARAMS);

		return new Promise<boolean>((resolve) => {
			// Versteckt starten wenn Session bekannt (Auto-Login erwartet)
			const hasSession = this.session !== null;
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

			// Bei jeder Seite: Padding + Interceptor injizieren
			authWindow.webContents.on("dom-ready", () => {
				authWindow.webContents.insertCSS("body { padding: 12px !important; }");
				this.injectInterceptor(authWindow);
			});

			// Warten bis Connect geladen ist, dann displayName aus App-Traffic extrahieren
			authWindow.webContents.on("did-finish-load", () => {
				const url = authWindow.webContents.getURL();
				console.log("Health Sync: Page loaded:", url);

				const isConnectPage = url.startsWith(APP_BASE) || url.startsWith(MODERN_BASE);
				if (isConnectPage && !resolved) {
					// Polling: warten bis die App den displayName in einer URL verraten hat
					const pollInterval = setInterval(async () => {
						if (resolved) { clearInterval(pollInterval); return; }
						try {
							const name = await authWindow.webContents.executeJavaScript(
								`window.__hs_displayName || ""`
							);
							if (name) {
								clearInterval(pollInterval);
								resolved = true;
								this.session = { displayName: name, timestamp: Date.now() };
								this.browserWindow = authWindow;
								authWindow.hide();
								console.log("Health Sync: Login successful, displayName:", name);
								resolve(true);
							} else {
								console.log("Health Sync: Waiting for displayName...");
							}
						} catch {
							// Window might be navigating
						}
					}, 2000);

					// Nach 10s Fenster anzeigen falls noch nicht eingeloggt
					setTimeout(() => {
						if (!resolved && !authWindow.isDestroyed()) {
							console.log("Health Sync: Auto-login taking long, showing window...");
							authWindow.show();
						}
					}, 10000);

					// Timeout nach 120 Sekunden
					setTimeout(() => {
						if (!resolved) {
							clearInterval(pollInterval);
							resolved = true;
							console.error("Health Sync: Login timeout");
							authWindow.close();
							resolve(false);
						}
					}, 120000);
				}
			});

			authWindow.on("closed", () => {
				if (this.browserWindow === authWindow) this.browserWindow = null;
				if (!resolved) { resolved = true; resolve(false); }
			});

			authWindow.loadURL(signinUrl);
		});
	}

	/** Interceptor in die Seite injizieren — faengt displayName und API-Responses ab */
	private injectInterceptor(win: BrowserWindowType): void {
		win.webContents.executeJavaScript(`
			(function() {
				if (window.__hs_injected) return;
				window.__hs_injected = true;
				window.__hs_displayName = "";
				window.__hs_responses = {};
				window.__hs_apiHeaders = null;

				// Fetch abfangen
				const origFetch = window.fetch;
				window.fetch = function(input, init) {
					const url = typeof input === "string" ? input : (input?.url || "");

					// API-Headers abfangen (v.a. connect-csrf-token fuer Direct Fetch)
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

					// displayName aus URLs extrahieren
					const nameMatch = url.match(/\\/device-info\\/all\\/([^?/]+)/)
						|| url.match(/\\/usersummary\\/daily\\/([^?/]+)/)
						|| url.match(/\\/socialProfile\\/([^?/]+)/)
						|| url.match(/\\/personal-information\\/([^?/]+)/);
					if (nameMatch && nameMatch[1] && nameMatch[1] !== "undefined") {
						window.__hs_displayName = nameMatch[1];
					}

					// API-Responses abfangen
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
							if (url.includes("spo2-service"))
								window.__hs_responses.spo2 = data;
							if (url.includes("respiration") && url.includes("allDay"))
								window.__hs_responses.respiration = data;
							if (url.includes("maxmet"))
								window.__hs_responses.trainingStatus = data;
							if (url.includes("trainingreadiness"))
								window.__hs_responses.trainingReadiness = Array.isArray(data) ? data[0] : data;
							if (url.includes("hydration/daily"))
								window.__hs_responses.hydration = data;
						}).catch(() => {});
					}

					return result;
				};

				// XHR auch abfangen (Garmin nutzt beides)
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
								// GraphQL responses koennen auch Daten enthalten
								const data = JSON.parse(this.responseText);
								if (data?.data) window.__hs_responses.graphql = data.data;
							}
						} catch {}
					});
					return origSend.apply(this, arguments);
				};
			})();
		`).catch(() => {});
	}

	/** BrowserWindow sicherstellen */
	async ensureBrowser(): Promise<boolean> {
		if (this.isBrowserReady()) return true;
		return this.loginViaBrowser();
	}

	// --- Daten abrufen ---

	/** Daten fuer ein Datum abrufen: zuerst Direct Fetch im BrowserWindow-Context, Fallback auf Navigation */
	async fetchDataForDate(date: string): Promise<Record<string, unknown>> {
		if (!this.session?.displayName) {
			throw new Error("Not logged in");
		}

		// BrowserWindow sicherstellen (Login falls noetig)
		if (!this.isBrowserReady()) {
			console.log("Health Sync: Browser not ready, opening...");
			const ok = await this.loginViaBrowser();
			if (!ok) throw new Error("Could not open browser session");
		}

		// Fast Path: Parallel fetch() im BrowserWindow-Context (~1-2s)
		try {
			const data = await this.fetchDirectInBrowser(date);
			if (Object.keys(data).length > 0) {
				console.log("Health Sync: Direct fetch OK ✓ keys:", Object.keys(data).join(", "));
				return data;
			}
			console.log("Health Sync: Direct fetch returned no data, falling back to navigation");
		} catch (e) {
			console.log("Health Sync: Direct fetch failed, falling back to navigation:", e);
		}

		// Slow Path: Seiten-Navigation + Interceptor (~10-15s)
		return this.fetchViaNavigation(date);
	}

	/** Alle benoetigten Endpoints parallel via fetch() im BrowserWindow-Context aufrufen */
	private async fetchDirectInBrowser(date: string): Promise<Record<string, unknown>> {
		const dn = this.session!.displayName;
		const endpointKeys = this.requiredEndpoints ?? Object.keys(ENDPOINTS);
		if (endpointKeys.length === 0) return {};

		// Pruefen ob wir API-Headers (v.a. CSRF-Token) von der App abgefangen haben
		const headersJson = await this.browserWindow!.webContents.executeJavaScript(
			`JSON.stringify(window.__hs_apiHeaders || null)`
		);
		if (!headersJson || headersJson === "null") {
			console.log("Health Sync: No CSRF token captured yet — skipping direct fetch");
			return {};
		}

		// Alle fetch-Calls mit den abgefangenen Headers ausfuehren
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

		// Timeout: falls BrowserWindow haengt
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("BrowserWindow fetch timeout 15s")), 15000));

		const rawJson = await Promise.race([
			this.browserWindow!.webContents.executeJavaScript(code),
			timeout
		]);

		const entries = JSON.parse(rawJson as string) as Array<{ key: string; status: number; data: unknown; error?: string }>;
		const results: Record<string, unknown> = {};
		const failed: string[] = [];

		for (const entry of entries) {
			if (entry.data != null && typeof entry.data === "object" && Object.keys(entry.data as object).length > 0) {
				results[entry.key] = this.transformResponse(entry.key, entry.data);
			} else if (entry.status !== 200) {
				failed.push(`${entry.key}:${entry.status}`);
			}
		}

		if (failed.length > 0) {
			console.log("Health Sync: Direct fetch — failed endpoints:", failed.join(", "));
		}

		return results;
	}

	/** Gleiche Response-Transformationen wie der BrowserWindow-Interceptor */
	private transformResponse(key: string, data: unknown): unknown {
		if (key === "sleep") {
			return (data as Record<string, unknown>)?.dailySleepDTO || data;
		}
		if (key === "trainingReadiness") {
			return Array.isArray(data) ? data[0] : data;
		}
		return data;
	}

	/** Fallback: BrowserWindow zur Daily-Summary-Seite navigieren + Interceptor */
	private async fetchViaNavigation(date: string): Promise<Record<string, unknown>> {
		// Gesammelte Responses zuruecksetzen
		await this.browserWindow!.webContents.executeJavaScript(`window.__hs_responses = {};`);

		// Interceptor sicherstellen (falls Page-Context verloren)
		this.injectInterceptor(this.browserWindow!);

		// Zur Daily-Summary-Seite fuer das gewuenschte Datum navigieren
		const url = `${APP_BASE}/daily-summary/${date}`;
		console.log("Health Sync: Navigating to", url);
		await this.browserWindow!.loadURL(url).catch(() => {});

		// Warten bis die App die API-Calls gemacht hat
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

		// Alle gesammelten Responses auslesen
		const rawJson = await this.browserWindow!.webContents.executeJavaScript(`
			JSON.stringify(window.__hs_responses || {})
		`);

		const responses = JSON.parse(rawJson as string) as Record<string, unknown>;
		console.log("Health Sync: Navigation fetch keys:", Object.keys(responses).join(", "));

		for (const [key, value] of Object.entries(responses)) {
			console.log(`Health Sync: Navigation [${key}]`, JSON.stringify(value).substring(0, 150));
		}

		return responses;
	}

	// --- Legacy API methods (jetzt via fetchDataForDate gebündelt) ---

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

	async fetchTrainingStatus(): Promise<Record<string, unknown>> {
		const today = new Date().toISOString().slice(0, 10);
		const data = await this.getCachedOrFetch(today);
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

	async fetchHydration(date: string): Promise<Record<string, unknown>> {
		const data = await this.getCachedOrFetch(date);
		return (data.hydration || {}) as Record<string, unknown>;
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
		// Heart Rate kommt aus dem Daily Summary
		return this.fetchDailySummary(date);
	}

	// --- Cache + Lock: pro Datum nur einmal navigieren ---

	private cachedDate = "";
	private cachedData: Record<string, unknown> = {};
	private fetchPromise: Promise<Record<string, unknown>> | null = null;

	private async getCachedOrFetch(date: string): Promise<Record<string, unknown>> {
		if (this.cachedDate === date && Object.keys(this.cachedData).length > 0) {
			return this.cachedData;
		}

		// Lock: wenn schon ein Fetch laeuft, darauf warten
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = this.fetchDataForDate(date).then(data => {
			this.cachedData = data;
			this.cachedDate = date;
			this.fetchPromise = null;
			return data;
		}).catch(e => {
			this.fetchPromise = null;
			throw e;
		});

		return this.fetchPromise;
	}

	/** Cache leeren (z.B. nach Sync) */
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
