/**
 * Toast payload construction shared by the in-process WSL notifier and the
 * out-of-sandbox bridge that serves it under nono.
 *
 * Title and body travel base64-encoded, so no argv, quoting or locale layer ever
 * parses user text. The tag is allowlisted by both callers because it is
 * interpolated into a single-quoted PowerShell literal.
 */

/**
 * Windows PowerShell's own registered AppUserModelID. WinRT drops a toast whose
 * AppUserModelID has no Start-menu registration, so a script must borrow one
 * that exists instead of inventing one.
 */
export const DEFAULT_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/** Escape hatch for machines where the PowerShell AppUserModelID is unavailable. */
export const AUMID_ENV = "OMP_WSL_TOAST_AUMID";

/**
 * Replacement handles. Two toasts sharing a Tag and a Group are one
 * notification, so the newer replaces the older in the Notification Center
 * instead of stacking; a toast with an empty tag and group never collides, which
 * is why both are set. Tags share the borrowed PowerShell AUMID's namespace and
 * are capped at 16 characters on hosts older than Windows 10 1703, hence the
 * short `omp-` names.
 */
export const TAG_TURN_COMPLETE = "omp-turn";
export const TAG_WAITING_INPUT = "omp-input";
export const TOAST_GROUP = "omp";

/** Tags the bridge accepts; anything else is rejected. */
export const ALLOWED_TAGS: Record<string, true> = {
	[TAG_TURN_COMPLETE]: true,
	[TAG_WAITING_INPUT]: true,
};

/** An AppUserModelID is interpolated into a PowerShell single-quoted literal, so a quote would break out. */
export function resolveAumid(): string {
	const override = process.env[AUMID_ENV];
	return override && !override.includes("'") ? override : DEFAULT_AUMID;
}

export function toastScript(title: string, body: string, aumid: string, tag: string): string {
	const title64 = Buffer.from(title, "utf8").toString("base64");
	const body64 = Buffer.from(body, "utf8").toString("base64");
	return [
		"$ErrorActionPreference = 'Stop'",
		`$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${title64}'))`,
		`$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body64}'))`,
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
		"$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
		"$nodes = $xml.GetElementsByTagName('text')",
		"$nodes.Item(0).AppendChild($xml.CreateTextNode($title)) > $null",
		"$nodes.Item(1).AppendChild($xml.CreateTextNode($body)) > $null",
		"$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
		`$toast.Tag = '${tag}'`,
		`$toast.Group = '${TOAST_GROUP}'`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid}').Show($toast)`,
	].join("\n");
}
