import type { HealthData, HealthProvider } from "../provider";
import type { ServerRegion } from "../../settings";
import { GarminApi, getRequiredEndpoints, calculateBatchDelay } from "./garmin-api";
import type { OAuth1Token, OAuth2Token } from "./garmin-oauth";
import type { AuthState } from "./auth-state";
import { LoginRequiredError, isLoginRequiredError } from "../../errors";
import {
	mapDailySummary,
	mapSleepData,
	mapHrvData,
	mapBodyBattery,
	mapSpO2,
	mapRespiration,
	mapWeight,
	mapTrainingReadiness,
	mapTrainingStatus,
	mapActivities,
} from "./garmin-mapper";

export class GarminProvider implements HealthProvider {
	readonly id = "garmin";
	readonly name = "Garmin Connect";

	private api = new GarminApi();

	setRegion(region: ServerRegion): void {
		this.api.setRegion(region);
	}

	async clearSession(): Promise<void> {
		await this.api.clearSession();
	}

	/** Closes any open login window (F12: invoked from the plugin onunload). */
	closeActiveLogin(): void {
		this.api.closeActiveLogin();
	}

	isConfigured(): boolean {
		// BrowserWindow login requires no pre-configured credentials
		return true;
	}

	isSessionValid(): boolean {
		return this.api.isSessionValid();
	}

	/** Interactive OAuth login via BrowserWindow (ticket → OAuth1 → OAuth2). */
	async authenticate(): Promise<boolean> {
		const res = await this.api.loginViaOAuth();
		if (!res.ok) console.debug("Garmin Health Sync: OAuth login failed —", res.detail);
		return res.ok;
	}

	/** Set persisted OAuth tokens (restore on startup). */
	setTokens(oauth1: OAuth1Token | null, oauth2: OAuth2Token | null): void {
		this.api.setTokens(oauth1, oauth2);
	}

	/** Current OAuth tokens for persistence. */
	getTokens(): { oauth1: OAuth1Token | null; oauth2: OAuth2Token | null } {
		return this.api.getTokens();
	}

	/** Auth state (Phase 7) — needsUserLogin = permanently paused. */
	getAuthState(): AuthState {
		return this.api.getAuthState();
	}

	/** Is auto-sync allowed to attempt a run right now? */
	shouldAttemptSync(): boolean {
		return this.api.shouldAttemptSync();
	}

	/** Recommended delay between dates in batch operations (ms) */
	getRecommendedBatchDelay(enabledMetrics: string[]): number {
		const endpoints = getRequiredEndpoints(enabledMetrics);
		return calculateBatchDelay(endpoints.length);
	}

	async fetchData(date: string, enabledMetrics: string[]): Promise<HealthData> {
		// OAuth: no BrowserWindow needed for data fetching. If the long-lived
		// OAuth1 token is missing, an interactive login is required. The OAuth2 refresh
		// happens silently in fetchDataForDate (Phase 7).
		if (!this.api.isSessionValid()) {
			throw new LoginRequiredError();
		}

		const enabled = new Set(enabledMetrics);
		// Only call required endpoints
		const requiredEndpoints = getRequiredEndpoints(enabledMetrics);
		this.api.setRequiredEndpoints(requiredEndpoints);
		console.debug("Garmin Health Sync: Endpoints:", requiredEndpoints.join(", "), `(${requiredEndpoints.length}/${enabledMetrics.length} metrics)`);
		const metrics: Record<string, number | string> = {};

		const requests: Promise<void>[] = [];
		const merge = (label: string, data: Record<string, number | string>): void => {
			console.debug(`Garmin Health Sync: Mapper [${label}] →`, JSON.stringify(data));
			Object.assign(metrics, data);
		};
		const warnOrRethrowAuth = (label: string, error: unknown): void => {
			if (isLoginRequiredError(error)) throw error;
			console.warn(`Garmin Health Sync: ${label} fetch failed`, error);
		};

		// Daily Summary
		const needsSummary = ["steps", "resting_hr", "stress", "calories_total", "calories_active", "distance_km", "floors", "intensity_min"]
			.some(k => enabled.has(k));
		if (needsSummary) {
			requests.push(
				this.api.fetchDailySummary(date)
					.then(data => merge("dailySummary", mapDailySummary(data, enabled)))
					.catch(e => warnOrRethrowAuth("Daily summary", e))
			);
		}

		// Sleep
		const needsSleep = ["sleep_duration", "sleep_score", "sleep_deep", "sleep_light", "sleep_rem", "sleep_awake"]
			.some(k => enabled.has(k));
		if (needsSleep) {
			requests.push(
				this.api.fetchSleepData(date)
					.then(data => merge("sleep", mapSleepData(data, enabled)))
					.catch(e => warnOrRethrowAuth("Sleep data", e))
			);
		}

		// HRV
		if (enabled.has("hrv")) {
			requests.push(
				this.api.fetchHrv(date)
					.then(data => merge("hrv", mapHrvData(data, enabled)))
					.catch(e => warnOrRethrowAuth("HRV", e))
			);
		}

		// Body Battery
		if (enabled.has("body_battery")) {
			requests.push(
				this.api.fetchBodyBattery(date)
					.then(data => merge("bodyBattery", mapBodyBattery(data, enabled)))
					.catch(e => warnOrRethrowAuth("Body Battery", e))
			);
		}

		// SpO2
		if (enabled.has("spo2")) {
			requests.push(
				this.api.fetchSpO2(date)
					.then(data => merge("spo2", mapSpO2(data, enabled)))
					.catch(e => warnOrRethrowAuth("SpO2", e))
			);
		}

		// Respiration
		if (enabled.has("respiration_rate")) {
			requests.push(
				this.api.fetchRespiration(date)
					.then(data => merge("respiration", mapRespiration(data, enabled)))
					.catch(e => warnOrRethrowAuth("Respiration", e))
			);
		}

		// Weight & Body Fat
		if (enabled.has("weight_kg") || enabled.has("body_fat_pct")) {
			requests.push(
				this.api.fetchWeight(date)
					.then(data => merge("weight", mapWeight(data, enabled)))
					.catch(e => warnOrRethrowAuth("Weight", e))
			);
		}

		// Training Readiness
		if (enabled.has("training_readiness")) {
			requests.push(
				this.api.fetchTrainingReadiness(date)
					.then(data => merge("trainingReadiness", mapTrainingReadiness(data, enabled)))
					.catch(e => warnOrRethrowAuth("Training Readiness", e))
			);
		}

		// Training Status / VO2 max
		if (enabled.has("training_status") || enabled.has("vo2_max")) {
			requests.push(
				this.api.fetchTrainingStatus(date)
					.then(data => merge("trainingStatus", mapTrainingStatus(data, enabled)))
					.catch(e => warnOrRethrowAuth("Training Status", e))
			);
		}

		// Activities
		let activities: Record<string, string> = {};
		let trainings: import("../provider").TrainingEntry[] = [];
		let startLocation: { lat: number; lon: number } | undefined;
		requests.push(
			this.api.fetchActivities(date)
				.then(data => {
					const result = mapActivities(data);
					activities = result.display;
					trainings = result.trainings;
					if (result.startLocation) startLocation = result.startLocation;
				})
				.catch(e => warnOrRethrowAuth("Activities", e))
		);

		await Promise.all(requests);

		return { metrics, activities, trainings, startLocation };
	}
}
