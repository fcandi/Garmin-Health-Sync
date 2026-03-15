import { App, Notice } from "obsidian";
import type { HealthProvider } from "./providers/provider";
import { writeToDailyNote } from "./daily-note";
import type { HealthSyncSettings } from "./settings";
import { t } from "./i18n/t";

export class SyncManager {
	private provider: HealthProvider;
	private app: App;

	constructor(app: App, provider: HealthProvider) {
		this.app = app;
		this.provider = provider;
	}

	setProvider(provider: HealthProvider): void {
		this.provider = provider;
	}

	/** Sync fuer heute ausfuehren */
	async syncToday(settings: HealthSyncSettings): Promise<boolean> {
		const today = this.todayString();

		// Pruefen ob heute schon gesynct wurde
		if (settings.lastSyncDate === today) {
			new Notice(t("noticeAlreadySynced", settings.language));
			return false;
		}

		return this.syncDate(today, settings);
	}

	/** Sync fuer ein bestimmtes Datum */
	async syncDate(date: string, settings: HealthSyncSettings): Promise<boolean> {
		if (!this.provider.isConfigured()) {
			new Notice(t("noticeLoginRequired", settings.language));
			return false;
		}

		new Notice(t("noticeSyncing", settings.language));

		try {
			// Authentifizieren falls noetig
			if (!this.provider.isSessionValid()) {
				const authenticated = await this.provider.authenticate();
				if (!authenticated) {
					new Notice(t("noticeSyncError", settings.language));
					return false;
				}
			}

			// Aktivierte Metriken sammeln
			const enabledMetrics = Object.entries(settings.enabledMetrics)
				.filter(([, enabled]) => enabled)
				.map(([key]) => key);

			// Daten abrufen
			const data = await this.provider.fetchData(date, enabledMetrics);

			const hasData = Object.keys(data.metrics).length > 0 || Object.keys(data.activities).length > 0;
			if (!hasData) {
				console.warn("Health Sync: No data returned for", date);
				new Notice(t("noticeSyncNoData", settings.language));
				return false;
			}

			// In Daily Note schreiben
			await writeToDailyNote(this.app, date, data, {
				dailyNotePath: settings.dailyNotePath,
				dailyNoteFormat: settings.dailyNoteFormat,
				prefix: settings.usePrefix ? "ohs_" : "",
				template: settings.dailyNoteTemplate,
			});

			new Notice(t("noticeSyncSuccess", settings.language));
			return true;
		} catch (error) {
			console.error("Health Sync: Sync failed", error);
			new Notice(t("noticeSyncError", settings.language));
			return false;
		}
	}

	/** Backfill fuer einen Datumsbereich */
	async backfill(fromDate: string, toDate: string, settings: HealthSyncSettings): Promise<number> {
		if (!this.provider.isConfigured()) {
			new Notice(t("noticeLoginRequired", settings.language));
			return 0;
		}

		new Notice(t("noticeBackfillStart", settings.language));

		try {
			if (!this.provider.isSessionValid()) {
				const authenticated = await this.provider.authenticate();
				if (!authenticated) return 0;
			}

			const enabledMetrics = Object.entries(settings.enabledMetrics)
				.filter(([, enabled]) => enabled)
				.map(([key]) => key);

			const dates = this.dateRange(fromDate, toDate);
			let count = 0;

			// Delay basierend auf Anzahl Endpoints berechnen (50 Req/Min Budget)
			const batchDelay = this.provider.getRecommendedBatchDelay?.(enabledMetrics) ?? 2000;
			console.log(`Health Sync: Backfill ${dates.length} dates, delay ${batchDelay}ms`);

			for (const date of dates) {
				try {
					const data = await this.provider.fetchData(date, enabledMetrics);
					const hasData = Object.keys(data.metrics).length > 0 || Object.keys(data.activities).length > 0;

					if (hasData) {
						await writeToDailyNote(this.app, date, data, {
							dailyNotePath: settings.dailyNotePath,
							dailyNoteFormat: settings.dailyNoteFormat,
							prefix: settings.usePrefix ? "ohs_" : "",
							template: settings.dailyNoteTemplate,
						});
						count++;
					}

					// Rate Limiting: dynamisch basierend auf Endpoint-Anzahl
					await this.sleep(batchDelay);
				} catch (error) {
					console.warn(`Health Sync: Backfill failed for ${date}`, error);
				}
			}

			new Notice(t("noticeBackfillDone", settings.language).replace("{count}", String(count)));
			return count;
		} catch (error) {
			console.error("Health Sync: Backfill failed", error);
			new Notice(t("noticeSyncError", settings.language));
			return 0;
		}
	}

	private todayString(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	}

	private dateRange(from: string, to: string): string[] {
		const dates: string[] = [];
		const current = new Date(from);
		const end = new Date(to);

		while (current <= end) {
			dates.push(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`);
			current.setDate(current.getDate() + 1);
		}

		return dates;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
