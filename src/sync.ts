import { App, Notice } from "obsidian";
import type { HealthProvider } from "./providers/provider";
import { writeToDailyNote } from "./daily-note";
import type { HealthSyncSettings } from "./settings";
import { t } from "./i18n/t";
import { convertToImperial } from "./units";
import { isLoginRequiredError } from "./errors";

export class SyncManager {
	private provider: HealthProvider;
	private app: App;

	constructor(app: App, provider: HealthProvider) {
		this.app = app;
		this.provider = provider;
	}

	/** Sync for a specific date.
	 * @param quiet Suppress per-date notices (used during auto-sync batch). */
	async syncDate(date: string, settings: HealthSyncSettings, quiet = false): Promise<boolean> {
		if (!this.provider.isConfigured()) {
			new Notice(t("noticeLoginRequired", settings.language));
			return false;
		}

		if (!quiet) new Notice(t("noticeSyncing", settings.language));

		try {
			// Authenticate if needed
			if (!this.provider.isSessionValid()) {
				const authenticated = await this.provider.authenticate();
				if (!authenticated.ok) {
					if (!quiet) new Notice(t("noticeSyncError", settings.language));
					return false;
				}
			}

			// Collect enabled metrics
			const enabledMetrics = Object.entries(settings.enabledMetrics)
				.filter(([, enabled]) => enabled)
				.map(([key]) => key);

			// Fetch data
			const data = await this.provider.fetchData(date, enabledMetrics);

			const hasData = Object.keys(data.metrics).length > 0 || Object.keys(data.activities).length > 0;
			if (!hasData) {
				console.warn("Garmin Health Sync: No data returned for", date);
				if (!quiet) new Notice(t("noticeSyncNoData", settings.language));
				return false;
			}

			// Convert to imperial if configured
			const outputData = settings.unitSystem === "imperial" ? convertToImperial(data) : data;

			// Write to daily note
			await writeToDailyNote(this.app, date, outputData, {
				dailyNotePath: settings.dailyNotePath,
				dailyNoteFormat: settings.dailyNoteFormat,
				prefix: settings.usePrefix ? "ohs_" : "",
				template: settings.dailyNoteTemplate,
				writeTrainings: settings.writeTrainings,
				writeWorkoutLocation: settings.writeWorkoutLocation,
			});

			if (!quiet) new Notice(t("noticeSyncSuccess", settings.language));
			return true;
		} catch (error) {
			if (isLoginRequiredError(error)) {
				if (!quiet) new Notice(t("noticeLoginRequired", settings.language));
				throw error; // Caller pauses autoSync
			}
			console.error("Garmin Health Sync: Sync failed", error);
			if (!quiet) new Notice(t("noticeSyncError", settings.language));
			return false;
		}
	}

	/** Backfill for a date range */
	async backfill(fromDate: string, toDate: string, settings: HealthSyncSettings): Promise<number> {
		if (!this.provider.isConfigured()) {
			new Notice(t("noticeLoginRequired", settings.language));
			return 0;
		}

		new Notice(t("noticeBackfillStart", settings.language));

		let count = 0;
		try {
			if (!this.provider.isSessionValid()) {
				const authenticated = await this.provider.authenticate();
				if (!authenticated.ok) return 0;
			}

			const enabledMetrics = Object.entries(settings.enabledMetrics)
				.filter(([, enabled]) => enabled)
				.map(([key]) => key);

			const dates = this.dateRange(fromDate, toDate);

			// Calculate delay based on number of endpoints (50 req/min budget)
			const batchDelay = this.provider.getRecommendedBatchDelay?.(enabledMetrics) ?? 2000;
			console.debug(`Garmin Health Sync: Backfill ${dates.length} dates, delay ${batchDelay}ms`);

			for (let i = 0; i < dates.length; i++) {
				const date = dates[i]!;
				try {
					const data = await this.provider.fetchData(date, enabledMetrics);
					const hasData = Object.keys(data.metrics).length > 0 || Object.keys(data.activities).length > 0;

					if (hasData) {
						const outputData = settings.unitSystem === "imperial" ? convertToImperial(data) : data;
						await writeToDailyNote(this.app, date, outputData, {
							dailyNotePath: settings.dailyNotePath,
							dailyNoteFormat: settings.dailyNoteFormat,
							prefix: settings.usePrefix ? "ohs_" : "",
							template: settings.dailyNoteTemplate,
							writeTrainings: settings.writeTrainings,
							writeWorkoutLocation: settings.writeWorkoutLocation,
						});
						count++;
					}

					// Rate limiting: skip delay after the last date
					if (i < dates.length - 1) {
						await this.sleep(batchDelay);
					}
				} catch (error) {
					if (isLoginRequiredError(error)) {
						new Notice(t("noticeLoginRequired", settings.language));
						throw error;
					}
					console.warn(`Garmin Health Sync: Backfill failed for ${date}`, error);
				}
			}

			new Notice(t("noticeBackfillDone", settings.language).replace("{count}", String(count)));
			return count;
		} catch (error) {
			if (isLoginRequiredError(error)) {
				return count;
			}
			console.error("Garmin Health Sync: Backfill failed", error);
			new Notice(t("noticeSyncError", settings.language));
			return 0;
		}
	}

	private dateRange(from: string, to: string): string[] {
		const dates: string[] = [];
		const current = new Date(from + "T00:00:00");
		const end = new Date(to + "T00:00:00");

		while (current <= end) {
			dates.push(`${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`);
			current.setDate(current.getDate() + 1);
		}

		return dates;
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}
}
