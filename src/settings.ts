import {
	App,
	PluginSettingTab,
	Setting,
	SettingDefinition,
	SettingDefinitionItem,
} from "obsidian";
import type HealthSyncPlugin from "./main";
import { METRICS, getDefaultEnabledMetrics } from "./metrics";
import { t } from "./i18n/t";
import type { TranslationKeys } from "./i18n/en";

/** Maps internal metric keys to their imperial i18n label when unit system is imperial */
const IMPERIAL_LABEL_MAP: Partial<Record<string, TranslationKeys>> = {
	distance_km: "metric_distance_mi",
	weight_kg: "metric_weight_lbs",
};

/**
 * Control-key prefix for per-metric toggles. Metric enablement lives in the
 * nested `enabledMetrics` record, so the flat declarative keys are namespaced
 * and mapped back in `getControlValue`/`setControlValue`.
 */
const METRIC_KEY_PREFIX = "metric:";

export type ServerRegion = "international" | "china";
export type UnitSystem = "metric" | "imperial";

export interface HealthSyncSettings {
	usePrefix: boolean;
	dailyNotePath: string;
	dailyNoteFormat: string;
	dailyNoteTemplate: string;
	enabledMetrics: Record<string, boolean>;
	lastSyncTimes: Record<string, number>; // Date → last sync timestamp (epoch ms)
	garminSession: string;
	garminOAuth1: string; // JSON-serialized OAuth1Token (long-lived, ~1 year)
	garminOAuth2: string; // JSON-serialized OAuth2Token (short-lived)
	language: string;
	autoSync: boolean;
	writeTrainings: boolean; // Machine-readable training data in frontmatter
	writeWorkoutLocation: boolean; // Reverse-geocoded workout location in frontmatter
	serverRegion: ServerRegion;
	unitSystem: UnitSystem;
}

export const DEFAULT_SETTINGS: HealthSyncSettings = {
	usePrefix: false,
	dailyNotePath: "",
	dailyNoteFormat: "YYYY-MM-DD",
	dailyNoteTemplate: "",
	enabledMetrics: getDefaultEnabledMetrics(),
	lastSyncTimes: {},
	garminSession: "",
	garminOAuth1: "",
	garminOAuth2: "",
	language: "en",
	autoSync: true,
	writeTrainings: false,
	writeWorkoutLocation: true,
	serverRegion: "international",
	unitSystem: "metric",
};

export class HealthSyncSettingTab extends PluginSettingTab {
	plugin: HealthSyncPlugin;

