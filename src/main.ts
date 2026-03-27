import { App, Modal, Notice, Plugin, Setting, TFile } from "obsidian";
import { DEFAULT_SETTINGS, HealthSyncSettings, HealthSyncSettingTab } from "./settings";
import { SyncManager } from "./sync";
import { GarminProvider } from "./providers/garmin/garmin-provider";
import type { GarminSession } from "./providers/garmin/garmin-api";
import { t } from "./i18n/t";

export default class HealthSyncPlugin extends Plugin {
	settings: HealthSyncSettings;
	private syncManager: SyncManager;
	private garminProvider: GarminProvider;
	private autoSyncRunning = false;

	async onload() {
		await this.loadSettings();
		this.autoDetectDailyNotePath();

		// Initialize provider
		this.garminProvider = new GarminProvider();

		// Restore session
		if (this.settings.garminSession) {
			try {
				const session = JSON.parse(this.settings.garminSession) as GarminSession;
				this.garminProvider.setSession(session);
			} catch {
				// Ignore invalid session
			}
		}

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
						const count = await this.syncManager.backfill(from, to, this.settings);
						if (count > 0) {
							await this.saveSession();
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

	onunload() {
		try { this.garminProvider.closeBrowser(); } catch { /* ignore */ }
	}

	/** Auto-sync — checks the last 7 days, syncs missing or outdated data */
	private async tryAutoSync(): Promise<void> {
		if (!this.settings.autoSync) return;
		if (this.settings.autoSyncPaused) return;
		if (this.autoSyncRunning) return;
		if (!this.garminProvider.isSessionValid()) {
			this.settings.autoSyncPaused = true;
			await this.saveSettings();
			new Notice(t("noticeSessionExpired", this.settings.language));
			return;
		}

		this.autoSyncRunning = true;
		try {
			await this.runAutoSync();
		} finally {
			this.autoSyncRunning = false;
		}
	}

	private async runAutoSync(): Promise<void> {
		if (!this.garminProvider.isSessionValid()) return;

		const now = Date.now();
		const RESYNC_WINDOW_MS = 72 * 60 * 60 * 1000; // 72h — more recent data may be overwritten
		const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown between re-syncs per date
		const FIRST_COOLDOWN_MS = 30 * 60 * 1000; // 30min — first re-sync happens sooner
		const syncTimes = this.settings.lastSyncTimes;

		// Check last 7 days — which ones need a (re-)sync?
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

		if (datesToSync.length === 0) {
			console.debug("Health Sync: Auto-sync — nothing to sync (all within cooldown or already synced)");
			return;
		}

		console.debug("Health Sync: Auto-sync — syncing:", datesToSync.join(", "));

		const enabledMetrics = Object.entries(this.settings.enabledMetrics)
			.filter(([, enabled]) => enabled)
			.map(([key]) => key);

		try {
			const batchDelay = this.garminProvider.getRecommendedBatchDelay(enabledMetrics);
			let synced = 0;

			for (let i = 0; i < datesToSync.length; i++) {
				const date = datesToSync[i]!;
				const success = await this.syncManager.syncDate(date, this.settings);
				if (success) {
					synced++;
					const isFirstSync = !this.settings.lastSyncTimes[date];
					if (isFirstSync) {
						// First sync: simulate short cooldown (30min)
						this.settings.lastSyncTimes[date] = Date.now() - (COOLDOWN_MS - FIRST_COOLDOWN_MS);
					} else {
						// Subsequent syncs: full 6h cooldown
						this.settings.lastSyncTimes[date] = Date.now();
					}
				}

				// Rate-limit delay between dates (not after the last one)
				if (i < datesToSync.length - 1) {
					await new Promise(r => setTimeout(r, batchDelay));
				}
			}

			// Clean up old entries (older than 8 days)
			const CLEANUP_AGE_MS = 8 * 24 * 60 * 60 * 1000;
			for (const [dateKey, timestamp] of Object.entries(this.settings.lastSyncTimes)) {
				if (now - timestamp > CLEANUP_AGE_MS) {
					delete this.settings.lastSyncTimes[dateKey];
				}
			}

			await this.saveSession();
			await this.saveSettings();

			if (synced > 0) {
				console.debug(`Health Sync: Auto-sync done — ${synced}/${datesToSync.length} days synced`);
			}
		} catch (error) {
			// login_required: notice was already shown in syncDate
			if (!(error instanceof Error && error.message === "login_required")) {
				console.error("Health Sync: Auto-sync failed", error);
				new Notice(t("noticeAutoSyncPaused", this.settings.language));
			}
			this.settings.autoSyncPaused = true;
			await this.saveSettings();
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
				await this.saveSession();
				await this.saveSettings();
			}
		} catch (error) {
			if (error instanceof Error && error.message === "login_required") {
				// Notice was already shown in syncDate
				this.settings.autoSyncPaused = true;
				await this.saveSettings();
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

		// Today → use yesterday; anything else → use that exact day
		return noteDate === this.todayString() ? yesterday : noteDate;
	}

	/** BrowserWindow login from settings */
	async loginViaBrowser(): Promise<void> {
		const lang = this.settings.language;
		try {
			const success = await this.garminProvider.authenticate();
			if (success) {
				// Re-enable auto-sync on successful login
				this.settings.autoSyncPaused = false;
				await this.saveSession();
				await this.saveSettings();
				new Notice(t("noticeLoginSuccess", lang));
			} else {
				new Notice(t("noticeLoginFailed", lang));
			}
		} catch (error) {
			console.error("Health Sync: Browser login failed", error);
			new Notice(t("noticeLoginFailed", lang));
		}
	}

	/** Logout — clear session */
	async logout(): Promise<void> {
		this.garminProvider.setSession(null);
		this.settings.garminSession = "";
		await this.saveSettings();
	}

	/** Checks whether a valid session exists */
	isSessionValid(): boolean {
		return this.garminProvider.isSessionValid();
	}

	/** Detect path and format from Periodic Notes / Daily Notes if not manually configured */
	private autoDetectDailyNotePath(): void {
		if (this.settings.dailyNotePath) return; // Manually configured — do not overwrite

		// Periodic Notes Plugin
		const periodicNotes = (this.app as unknown as { plugins: { plugins: Record<string, { settings?: { daily?: { folder?: string; format?: string } } }> } })
			?.plugins?.plugins?.["periodic-notes"];
		if (periodicNotes?.settings?.daily?.folder) {
			this.settings.dailyNotePath = periodicNotes.settings.daily.folder;
			if (periodicNotes.settings.daily.format) {
				this.settings.dailyNoteFormat = periodicNotes.settings.daily.format;
			}
			console.debug("Health Sync: Auto-detected daily note path from Periodic Notes:", this.settings.dailyNotePath);
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
			console.debug("Health Sync: Auto-detected daily note path from Daily Notes:", this.settings.dailyNotePath);
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
			const obsidianLang = document.documentElement.lang?.slice(0, 2) ?? "en";
			const supported = ["en", "de", "zh", "ja", "es", "fr"];
			this.settings.language = supported.includes(obsidianLang) ? obsidianLang : "en";
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async saveSession(): Promise<void> {
		const session = this.garminProvider.getSession();
		this.settings.garminSession = session ? JSON.stringify(session) : "";
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

	/** Checks whether a file is a daily note for one of the given dates */
	private isDailyNote(file: TFile, dates: string[]): boolean {
		for (const date of dates) {
			if (this.matchesDailyNote(file, date)) return true;
		}
		return false;
	}

	/** Extracts the date from a daily note, or null if not a daily note */
	private dateFromDailyNote(file: TFile): string | null {
		const format = this.settings.dailyNoteFormat || "YYYY-MM-DD";
		const path = this.settings.dailyNotePath || "";

		// Check expected path prefix (also allow subdirectories)
		const dir = file.path.substring(0, file.path.lastIndexOf("/"));
		if (path && dir !== path && !dir.startsWith(path + "/")) return null;
		if (!path && dir !== "") return null;

		// Match filename against format (YYYY-MM-DD → regex)
		// First replace placeholders temporarily, then escape special chars, then insert groups
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

		return `${match.groups.year}-${match.groups.month}-${match.groups.day}`;
	}

	private matchesDailyNote(file: TFile, date: string): boolean {
		return this.dateFromDailyNote(file) === date;
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
