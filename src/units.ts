import type { HealthData, TrainingEntry } from "./providers/provider";

const KM_TO_MI = 1.60934;
const KG_TO_LBS = 2.20462;

function round1(value: number): number {
	return Math.round(value * 10) / 10;
}

/** Converts HealthData from metric to imperial units (km→mi, kg→lbs) */
export function convertToImperial(data: HealthData): HealthData {
	const metrics = { ...data.metrics };

	// Distance: km → mi
	if ("distance_km" in metrics) {
		metrics["distance_mi"] = round1(Number(metrics["distance_km"]) / KM_TO_MI);
		delete metrics["distance_km"];
	}

	// Weight: kg → lbs
	if ("weight_kg" in metrics) {
		metrics["weight_lbs"] = round1(Number(metrics["weight_kg"]) * KG_TO_LBS);
		delete metrics["weight_kg"];
	}

	// Activities: replace "X km" with "X mi" in display strings
	const activities: Record<string, string> = {};
	for (const [key, value] of Object.entries(data.activities)) {
		activities[key] = value.replace(/(\d+\.?\d*) km/g, (_, num) => {
			return `${round1(Number(num) / KM_TO_MI)} mi`;
		});
	}

	// Trainings: distance_km → distance_mi
	const trainings = data.trainings?.map((entry): TrainingEntry => {
		if (entry.distance_km != null) {
			const { distance_km, ...rest } = entry;
			return { ...rest, distance_mi: round1(distance_km / KM_TO_MI) };
		}
		return entry;
	});

	return { ...data, metrics, activities, trainings };
}
