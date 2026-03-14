/** Normalisierte Gesundheitsdaten — provider-unabhaengig */
export interface HealthData {
	/** Metriken als Key-Value (normalisierte Keys) */
	metrics: Record<string, number | string>;
	/** Aktivitaeten/Trainings als Key-Value */
	activities: Record<string, string>;
}

/** Interface das jeder Health-Provider implementiert */
export interface HealthProvider {
	/** Eindeutiger Name des Providers */
	readonly id: string;
	/** Anzeigename */
	readonly name: string;

	/** Prueft ob gueltige Credentials vorhanden sind */
	isConfigured(): boolean;

	/** Login durchfuehren, gibt true bei Erfolg zurueck */
	authenticate(): Promise<boolean>;

	/** Prueft ob die aktuelle Session noch gueltig ist */
	isSessionValid(): boolean;

	/** Gesundheitsdaten fuer ein bestimmtes Datum abrufen */
	fetchData(date: string, enabledMetrics: string[]): Promise<HealthData>;
}
