/**
 * dsh-plugin-open-in-app-fix — make dsh's "Open In …" actually start Electron editors.
 *
 * ## The defect
 *
 * `@deepseek-ai/dsh-host-open-in-app` launches a resolved application through its
 * `launchDetachedApp` adapter, which spawns the child with `scrubbedParentEnv()`
 * plus the adapter's own env entries. `scrubbedParentEnv()` drops credential-shaped
 * names and every `DSH_*` name, but it keeps `ELECTRON_RUN_AS_NODE`.
 *
 * The plugin runs inside the Desktop Host process, which the Electron shell starts
 * in Node mode, so that process carries `ELECTRON_RUN_AS_NODE=1` in its own
 * environment. Every catalog entry that is itself an Electron application — VS Code,
 * VS Code Insiders, Cursor, Windsurf — therefore receives `ELECTRON_RUN_AS_NODE=1`,
 * starts as a plain Node process instead of a GUI, and exits non-zero inside
 * `launchWatchMs`. `runLaunch` classifies that as `failed`, the open route answers
 * `launch-failed`, and the browser renders "打开失败，请重试" / "Could not open. Try again."
 *
 * Measured on the affected host, launching `Code.exe <dir>` the way the adapter does:
 *
 * | child env | outcome |
 * |---|---|
 * | inherited `ELECTRON_RUN_AS_NODE=1` (today) | exit code 1 after ~64 ms → dsh reports failure |
 * | selector removed | still running at the watch deadline → dsh reports launched, GUI opens |
 *
 * ## Why the repair lives here
 *
 * The obvious shortcut — deleting `process.env.ELECTRON_RUN_AS_NODE` — is wrong:
 * `dsh-subprocess-local` builds its runner environment from `scrubbedParentEnv()`
 * and relies on *inheriting* the selector so that `process.execPath` (the Electron
 * executable) boots `runner.js` in Node mode. Clearing it process-wide would take
 * every shell and exec tool down with it.
 *
 * Editing the open-in-app module is not reachable either: it calls the ESM binding
 * of `child_process.spawn` (a snapshot, so monkey-patching the module export has no
 * effect) and that module is bundled inside `app.asar`.
 *
 * What the snapshot and the internal implementation *do* share is the object the
 * snapshot's function uses internally: `ChildProcess.prototype.spawn(options)`. This
 * plugin patches that method and removes the selector only from launches matching
 * the open-in-app GUI adapter's exact shape — `detached: true` with `stdio: "ignore"`.
 * A scan of the shipped `app.asar` finds that shape exactly once (the GUI adapter);
 * the subprocess runner, the bash session and the `ctx.subprocess` seam all spawn
 * with structured stdio, so they keep the selector and stay in Node mode.
 *
 * @module dsh-plugin-open-in-app-fix
 */
import { ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin identity. */
export const name = "open-in-app-fix";

/** No service dependency: the repair is a process-level adapter patch. */
export const inject = [];

/** Documented configuration keys. The repair is unconditional; these are diagnostic. */
export const CONFIG_DEFAULTS = {
	selfTest: true
};

const SELECTOR = "ELECTRON_RUN_AS_NODE";
const SELECTOR_PAIR = /^ELECTRON_RUN_AS_NODE=/i;
const MARK = "__dshOpenInAppFixPatched";
const SELF_TEST_MARKER = "run-selftest";
const SELF_TEST_RESULT = "selftest.json";
const SELF_TEST_WATCH_MS = 2_000;

/** This package's directory, used only to locate the opt-in self-test marker. */
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

/** The live patch of this process, or null when not installed. */
let installed = null;

/**
 * Whether a stdio option leaves the child with no pipe on any descriptor.
 * `spawn` normalizes stdio to an array on some Node versions and leaves the
 * string form intact on others, so both spellings are accepted.
 * @param stdio - the `stdio` option as handed to `ChildProcess.prototype.spawn`.
 * @returns true for `"ignore"` and for an all-`"ignore"` descriptor array.
 */
function isIgnoredStdio(stdio) {
	if (stdio === "ignore") return true;
	return Array.isArray(stdio) && stdio.length > 0 && stdio.every((entry) => entry === "ignore");
}

/**
 * Whether these spawn options are the open-in-app GUI adapter's launch: a detached
 * process whose stdio is discarded. Every other spawn in the shipped tree (the
 * subprocess runner, the bash session, `ctx.subprocess`) uses structured stdio.
 * @param options - the options object handed to `ChildProcess.prototype.spawn`.
 * @returns true when the launch shape matches the GUI adapter.
 */
function isDetachedGuiLaunch(options) {
	return options !== null && typeof options === "object" && options.detached === true && isIgnoredStdio(options.stdio);
}

/**
 * Remove the Electron Node-mode selector from one already-normalized spawn request.
 * `spawn()` turns `options.env` into `options.envPairs` before this point, so the
 * pairs are the carrier that actually decides the child's environment; the `env`
 * object is rewritten as a filtered copy for any later reader.
 *
 * Nothing caller-owned is mutated: the `env` object is replaced, never edited in
 * place. A caller that reuses one environment object across launches therefore keeps
 * it intact, and `options.env === process.env` (a spawn with no explicit env) can
 * never turn this repair into a process-wide variable deletion.
 * @param options - the options object handed to `ChildProcess.prototype.spawn`.
 * @returns the number of carriers the selector was removed from.
 */
function stripSelector(options) {
	let removed = 0;
	const pairs = options.envPairs;
	if (Array.isArray(pairs)) {
		const kept = pairs.filter((pair) => typeof pair !== "string" || !SELECTOR_PAIR.test(pair));
		if (kept.length !== pairs.length) {
			options.envPairs = kept;
			removed += 1;
		}
	}
	const env = options.env;
	if (env !== null && typeof env === "object") {
		const carriers = Object.keys(env).filter((key) => key.toUpperCase() === SELECTOR);
		if (carriers.length > 0) {
			const filtered = { ...env };
			for (const key of carriers) delete filtered[key];
			options.env = filtered;
			removed += 1;
		}
	}
	return removed;
}

/**
 * Install the prototype patch once per process.
 * @returns the installed patch record, or the existing one.
 */
function installPatch() {
	if (installed !== null) return installed;
	const prototype = ChildProcess.prototype;
	const original = prototype.spawn;
	if (typeof original !== "function") return null;
	const patched = function openInAppFixSpawn(options) {
		if (isDetachedGuiLaunch(options)) stripSelector(options);
		return original.call(this, options);
	};
	patched[MARK] = original;
	prototype.spawn = patched;
	installed = { prototype, original, patched };
	return installed;
}

/** Restore the method this plugin replaced, unless someone patched after us. */
function uninstallPatch() {
	if (installed === null) return;
	const { prototype, original, patched } = installed;
	if (prototype.spawn === patched) prototype.spawn = original;
	installed = null;
}

/** Every credential-shaped and `DSH_*` name, mirroring `scrubbedParentEnv()`. */
const SENSITIVE = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * A local stand-in for the launch environment the GUI adapter builds: the ambient
 * environment minus credential-shaped and `DSH_*` names. The selector is left in
 * place on purpose — removing it is what the patch under test must do.
 * @returns the environment handed to the probe child.
 */
function probeEnvironment() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (SENSITIVE.test(key)) continue;
		if (key.toUpperCase().startsWith("DSH_")) continue;
		env[key] = value;
	}
	return env;
}

/**
 * The VS Code launcher this catalog entry resolves to, using the same candidates
 * the shipped catalog declares for win32.
 * @returns an absolute executable path, or null when VS Code is not installed.
 */
