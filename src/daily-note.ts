import { App, Notice, TFile, TFolder, moment, normalizePath, parseYaml, stringifyYaml } from "obsidian";
import type { HealthData } from "./providers/provider";
import { applyPrefix } from "./metrics";
import { reverseGeocode } from "./geocoding";

/**
 * Searches for a daily note recursively in the given directory and all subdirectories.
 * Returns the TFile if found, null otherwise.
 */
function findDailyNoteRecursive(app: App, fileName: string, basePath: string): TFile | null {
	// 1. Check directly in root directory (fast path)
	const directPath = normalizePath(`${basePath}/${fileName}.md`);
	const directFile = app.vault.getAbstractFileByPath(directPath);
	if (directFile instanceof TFile) return directFile;

	// 2. Search recursively in subdirectories
	const baseFolder = app.vault.getAbstractFileByPath(normalizePath(basePath));
	if (!(baseFolder instanceof TFolder)) return null;

	return findInFolder(baseFolder, `${fileName}.md`);
}

function findInFolder(folder: TFolder, targetName: string): TFile | null {
	for (const child of folder.children) {
		if (child instanceof TFile && child.name === targetName) {
			return child;
		}
		if (child instanceof TFolder) {
			const found = findInFolder(child, targetName);
			if (found) return found;
		}
	}
	return null;
}

/** Creates a folder including all parent directories */
async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	if (app.vault.getAbstractFileByPath(normalized)) return;
	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			await app.vault.createFolder(current);
		}
	}
}

/**
 * Writes health data as frontmatter properties into a daily note.
 * Creates the daily note if it does not exist.
 * Returns true if the file was actually modified, false if all target values
 * already matched the existing frontmatter (dirty check — avoids redundant
 * writes that would trigger sync engines like LiveSync).
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
		writeTrainings: boolean;
		writeWorkoutLocation: boolean;
	}
): Promise<boolean> {
	const fileName = formatDate(date, options.dailyNoteFormat);

	// Search for existing daily note recursively
	let file: TFile | null = findDailyNoteRecursive(app, fileName, options.dailyNotePath);

	if (!file) {
		// Create new daily note (optionally with subdirectories from the format)
		const filePath = normalizePath(`${options.dailyNotePath}/${fileName}.md`);
		const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
		if (fileDir) {
			await ensureFolderExists(app, fileDir);
		}
		const initialContent = options.template || "";
		file = await app.vault.create(filePath, initialContent);
	}

	// Build properties map
	const properties: Record<string, number | string | Record<string, unknown>[]> = {};

	for (const [key, value] of Object.entries(data.metrics)) {
		properties[applyPrefix(key, options.prefix)] = value;
	}

	for (const [key, value] of Object.entries(data.activities)) {
		properties[applyPrefix(key, options.prefix)] = value;
	}

	// Machine-readable training data (optional)
	if (options.writeTrainings && data.trainings && data.trainings.length > 0) {
		properties[applyPrefix("trainings", options.prefix)] = data.trainings as unknown as Record<string, unknown>[];
	}

	// Workout Location via Reverse Geocoding (optional)
	if (options.writeWorkoutLocation && data.startLocation) {
		const locationName = await reverseGeocode(data.startLocation.lat, data.startLocation.lon);
		if (locationName) {
			properties[applyPrefix("workout_location", options.prefix)] = locationName;
		}
	}

	// Write to frontmatter (returns false if nothing would change)
	return updateFrontmatter(app, file, properties);
}

/**
 * Updates or adds frontmatter properties in a file.
 *
 * Reads the file directly, parses the frontmatter block strictly via parseYaml,
 * merges new values, re-serializes via stringifyYaml, writes via vault.modify.
 *
 * This replaces app.fileManager.processFrontMatter, which has shown two
 * data-corrupting failure modes against real notes:
 *   1. Files with `---` somewhere in the body (Markdown horizontal rules)
 *      were misinterpreted as having frontmatter spanning into the body.
 *   2. YAML maps that ended with a block sequence (e.g. `book_titles:\n- '[[..]]'`)
 *      received new keys *before* the sequence, breaking the file.
 *
 * Returns true if the file was modified, false if all incoming values already
 * matched what was already in the frontmatter (dirty-check).
 */
async function updateFrontmatter(
	app: App,
	file: TFile,
	properties: Record<string, number | string | Record<string, unknown>[]>
): Promise<boolean> {
	const content = await app.vault.read(file);
	const parsed = extractFrontmatter(content);

	if (parsed.kind === "invalid") {
		// Don't overwrite a damaged file — back it up and bail with a notice.
		await backupFile(app, file, content, parsed.reason);
		const msg = `Garmin Health Sync: Frontmatter in "${file.path}" ist kaputt (${parsed.reason}). Ein Backup wurde unter _garmin-health-sync/backups/ abgelegt. Bitte manuell reparieren.`;
		console.warn(msg);
		new Notice(msg, 15000);
		return false;
	}

	const existing = parsed.kind === "present" ? parsed.data : {};

	// Dirty-check: skip the write when every incoming key is already present
	// with the same value. Avoids flipping the file's mtime and firing LiveSync
	// when nothing changed.
	let changed = false;
	for (const [key, value] of Object.entries(properties)) {
		if (!isDeepEqual(existing[key], value)) {
			changed = true;
			break;
		}
	}
	if (!changed) {
		console.debug("Garmin Health Sync: frontmatter unchanged, skipping write for", file.path);
		return false;
	}

	const merged = { ...existing };
	for (const [key, value] of Object.entries(properties)) {
		merged[key] = value;
	}

	const newContent = renderWithFrontmatter(merged, parsed);
	await app.vault.modify(file, newContent);
	return true;
}

