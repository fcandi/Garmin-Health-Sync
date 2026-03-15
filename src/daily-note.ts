import { App, TFile, normalizePath } from "obsidian";
import type { HealthData } from "./providers/provider";
import { applyPrefix } from "./metrics";

/**
 * Prueft ob eine Daily Note bereits Health-Daten im Frontmatter hat.
 * Gibt true zurueck wenn mindestens eine aktivierte Metrik vorhanden ist.
 */
export function hasHealthData(
	app: App,
	date: string,
	options: {
		dailyNotePath: string;
		dailyNoteFormat: string;
		prefix: string;
		enabledMetrics: string[];
	}
): boolean {
	const fileName = formatDate(date, options.dailyNoteFormat);
	const filePath = normalizePath(`${options.dailyNotePath}/${fileName}.md`);
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return false;

	const cache = app.metadataCache.getFileCache(file);
	if (!cache?.frontmatter) return false;

	for (const metric of options.enabledMetrics) {
		const key = applyPrefix(metric, options.prefix);
		if (cache.frontmatter[key] !== undefined) return true;
	}
	return false;
}

/**
 * Schreibt Gesundheitsdaten als Frontmatter-Properties in eine Daily Note.
 * Erstellt die Daily Note falls sie nicht existiert.
 */
export async function writeToDailyNote(
	app: App,
	date: string,
	data: HealthData,
	options: {
		dailyNotePath: string;
		dailyNoteFormat: string;
		prefix: string;
		template: string;
	}
): Promise<void> {
	const fileName = formatDate(date, options.dailyNoteFormat);
	const filePath = normalizePath(`${options.dailyNotePath}/${fileName}.md`);

	let file = app.vault.getAbstractFileByPath(filePath);

	if (!file) {
		// Daily Note erstellen
		const folder = options.dailyNotePath;
		const folderExists = app.vault.getAbstractFileByPath(normalizePath(folder));
		if (!folderExists) {
			await app.vault.createFolder(normalizePath(folder));
		}
		const initialContent = options.template || "";
		file = await app.vault.create(filePath, initialContent);
	}

	if (!(file instanceof TFile)) return;

	// Properties vorbereiten
	const properties: Record<string, number | string> = {};

	for (const [key, value] of Object.entries(data.metrics)) {
		properties[applyPrefix(key, options.prefix)] = value;
	}

	for (const [key, value] of Object.entries(data.activities)) {
		properties[applyPrefix(key, options.prefix)] = value;
	}

	// Frontmatter aktualisieren
	await updateFrontmatter(app, file, properties);
}

/**
 * Aktualisiert oder ergaenzt Frontmatter-Properties in einer Datei.
 * Bestehende Properties werden ueberschrieben, andere bleiben erhalten.
 */
async function updateFrontmatter(
	app: App,
	file: TFile,
	properties: Record<string, number | string>
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		for (const [key, value] of Object.entries(properties)) {
			frontmatter[key] = value;
		}
	});
}

/**
 * Einfache Datumsformatierung fuer Daily Note Dateinamen.
 * Unterstuetzt YYYY, MM, DD Platzhalter.
 */
function formatDate(dateStr: string, format: string): string {
	const [year, month, day] = dateStr.split("-");
	if (!year || !month || !day) return dateStr;

	return format
		.replace("YYYY", year)
		.replace("MM", month)
		.replace("DD", day);
}
