export class LoginRequiredError extends Error {
	constructor(message = "login_required") {
		super(message);
		this.name = "LoginRequiredError";
	}
}

export function isLoginRequiredError(error: unknown): error is LoginRequiredError {
	return error instanceof LoginRequiredError
		|| (error instanceof Error && error.message === "login_required");
}
