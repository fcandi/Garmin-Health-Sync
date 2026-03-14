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

	async onload() {
		await this.loadSettings();
		this.autoDetectDailyNotePath();

		// Provider initialisieren
		this.garminProvider = new GarminProvider();

		// Session wiederherstellen
		if (this.settings.garminSession) {
			try {
				const session = JSON.parse(this.settings.garminSession) as GarminSession;
				this.garminProvider.setSession(session);
			} catch {
				// Ungueltige Session ignorieren
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
				new BackfillModal(this.app, this.settings.language, async (from, to) => {
					const count = await this.syncManager.backfill(from, to, this.settings);
					if (count > 0) {
						await this.saveSession();
						await this.saveSettings();
					}
				}).open();
			},
		});

		// Settings Tab
		this.addSettingTab(new HealthSyncSettingTab(this.app, this));

		// Beim Start: BrowserWindow proaktiv oeffnen (versteckt) + Auto-Sync
		this.app.workspace.onLayoutReady(() => {
			if (this.garminProvider.isSessionValid()) {
				this.garminProvider.warmupBrowser();
			}
			this.tryAutoSync();
		});

		// Auto-Sync beim Oeffnen von heute/gestern Daily Note
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file instanceof TFile && this.isDailyNote(file, [this.todayString(), this.yesterdayString()])) {
					this.tryAutoSync();
				}
			})
		);
	}

	onunload() {
		try { this.garminProvider.closeBrowser(); } catch { /* ignore */ }
	}

	/** Auto-Sync — holt Daten von gestern, einmal pro Tag */
	private async tryAutoSync(): Promise<void> {
		if (!this.settings.autoSync) return;
		if (this.settings.autoSyncPaused) return;
		const yesterday = this.yesterdayString();
		if (this.settings.lastSyncDate === yesterday) return;
		if (!this.garminProvider.isSessionValid()) return;

		try {
			const success = await this.syncManager.syncDate(yesterday, this.settings);
			if (success) {
				this.settings.lastSyncDate = yesterday;
				await this.saveSession();
				await this.saveSettings();
			}
		} catch (error) {
			console.error("Health Sync: Auto-sync failed", error);
			// Bei Auth-Fehler Auto-Sync pausieren
			this.settings.autoSyncPaused = true;
			await this.saveSettings();
			new Notice(t("noticeAutoSyncPaused", this.settings.language));
		}
	}

	/** Manueller Sync — kontextabhaengig je nach offener Daily Note */
	private async manualSync(): Promise<void> {
		if (!this.garminProvider.isSessionValid()) {
			new Notice(t("noticeLoginRequired", this.settings.language));
			return;
		}

		const syncDate = this.detectSyncDate();
		const success = await this.syncManager.syncDate(syncDate, this.settings);
		if (success) {
			// lastSyncDate nur setzen wenn es der regulaere Gestern-Sync war
			if (syncDate === this.yesterdayString()) {
				this.settings.lastSyncDate = syncDate;
			}
			await this.saveSession();
			await this.saveSettings();
		}
	}

	/** Bestimmt das Sync-Datum anhand der aktuell offenen Datei */
	private detectSyncDate(): string {
		const yesterday = this.yesterdayString();
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) return yesterday;

		const noteDate = this.dateFromDailyNote(activeFile);
		if (!noteDate) return yesterday;

		// Heute → gestern holen; alles andere → genau diesen Tag
		return noteDate === this.todayString() ? yesterday : noteDate;
	}

	/** BrowserWindow-Login aus Settings heraus */
	async loginViaBrowser(): Promise<void> {
		const lang = this.settings.language;
		try {
			const success = await this.garminProvider.authenticate();
			if (success) {
				// Auto-Sync wieder aktivieren bei erfolgreichem Login
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

	/** Logout — Session loeschen */
	async logout(): Promise<void> {
		this.garminProvider.setSession(null);
		this.settings.garminSession = "";
		await this.saveSettings();
	}

	/** Prueft ob eine gueltige Session besteht */
	isSessionValid(): boolean {
		return this.garminProvider.isSessionValid();
	}

	/** Pfad und Format aus Periodic Notes / Daily Notes uebernehmen falls nicht manuell gesetzt */
	private autoDetectDailyNotePath(): void {
		if (this.settings.dailyNotePath) return; // Manuell gesetzt — nicht ueberschreiben

		// Periodic Notes Plugin
		const periodicNotes = (this.app as unknown as { plugins: { plugins: Record<string, { settings?: { daily?: { folder?: string; format?: string } } }> } })
			?.plugins?.plugins?.["periodic-notes"];
		if (periodicNotes?.settings?.daily?.folder) {
			this.settings.dailyNotePath = periodicNotes.settings.daily.folder;
			if (periodicNotes.settings.daily.format) {
				this.settings.dailyNoteFormat = periodicNotes.settings.daily.format;
			}
			console.log("Health Sync: Auto-detected daily note path from Periodic Notes:", this.settings.dailyNotePath);
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
			console.log("Health Sync: Auto-detected daily note path from Daily Notes:", this.settings.dailyNotePath);
			return;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<HealthSyncSettings>);
		const defaults = DEFAULT_SETTINGS.enabledMetrics;
		for (const key of Object.keys(defaults)) {
			if (this.settings.enabledMetrics[key] === undefined) {
				this.settings.enabledMetrics[key] = defaults[key]!;
			}
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

	/** Prueft ob eine Datei eine Daily Note fuer eines der angegebenen Daten ist */
	private isDailyNote(file: TFile, dates: string[]): boolean {
		for (const date of dates) {
			if (this.matchesDailyNote(file, date)) return true;
		}
		return false;
	}

	/** Extrahiert das Datum aus einer Daily Note, oder null falls keine */
	private dateFromDailyNote(file: TFile): string | null {
		const format = this.settings.dailyNoteFormat || "YYYY-MM-DD";
		const path = this.settings.dailyNotePath || "";

		// Erwarteten Pfad-Prefix pruefen
		const dir = file.path.substring(0, file.path.lastIndexOf("/"));
		if (path && dir !== path) return null;
		if (!path && dir !== "") return null;

		// Dateiname gegen Format matchen (YYYY-MM-DD → Regex)
		const pattern = format
			.replace("YYYY", "(?<year>\\d{4})")
			.replace("MM", "(?<month>\\d{2})")
			.replace("DD", "(?<day>\\d{2})");
		const match = file.basename.match(new RegExp(`^${pattern}$`));
		if (!match?.groups) return null;

		return `${match.groups.year}-${match.groups.month}-${match.groups.day}`;
	}

	private matchesDailyNote(file: TFile, date: string): boolean {
		return this.dateFromDailyNote(file) === date;
	}
}

/** Modal fuer Backfill Datumsbereich */
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
