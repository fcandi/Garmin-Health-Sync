import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n/t";
import type { TranslationKeys } from "../i18n/en";
import type { CredentialLoginOutcome } from "../providers/garmin/garmin-api";
import { formatCountdown } from "../login-cooldown";

export interface CredentialLoginHandlers {
	login: (email: string, password: string) => Promise<CredentialLoginOutcome>;
	verifyMfa: (code: string) => Promise<CredentialLoginOutcome>;
	/** Called after a successful login, before the modal closes. */
	onSuccess: () => Promise<void>;
	/** Opens the guided browser (paste-ticket) login instead. */
	onBrowserFallback: () => void;
	getDiagnostics: () => string;
	/** Called once when the modal closes (lets the caller avoid stacking modals). */
	onClosed?: () => void;
	/** Pause between attempts after Garmin pushed back (429/403/CAPTCHA). */
	cooldown: {
		remainingSeconds: () => number;
		registerBlock: (retryAfterSeconds?: number) => number;
		reset: () => void;
	};
}

const ERROR_KEYS: Record<string, TranslationKeys> = {
	invalid_credentials: "modalCredErrorInvalid",
	blocked: "modalCredErrorBlocked",
	rate_limited: "modalCredErrorRateLimited",
	captcha: "modalCredErrorBlocked",
	mfa_failed: "modalCredErrorMfa",
};

/** Browser-free Garmin sign-in (email + password, optional MFA code). The password lives
 *  in a local variable for the duration of one call and is never stored or logged. */
export class CredentialLoginModal extends Modal {
	private lang: string;
	private handlers: CredentialLoginHandlers;
	private busy = false;
	private closed = false;
	private lastEmail = "";
	private timer: number | null = null;

	constructor(app: App, lang: string, handlers: CredentialLoginHandlers) {
		super(app);
		this.lang = lang;
		this.handlers = handlers;
	}

	onOpen(): void {
		this.contentEl.addClass("ghs-modal");
		this.renderCredentials();
	}

	onClose(): void {
		this.closed = true;
		this.stopCountdown();
		this.contentEl.empty();
		this.handlers.onClosed?.();
	}

	private stopCountdown(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Disables `button` and shows a live "try again in m:ss" in `setting` until the cooldown
	 *  ends. No-op when no cooldown is active. */
	private startCountdown(setting: Setting, button: ButtonComponent): void {
		this.stopCountdown();
		if (this.closed) return;
		const tick = (): void => {
			const left = this.handlers.cooldown.remainingSeconds();
			if (left <= 0) {
				this.stopCountdown();
				button.setDisabled(false);
				setting.setDesc("");
				return;
			}
			button.setDisabled(true);
			setting.setDesc(t("modalCredCooldown", this.lang).replace("{time}", formatCountdown(left)));
		};
		tick();
		if (this.handlers.cooldown.remainingSeconds() > 0) {
			this.timer = window.setInterval(tick, 1000);
		}
	}

	private renderCredentials(error?: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("modalCredTitle", this.lang) });
		contentEl.createEl("p", { text: t("modalCredIntro", this.lang) });
		if (error) contentEl.createEl("p", { text: error, cls: "mod-warning" });

