/**
 * Reverse Geocoding via Nominatim (OpenStreetMap).
 * Free to use, no API key required. Rate limit: 1 req/s per IP.
 */

import { requestUrl } from "obsidian";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "ObsidianHealthSync/1.0";

/**
 * Removes non-Latin characters from a string.
 * Nominatim returns multi-script results for some countries
 * (e.g. "Oualidia ⵍⵡⴰⵍⵉⴷⵢⵢⴰ الوليدية"), we only want the Latin part.
 */
function cleanMultiscript(text: string): string {
	// Keep words that consist only of Latin characters + common special characters
	const words = text.split(/\s+/);
	const latin = words.filter(w => !/[\u0250-\uFFFF]/.test(w));
	return latin.length > 0 ? latin.join(" ").trim() : text.trim();
}

/**
 * Converts coordinates into a human-readable location name.
 * Uses the Obsidian language for localized results.
 * Returns e.g. "Bad Honnef, Germany" or null on error.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
	try {
		const lang = document.documentElement.lang?.slice(0, 2) || "en";
		const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&zoom=14&accept-language=${lang}`;
		const response = await requestUrl({
			url,
			headers: { "User-Agent": USER_AGENT },
		});

		if (response.status !== 200) return null;

		const data = response.json as {
			address?: {
				city?: string;
				town?: string;
				village?: string;
				municipality?: string;
				residential?: string;
				county?: string;
				state?: string;
				country?: string;
			};
		};

		if (!data.address) return null;

		const a = data.address;
		const rawPlace = a.city || a.town || a.village || a.municipality || a.residential || a.county || a.state;
		const place = rawPlace ? cleanMultiscript(rawPlace) : null;
		const country = a.country;

		if (place && country) return `${place}, ${country}`;
		if (place) return place;
		if (country) return country;
		return null;
	} catch {
		return null;
	}
}