type FrontmatterParse =
	| { kind: "absent"; body: string; lineEnding: string }
	| {
			kind: "present";
			data: Record<string, unknown>;
			body: string;
			lineEnding: string;
			rawHeader: string;
	  }
	| { kind: "invalid"; reason: string };

/**
 * Extracts the frontmatter block strictly: the file must start with `---`
 * on its own line. The block ends at the next `---` line. Anything between
 * is parsed via parseYaml and must yield a plain object.
 */
function extractFrontmatter(content: string): FrontmatterParse {
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";

	// File doesn't open with `---\n` → no frontmatter.
	if (!/^---\r?\n/.test(content)) {
		return { kind: "absent", body: content, lineEnding };
	}

	const lines = content.split(/\r?\n/);
	// Find the closing `---` (start at line 1, line 0 is the opener).
	let closingIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			closingIdx = i;
			break;
		}
	}
	if (closingIdx === -1) {
		return { kind: "invalid", reason: "kein schließender --- Marker gefunden" };
	}

	const yamlText = lines.slice(1, closingIdx).join(lineEnding);
	let data: unknown;
	try {
		data = parseYaml(yamlText);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { kind: "invalid", reason: `YAML-Parse-Fehler: ${msg}` };
	}

	// Empty frontmatter (`---\n---`) → parseYaml returns null. Treat as empty object.
	if (data === null || data === undefined) {
		const body = lines.slice(closingIdx + 1).join(lineEnding);
		return {
			kind: "present",
			data: {},
			body,
			lineEnding,
			rawHeader: "",
		};
	}

	if (typeof data !== "object" || Array.isArray(data)) {
		return { kind: "invalid", reason: "Frontmatter ist kein YAML-Object (z.B. Liste oder Skalar)" };
	}

	const body = lines.slice(closingIdx + 1).join(lineEnding);
	return {
		kind: "present",
		data: data as Record<string, unknown>,
		body,
		lineEnding,
		rawHeader: yamlText,
	};
}

/** Re-assembles the file content with the merged frontmatter. */
function renderWithFrontmatter(
	merged: Record<string, unknown>,
	parsed: Exclude<FrontmatterParse, { kind: "invalid" }>
): string {
	const lineEnding = parsed.lineEnding;
	let yaml = stringifyYaml(merged);
	// stringifyYaml ends with a newline already; trim trailing newlines so we control the joining exactly.
	yaml = yaml.replace(/\r?\n+$/, "");
	const yamlBlock = `---${lineEnding}${yaml.replace(/\n/g, lineEnding)}${lineEnding}---`;

	if (parsed.kind === "absent") {
		// Insert frontmatter at the top. Empty file → just the FM.
		if (parsed.body.length === 0) return `${yamlBlock}${lineEnding}`;
		return `${yamlBlock}${lineEnding}${parsed.body}`;
	}

	// Present: yaml block + original body (body was sliced AFTER the closing ---,
	// so it already starts at the right line; rejoin with one line ending).
	return `${yamlBlock}${lineEnding}${parsed.body}`;
}

/**
 * Writes a timestamped backup of the file content into _garmin-health-sync/backups/.
 * Best-effort — failures are logged but not propagated.
 */
async function backupFile(app: App, file: TFile, content: string, reason: string): Promise<void> {
	try {
		const backupDir = "_garmin-health-sync/backups";
		await ensureFolderExists(app, backupDir);
		const ts = moment().format("YYYY-MM-DDTHH-mm-ss");
		const safeName = file.name.replace(/\.md$/, "");
		const backupPath = normalizePath(`${backupDir}/${safeName}.${ts}.md`);
		const header = `<!-- Garmin Health Sync Backup\nReason: ${reason}\nOriginal: ${file.path}\nTimestamp: ${ts}\n-->\n`;
		await app.vault.create(backupPath, header + content);
		console.warn("Garmin Health Sync: backup written to", backupPath);
	} catch (e) {
		console.error("Garmin Health Sync: backup failed for", file.path, e);
	}
}

function isDeepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!isDeepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (typeof a === "object" && typeof b === "object") {
		const aObj = a as Record<string, unknown>;
		const bObj = b as Record<string, unknown>;
		const aKeys = Object.keys(aObj);
		const bKeys = Object.keys(bObj);
		if (aKeys.length !== bKeys.length) return false;
		for (const key of aKeys) {
			if (!isDeepEqual(aObj[key], bObj[key])) return false;
		}
		return true;
	}
	return false;
}

/**
 * Formats a date string using moment.js — the same library Obsidian's
 * core Daily Notes plugin uses. Supports all moment tokens (YYYY, MM, DD,
 * ddd, MMM, Wo, etc.).
 */
function formatDate(dateStr: string, format: string): string {
	return moment(dateStr, "YYYY-MM-DD").format(format);
}