		let email = this.lastEmail;
		let password = "";
		const submit = (): void => {
			if (!email.trim() || !password || this.busy || this.handlers.cooldown.remainingSeconds() > 0) return;
			void this.run(() => this.handlers.login(email, password)).finally(() => { password = ""; });
		};
		new Setting(contentEl)
			.setName(t("modalCredEmail", this.lang))
			.addText((text) => {
				text.inputEl.type = "email";
				text.inputEl.autocomplete = "username";
				text.inputEl.setAttr("autocapitalize", "off");
				text.inputEl.spellcheck = false;
				text.setValue(email);
				text.onChange((v) => { email = v; this.lastEmail = v; });
			});
		new Setting(contentEl)
			.setName(t("modalCredPassword", this.lang))
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "current-password";
				text.inputEl.enterKeyHint = "go";
				text.onChange((v) => { password = v; });
				text.inputEl.addEventListener("keydown", (ev: KeyboardEvent) => {
					if (ev.key === "Enter") { ev.preventDefault(); submit(); }
				});
			});

		const submitRow = new Setting(contentEl).setClass("ghs-action-row");
		submitRow.addButton((btn) => {
			btn.setButtonText(t("modalCredSubmit", this.lang)).setCta().onClick(submit);
			this.startCountdown(submitRow, btn);
		});
		new Setting(contentEl).setClass("ghs-action-row").addButton((btn) => btn
			.setButtonText(t("modalCredBrowserFallback", this.lang))
			.onClick(() => {
				this.close();
				this.handlers.onBrowserFallback();
			}));
	}

	private renderMfa(error?: string): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("modalCredMfaTitle", this.lang) });
		contentEl.createEl("p", { text: t("modalCredMfaIntro", this.lang) });
		if (error) contentEl.createEl("p", { text: error, cls: "mod-warning" });

		let code = "";
		new Setting(contentEl)
			.setName(t("modalCredMfaCode", this.lang))
			.addText((text) => {
				text.inputEl.inputMode = "numeric";
				text.inputEl.autocomplete = "one-time-code";
				text.onChange((v) => { code = v; });
			});
		new Setting(contentEl)
			.setClass("ghs-action-row")
			.addButton((btn) => btn
				.setButtonText(t("modalCredSubmit", this.lang))
				.setCta()
				.onClick(() => {
					if (!code.trim() || this.busy) return;
					void this.run(() => this.handlers.verifyMfa(code));
				}));
	}

	private renderFailure(message: string): void {
		const { contentEl } = this;
		this.stopCountdown();
		contentEl.empty();
		contentEl.createEl("h2", { text: t("modalCredTitle", this.lang) });
		contentEl.createEl("p", { text: message, cls: "mod-warning" });
		new Setting(contentEl).setClass("ghs-action-row").addButton((btn) => btn
			.setButtonText(t("modalCredBrowserFallback", this.lang))
			.setCta()
			.onClick(() => {
				this.close();
				this.handlers.onBrowserFallback();
			}));
		const retryRow = new Setting(contentEl).setClass("ghs-action-row");
		retryRow.addButton((btn) => {
			btn.setButtonText(t("modalCredRetry", this.lang)).onClick(() => this.renderCredentials());
			this.startCountdown(retryRow, btn);
		});
		new Setting(contentEl).setClass("ghs-action-row").addButton((btn) => btn
			.setButtonText(t("modalCredCopyDiagnostics", this.lang))
			.onClick(async () => {
				try {
					await navigator.clipboard.writeText(this.handlers.getDiagnostics());
					new Notice(t("modalCredDiagnosticsCopied", this.lang));
				} catch {
					// Clipboard write blocked: show the text so it can be selected and copied by hand.
					const area = this.contentEl.createEl("textarea", { text: this.handlers.getDiagnostics() });
					area.readOnly = true;
					area.rows = 6;
					area.addClass("ghs-diagnostics");
				}
			}));
	}

	private async run(action: () => Promise<CredentialLoginOutcome>): Promise<void> {
		this.busy = true;
		try {
			const outcome = await action();
			if (outcome.status === "error" && ["blocked", "rate_limited", "captcha"].includes(outcome.reason)) {
				this.handlers.cooldown.registerBlock(outcome.retryAfter);
			}
			if (outcome.status === "ok") {
				this.handlers.cooldown.reset();
				// A failure while saving/starting the first sync must not look like a failed sign-in.
				try {
					await this.handlers.onSuccess();
				} catch (e: unknown) {
					console.error("Garmin Health Sync: post-login step failed", e);
				}
				this.close();
			} else if (this.closed) {
				// Modal was dismissed while the request was in flight: nothing to render.
				return;
			} else if (outcome.status === "mfa") {
				this.renderMfa();
			} else if (outcome.reason === "invalid_credentials") {
				this.renderCredentials(t("modalCredErrorInvalid", this.lang));
			} else if (outcome.reason === "mfa_failed") {
				this.renderMfa(t("modalCredErrorMfa", this.lang));
			} else {
				const key = ERROR_KEYS[outcome.reason] ?? "modalCredErrorGeneric";
				this.renderFailure(t(key, this.lang));
			}
		} catch (e: unknown) {
			console.error("Garmin Health Sync: credential login crashed", e);
			this.renderFailure(t("modalCredErrorGeneric", this.lang));
		} finally {
			this.busy = false;
		}
	}
}
