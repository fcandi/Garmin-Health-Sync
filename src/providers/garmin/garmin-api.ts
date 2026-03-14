const CONNECT_BASE = "https://connect.garmin.com";
const APP_BASE = `${CONNECT_BASE}/app`;
const MODERN_BASE = `${CONNECT_BASE}/modern`;

const SSO_SIGNIN = "https://sso.garmin.com/portal/sso/en-US/sign-in";
const SIGNIN_PARAMS: Record<string, string> = {
	clientId: "GarminConnect",
	service: APP_BASE,
};

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

	setSession(session: GarminSession | null): void {
		this.session = session;
	}

	getSession(): GarminSession | null {
		return this.session;
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

				// Fetch abfangen
				const origFetch = window.fetch;
				window.fetch = function(input, init) {
					const url = typeof input === "string" ? input : (input?.url || "");
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

	// --- Daten abrufen via BrowserWindow Navigation ---

	/** Daten fuer ein Datum abrufen: Browser zur Daily-Summary-Seite navigieren und Responses abfangen */
	async fetchDataForDate(date: string): Promise<Record<string, unknown>> {
		if (!this.isBrowserReady()) {
			console.log("Health Sync: Browser not ready, opening...");
			const ok = await this.loginViaBrowser();
			if (!ok) throw new Error("Could not open browser session");
		}
		if (!this.session?.displayName) {
			throw new Error("Not logged in");
		}

		// TEST: electron.net mit persistiertem Cookie-Jar
		console.log("Health Sync: Testing electron.net...");
		try {
			const testUrl = `${CONNECT_BASE}/gc-api/usersummary-service/usersummary/daily/${this.session.displayName}?calendarDate=${date}`;
			const timeout = new Promise<unknown>((_, reject) => setTimeout(() => reject(new Error("Timeout 5s")), 5000));
			const testResult = await Promise.race([this.electronNetGet(testUrl), timeout]);
			console.log("Health Sync: electron.net TEST:", JSON.stringify(testResult).substring(0, 200));
		} catch (e) {
			console.log("Health Sync: electron.net TEST failed:", e);
		}

		// Gesammelte Responses zuruecksetzen
		await this.browserWindow!.webContents.executeJavaScript(`window.__hs_responses = {};`);

		// Interceptor sicherstellen (falls Page-Context verloren)
		this.injectInterceptor(this.browserWindow!);

		// Zur Daily-Summary-Seite fuer das gewuenschte Datum navigieren
		const url = `${APP_BASE}/daily-summary/${date}`;
		console.log("Health Sync: Navigating to", url);
		// loadURL kann ERR_ABORTED werfen weil die SPA den Router uebernimmt — ignorieren
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
					// Etwas mehr warten damit alle Responses eintreffen
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
		console.log("Health Sync: Collected responses keys:", Object.keys(responses).join(", "));

		// Debug: Zeige Struktur jeder Response
		for (const [key, value] of Object.entries(responses)) {
			const json = JSON.stringify(value);
			console.log(`Health Sync: [${key}]`, json.substring(0, 200));
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

	async fetchBodyBattery(date: string): Promise<Record<string, unknown>[]> {
		const data = await this.getCachedOrFetch(date);
		const bb = data.bodyBattery;
		return Array.isArray(bb) ? bb as Record<string, unknown>[] : [];
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

	/** HTTP GET via Electron net (nutzt persistierten Cookie-Jar der Session) */
	private electronNetGet(url: string): Promise<unknown> {
		const electron = require("electron");
		const { net } = electron.remote || electron;

		return new Promise((resolve, reject) => {
			const request = net.request({ url, method: "GET" });
			request.setHeader("NK", "NT");
			request.setHeader("Accept", "application/json");

			let body = "";
			request.on("response", (response: { statusCode: number; on: (event: string, handler: (chunk?: Buffer) => void) => void }) => {
				response.on("data", (chunk: Buffer) => { body += chunk.toString(); });
				response.on("end", () => {
					console.log("Health Sync: net.request", response.statusCode, body.substring(0, 100));
					if (response.statusCode === 200 && body.length > 2) {
						try { resolve(JSON.parse(body)); } catch { resolve({}); }
					} else {
						resolve({});
					}
				});
			});
			request.on("error", reject);
			request.end();
		});
	}

	private buildUrl(base: string, params: Record<string, string>): string {
		const url = new URL(base);
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
		return url.toString();
	}
}
