import { App, Notice } from "obsidian";
import type { HealthProvider } from "./providers/provider";
import { writeToDailyNote, dailyNoteExists } from "./daily-note";
import type { HealthSyncSettings } from "./settings";
import { t } from "./i18n/t";
import { convertToImperial } from "./units";
import { isLoginRequiredError } from "./errors";

/**
 * Result of a single-date sync:
 *  - "synced": data was fetched and written
 *  - "no-data": the provider returned nothing for the date
 *  - "skipped-missing-note": the daily note doesn't exist and creation is off —
 *    no API call was made, so the caller should retry later without a cooldown
 *  - "error": configuration/auth/transient failure
 */
export type SyncOutcome = "synced" | "no-data" | "skipped-missing-note" | "error";

export class SyncManager {
	private provider: HealthProvider;
	private app: App;

	constructor(app: App, provider: HealthProvider) {
		this.app = app;
		this.provider = provider;
	}

	/** Sync for a specific date.
	 * @param quiet Suppress per-date notices (used during auto-sync batch).
	 * @param options.waitForNote When true, the sync waits for an existing
	 *        (non-empty) daily note instead of creating one — set only by the
	 *        background auto-sync when "create daily note when missing" is off.
	 *        Manual sync and backfill leave it false and always create. */
	async syncDate(
		date: string,
		settings: HealthSyncSettings,
		quiet = false,
		options: { waitForNote?: boolean } = {}
	): Promise<SyncOutcome> {
		const waitForNote = options.waitForNote ?? false;

		if (!this.provider.isConfigured()) {
			new Notice(t("noticeLoginRequired", settings.language));
			return "error";
		}

		// Gate before any network call: in wait-for-note mode, skip without
		// spending an API request until a real (non-empty) daily note exists.
		// The caller retries at the next opportunity (no cooldown is set).
		if (waitForNote && !dailyNoteExists(this.app, date, {
			dailyNotePath: settings.dailyNotePath,
			dailyNoteFormat: settings.dailyNoteFormat,
		})) {
			console.debug("Garmin Health Sync: daily note missing/empty, sync skipped (waiting for note) for", date);
			if (!quiet) new Notice(t("noticeSyncWaitingForNote", settings.language).replace("{date}", date));
			return "skipped-missing-note";
		}

		if (!quiet) new Notice(t("noticeSyncing", settings.language));

		try {
			// Authenticate if needed
			if (!this.provider.isSessionValid()) {
				const authenticated = await this.provider.authenticate();
				if (!authenticated.ok) {
					if (!quiet) new Notice(t("noticeSyncError", settings.language));
					return "error";
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
				return "no-data";
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
				// In wait mode the gate above already confirmed the note exists;
				// keep createIfMissing false as a safety net should it vanish
				// mid-sync. Otherwise (manual/auto-with-creation) create as before.
				createIfMissing: !waitForNote,
			});

			if (!quiet) new Notice(t("noticeSyncSuccess", settings.language));
			return "synced";
		} catch (error) {
			if (isLoginRequiredError(error)) {
				if (!quiet) new Notice(t("noticeLoginRequired", settings.language));
				throw error; // Caller pauses autoSync
			}
			console.error("Garmin Health Sync: Sync failed", error);
			if (!quiet) new Notice(t("noticeSyncError", settings.language));
			return "error";
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
						// Backfill is an explicit user action over a date range — it
						// always creates missing notes, regardless of the auto-sync
						// "create daily note when missing" setting.
						await writeToDailyNote(this.app, date, outputData, {
							dailyNotePath: settings.dailyNotePath,
							dailyNoteFormat: settings.dailyNoteFormat,
							prefix: settings.usePrefix ? "ohs_" : "",
							template: settings.dailyNoteTemplate,
							writeTrainings: settings.writeTrainings,
							writeWorkoutLocation: settings.writeWorkoutLocation,
							createIfMissing: true,
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
