import { App, PluginSettingTab, Setting } from "obsidian";
import type HealthSyncPlugin from "./main";
import { METRICS, getDefaultEnabledMetrics } from "./metrics";
import { t } from "./i18n/t";
import type { TranslationKeys } from "./i18n/en";

/** Maps internal metric keys to their imperial i18n label when unit system is imperial */
const IMPERIAL_LABEL_MAP: Partial<Record<string, TranslationKeys>> = {
	distance_km: "metric_distance_mi",
	weight_kg: "metric_weight_lbs",
};

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
	language: string;
	autoSync: boolean;
	autoSyncPaused: boolean; // Automatically paused on auth error
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
	language: "en",
	autoSync: true,
	autoSyncPaused: false,
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

	display(): void {
		const { containerEl } = this;
		const lang = this.plugin.settings.language;
		containerEl.empty();

		// Language
		new Setting(containerEl)
			.setName(t("settingsLanguage", lang))
			.setDesc(t("settingsLanguageDesc", lang))
			.addDropdown(drop => drop
				.addOption("en", "English")
				.addOption("de", "Deutsch")
				.addOption("zh", "中文")
				.addOption("ja", "日本語")
				.addOption("es", "Español")
				.addOption("fr", "Français")
				.setValue(this.plugin.settings.language)
				.onChange(async (value) => {
					this.plugin.settings.language = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		// Server Region
		new Setting(containerEl)
			.setName(t("settingsServerRegion", lang))
			.setDesc(t("settingsServerRegionDesc", lang))
			.addDropdown(drop => drop
				.addOption("international", t("regionInternational", lang))
				.addOption("china", t("regionChina", lang))
				.setValue(this.plugin.settings.serverRegion)
				.onChange(async (value) => {
					this.plugin.settings.serverRegion = value as ServerRegion;
					await this.plugin.saveSettings();
					this.plugin.applyServerRegion();
					this.display();
				}));

		// Unit System
		new Setting(containerEl)
			.setName(t("settingsUnitSystem", lang))
			.setDesc(t("settingsUnitSystemDesc", lang))
			.addDropdown(drop => drop
				.addOption("metric", t("unitMetric", lang))
				.addOption("imperial", t("unitImperial", lang))
				.setValue(this.plugin.settings.unitSystem)
				.onChange(async (value) => {
					this.plugin.settings.unitSystem = value as UnitSystem;
					await this.plugin.saveSettings();
					this.display();
				}));

		// Garmin Login
		const isLoggedIn = this.plugin.isSessionValid();
		const loginSetting = new Setting(containerEl)
			.setName(t("settingsGarminLogin", lang))
			.setDesc(isLoggedIn ? t("settingsGarminLoggedIn", lang) : t("settingsGarminLoggedOut", lang));

		if (isLoggedIn) {
			loginSetting.addButton(btn => btn
				.setButtonText(t("settingsGarminLogout", lang))
				.onClick(async () => {
					await this.plugin.logout();
					this.display();
				}));
		} else {
			loginSetting.addButton(btn => btn
				.setButtonText(t("settingsGarminLogin", lang))
				.setCta()
				.onClick(async () => {
					await this.plugin.loginViaBrowser();
					this.display();
				}));
		}

		// Auto-Sync
		const autoSyncDesc = this.plugin.settings.autoSyncPaused
			? t("settingsAutoSyncPaused", lang)
			: t("settingsAutoSyncDesc", lang);
		new Setting(containerEl)
			.setName(t("settingsAutoSync", lang))
			.setDesc(autoSyncDesc)
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					if (value) {
						this.plugin.settings.autoSyncPaused = false;
					}
					await this.plugin.saveSettings();
					this.display();
				}));

		// Daily Notes
		new Setting(containerEl)
			.setName(t("settingsDailyNotePath", lang))
			.setDesc(t("settingsDailyNotePathDesc", lang))
			.addText(text => text
				.setValue(this.plugin.settings.dailyNotePath)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settingsDailyNoteFormat", lang))
			.setDesc(t("settingsDailyNoteFormatDesc", lang))
			.addText(text => text
				.setValue(this.plugin.settings.dailyNoteFormat)
				.onChange(async (value) => {
					this.plugin.settings.dailyNoteFormat = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settingsDailyNoteTemplate", lang))
			.setDesc(t("settingsDailyNoteTemplateDesc", lang))
			.addTextArea(text => {
				text.setPlaceholder("")
					.setValue(this.plugin.settings.dailyNoteTemplate)
					.onChange(async (value) => {
						this.plugin.settings.dailyNoteTemplate = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 4;
			});

		// Prefix
		new Setting(containerEl)
			.setName(t("settingsPrefix", lang))
			.setDesc(t("settingsPrefixDesc", lang))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.usePrefix)
				.onChange(async (value) => {
					this.plugin.settings.usePrefix = value;
					await this.plugin.saveSettings();
				}));

		// Workout Location
		new Setting(containerEl)
			.setName(t("settingsWriteWorkoutLocation", lang))
			.setDesc(t("settingsWriteWorkoutLocationDesc", lang))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.writeWorkoutLocation)
				.onChange(async (value) => {
					this.plugin.settings.writeWorkoutLocation = value;
					await this.plugin.saveSettings();
				}));

		// Machine-readable trainings
		new Setting(containerEl)
			.setName(t("settingsWriteTrainings", lang))
			.setDesc(t("settingsWriteTrainingsDesc", lang))
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.writeTrainings)
				.onChange(async (value) => {
					this.plugin.settings.writeTrainings = value;
					await this.plugin.saveSettings();
				}));

		// Standard metrics
		const isImperial = this.plugin.settings.unitSystem === "imperial";
		new Setting(containerEl).setName(t("settingsMetricsStandard", lang)).setHeading();
		for (const metric of METRICS.filter(m => m.category === "standard")) {
			const labelKey = (isImperial && IMPERIAL_LABEL_MAP[metric.key]) || `metric_${metric.key}` as TranslationKeys;
			new Setting(containerEl)
				.setName(t(labelKey, lang))
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enabledMetrics[metric.key] ?? metric.defaultEnabled)
					.onChange(async (value) => {
						this.plugin.settings.enabledMetrics[metric.key] = value;
						await this.plugin.saveSettings();
					}));
		}

		// Extended metrics (collapsed)
		const extDetails = containerEl.createEl("details");
		extDetails.createEl("summary", { text: t("settingsMetricsExtendedDesc", lang) });

		for (const metric of METRICS.filter(m => m.category === "extended")) {
			const labelKey = (isImperial && IMPERIAL_LABEL_MAP[metric.key]) || `metric_${metric.key}` as TranslationKeys;
			new Setting(extDetails)
				.setName(t(labelKey, lang))
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enabledMetrics[metric.key] ?? metric.defaultEnabled)
					.onChange(async (value) => {
						this.plugin.settings.enabledMetrics[metric.key] = value;
						await this.plugin.saveSettings();
					}));
		}

	}
}
