import { App, PluginSettingTab, Setting } from "obsidian";
import type HealthSyncPlugin from "./main";
import { METRICS, getDefaultEnabledMetrics } from "./metrics";
import { t } from "./i18n/t";
import type { TranslationKeys } from "./i18n/en";

export interface HealthSyncSettings {
	provider: string;
	usePrefix: boolean;
	dailyNotePath: string;
	dailyNoteFormat: string;
	dailyNoteTemplate: string;
	enabledMetrics: Record<string, boolean>;
	lastSyncDate: string;
	garminSession: string;
	language: string;
	autoSync: boolean;
	autoSyncPaused: boolean; // Bei Auth-Fehler automatisch pausiert
}

export const DEFAULT_SETTINGS: HealthSyncSettings = {
	provider: "garmin",
	usePrefix: false,
	dailyNotePath: "",
	dailyNoteFormat: "YYYY-MM-DD",
	dailyNoteTemplate: "",
	enabledMetrics: getDefaultEnabledMetrics(),
	lastSyncDate: "",
	garminSession: "",
	language: "en",
	autoSync: true,
	autoSyncPaused: false,
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

		// Sprache
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

		// Provider
		new Setting(containerEl)
			.setName(t("settingsProvider", lang))
			.setDesc(t("settingsProviderDesc", lang))
			.addDropdown(drop => drop
				.addOption("garmin", "Garmin Connect")
				.setValue(this.plugin.settings.provider)
				.onChange(async (value) => {
					this.plugin.settings.provider = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		// Garmin Login
		if (this.plugin.settings.provider === "garmin") {
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
				.setPlaceholder("Journal/Daily")
				.setValue(this.plugin.settings.dailyNotePath)
				.onChange(async (value) => {
					this.plugin.settings.dailyNotePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t("settingsDailyNoteFormat", lang))
			.setDesc(t("settingsDailyNoteFormatDesc", lang))
			.addText(text => text
				.setPlaceholder("YYYY-MM-DD")
				.setValue(this.plugin.settings.dailyNoteFormat)
				.onChange(async (value) => {
					this.plugin.settings.dailyNoteFormat = value;
					await this.plugin.saveSettings();
				}));

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

		// Standard Metriken
		containerEl.createEl("h3", { text: t("settingsMetricsStandard", lang) });
		for (const metric of METRICS.filter(m => m.category === "standard")) {
			const labelKey = `metric_${metric.key}` as TranslationKeys;
			new Setting(containerEl)
				.setName(t(labelKey, lang))
				.addToggle(toggle => toggle
					.setValue(this.plugin.settings.enabledMetrics[metric.key] ?? metric.defaultEnabled)
					.onChange(async (value) => {
						this.plugin.settings.enabledMetrics[metric.key] = value;
						await this.plugin.saveSettings();
					}));
		}

		// Erweiterte Metriken (eingeklappt)
		const extDetails = containerEl.createEl("details");
		extDetails.createEl("summary", { text: t("settingsMetricsExtendedDesc", lang) });

		for (const metric of METRICS.filter(m => m.category === "extended")) {
			const labelKey = `metric_${metric.key}` as TranslationKeys;
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
