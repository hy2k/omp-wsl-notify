/**
 * Windows toast notifications for omp running under WSL.
 *
 * Tern draws omp's OSC 99 notifications inside its own window, so nothing
 * surfaces while that window is unfocused, and omp has no Windows notification
 * path of its own: packages/tui/src/desktop-notify.ts is a freedesktop D-Bus
 * fallback, Linux-only and gated to NotifyProtocol.Bell. WSL interop reaches the
 * Windows notification platform instead, through the powershell.exe on PATH.
 *
 * Under nono the sandbox hides /mnt/c and /run/WSL, so powershell.exe is not
 * resolvable and /init is unreachable. The launcher (bin/nono) starts a bridge
 * outside the sandbox and exports OMP_NOTIFY_SOCKET; this module posts toast
 * payloads to that native Unix socket instead. The direct /init path remains as
 * a fallback for an unsandboxed WSL session.
 *
 * Ambient extension discovery runs once at omp startup, and `/reload-plugins`
 * does not rescan this tree (it refreshes skills, commands, agents and MCP), so
 * adding or editing this module takes effect only after an omp restart.
 */
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveAumid, TAG_TURN_COMPLETE, TAG_WAITING_INPUT, toastScript } from "./lib/toast";

/** Notifier binary; its absence is also the guard that this extension is inert without WSL interop. */
const POWERSHELL_BINARY = "powershell.exe";

/**
 * WSL's binfmt interpreter. Executing a Windows PE makes the kernel run this
 * binary with the PE path in argv[1]. In an unsandboxed session the PE lives on
 * the 9P /mnt/c mount, where Landlock exec rules are not reliably enforced, so
 * the fallback invokes /init itself with the same argv layout: /init then asks
 * Windows to open the PE, and Linux never executes it.
 */
const WSL_INIT_BINARY = "/init";

/** WSL-only marker; absent on a native Linux desktop. */
const WSL_INTEROP_MARKER = "/proc/sys/fs/binfmt_misc/WSLInterop";

/**
 * PID 1's interop server. /init normally discovers a server by walking its
 * parent chain, but nono's Landlock profile grants /proc/<pid>/stat only for
 * processes alive at sandbox start, so the omp PID may be unreadable. Naming
 * the stable init socket avoids that lookup; WSL's own fallback uses it last.
 */
const WSL_INIT_INTEROP_SOCKET = "/run/WSL/1_interop";

/** Set by bin/nono; names the native socket served by the out-of-sandbox bridge. */
const NOTIFY_SOCKET_ENV = "OMP_NOTIFY_SOCKET";

/**
 * Default bridge socket. The sandboxed nono profile must grant this directory
 * with `unix_socket_dir`.
 */
const DEFAULT_NOTIFY_SOCKET = join(homedir(), ".cache/omp/notify/notify.sock");

/** Mirrors omp's own PI_NOTIFICATIONS semantics (packages/tui/src/terminal-capabilities.ts). */
function notificationsSuppressed(): boolean {
	const value = process.env.PI_NOTIFICATIONS;
	return value === "off" || value === "0" || value === "false";
}

/**
 * Nerd Fonts glyphs: the Private Use Area planes the icon fonts draw in. Under
 * `nf+emoji` a session title is a card title — `<icon> <CODE>: <title>` — and
 * that icon is one of these glyphs; a toast renders through Segoe UI, which has
 * no coverage for them and no font to name (the toast XML text element carries
 * no font attribute), so they show as tofu boxes unless stripped. Emoji survive,
 * since Segoe UI Emoji covers them.
 */
const NERD_FONT_GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]\u{FE0F}?/gu;

/** Zero-width joiners stranded at the title's edges once their glyph is gone. */
const EDGE_JOINERS = /^\u{200D}+|\u{200D}+$/gu;

export default function notifyWindows(pi: ExtensionAPI): void {
	// WSL only: a Linux desktop has its own notification daemon, macOS has no powershell.exe.
	if (process.platform !== "linux") return;

	const socketPath = process.env[NOTIFY_SOCKET_ENV] || DEFAULT_NOTIFY_SOCKET;

	/** Unsandboxed fallback: resolve the PE and ask Windows to open it. */
	const direct = (title: string, body: string, tag: string): void => {
		const powershell = Bun.which(POWERSHELL_BINARY);
		if (!powershell) return;
		// Native PATH lookups only prove the PE exists; they do not prove the kernel
		// can exec it on the 9P mount. Prefer /init, which is on the native root.
		const useWslInit = existsSync(WSL_INTEROP_MARKER) && existsSync(WSL_INIT_BINARY);
		const interopSocket =
			process.env.WSL_INTEROP ?? (existsSync(WSL_INIT_INTEROP_SOCKET) ? WSL_INIT_INTEROP_SOCKET : undefined);
		const wslInitEnv = useWslInit && interopSocket ? { ...process.env, WSL_INTEROP: interopSocket } : undefined;

		const script = toastScript(title, body, resolveAumid(), tag);
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded];
		// binfmt's P flag puts the caller's argv[0] after the PE path; Bun sets it
		// to the resolved absolute path, so pass that path twice and let /init
		// reduce the second copy to the basename Windows expects.
		const cmd = useWslInit ? [WSL_INIT_BINARY, powershell, powershell, ...args] : [powershell, ...args];
		try {
			// Detached, like omp's own Linux notifier: a completed turn must never wait on a notifier,
			// and the toast must outlive nothing but itself.
			Bun.spawn({
				cmd,
				env: useWslInit ? wslInitEnv : undefined,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			}).unref();
		} catch {
			// Best effort: a blocked or missing notifier must never disturb the turn.
		}
	};

	const toast = (body: string, tag: string): void => {
		// Card titles carry a Nerd Fonts glyph under `nf+emoji`, which a toast cannot draw; stripping
		// can leave nothing (an icon-only name), so the `omp` fallback applies after the strip.
		const title =
			(pi.getSessionName() ?? "").replace(NERD_FONT_GLYPHS, "").replace(EDGE_JOINERS, "").replace(/\s+/g, " ").trim() ||
			"omp";
		if (existsSync(socketPath)) {
			try {
				const socket = connect(socketPath);
				socket.once("error", () => direct(title, body, tag));
				// One JSON line per toast; the bridge owns the PowerShell construction.
				socket.end(JSON.stringify({ v: 1, tag, title, body }) + "\n");
				return;
			} catch {
				// Fall through to the direct path.
			}
		}
		direct(title, body, tag);
	};

	// `tui` excludes print/rpc/json runs; `main` excludes task, eval `agent()` and /tan subagent sessions,
	// whose factories are rebound from the parent and would otherwise toast once per subagent turn.
	const canToast = (mode: string, agentKind: string): boolean =>
		!notificationsSuppressed() && mode === "tui" && agentKind === "main";

	pi.on("agent_end", (_event, ctx) => {
		if (canToast(ctx.mode, ctx.agent.kind)) toast("Turn complete", TAG_TURN_COMPLETE);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "ask" && canToast(ctx.mode, ctx.agent.kind)) toast("Waiting for input", TAG_WAITING_INPUT);
	});
}
