import type { HealthData, HealthProvider } from "../provider";
import { GarminApi, GarminSession } from "./garmin-api";
import {
	mapDailySummary,
	mapSleepData,
	mapHrvData,
	mapBodyBattery,
	mapSpO2,
	mapRespiration,
	mapWeight,
	mapHydration,
	mapTrainingReadiness,
	mapTrainingStatus,
	mapActivities,
} from "./garmin-mapper";

export class GarminProvider implements HealthProvider {
	readonly id = "garmin";
	readonly name = "Garmin Connect";

	private api = new GarminApi();

	setSession(session: GarminSession | null): void {
		this.api.setSession(session);
	}

	getSession(): GarminSession | null {
		return this.api.getSession();
	}

	isConfigured(): boolean {
		// BrowserWindow-Login braucht keine vorab-konfigurierten Credentials
		return true;
	}

	isSessionValid(): boolean {
		return this.api.isSessionValid();
	}

	async authenticate(): Promise<boolean> {
		return this.api.ensureBrowser();
	}

	closeBrowser(): void {
		this.api.closeBrowser();
	}

	/** BrowserWindow im Hintergrund oeffnen (fuer schnellere Syncs) */
	warmupBrowser(): void {
		this.api.ensureBrowser().catch(() => {});
	}

	async fetchData(date: string, enabledMetrics: string[]): Promise<HealthData> {
		const enabled = new Set(enabledMetrics);
		console.log("Health Sync: Enabled metrics:", enabledMetrics.join(", "));
		const metrics: Record<string, number | string> = {};

		const requests: Promise<void>[] = [];
		const merge = (label: string, data: Record<string, number | string>): void => {
			console.log(`Health Sync: Mapper [${label}] →`, JSON.stringify(data));
			Object.assign(metrics, data);
		};

		// Daily Summary
		const needsSummary = ["steps", "resting_hr", "stress", "calories_total", "calories_active", "distance_km", "floors", "intensity_min"]
			.some(k => enabled.has(k));
		if (needsSummary) {
			requests.push(
				this.api.fetchDailySummary(date)
					.then(data => merge("dailySummary", mapDailySummary(data, enabled)))
					.catch(e => console.warn("Health Sync: Daily summary fetch failed", e))
			);
		}

		// Sleep
		const needsSleep = ["sleep_duration", "sleep_score", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"]
			.some(k => enabled.has(k));
		if (needsSleep) {
			requests.push(
				this.api.fetchSleepData(date)
					.then(data => merge("sleep", mapSleepData(data, enabled)))
					.catch(e => console.warn("Health Sync: Sleep data fetch failed", e))
			);
		}

		// HRV
		if (enabled.has("hrv")) {
			requests.push(
				this.api.fetchHrv(date)
					.then(data => merge("hrv", mapHrvData(data, enabled)))
					.catch(e => console.warn("Health Sync: HRV fetch failed", e))
			);
		}

		// Body Battery
		if (enabled.has("body_battery")) {
			requests.push(
				this.api.fetchBodyBattery(date)
					.then(data => merge("bodyBattery", mapBodyBattery(data, enabled)))
					.catch(e => console.warn("Health Sync: Body Battery fetch failed", e))
			);
		}

		// SpO2
		if (enabled.has("spo2")) {
			requests.push(
				this.api.fetchSpO2(date)
					.then(data => merge("spo2", mapSpO2(data, enabled)))
					.catch(e => console.warn("Health Sync: SpO2 fetch failed", e))
			);
		}

		// Respiration
		if (enabled.has("respiration_rate")) {
			requests.push(
				this.api.fetchRespiration(date)
					.then(data => merge("respiration", mapRespiration(data, enabled)))
					.catch(e => console.warn("Health Sync: Respiration fetch failed", e))
			);
		}

		// Weight & Body Fat
		if (enabled.has("weight_kg") || enabled.has("body_fat_pct")) {
			requests.push(
				this.api.fetchWeight(date)
					.then(data => merge("weight", mapWeight(data, enabled)))
					.catch(e => console.warn("Health Sync: Weight fetch failed", e))
			);
		}

		// Hydration
		if (enabled.has("hydration_ml")) {
			requests.push(
				this.api.fetchHydration(date)
					.then(data => merge("hydration", mapHydration(data, enabled)))
					.catch(e => console.warn("Health Sync: Hydration fetch failed", e))
			);
		}

		// Training Readiness
		if (enabled.has("training_readiness")) {
			requests.push(
				this.api.fetchTrainingReadiness(date)
					.then(data => merge("trainingReadiness", mapTrainingReadiness(data, enabled)))
					.catch(e => console.warn("Health Sync: Training Readiness fetch failed", e))
			);
		}

		// Training Status
		if (enabled.has("training_status")) {
			requests.push(
				this.api.fetchTrainingStatus()
					.then(data => merge("trainingStatus", mapTrainingStatus(data, enabled)))
					.catch(e => console.warn("Health Sync: Training Status fetch failed", e))
			);
		}

		// Activities
		let activities: Record<string, string> = {};
		requests.push(
			this.api.fetchActivities(date)
				.then(data => { activities = mapActivities(data); })
				.catch(e => console.warn("Health Sync: Activities fetch failed", e))
		);

		await Promise.all(requests);

		return { metrics, activities };
	}
}