	constructor(app: App, plugin: HealthSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const lang = this.plugin.settings.language;

		// On needsUserLogin the OAuth tokens are discarded → appears as "not
		// connected"; transient errors leave the tokens in place and are
		// automatically retried with backoff (no separate UI state needed).
		const hasSavedSession = this.plugin.isSessionValid();
		const garminStatus = hasSavedSession
			? t("settingsGarminLoggedIn", lang)
			: t("settingsGarminLoggedOut", lang);

		return [
			{
				name: t("settingsLanguage", lang),
				desc: t("settingsLanguageDesc", lang),
				control: {
					type: "dropdown",
					key: "language",
					options: {
						en: "English",
						de: "Deutsch",
						zh: "中文",
						ja: "日本語",
						es: "Español",
						fr: "Français",
					},
				},
			},
			{
				name: t("settingsServerRegion", lang),
				desc: t("settingsServerRegionDesc", lang),
				control: {
					type: "dropdown",
					key: "serverRegion",
					options: {
						international: t("regionInternational", lang),
						china: t("regionChina", lang),
					},
				},
			},
			{
				name: t("settingsUnitSystem", lang),
				desc: t("settingsUnitSystemDesc", lang),
				control: {
					type: "dropdown",
					key: "unitSystem",
					options: {
						metric: t("unitMetric", lang),
						imperial: t("unitImperial", lang),
					},
				},
			},
			{
				name: t("settingsGarminLogin", lang),
				desc: `${garminStatus}. ${t("settingsGarminSessionPrivacyDesc", lang)}`,
				render: (setting) => this.renderGarminLogin(setting, hasSavedSession),
			},
			{
				name: t("settingsAutoSync", lang),
				desc: t("settingsAutoSyncDesc", lang),
				control: { type: "toggle", key: "autoSync" },
			},
			{
				name: t("settingsDailyNotePath", lang),
				desc: t("settingsDailyNotePathDesc", lang),
				control: { type: "text", key: "dailyNotePath" },
			},
			{
				name: t("settingsDailyNoteFormat", lang),
				desc: t("settingsDailyNoteFormatDesc", lang),
				control: { type: "text", key: "dailyNoteFormat" },
			},
			{
				name: t("settingsDailyNoteTemplate", lang),
				desc: t("settingsDailyNoteTemplateDesc", lang),
				control: { type: "textarea", key: "dailyNoteTemplate", rows: 4 },
			},
			{
				name: t("settingsPrefix", lang),
				desc: t("settingsPrefixDesc", lang),
				control: { type: "toggle", key: "usePrefix" },
			},
			{
				name: t("settingsWriteWorkoutLocation", lang),
				desc: t("settingsWriteWorkoutLocationDesc", lang),
				control: { type: "toggle", key: "writeWorkoutLocation" },
			},
			{
				name: t("settingsWriteTrainings", lang),
				desc: t("settingsWriteTrainingsDesc", lang),
				control: { type: "toggle", key: "writeTrainings" },
			},
			{
				type: "group",
				heading: t("settingsMetricsStandard", lang),
				items: this.metricToggleDefinitions("standard", lang),
			},
			{
				type: "page",
				name: t("settingsMetricsExtendedDesc", lang),
				items: [
					{
						type: "group",
						items: this.metricToggleDefinitions("extended", lang),
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		if (key.startsWith(METRIC_KEY_PREFIX)) {
			const metricKey = key.slice(METRIC_KEY_PREFIX.length);
			const metric = METRICS.find((m) => m.key === metricKey);
			return this.plugin.settings.enabledMetrics[metricKey] ?? metric?.defaultEnabled ?? false;
		}
		return this.plugin.settings[key as keyof HealthSyncSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith(METRIC_KEY_PREFIX)) {
			const metricKey = key.slice(METRIC_KEY_PREFIX.length);
			this.plugin.settings.enabledMetrics[metricKey] = Boolean(value);
			await this.plugin.saveSettings();
			return;
		}

		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		settings[key] = value;
		await this.plugin.saveSettings();

		if (key === "serverRegion") {
			this.plugin.applyServerRegion();
		} else if (key === "language" || key === "unitSystem") {
			// Rebuild the definitions so labels reflect the new locale / units.
			this.update();
		}
	}

	private metricToggleDefinitions(
		category: "standard" | "extended",
		lang: string
	): SettingDefinition[] {
		const isImperial = this.plugin.settings.unitSystem === "imperial";
		return METRICS.filter((m) => m.category === category).map((metric) => {
			const labelKey =
				(isImperial && IMPERIAL_LABEL_MAP[metric.key]) ||
				(`metric_${metric.key}` as TranslationKeys);
			return {
				name: t(labelKey, lang),
				control: { type: "toggle", key: `${METRIC_KEY_PREFIX}${metric.key}` },
			};
		});
	}

	/**
	 * Login/logout row. Returns a cleanup callback — the row is re-rendered on
	 * every update() (e.g. after login state or language changes), and without
	 * it each pass would append another set of buttons.
	 */
	private renderGarminLogin(setting: Setting, hasSavedSession: boolean): () => void {
		const lang = this.plugin.settings.language;
		const buttonEls: HTMLButtonElement[] = [];

		if (hasSavedSession) {
			setting.addButton((btn) => {
				buttonEls.push(btn.buttonEl);
				btn.setButtonText(t("settingsGarminLogout", lang)).onClick(async () => {
					await this.plugin.logout();
					this.update();
				});
			});
		} else {
			setting.addButton((btn) => {
				buttonEls.push(btn.buttonEl);
				btn.setButtonText(t("settingsGarminLogin", lang))
					.setCta()
					.onClick(async () => {
						await this.plugin.loginViaBrowser();
						this.update();
					});
			});
			// Manual-ticket fallback (issue #6) for accounts where the embedded
			// login window never completes the sign-in.
			setting.addButton((btn) => {
				buttonEls.push(btn.buttonEl);
				btn.setButtonText(t("settingsGarminManualLogin", lang))
					.setTooltip(t("settingsGarminManualLoginTooltip", lang))
					.onClick(() => {
						this.plugin.openManualLogin(() => this.update());
					});
			});
		}

		return () => buttonEls.forEach((el) => el.remove());
	}
}
