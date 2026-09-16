import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AppHost, AspireResource, AspireResources, AspireStatus } from "../shared/aspire";
import { EMPTY_RESOURCES, IDLE_STATUS } from "../shared/aspire";

type Instance = {
	workspaceId: string;
	appHost: AppHost;
	pid: number;
	pgid: number;
	source: "plugin" | "script" | "external";
	startedAt: string;
	dashboardUrl: string | null;
	dashboardUrlKind: "login" | "fallback" | null;
	logFile: string | null;
	logOffset: number;
	logRemainder: string;
	tailer: ReturnType<typeof setInterval> | null;
	exited: boolean;
	probing: boolean;
	error: string | null;
};

type PersistedInstance = {
	pid: number;
	pgid: number;
	startedAt: string;
	dashboardUrl: string | null;
	logFile: string | null;
	appHost: AppHost;
};

const LOGIN_PATTERNS = [
	/Login to the dashboard at\s+(https?:\/\/\S+)/i,
	/Login URL:\s+(https?:\/\/\S+)/i,
	/(https?:\/\/[^\s\x1b]+\/login\?t=[^\s\x1b]+)/i,
];
const FALLBACK_PATTERNS = [
	/Dashboard:\s+(https?:\/\/\S+)/i,
	/Now listening on:\s+(https?:\/\/\S+)/i,
	/ASPIRE_DASHBOARD_URL[=:]\s*(https?:\/\/[^\s;,"']+)/i,
	/ASPNETCORE_URLS[=:]\s*(https?:\/\/[^\s;,"']+)/i,
];
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]|${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, "g");
const TAIL_INTERVAL_MS = 500;
const STOP_GRACE_MS = 8_000;
const SCRIPT_NAME = "aspire";
const SCRIPT_PENDING_MS = 120_000;
const RESOURCES_TTL_MS = 2_000;

const instances = new Map<string, Instance>();
const errors = new Map<string, string>();
const scriptLaunches = new Map<string, string>();
const resourceCache = new Map<string, { at: number; result: AspireResources; inflight: Promise<AspireResources> | null }>();
const stateDir = join(homedir(), ".paseo", "plugin-state", "aspire");
const stateFile = join(stateDir, "state.json");
const logDir = join(stateDir, "logs");

export function stateLocation() {
	return stateDir;
}

export function getStatus(workspaceId: string): AspireStatus {
	const instance = instances.get(workspaceId);
	if (!instance || instance.exited) {
		const pendingSince = scriptLaunches.get(workspaceId);
		if (pendingSince && Date.now() - Date.parse(pendingSince) < SCRIPT_PENDING_MS) {
			return { state: "starting", source: "script", pid: null, dashboardUrl: null, startedAt: pendingSince, error: null };
		}
		return { ...IDLE_STATUS, error: errors.get(workspaceId) ?? null };
	}
	return {
		state: instance.dashboardUrl || instance.source !== "plugin" ? "running" : "starting",
		source: instance.source,
		pid: instance.pid,
		dashboardUrl: instance.dashboardUrl,
		startedAt: instance.startedAt,
		error: instance.error,
	};
}

export async function describeResources(workspaceId: string): Promise<AspireResources> {
	const instance = instances.get(workspaceId);
	if (!instance || instance.exited) {
		resourceCache.delete(workspaceId);
		return EMPTY_RESOURCES;
	}
	if (!(await hasAspireCli())) {
		return { ...EMPTY_RESOURCES, error: "Aspire CLI not found on the daemon; resource list unavailable" };
	}
	const cached = resourceCache.get(workspaceId);
	if (cached?.inflight) return cached.inflight;
	if (cached && Date.now() - cached.at < RESOURCES_TTL_MS) return cached.result;
	const inflight = runDescribe(instance, cached?.result ?? EMPTY_RESOURCES).then((result) => {
		resourceCache.set(workspaceId, { at: Date.now(), result, inflight: null });
		return result;
	});
	resourceCache.set(workspaceId, { at: cached?.at ?? 0, result: cached?.result ?? EMPTY_RESOURCES, inflight });
	return inflight;
}

async function runDescribe(instance: Instance, previous: AspireResources): Promise<AspireResources> {
	const target = instance.appHost.kind === "csproj" ? instance.appHost.projectPath : instance.appHost.directory;
	const result = await runCapture(
		"aspire",
		["describe", "--non-interactive", "--nologo", "--format", "json", "--apphost", target],
		instance.appHost.directory,
	);
	const start = result.stdout.indexOf("{");
	if (start >= 0) {
		try {
			const parsed = JSON.parse(result.stdout.slice(start)) as { resources?: RawResource[] };
			const resources = (parsed.resources ?? []).map(toResource).sort((a, b) => a.displayName.localeCompare(b.displayName));
			return { resources, updatedAt: new Date().toISOString(), error: null };
		} catch {}
	}
	const message =
		`${result.stderr}\n${result.stdout}`
			.replace(ANSI, "")
			.split("\n")
			.map((line) => line.replace(/^[^\w]+/, "").trim())
			.filter((line) => line && !/^See logs at/i.test(line) && !/AppHosts?\.\.\.$/i.test(line))
			.pop() ?? `aspire describe exited with ${result.code ?? "signal"}`;
	return { ...previous, error: message };
}

type RawResource = {
	name?: string;
	displayName?: string;
	resourceType?: string;
	state?: string | null;
	healthStatus?: string | null;
	urls?: { name?: string; url?: string; isInternal?: boolean }[];
};

function toResource(raw: RawResource): AspireResource {
	const name = raw.name ?? "";
	return {
		name,
		displayName: raw.displayName ?? name,
		type: raw.resourceType ?? "",
		state: raw.state ?? null,
		health: raw.healthStatus ?? null,
		urls: (raw.urls ?? [])
			.filter((entry) => entry.url && !entry.isInternal)
			.map((entry) => ({ name: entry.name ?? "default", url: entry.url as string })),
	};
}

export function hasInstance(workspaceId: string) {
	const instance = instances.get(workspaceId);
	return Boolean(instance && !instance.exited);
}

export async function launch(workspaceId: string, workspaceDirectory: string, appHost: AppHost): Promise<AspireStatus> {
	if (hasInstance(workspaceId)) return getStatus(workspaceId);
	errors.delete(workspaceId);
	if (await hasWorkspaceScript(workspaceDirectory)) return launchViaScript(workspaceId, workspaceDirectory, appHost);
	mkdirSync(logDir, { recursive: true });
	const logFile = join(logDir, `${workspaceId}.log`);
	writeFileSync(logFile, "");
	const fd = openSync(logFile, "a");
	const command = await buildCommand(appHost);
	console.log(`[aspire] launching ${command.bin} ${command.args.join(" ")} in ${command.cwd}`);
	const child = spawn(command.bin, command.args, {
		cwd: command.cwd,
		detached: true,
		stdio: ["ignore", fd, fd],
		env: { ...process.env, NO_COLOR: "1", TERM: "dumb", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
	});
	const spawned = await new Promise<Error | null>((done) => {
		child.once("error", (error) => done(error));
		child.once("spawn", () => done(null));
	});
	closeSync(fd);
	if (spawned || !child.pid) {
		const message = `Failed to start ${command.bin}: ${spawned?.message ?? "no pid"}`;
		errors.set(workspaceId, message);
		return getStatus(workspaceId);
	}
	child.unref();
	const instance: Instance = {
		workspaceId,
		appHost,
		pid: child.pid,
		pgid: child.pid,
		source: "plugin",
		startedAt: new Date().toISOString(),
		dashboardUrl: null,
		dashboardUrlKind: null,
		logFile,
		logOffset: 0,
		logRemainder: "",
		tailer: null,
		exited: false,
		probing: false,
		error: null,
	};
	child.on("exit", (code, signal) => onExit(instance, code, signal));
	instances.set(workspaceId, instance);
	startTailer(instance);
	persist();
	return getStatus(workspaceId);
}

export async function stop(workspaceId: string): Promise<AspireStatus> {
	const instance = instances.get(workspaceId);
	scriptLaunches.delete(workspaceId);
	if (!instance || instance.exited) return getStatus(workspaceId);
	if (instance.source === "script") {
		await runQuiet("paseo", ["script", "stop", SCRIPT_NAME, "--workspace", workspaceId], instance.appHost.directory);
	} else if (instance.source === "external" && (await hasAspireCli())) {
		await runQuiet("aspire", ["stop", "--non-interactive", "--nologo", "--apphost", instance.appHost.projectPath], instance.appHost.directory);
	}
	signalGroup(instance, "SIGTERM");
	const deadline = Date.now() + STOP_GRACE_MS;
	while (Date.now() < deadline && isAlive(instance.pid)) {
		await sleep(250);
	}
	if (isAlive(instance.pid)) signalGroup(instance, "SIGKILL");
	await sleep(200);
	finish(instance, null);
	return getStatus(workspaceId);
}

export async function refresh(workspaceId: string, workspaceDirectory: string, appHost: AppHost): Promise<AspireStatus> {
	const tracked = instances.get(workspaceId);
	if (tracked && !tracked.exited) {
		if (!isAlive(tracked.pid)) finish(tracked, null);
		else if (!tracked.dashboardUrl && tracked.source === "external") await discoverExternalUrl(tracked);
		return getStatus(workspaceId);
	}
	const external = await findExternal(workspaceDirectory, appHost);
	if (external) {
		external.workspaceId = workspaceId;
		if (scriptLaunches.has(workspaceId)) external.source = "script";
		instances.set(workspaceId, external);
		await discoverExternalUrl(external);
		startTailer(external);
	}
	return getStatus(workspaceId);
}

export function restoreState() {
	let persisted: Record<string, PersistedInstance> = {};
	try {
		persisted = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, PersistedInstance>;
	} catch {
		return;
	}
	for (const [workspaceId, entry] of Object.entries(persisted)) {
		if (!isAlive(entry.pid) || !cmdlineMentions(entry.pid, entry.appHost)) continue;
		const instance: Instance = {
			workspaceId,
			appHost: entry.appHost,
			pid: entry.pid,
			pgid: entry.pgid,
			source: "plugin",
			startedAt: entry.startedAt,
			dashboardUrl: entry.dashboardUrl,
			dashboardUrlKind: entry.dashboardUrl ? "login" : null,
			logFile: entry.logFile,
			logOffset: 0,
			logRemainder: "",
			tailer: null,
			exited: false,
			probing: false,
			error: null,
		};
		instances.set(workspaceId, instance);
		startTailer(instance);
		console.log(`[aspire] re-adopted app host pid ${entry.pid} for ${workspaceId}`);
	}
	persist();
}

export function shutdown() {
	for (const instance of instances.values()) {
		if (instance.tailer) clearInterval(instance.tailer);
		instance.tailer = null;
	}
	persist();
}

async function hasWorkspaceScript(workspaceDirectory: string) {
	try {
		const config = JSON.parse(await readFile(join(workspaceDirectory, "paseo.json"), "utf8")) as { scripts?: Record<string, { type?: string }> };
		return config.scripts?.[SCRIPT_NAME]?.type === "service";
	} catch {
		return false;
	}
}

async function launchViaScript(workspaceId: string, workspaceDirectory: string, appHost: AppHost): Promise<AspireStatus> {
	console.log(`[aspire] starting workspace script "${SCRIPT_NAME}" for ${workspaceId}`);
	const result = await runCapture("paseo", ["script", "start", SCRIPT_NAME, "--workspace", workspaceId], workspaceDirectory);
	if (result.code !== 0) {
		errors.set(workspaceId, `paseo script start ${SCRIPT_NAME} failed: ${(result.stderr || result.stdout).trim().split("\n").pop() ?? `exit ${result.code}`}`);
		return getStatus(workspaceId);
	}
	scriptLaunches.set(workspaceId, new Date().toISOString());
	return refresh(workspaceId, workspaceDirectory, appHost);
}

async function buildCommand(appHost: AppHost) {
	if (await hasAspireCli()) {
		const target = appHost.kind === "csproj" ? appHost.projectPath : appHost.directory;
		return { bin: "aspire", args: ["run", "--non-interactive", "--nologo", "--apphost", target], cwd: appHost.directory };
	}
	const args = appHost.kind === "csproj" ? ["run", "--project", appHost.projectPath] : ["run", appHost.projectPath];
	return { bin: "dotnet", args, cwd: appHost.directory };
}

let aspireCliAvailable: boolean | null = null;
async function hasAspireCli() {
	if (aspireCliAvailable !== null) return aspireCliAvailable;
	const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const entry of pathEntries) {
		try {
			const info = await stat(join(entry, "aspire"));
			if (info.isFile()) {
				aspireCliAvailable = true;
				return true;
			}
		} catch {}
	}
	aspireCliAvailable = false;
	return false;
}

function startTailer(instance: Instance) {
	if (instance.tailer) return;
	instance.tailer = setInterval(() => {
		if (instance.logFile) void tail(instance);
		if (!isAlive(instance.pid)) finish(instance, null);
	}, TAIL_INTERVAL_MS);
}

async function tail(instance: Instance) {
	if (!instance.logFile) return;
	let content: Buffer;
	try {
		content = await readFile(instance.logFile);
	} catch {
		return;
	}
	if (content.length < instance.logOffset) instance.logOffset = 0;
	if (content.length === instance.logOffset) return;
	const chunk = content.subarray(instance.logOffset).toString("utf8");
	instance.logOffset = content.length;
	const lines = (instance.logRemainder + chunk).split(/\r?\n/);
	instance.logRemainder = lines.pop() ?? "";
	for (const line of lines) consumeLine(instance, line.replace(ANSI, ""));
}

function consumeLine(instance: Instance, line: string) {
	for (const pattern of LOGIN_PATTERNS) {
		const match = pattern.exec(line);
		if (match) {
			setDashboardUrl(instance, match[1], "login");
			return;
		}
	}
	if (instance.dashboardUrlKind !== null) return;
	for (const pattern of FALLBACK_PATTERNS) {
		const match = pattern.exec(line);
		if (match) {
			void proposeFallback(instance, match[1]);
			return;
		}
	}
}

async function proposeFallback(instance: Instance, url: string) {
	if (instance.dashboardUrlKind !== null || instance.probing || instance.exited) return;
	instance.probing = true;
	try {
		if ((await reachable(url)) && instance.dashboardUrlKind === null) setDashboardUrl(instance, url, "fallback");
	} finally {
		instance.probing = false;
	}
}

function reachable(url: string) {
	return new Promise<boolean>((done) => {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			done(false);
			return;
		}
		const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
		const socket = connect({ host: parsed.hostname, port });
		const timer = setTimeout(() => {
			socket.destroy();
			done(false);
		}, 1_500);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			done(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			done(false);
		});
	});
}

function setDashboardUrl(instance: Instance, url: string, kind: "login" | "fallback") {
	const cleaned = url.replace(/[.,;)\]]+$/, "");
	if (instance.dashboardUrl === cleaned && instance.dashboardUrlKind === kind) return;
	instance.dashboardUrl = cleaned;
	instance.dashboardUrlKind = kind;
	console.log(`[aspire] dashboard ${kind} url found for ${instance.workspaceId}`);
	persist();
}

