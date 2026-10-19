#!/usr/bin/env bun
/**
 * Out-of-sandbox toast bridge for sandboxed omp sessions.
 *
 * bin/nono starts this process before entering the mount namespace that hides
 * /mnt/c and /run/WSL. The sandboxed extension can therefore reach a native
 * Unix socket while it has no Windows interop path of its own.
 *
 * Trust boundary: the socket directory is 0700 and the socket is 0600, so only
 * the same Unix user can connect. A message may carry a tag, title and body and
 * nothing else; the bridge constructs the PowerShell command itself with a
 * fixed interpreter, fixed argv layout and base64-encoded text. It never
 * accepts a path, executable, command line, or file to read. The bridge does not
 * return data to the caller, so it cannot be used to read Windows state.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { ALLOWED_TAGS, resolveAumid, toastScript } from "../lib/toast";

const MAX_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 5_000;

/**
 * Fixed Windows PowerShell path. The bridge runs outside the sandbox, so it must
 * not resolve this name through PATH: a sandbox-writable PATH directory is
 * exactly the escalation the sandbox is meant to prevent. The extension uses
 * Bun.which inside the sandbox only as a fallback for the direct /init path.
 */
const POWERSHELL_BINARY = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

interface ToastMessage {
	readonly tag: string;
	readonly title: string;
	readonly body: string;
}

interface BridgePayload {
	readonly v?: unknown;
	readonly tag?: unknown;
	readonly title?: unknown;
	readonly body?: unknown;
}

let server: Server | undefined;
let idleTimer: NodeJS.Timeout | undefined;
const clients = new Set<Socket>();

function parseSocketPath(): string {
	const flag = process.argv.indexOf("--socket");
	const value = flag === -1 ? undefined : process.argv[flag + 1];
	if (!value) {
		console.error("notify-bridge: --socket <path> is required");
		process.exit(2);
	}
	return value;
}

function resetIdle(): void {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(shutdown, IDLE_TIMEOUT_MS);
}

function shutdown(): void {
	clearTimeout(idleTimer);
	for (const client of clients) client.destroy();
	clients.clear();
	if (!server) {
		process.exit(0);
		return;
	}
	server.close(() => process.exit(0));
	// Do not let a stuck connection hold the daemon open forever.
	setTimeout(() => process.exit(0), 500).unref();
}

function payloadMessage(payload: BridgePayload): ToastMessage | undefined {
	if (payload.v !== 1) return undefined;
	if (typeof payload.tag !== "string" || ALLOWED_TAGS[payload.tag] !== true) return undefined;
	if (typeof payload.title !== "string" || typeof payload.body !== "string") return undefined;
	if (payload.title.length > 4_096 || payload.body.length > 16_384) return undefined;
	return { tag: payload.tag, title: payload.title, body: payload.body };
}

function showToast(message: ToastMessage): void {
	if (!existsSync(POWERSHELL_BINARY)) return;

	const useWslInit = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") && existsSync("/init");
	const interop =
		process.env.WSL_INTEROP ?? (existsSync("/run/WSL/1_interop") ? "/run/WSL/1_interop" : undefined);
	const script = toastScript(message.title, message.body, resolveAumid(), message.tag);
	const encoded = Buffer.from(script, "utf16le").toString("base64");
	const args = ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded];
	const cmd = useWslInit
		? ["/init", POWERSHELL_BINARY, POWERSHELL_BINARY, ...args]
		: [POWERSHELL_BINARY, ...args];
	const env = useWslInit && interop ? { ...process.env, WSL_INTEROP: interop } : undefined;

	try {
		Bun.spawn({
			cmd,
			env,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}).unref();
	} catch (error) {
		console.error("notify-bridge: spawn failed:", error instanceof Error ? error.message : error);
	}
}

function onConnection(socket: Socket): void {
	resetIdle();
	clients.add(socket);
	socket.setTimeout(CONNECTION_TIMEOUT_MS, () => socket.destroy());
	socket.on("close", () => clients.delete(socket));
	socket.on("error", () => socket.destroy());

	let size = 0;
	const chunks: Buffer[] = [];
	socket.on("data", (chunk: Buffer) => {
		size += chunk.length;
		if (size > MAX_BYTES) {
			socket.destroy();
			return;
		}
		const newline = chunk.indexOf(0x0a);
		if (newline === -1) {
			chunks.push(chunk);
			return;
		}
		chunks.push(chunk.subarray(0, newline));
		const text = Buffer.concat(chunks).toString("utf8");
		chunks.length = 0;
		try {
			const message = payloadMessage(JSON.parse(text) as BridgePayload);
			if (message) showToast(message);
		} catch {
			// Malformed payloads are discarded; they must not affect the daemon.
		}
		socket.end();
	});
}

function listen(socketPath: string): void {
	const candidate = createServer(onConnection);
	candidate.on("error", (error: { code?: string; message?: string }) => {
		if (error.code === "EADDRINUSE") {
			// Another bridge may own the socket. Probe first: a live owner wins,
			// a stale socket is replaced.
			const probe = connect(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				process.exit(0);
			});
			probe.once("error", () => {
				try {
					unlinkSync(socketPath);
				} catch {
					// Already gone.
				}
				listen(socketPath);
			});
			return;
		}
		console.error("notify-bridge:", error.message ?? "listen failed");
		process.exit(1);
	});
	candidate.listen(socketPath, () => {
		server = candidate;
		try {
			chmodSync(socketPath, 0o600);
		} catch {
			// The directory permission is the primary boundary.
		}
		resetIdle();
	});
}

function main(): void {
	const socketPath = parseSocketPath();
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		chmodSync(dirname(socketPath), 0o700);
	} catch {
		// Best effort; the caller may own the directory already.
	}
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	listen(socketPath);
}

if (import.meta.main) main();
