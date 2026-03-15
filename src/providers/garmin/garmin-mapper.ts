/** Konvertiert Sekunden in "Xh Ymin" Format */
export function secondsToHoursMin(seconds: number | null | undefined): string | null {
	if (seconds == null || seconds <= 0) return null;
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.round((seconds % 3600) / 60);
	return `${hours}h ${minutes}min`;
}

/** Rundet auf eine Nachkommastelle */
function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Sicherer Zugriff auf verschachtelte Properties */
function get(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Mappt Garmin Daily Summary auf normalisierte Metriken */
export function mapDailySummary(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};

	const mappings: [string, string, ((v: unknown) => number | string | null)?][] = [
		["steps", "totalSteps"],
		["resting_hr", "restingHeartRate"],
		["stress", "averageStressLevel"],
		["calories_total", "totalKilocalories"],
		["calories_active", "activeKilocalories"],
		["distance_km", "totalDistanceMeters", (v) => v != null ? round1(Number(v) / 1000) : null],
		["floors", "floorsAscended", (v) => Math.round(Number(v))],
		["intensity_min", "moderateIntensityMinutes", (v) => {
			const moderate = Number(v) || 0;
			const vigorous = Number(data["vigorousIntensityMinutes"]) || 0;
			return moderate + vigorous;
		}],
	];

	for (const [key, field, transform] of mappings) {
		if (!enabled.has(key)) continue;
		const raw = data[field];
		if (raw == null) continue;

		if (transform) {
			const val = transform(raw);
			if (val != null) result[key] = val;
		} else {
			result[key] = Number(raw);
		}
	}

	return result;
}

/** Mappt Garmin Sleep Daten auf normalisierte Metriken */
export function mapSleepData(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};

	if (enabled.has("sleep_score")) {
		const score = get(data, "sleepScores.overall.value") ?? data["overallSleepScore"];
		if (score != null) result["sleep_score"] = Number(score);
	}

	if (enabled.has("sleep_duration")) {
		const seconds = data["sleepTimeSeconds"];
		if (seconds != null) {
			const formatted = secondsToHoursMin(Number(seconds));
			if (formatted) result["sleep_duration"] = formatted;
		}
	}

	const sleepPhases: [string, string][] = [
		["sleep_deep", "deepSleepSeconds"],
		["sleep_light", "lightSleepSeconds"],
		["sleep_rem", "remSleepSeconds"],
		["sleep_awake", "awakeSleepSeconds"],
	];

	for (const [key, field] of sleepPhases) {
		if (!enabled.has(key)) continue;
		const seconds = data[field];
		if (seconds == null) continue;
		const formatted = secondsToHoursMin(Number(seconds));
		if (formatted) result[key] = formatted;
	}

	return result;
}

/** Mappt HRV Daten */
export function mapHrvData(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("hrv")) return result;

	const hrvValue = get(data, "hrvSummary.weeklyAvg") ?? get(data, "hrvSummary.lastNightAvg") ?? data["hrvStatus"];
	if (hrvValue != null) result["hrv"] = Math.round(Number(hrvValue));

	return result;
}

/** Mappt Body Battery Daten (Garmin gibt ein Objekt zurueck, kein Array) */
export function mapBodyBattery(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("body_battery") || Object.keys(data).length === 0) return result;

	// Body Battery kann in verschiedenen Feldern stecken
	const charged = data["charged"]
		?? get(data, "bodyBatteryStatList.0.charged")
		?? data["bodyBatteryMostRecentValue"]
		?? data["chargedValue"];
	if (charged != null) result["body_battery"] = Number(charged);

	return result;
}

/** Mappt SpO2 Daten */
export function mapSpO2(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("spo2")) return result;

	const avg = data["averageSpo2"] ?? get(data, "allDaySpO2.averageSpo2");
	if (avg != null && Number(avg) > 0) result["spo2"] = Number(avg);

	return result;
}

/** Mappt Respiration Daten */
export function mapRespiration(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("respiration_rate")) return result;

	const avg = data["avgWakingRespirationValue"];
	if (avg != null && Number(avg) > 0) result["respiration_rate"] = Number(avg);

	return result;
}

/** Mappt Gewichts-Daten */
export function mapWeight(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};

	const entries = data["dailyWeightSummaries"] ?? data["dateWeightList"];
	if (!Array.isArray(entries) || entries.length === 0) return result;

	const latest = entries[entries.length - 1] as Record<string, unknown> | undefined;
	if (!latest) return result;

	if (enabled.has("weight_kg")) {
		const weight = latest["weight"] ?? get(latest, "weight");
		if (weight != null) result["weight_kg"] = round1(Number(weight) / 1000);
	}

	if (enabled.has("body_fat_pct")) {
		const fat = latest["bodyFat"];
		if (fat != null) result["body_fat_pct"] = round1(Number(fat));
	}

	return result;
}

/** Mappt Hydrations-Daten */
export function mapHydration(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("hydration_ml")) return result;

	const intake = data["valueInML"] ?? data["hydrationIntakeML"];
	if (intake != null && Number(intake) > 0) result["hydration_ml"] = Number(intake);

	return result;
}

/** Mappt Training Readiness */
export function mapTrainingReadiness(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("training_readiness")) return result;

	const score = data["score"] ?? data["trainingReadinessScore"];
	if (score != null) result["training_readiness"] = Math.round(Number(score));

	return result;
}

/** Mappt Training Status */
export function mapTrainingStatus(data: Record<string, unknown>, enabled: Set<string>): Record<string, number | string> {
	const result: Record<string, number | string> = {};
	if (!enabled.has("training_status")) return result;

	const status = data["currentTrainingStatusPhrase"] ?? data["trainingStatusPhrase"];
	if (status != null) result["training_status"] = String(status);

	return result;
}

/** Mappt Garmin Activities auf normalisierte Trainings-Strings */
export function mapActivities(activities: Record<string, unknown>[]): Record<string, string> {
	const grouped: Record<string, { count: number; distanceKm: number; durationMin: number; avgHr: number; hrCount: number; calories: number }> = {};

	for (const act of activities) {
		// typeKey von der API ist autoritativ — Garmin aendert typeIds gelegentlich
		const typeName = String(get(act, "activityType.typeKey") ?? "workout").toLowerCase().replace(/\s+/g, "_");

		if (!grouped[typeName]) {
			grouped[typeName] = { count: 0, distanceKm: 0, durationMin: 0, avgHr: 0, hrCount: 0, calories: 0 };
		}

		const group = grouped[typeName]!;
		group.count++;
		group.distanceKm += round1((Number(act["distance"]) || 0) / 1000);
		group.durationMin += Math.round((Number(act["duration"]) || 0) / 60);
		group.calories += Math.round(Number(act["calories"]) || 0);

		const hr = Number(act["averageHR"]) || 0;
		if (hr > 0) {
			group.avgHr += hr;
			group.hrCount++;
		}
	}

	const result: Record<string, string> = {};
	for (const [type, data] of Object.entries(grouped)) {
		const parts: string[] = [];

		if (data.count > 1) parts.push(`${data.count}x`);
		if (data.distanceKm > 0) parts.push(`${round1(data.distanceKm)} km`);
		if (data.durationMin > 0) parts.push(`${data.durationMin}min`);
		if (data.hrCount > 0) parts.push(`Ø${Math.round(data.avgHr / data.hrCount)} bpm`);
		if (data.calories > 0) parts.push(`${data.calories} kcal`);

		if (parts.length > 0) {
			result[type] = parts.join(" · ");
		}
	}

	return result;
}