function onExit(instance: Instance, code: number | null, signal: NodeJS.Signals | null) {
	const failed = code !== null && code !== 0 && !instance.dashboardUrl;
	finish(instance, failed ? `App host exited with code ${code}${signal ? ` (${signal})` : ""}` : null);
}

function finish(instance: Instance, error: string | null) {
	resourceCache.delete(instance.workspaceId);
	if (instance.exited) return;
	instance.exited = true;
	if (instance.tailer) clearInterval(instance.tailer);
	instance.tailer = null;
	if (error) errors.set(instance.workspaceId, error);
	if (instances.get(instance.workspaceId) === instance) instances.delete(instance.workspaceId);
	persist();
	console.log(`[aspire] app host for ${instance.workspaceId} stopped${error ? `: ${error}` : ""}`);
}

function signalGroup(instance: Instance, signal: NodeJS.Signals) {
	try {
		process.kill(-instance.pgid, signal);
		return;
	} catch {}
	try {
		process.kill(instance.pid, signal);
	} catch {}
}

function isAlive(pid: number) {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		return !/^State:\s+Z/m.test(status);
	} catch {
		return true;
	}
}

function persist() {
	const snapshot: Record<string, PersistedInstance> = {};
	for (const instance of instances.values()) {
		if (instance.exited || instance.source !== "plugin") continue;
		snapshot[instance.workspaceId] = {
			pid: instance.pid,
			pgid: instance.pgid,
			startedAt: instance.startedAt,
			dashboardUrl: instance.dashboardUrl,
			logFile: instance.logFile,
			appHost: instance.appHost,
		};
	}
	try {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(stateFile, JSON.stringify(snapshot, null, "\t"));
	} catch (error) {
		console.error(`[aspire] failed to persist state: ${(error as Error).message}`);
	}
}

