import { en, TranslationKeys } from "./en";
import { de } from "./de";
import { zh } from "./zh";
import { ja } from "./ja";
import { es } from "./es";
import { fr } from "./fr";

const translations: Record<string, Record<TranslationKeys, string>> = { en, de, zh, ja, es, fr };

export function t(key: TranslationKeys, lang: string = "en"): string {
	return translations[lang]?.[key] ?? translations["en"]?.[key] ?? key;
}