function resolveVsCode() {
	const candidates = [];
	if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"));
	if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Reproduce the GUI adapter's launch — same `spawn` binding, same options, same
 * environment — and report how it ended. A launch still alive at the watch
 * deadline is the success dsh itself counts as launched.
 * @param target - absolute directory to hand the editor.
 * @returns the recorded probe outcome.
 */
function probeLaunch(target) {
	return new Promise((resolve) => {
		const command = resolveVsCode();
		if (command === null) {
			resolve({ outcome: "not-installed", detail: "no VS Code launcher found in the win32 catalog candidates" });
			return;
		}
		const startedAt = Date.now();
		let settled = false;
		const finish = (outcome, detail) => {
			if (settled) return;
			settled = true;
			clearTimeout(watch);
			resolve({ outcome, detail, command, target, watchMs: SELF_TEST_WATCH_MS, elapsedMs: Date.now() - startedAt });
		};
		let child;
		try {
			child = spawn(command, [target], { detached: true, stdio: "ignore", env: probeEnvironment() });
		} catch (error) {
			finish("spawn-threw", String(error?.message ?? error));
			return;
		}
		const watch = setTimeout(() => {
			child.unref();
			finish("launched", "child still running when the watch closed, so dsh counts this launch as successful");
		}, SELF_TEST_WATCH_MS);
		watch.unref?.();
		child.on("error", (error) => finish("spawn-error", String(error?.code ?? error?.message ?? error)));
		child.on("exit", (code, signal) => finish("exited", `exit code=${String(code)} signal=${String(signal)}`));
	});
}

/**
 * Run the opt-in self-test: it exists only while `<package>/run-selftest` is present,
 * and it writes `<package>/selftest.json` then deletes the marker so an ordinary boot
 * never opens an editor. Absence of the result file is itself the signal that the
 * plugin has not loaded.
 * @param ctx - the Cordis context, used for logging only.
 */
async function runSelfTest(ctx) {
	const marker = join(PACKAGE_DIR, SELF_TEST_MARKER);
	if (!existsSync(marker)) return;
	const requested = readFileSync(marker, "utf8").trim();
	const target = requested === "" ? process.cwd() : requested;
	let probe;
	try {
		probe = await probeLaunch(target);
	} catch (error) {
		probe = { outcome: "probe-threw", detail: String(error?.message ?? error) };
	}
	const report = {
		ranAt: new Date().toISOString(),
		hostPid: process.pid,
		execPath: process.execPath,
		node: process.versions.node,
		electron: process.versions.electron ?? null,
		platform: process.platform,
		selectorPresentInHostEnv: process.env[SELECTOR] === undefined ? "absent" : "present",
		patched: installed !== null,
		probe
	};
	try {
		writeFileSync(join(PACKAGE_DIR, SELF_TEST_RESULT), `${JSON.stringify(report, null, 2)}\n`, "utf8");
		rmSync(marker, { force: true });
		ctx?.logger?.info?.(`open-in-app-fix: self-test wrote selftest.json (probe outcome: ${probe.outcome})`);
	} catch (error) {
		ctx?.logger?.warn?.(`open-in-app-fix: self-test could not write its result: ${String(error?.message ?? error)}`);
	}
}

/**
 * Cordis plugin body: install the spawn patch and, when the opt-in marker is
 * present, run the self-test.
 * @param ctx - the Cordis context.
 */
export function apply(ctx) {
	const patch = installPatch();
	if (patch === null) {
		ctx?.logger?.warn?.("open-in-app-fix: node:child_process.ChildProcess.prototype.spawn is unavailable; nothing patched");
		return;
	}
	const dispose = () => uninstallPatch();
	if (typeof ctx?.effect === "function") ctx.effect(() => dispose, "open-in-app-fix: detached GUI launch patch");
	else ctx?.on?.("dispose", dispose);
	ctx?.logger?.info?.("open-in-app-fix: detached GUI launches no longer inherit ELECTRON_RUN_AS_NODE");
	if (CONFIG_DEFAULTS.selfTest) {
		runSelfTest(ctx).catch((error) => {
			ctx?.logger?.warn?.(`open-in-app-fix: self-test failed: ${String(error?.message ?? error)}`);
		});
	}
}