function cmdlineMentions(pid: number, appHost: AppHost) {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
		return cmdline.includes(appHost.projectPath) || cmdline.includes(appHost.directory);
	} catch {
		return false;
	}
}

type ProcessInfo = { pid: number; ppid: number; pgid: number; args: string[]; cwd: string | null };

async function listProcesses(): Promise<ProcessInfo[]> {
	let entries: string[];
	try {
		entries = await readdir("/proc");
	} catch {
		return [];
	}
	const result: ProcessInfo[] = [];
	await Promise.all(
		entries
			.filter((entry) => /^\d+$/.test(entry))
			.map(async (entry) => {
				const pid = Number(entry);
				if (pid === process.pid) return;
				try {
					const [cmdline, statLine] = await Promise.all([readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
					const args = cmdline.split("\u0000").filter(Boolean);
					if (args.length === 0) return;
					const fields = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
					const ppid = Number(fields[1]);
					const pgid = Number(fields[2]);
					const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
					result.push({ pid, ppid, pgid, args, cwd });
				} catch {}
			}),
	);
	return result;
}

function isAppHostProcess(info: ProcessInfo, workspaceDirectory: string, appHost: AppHost) {
	const bin = basename(info.args[0]);
	if (bin !== "aspire" && bin !== "dotnet") return false;
	if (info.args.some((arg) => arg === appHost.projectPath || arg.startsWith(`${appHost.directory}/`))) return true;
	if (!info.cwd || !isWithin(info.cwd, workspaceDirectory)) return false;
	return info.args.includes("run") || info.args.includes("watch");
}

function isWithin(path: string, root: string) {
	const resolvedRoot = resolve(root);
	const resolvedPath = resolve(path);
	return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

async function findExternal(workspaceDirectory: string, appHost: AppHost): Promise<Instance | null> {
	const processes = await listProcesses();
	const matches = processes.filter((info) => isAppHostProcess(info, workspaceDirectory, appHost));
	if (matches.length === 0) return null;
	const pids = new Set(matches.map((info) => info.pid));
	const roots = matches.filter((info) => !pids.has(info.ppid));
	roots.sort((a, b) => Number(basename(b.args[0]) === "aspire") - Number(basename(a.args[0]) === "aspire") || a.pid - b.pid);
	const root = roots[0] ?? matches[0];
	const logIndex = root.args.indexOf("--log-file");
	const logFile = logIndex >= 0 ? root.args[logIndex + 1] ?? null : null;
	let startedAt = new Date().toISOString();
	try {
		startedAt = (await stat(`/proc/${root.pid}`)).mtime.toISOString();
	} catch {}
	console.log(`[aspire] detected external app host pid ${root.pid} for ${appHost.projectPath}`);
	return {
		workspaceId: "",
		appHost,
		pid: root.pid,
		pgid: root.pgid,
		source: "external",
		startedAt,
		dashboardUrl: null,
		dashboardUrlKind: null,
		logFile,
		logOffset: 0,
		logRemainder: "",
		tailer: null,
		exited: false,
		probing: false,
		error: null,
	};
}

async function discoverExternalUrl(instance: Instance) {
	if (hasLoginUrl(instance)) return;
	if (instance.logFile) await tail(instance);
	if (hasLoginUrl(instance)) return;
	const processes = await listProcesses();
	const tree = new Set([instance.pid, ...collectDescendants(processes, instance.pid).map((info) => info.pid)]);
	for (const info of processes) {
		if (!info.args.some((arg) => /Aspire\.Dashboard(\.dll)?$/.test(arg))) continue;
		const env = await readEnviron(info.pid);
		const cliPid = Number(env.ASPIRE_CLI_PID);
		if (!tree.has(info.pid) && !(cliPid && tree.has(cliPid))) continue;
		const url = (env.DASHBOARD__FRONTEND__PUBLICURL ?? env.ASPNETCORE_URLS)?.split(";")[0];
		const token = env.DASHBOARD__FRONTEND__BROWSERTOKEN;
		if (url && token) {
			setDashboardUrl(instance, `${url.replace(/\/$/, "")}/login?t=${token}`, "login");
			return;
		}
		if (url) await proposeFallback(instance, url);
	}
}

function hasLoginUrl(instance: Instance) {
	return instance.dashboardUrlKind === "login";
}

function collectDescendants(processes: ProcessInfo[], rootPid: number) {
	const byParent = new Map<number, ProcessInfo[]>();
	for (const info of processes) {
		const siblings = byParent.get(info.ppid) ?? [];
		siblings.push(info);
		byParent.set(info.ppid, siblings);
	}
	const result: ProcessInfo[] = [];
	const queue = [rootPid];
	while (queue.length > 0) {
		const pid = queue.shift()!;
		for (const child of byParent.get(pid) ?? []) {
			result.push(child);
			queue.push(child.pid);
		}
	}
	return result;
}

async function readEnviron(pid: number) {
	const env: Record<string, string> = {};
	try {
		const raw = await readFile(`/proc/${pid}/environ`, "utf8");
		for (const entry of raw.split("\u0000")) {
			const separator = entry.indexOf("=");
			if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
		}
	} catch {}
	return env;
}

function runCapture(bin: string, args: string[], cwd: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("error", (error) => {
			clearTimeout(timer);
			done({ code: null, stdout, stderr: stderr || error.message });
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			done({ code, stdout, stderr });
		});
	});
}

function runQuiet(bin: string, args: string[], cwd: string) {
	return new Promise<void>((done) => {
		const child = spawn(bin, args, { cwd, stdio: "ignore" });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.once("error", () => {
			clearTimeout(timer);
			done();
		});
		child.once("exit", () => {
			clearTimeout(timer);
			done();
		});
	});
}

function sleep(ms: number) {
	return new Promise((done) => setTimeout(done, ms));
}
