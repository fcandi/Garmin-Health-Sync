/** Structured training data for machine-readable output */
export interface TrainingEntry {
	type: string;
	category: string;
	distance_km?: number;
	duration_min?: number;
	avg_hr?: number;
	calories?: number;
}

/** Normalized health data — provider-independent */
export interface HealthData {
	/** Metrics as key-value pairs (normalized keys) */
	metrics: Record<string, number | string>;
	/** Activities/trainings as key-value pairs (human-readable) */
	activities: Record<string, string>;
	/** Structured training data (machine-readable, optional) */
	trainings?: TrainingEntry[];
	/** Start coordinates of the first activity with GPS */
	startLocation?: { lat: number; lon: number };
}

/** Interface implemented by every health provider */
export interface HealthProvider {
	/** Unique provider identifier */
	readonly id: string;
	/** Display name */
	readonly name: string;

	/** Checks whether valid credentials are available */
	isConfigured(): boolean;

	/** Perform login, returns true on success */
	authenticate(): Promise<boolean>;

	/** Checks whether the current session is still valid */
	isSessionValid(): boolean;

	/** Fetch health data for a specific date */
	fetchData(date: string, enabledMetrics: string[]): Promise<HealthData>;

	/** Recommended delay between dates in batch operations (ms) — optional */
	getRecommendedBatchDelay?(enabledMetrics: string[]): number;
}
