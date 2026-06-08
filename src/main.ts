import { App, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { DEFAULT_SETTINGS, HealthSyncSettings, HealthSyncSettingTab } from "./settings";
import { SyncManager } from "./sync";
import { GarminProvider } from "./providers/garmin/garmin-provider";
import type { OAuth1Token, OAuth2Token } from "./providers/garmin/garmin-oauth";
import { t } from "./i18n/t";
import { isLoginRequiredError } from "./errors";

const AUTO_SYNC_TRIGGER_DEBOUNCE_MS = 30 * 1000;
const RESYNC_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h — more recent data may be overwritten
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown between re-syncs per date
const FIRST_RESYNC_AFTER_MS = 30 * 60 * 1000; // 30min — first re-sync happens sooner
const NO_DATA_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1h cooldown for dates that returned no data
const CLEANUP_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const LOGIN_NOTICE_THROTTLE_MS = 10 * 60 * 1000; // 10min: re-show login notice no more often than this

export default class HealthSyncPlugin extends Plugin {
	settings: HealthSyncSettings;
	private syncManager: SyncManager;
	private garminProvider: GarminProvider;
	private autoSyncRunning = false;
	private lastAutoSyncAttempt = 0;
	private loginRequiredNotice: Notice | null = null;
	private lastLoginNoticeAt = 0;

	async onload() {
		await this.loadSettings();
		this.autoDetectDailyNotePath();

		this.garminProvider = new GarminProvider();
		this.garminProvider.setVersion(this.manifest.version);
		this.applyServerRegion();

		// Restore persisted OAuth tokens; migrate legacy cookie users (M6)
		this.restoreTokens();
		await this.migrateLegacySession();

		this.syncManager = new SyncManager(this.app, this.garminProvider);

		// Command: Sync Health Data
		this.addCommand({
			id: "sync-health-data",
			name: t("commandSync", this.settings.language),
			callback: () => this.manualSync(),
		});

		// Command: Backfill Health Data
		this.addCommand({
			id: "backfill-health-data",
			name: t("commandBackfill", this.settings.language),
			callback: () => {
				new BackfillModal(this.app, this.settings.language, (from, to) => {
					void (async () => {
						try {
							await this.syncManager.backfill(from, to, this.settings);
						} catch (error) {
							// F6: persist even on error (see below) and show the re-login
							// notice on a dead token, instead of silently leaving the dead
							// OAuth1 token on disk.
							if (isLoginRequiredError(error) || this.garminProvider.getAuthState() === "needsUserLogin") {
								this.showGarminLoginRequiredNotice("backfill login_required");
							} else {
								console.debug("Garmin Health Sync: Backfill failed — transient", error);
							}
						} finally {
							// Tokens may have been refreshed/invalidated during the backfill → persist.
							this.saveTokens();
							await this.saveSettings();
						}
					})();
				}).open();
			},
		});

		// Settings Tab
		this.addSettingTab(new HealthSyncSettingTab(this.app, this));

		// On startup: auto-sync only — BrowserWindow opens on demand
		this.app.workspace.onLayoutReady(() => {
			void this.tryAutoSync();
		});

		// Auto-sync when opening today's/yesterday's daily note
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file instanceof TFile && this.isDailyNote(file, [this.todayString(), this.yesterdayString()])) {
					void this.tryAutoSync();
				}
			})
		);
	}

	/** F12: on disable/reload, close any still-open Garmin login window instead of
	 *  leaving it visibly open until the 120s timeout. */
	onunload(): void {
		this.garminProvider?.closeActiveLogin();
	}

	/** Auto-sync — checks the last 7 days, syncs missing or outdated data */
	private async tryAutoSync(): Promise<void> {
		if (!this.settings.autoSync) return;
		if (this.autoSyncRunning) return;
		// Phase 7: The state machine decides. needsUserLogin pauses permanently,
		// temporarilyUnavailable only until the backoff expires. No cookie probe
		// anymore — the OAuth2 refresh happens silently in fetchDataForDate.
		if (!this.garminProvider.shouldAttemptSync()) return;

		const now = Date.now();
		if (now - this.lastAutoSyncAttempt < AUTO_SYNC_TRIGGER_DEBOUNCE_MS) return;
		this.lastAutoSyncAttempt = now;

		const datesToSync = this.getAutoSyncDates();
		if (datesToSync.length === 0) {
			console.debug("Garmin Health Sync: Auto-sync — nothing to sync (all within cooldown or already synced)");
			return;
		}

		if (!this.garminProvider.isSessionValid()) {
			this.showGarminLoginRequiredNotice("no OAuth token");
			return;
		}

		this.autoSyncRunning = true;
		try {
			await this.runAutoSync(datesToSync);
		} finally {
			this.autoSyncRunning = false;
		}
	}

	private getAutoSyncDates(now = Date.now()): string[] {
		const syncTimes = this.settings.lastSyncTimes;
		const datesToSync: string[] = [];

		for (let i = 1; i <= 7; i++) {
			const d = new Date();
			d.setDate(d.getDate() - i);
			const dateStr = this.dateString(d);

			// Date age: midnight of next day = "data complete"
			const dateEnd = new Date(dateStr + "T00:00:00");
			dateEnd.setDate(dateEnd.getDate() + 1);
			const ageMs = now - dateEnd.getTime();

			const lastSync = syncTimes[dateStr];

			if (ageMs > RESYNC_WINDOW_MS) {
				// Older than 72h: only sync if never synced before
				if (!lastSync) datesToSync.push(dateStr);
			} else {
				// Within 72h: re-sync allowed but with 6h cooldown
				if (!lastSync || (now - lastSync) >= COOLDOWN_MS) {
					datesToSync.push(dateStr);
				}
			}
		}

		return datesToSync;
	}

	private async runAutoSync(datesToSync: string[]): Promise<void> {
		if (!this.garminProvider.isSessionValid()) return;

		const now = Date.now();

		console.debug("Garmin Health Sync: Auto-sync — syncing:", datesToSync.join(", "));

		const enabledMetrics = Object.entries(this.settings.enabledMetrics)
			.filter(([, enabled]) => enabled)
			.map(([key]) => key);

		try {
			const batchDelay = this.garminProvider.getRecommendedBatchDelay?.(enabledMetrics) ?? 2000;
			let synced = 0;

			for (let i = 0; i < datesToSync.length; i++) {
				const date = datesToSync[i]!;
				const success = await this.syncManager.syncDate(date, this.settings, true);
				if (success) {
					synced++;
					const isFirstSync = !this.settings.lastSyncTimes[date];
					if (isFirstSync) {
						// First sync: set timestamp so next re-sync fires after FIRST_RESYNC_AFTER_MS (30min)
						this.settings.lastSyncTimes[date] = Date.now() - (COOLDOWN_MS - FIRST_RESYNC_AFTER_MS);
					} else {
						// Subsequent syncs: full 6h cooldown
						this.settings.lastSyncTimes[date] = Date.now();
					}
				} else {
					// No data: still set a cooldown so we don't hammer the API on every page switch
					this.settings.lastSyncTimes[date] = Date.now() - (COOLDOWN_MS - NO_DATA_COOLDOWN_MS);
				}

				// Rate-limit delay between dates (not after the last one)
				if (i < datesToSync.length - 1) {
					await this.sleep(batchDelay);
				}
			}

			// Clean up old entries (older than 8 days)
			for (const [dateKey, timestamp] of Object.entries(this.settings.lastSyncTimes)) {
				if (now - timestamp > CLEANUP_AGE_MS) {
					delete this.settings.lastSyncTimes[dateKey];
				}
			}

			this.saveTokens();
			await this.saveSettings();

			if (synced > 0) {
				new Notice(t("noticeAutoSyncDone", this.settings.language).replace("{count}", String(synced)));
				console.debug(`Garmin Health Sync: Auto-sync done — ${synced}/${datesToSync.length} days synced`);
			}
		} catch (error) {
			// Token may have been refreshed/invalidated → persist. The permanent vs. transient
			// state is tracked by the state machine (provider.getAuthState()).
			this.saveTokens();
			await this.saveSettings();
			if (isLoginRequiredError(error) || this.garminProvider.getAuthState() === "needsUserLogin") {
				this.showGarminLoginRequiredNotice("sync hit login_required");
			} else {
				// Transient error: temporarilyUnavailable + backoff, do NOT pause permanently.
				console.debug("Garmin Health Sync: Auto-sync transient failure — will retry with backoff", error);
			}
		}
	}

	/** Manual sync — context-dependent based on the open daily note */
	private async manualSync(): Promise<void> {
		if (!this.garminProvider.isSessionValid()) {
			new Notice(t("noticeLoginRequired", this.settings.language));
			return;
		}

		const syncDate = this.detectSyncDate();
		try {
			const success = await this.syncManager.syncDate(syncDate, this.settings);
			if (success) {
				this.settings.lastSyncTimes[syncDate] = Date.now();
			}
			this.saveTokens();
			await this.saveSettings();
		} catch (error) {
			this.saveTokens();
			await this.saveSettings();
			if (isLoginRequiredError(error) || this.garminProvider.getAuthState() === "needsUserLogin") {
				this.showGarminLoginRequiredNotice("manual sync login_required");
			}
		}
	}

	/** Determines the sync date based on the currently open file */
	private detectSyncDate(): string {
		const yesterday = this.yesterdayString();
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return yesterday;

		const noteDate = this.dateFromDailyNote(activeFile);
		if (!noteDate) return yesterday;

		return noteDate;
	}

	/** Interactive OAuth login from settings (opens the Garmin login window). */
	async loginViaBrowser(): Promise<void> {
		const lang = this.settings.language;
		try {
			const success = await this.garminProvider.authenticate();
			if (success) {
				this.saveTokens();
				await this.saveSettings();
				new Notice(t("noticeLoginSuccess", lang));
				// Fresh login → state machine is ready; trigger a sync immediately.
				this.lastAutoSyncAttempt = 0;
				this.lastLoginNoticeAt = 0; // reset throttle: report future errors immediately
				void this.tryAutoSync();
			} else {
				new Notice(t("noticeLoginFailed", lang));
			}
		} catch (error) {
			console.error("Garmin Health Sync: OAuth login failed", error);
			new Notice(t("noticeLoginFailed", lang));
		}
	}

	/** Logout — clear OAuth tokens and persisted state */
	async logout(): Promise<void> {
		await this.garminProvider.clearSession();
		this.settings.garminSession = "";
		this.settings.garminOAuth1 = "";
		this.settings.garminOAuth2 = "";
		await this.saveSettings();
	}

	/** Checks whether a valid session exists */
	isSessionValid(): boolean {
		return this.garminProvider.isSessionValid();
	}

	/** Apply the configured server region to the API layer */
	applyServerRegion(): void {
		this.garminProvider.setRegion(this.settings.serverRegion);
	}

	/** Detect path and format from Periodic Notes / Daily Notes if not manually configured */
	private autoDetectDailyNotePath(): void {
		if (this.settings.dailyNotePath) return;

		// Periodic Notes Plugin
		const periodicNotes = (this.app as unknown as { plugins: { plugins: Record<string, { settings?: { daily?: { folder?: string; format?: string } } }> } })
			?.plugins?.plugins?.["periodic-notes"];
		if (periodicNotes?.settings?.daily?.folder) {
			this.settings.dailyNotePath = periodicNotes.settings.daily.folder;
			if (periodicNotes.settings.daily.format) {
				this.settings.dailyNoteFormat = periodicNotes.settings.daily.format;
			}
			console.debug("Garmin Health Sync: Auto-detected daily note path from Periodic Notes:", this.settings.dailyNotePath);
			return;
		}

		// Daily Notes Core Plugin
		const dailyNotes = (this.app as unknown as { internalPlugins: { plugins: Record<string, { instance?: { options?: { folder?: string; format?: string } } }> } })
			?.internalPlugins?.plugins?.["daily-notes"];
		if (dailyNotes?.instance?.options?.folder) {
			this.settings.dailyNotePath = dailyNotes.instance.options.folder;
			if (dailyNotes.instance.options.format) {
				this.settings.dailyNoteFormat = dailyNotes.instance.options.format;
			}
			console.debug("Garmin Health Sync: Auto-detected daily note path from Daily Notes:", this.settings.dailyNotePath);
			return;
		}
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<HealthSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		const defaults = DEFAULT_SETTINGS.enabledMetrics;
		for (const key of Object.keys(defaults)) {
			if (this.settings.enabledMetrics[key] === undefined) {
				this.settings.enabledMetrics[key] = defaults[key]!;
			}
		}

		// Detect language from Obsidian on first launch
		if (!saved?.language) {
			const obsidianLang = activeDocument.documentElement.lang?.slice(0, 2) ?? "en";
			const supported = ["en", "de", "zh", "ja", "es", "fr"];
			this.settings.language = supported.includes(obsidianLang) ? obsidianLang : "en";
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Restore persisted OAuth tokens into the provider on startup. */
	private restoreTokens(): void {
		const parse = <T>(raw: string): T | null => {
			if (!raw) return null;
			try { return JSON.parse(raw) as T; } catch { return null; }
		};
		const oauth1 = parse<OAuth1Token>(this.settings.garminOAuth1);
		const oauth2 = parse<OAuth2Token>(this.settings.garminOAuth2);
		if (oauth1) this.garminProvider.setTokens(oauth1, oauth2);
	}

	/** Persist the provider's current OAuth tokens (they may have been refreshed). */
	private saveTokens(): void {
		const { oauth1, oauth2 } = this.garminProvider.getTokens();
		this.settings.garminOAuth1 = oauth1 ? JSON.stringify(oauth1) : "";
		this.settings.garminOAuth2 = oauth2 ? JSON.stringify(oauth2) : "";
	}

	/** M6: Prompt existing users with a legacy cookie session (but no OAuth1) to
	 *  log in again once, and clear the legacy field so the notice does not
	 *  reappear. The re-login then goes through the new OAuth flow. */
	private async migrateLegacySession(): Promise<void> {
		if (this.settings.garminSession && !this.settings.garminOAuth1) {
			new Notice(t("noticeMigrationReloginRequired", this.settings.language), 0);
			this.settings.garminSession = "";
			// F10: await so the disk write completes — otherwise the migration notice
			// reappears on every start if a crash happens before the write.
			await this.saveSettings();
		}
	}

	private showGarminLoginRequiredNotice(reason: string): void {
		console.debug(`Garmin Health Sync: Login required — ${reason}`);
		// F3 + Review-A: time-based throttle instead of a binary guard. Prevents a new
		// notice on every daily-note open, but shows one again after the window elapses —
		// even if the user closed the last one manually (X). A binary
		// `if (loginRequiredNotice) return` would otherwise stay active forever
		// (notice closed via X → reference stays non-null → auto-sync silently paused).
		const now = Date.now();
		if (now - this.lastLoginNoticeAt < LOGIN_NOTICE_THROTTLE_MS) return;
		this.lastLoginNoticeAt = now;

		if (this.loginRequiredNotice) {
			this.loginRequiredNotice.hide();
			this.loginRequiredNotice = null;
		}

		const fragment = activeDocument.createDocumentFragment();
		const wrapper = activeDocument.createElement("div");
		const message = activeDocument.createElement("div");
		message.textContent = t("noticeSessionExpired", this.settings.language);
		wrapper.appendChild(message);

		const button = activeDocument.createElement("button");
		button.textContent = t("noticeLoginAction", this.settings.language);
		wrapper.appendChild(button);

		fragment.appendChild(wrapper);
		const notice = new Notice(fragment, 0);
		this.loginRequiredNotice = notice;
		button.addEventListener("click", () => {
			void this.loginFromNotice(notice, button);
		});
	}

	private async loginFromNotice(notice: Notice, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		button.textContent = t("noticeLoginInProgress", this.settings.language);
		await this.loginViaBrowser();

		if (this.garminProvider.isSessionValid() && this.garminProvider.getAuthState() !== "needsUserLogin") {
			// Review-C: loginViaBrowser() already triggered an auto-sync on success —
			// just close the notice here, no second tryAutoSync.
			notice.hide();
			if (this.loginRequiredNotice === notice) this.loginRequiredNotice = null;
			return;
		}

		button.disabled = false;
		button.textContent = t("noticeLoginAction", this.settings.language);
	}

	private todayString(): string {
		return this.dateString(new Date());
	}

	private yesterdayString(): string {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return this.dateString(d);
	}

	private dateString(d: Date): string {
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	}

	private isDailyNote(file: TFile, dates: string[]): boolean {
		for (const date of dates) {
			if (this.matchesDailyNote(file, date)) return true;
		}
		return false;
	}

	private dateFromDailyNote(file: TFile): string | null {
		const format = this.settings.dailyNoteFormat || "YYYY-MM-DD";
		const path = this.settings.dailyNotePath || "";

		const dir = file.path.substring(0, file.path.lastIndexOf("/"));
		if (path && dir !== path && !dir.startsWith(path + "/")) return null;
		if (!path && dir !== "") return null;

		const escaped = format
			.replace("YYYY", "\x01")
			.replace("MM", "\x02")
			.replace("DD", "\x03")
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace("\x01", "(?<year>\\d{4})")
			.replace("\x02", "(?<month>\\d{2})")
			.replace("\x03", "(?<day>\\d{2})");
		const match = file.basename.match(new RegExp(`^${escaped}$`));
		if (!match?.groups) return null;

		const { year, month, day } = match.groups;
		if (!year || !month || !day) return null;
		return `${year}-${month}-${day}`;
	}

	private matchesDailyNote(file: TFile, date: string): boolean {
		return this.dateFromDailyNote(file) === date;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}
}

/** Modal for backfill date range */
class BackfillModal extends Modal {
	private onSubmit: (from: string, to: string) => void;
	private lang: string;

	constructor(app: App, lang: string, onSubmit: (from: string, to: string) => void) {
		super(app);
		this.lang = lang;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("modalBackfillTitle", this.lang) });

		const today = new Date().toISOString().slice(0, 10);
		const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

		let fromDate = weekAgo;
		let toDate = today;

		new Setting(contentEl)
			.setName(t("modalBackfillFrom", this.lang))
			.addText(text => {
				text.inputEl.type = "date";
				text.setValue(weekAgo)
					.onChange(value => { fromDate = value; });
			});

		new Setting(contentEl)
			.setName(t("modalBackfillTo", this.lang))
			.addText(text => {
				text.inputEl.type = "date";
				text.setValue(today)
					.onChange(value => { toDate = value; });
			});

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText(t("modalBackfillStart", this.lang))
				.setCta()
				.onClick(() => {
					this.onSubmit(fromDate, toDate);
					this.close();
				}));
	}

	onClose() {
		this.contentEl.empty();
	}
}
