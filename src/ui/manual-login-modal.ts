import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n/t";

/** Manual-ticket login fallback (issue #6): some Garmin SSO widget variants
 *  never surface the service ticket inside the embedded login window. This
 *  modal walks the user through completing the same sign-in in an external
 *  browser and pasting the resulting `ST-…` ticket (or the full
 *  `…/sso/embed?ticket=…` URL) back into the plugin. */
export class ManualLoginModal extends Modal {
	private lang: string;
	private signinUrl: string;
	private onSubmit: (input: string) => Promise<boolean>;

	constructor(
		app: App,
		lang: string,
		signinUrl: string,
		onSubmit: (input: string) => Promise<boolean>,
	) {
		super(app);
		this.lang = lang;
		this.signinUrl = signinUrl;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: t("modalManualLoginTitle", this.lang) });
		contentEl.createEl("p", { text: t("modalManualLoginIntro", this.lang) });

		const steps = contentEl.createEl("ol");
		steps.createEl("li", { text: t("modalManualLoginStep1", this.lang) });
		steps.createEl("li", { text: t("modalManualLoginStep2", this.lang) });
		steps.createEl("li", { text: t("modalManualLoginStep3", this.lang) });

		new Setting(contentEl)
			.setName(t("modalManualLoginOpenUrl", this.lang))
			.addButton(btn => btn
				.setButtonText(t("modalManualLoginOpenButton", this.lang))
				.onClick(() => {
					// In Obsidian desktop window.open with an http(s) URL is
					// forwarded to the system browser — exactly what we want here.
					window.open(this.signinUrl);
				}))
			.addExtraButton(btn => btn
				.setIcon("copy")
				.setTooltip(t("modalManualLoginCopyTooltip", this.lang))
				.onClick(async () => {
					await navigator.clipboard.writeText(this.signinUrl);
					new Notice(t("modalManualLoginCopied", this.lang));
				}));

		let input = "";
		new Setting(contentEl)
			.setName(t("modalManualLoginTicket", this.lang))
			.setDesc(t("modalManualLoginTicketDesc", this.lang))
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ST-…" is Garmin's literal service ticket format, not UI copy
				.setPlaceholder("ST-…")
				.onChange(value => { input = value; }));

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText(t("modalManualLoginSubmit", this.lang))
				.setCta()
				.onClick(async () => {
					if (!input.trim()) return;
					btn.setDisabled(true);
					try {
						const ok = await this.onSubmit(input.trim());
						if (ok) {
							this.close();
							return;
						}
					} finally {
						btn.setDisabled(false);
					}
				}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
