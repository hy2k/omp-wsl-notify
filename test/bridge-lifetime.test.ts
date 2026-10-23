import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-process lifetime test: the bridge's watchdog runs in a child process,
 * so fake timers cannot drive it. The real sleeps are deliberate — the waits
 * poll observable state (socket presence, exit code) in the child, and the
 * 500 ms hold covers five 100 ms watchdog ticks.
 */
const BRIDGE = join(import.meta.dir, "..", "bin", "notify-bridge.ts");
const dir = mkdtempSync(join(import.meta.dir, ".tmp-"));
const children: Bun.Subprocess[] = [];
const silent = { stdin: "ignore", stdout: "ignore", stderr: "pipe" } as const;

function spawnBridge(socketPath: string, extra: string[]): Bun.Subprocess {
	const child = Bun.spawn(["bun", BRIDGE, "--socket", socketPath, ...extra], {
		env: { ...process.env, OMP_NOTIFY_WATCHDOG_MS: "100" },
		...silent,
	});
	children.push(child);
	return child;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(20);
	}
}

afterAll(() => {
	for (const child of children) child.kill();
	rmSync(dir, { recursive: true, force: true });
});

test("bridge stays alive while the parent lives", async () => {
	const socketPath = join(dir, "live.sock");
	const parent = Bun.spawn(["sleep", "60"], silent);
	children.push(parent);
	const bridge = spawnBridge(socketPath, ["--parent-pid", String(parent.pid)]);

	await waitFor(() => existsSync(socketPath), 5_000);
	await Bun.sleep(500); // five watchdog ticks at 100 ms
	expect(existsSync(socketPath)).toBe(true);
	expect(bridge.exitCode).toBeNull();
});

test("bridge exits and removes the socket when the parent dies", async () => {
	const socketPath = join(dir, "dead.sock");
	const parent = Bun.spawn(["sleep", "60"], silent);
	children.push(parent);
	const bridge = spawnBridge(socketPath, ["--parent-pid", String(parent.pid)]);

	await waitFor(() => existsSync(socketPath), 5_000);
	parent.kill();
	await waitFor(() => !existsSync(socketPath), 5_000);
	expect(await bridge.exited).toBe(0);
});

test("bridge refuses to start without a valid parent pid", async () => {
	const child = spawnBridge(join(dir, "noparent.sock"), []);
	expect(await child.exited).toBe(2);
});
