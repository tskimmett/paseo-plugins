import type { PluginButton, PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking, Platform } from "react-native";
import type { ComponentType } from "react";
import type { AspireResources, AspireStatus } from "../shared/aspire";
import { IDLE_STATUS, aspireResourcesRpc, aspireStatusRpc, detectAspireRpc, launchAspireRpc, stopAspireRpc } from "../shared/aspire";
import { AspireIcon } from "./aspire-icon";
import type { LinkTarget } from "./aspire-popover";
import { createAspirePopover, describeError, mergeResources } from "./aspire-popover";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;
const REDETECT_MS = 60_000;
const RESOURCE_BACKGROUND_MS = 10_000;
const MOBILE = Platform.OS === "ios" || Platform.OS === "android";
const URL_PARTS = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i;

type WorkspaceEntry = Awaited<ReturnType<PluginClientContext["paseo"]["workspaces"]["list"]>>["entries"][number];
type WorkspaceScripts = NonNullable<WorkspaceEntry["scripts"]>;

type Entry = {
	registration: PluginButtonRegistration | null;
	status: AspireStatus;
	resources: AspireResources | null;
	resourcesAt: number;
	resourcesInflight: Promise<void> | null;
	scripts: WorkspaceScripts;
	cancelPoll: (() => void) | null;
	detectedAt: number;
	launchedHere: boolean;
	openedUrl: string | null;
	busy: boolean;
	version: number;
	listeners: Set<() => void>;
	Content: ComponentType<PluginButtonContentProps> | null;
};

export type DashboardTarget = LinkTarget;

function isLoopbackHost(hostname: string) {
	const host = hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
}

/** Maps a daemon-local URL to something this client can open. Desktop and web clients open URLs as-is. */
export function resolveLinkTarget(url: string | null, scripts: WorkspaceScripts, mobile = MOBILE): LinkTarget {
	if (!url) return { url: null, reason: "Aspire dashboard URL is not known yet" };
	if (!mobile) return { url, reason: null };
	const parts = URL_PARTS.exec(url);
	if (!parts) return { url, reason: null };
	const [, protocol, hostname, portText, pathname = "", search = ""] = parts;
	if (!isLoopbackHost(hostname)) return { url, reason: null };
	const port = portText ? Number(portText) : protocol.toLowerCase() === "https" ? 443 : 80;
	const route = scripts.find((script) => script.type === "service" && script.lifecycle === "running" && script.port === port);
	if (!route) return { url: null, reason: "Only reachable on the daemon host (no Paseo service route)" };
	if (!route.publicProxyUrl) return { url: null, reason: "Route has no public URL (set daemon.serviceProxy.publicBaseUrl)" };
	return { url: `${route.publicProxyUrl.replace(/\/$/, "")}${pathname}${search}`, reason: null };
}

export const resolveDashboardTarget = resolveLinkTarget;

export function contributeHeaderButtons(client: PluginClientContext) {
	const entries = new Map<string, Entry>();
	let stopped = false;

	const entryFor = (workspaceId: string) => {
		let entry = entries.get(workspaceId);
		if (!entry) {
			entry = {
				registration: null,
				status: IDLE_STATUS,
				resources: null,
				resourcesAt: 0,
				resourcesInflight: null,
				scripts: [],
				cancelPoll: null,
				detectedAt: 0,
				launchedHere: false,
				openedUrl: null,
				busy: false,
				version: 0,
				listeners: new Set(),
				Content: null,
			};
			entries.set(workspaceId, entry);
		}
		return entry;
	};

	const notify = (entry: Entry) => {
		entry.version += 1;
		for (const listener of entry.listeners) listener();
	};

	const resolveFor = (workspaceId: string, url: string | null) => resolveLinkTarget(url, entries.get(workspaceId)?.scripts ?? []);

	const targetFor = (workspaceId: string, status = entries.get(workspaceId)?.status ?? IDLE_STATUS) => resolveFor(workspaceId, status.dashboardUrl);

	const openLink = async (workspaceId: string, url: string) => {
		const target = resolveFor(workspaceId, url);
		if (target.url === null) throw new Error(target.reason);
		await Linking.openURL(target.url);
	};

	const refreshResources = (workspaceId: string) => {
		const entry = entries.get(workspaceId);
		if (!entry || stopped) return Promise.resolve();
		if (entry.resourcesInflight) return entry.resourcesInflight;
		entry.resourcesInflight = client
			.rpc(aspireResourcesRpc, { workspaceId })
			.then(
				(next) => mergeResources(entry.resources, next),
				(error) => mergeResources(entry.resources, { resources: [], updatedAt: null, error: describeError(error) }),
			)
			.then((merged) => {
				entry.resourcesInflight = null;
				entry.resourcesAt = Date.now();
				if (merged === entry.resources) return;
				entry.resources = merged;
				notify(entry);
			});
		return entry.resourcesInflight;
	};

	const contentFor = (workspaceId: string) => {
		const entry = entryFor(workspaceId);
		if (!entry.Content) {
			entry.Content = createAspirePopover({
				subscribe: (listener) => {
					entry.listeners.add(listener);
					return () => entry.listeners.delete(listener);
				},
				getVersion: () => entry.version,
				getStatus: () => entry.status,
				getResources: () => entry.resources,
				refreshResources: () => refreshResources(workspaceId),
				resolve: (url) => resolveFor(workspaceId, url),
				open: (url) => openLink(workspaceId, url),
				stop: () => stopAspire(workspaceId),
			});
		}
		return entry.Content;
	};

	const describe = (workspaceId: string, status: AspireStatus): PluginButton => {
		if (status.state === "idle") {
			return {
				title: status.error ? `Launch Aspire app host (last run failed: ${status.error})` : "Launch Aspire app host",
				icon: AspireIcon,
				label: "Aspire",
				behavior: { kind: "action", onPress: () => launch(workspaceId) },
			};
		}
		const running = status.state === "running";
		return {
			title: running ? "Aspire app host is running" : "Aspire app host is starting",
			icon: AspireIcon,
			label: running ? "Aspire running" : "Aspire starting",
			behavior: { kind: "popover", Content: contentFor(workspaceId) },
		};
	};

	const maybeAutoOpen = (workspaceId: string, entry: Entry) => {
		if (!entry.launchedHere || !entry.status.dashboardUrl || entry.openedUrl === entry.status.dashboardUrl) return;
		const target = targetFor(workspaceId, entry.status);
		if (target.url === null) return;
		entry.openedUrl = entry.status.dashboardUrl;
		void Linking.openURL(target.url).catch((error) => {
			console.error("[aspire] failed to open dashboard", error);
		});
	};

	const applyStatus = (workspaceId: string, status: AspireStatus) => {
		const entry = entries.get(workspaceId);
		if (!entry || !entry.registration) return;
		const previous = entry.status;
		entry.status = status;
		if (status.state === "idle") {
			entry.launchedHere = false;
			entry.openedUrl = null;
			if (entry.resources !== null) {
				entry.resources = null;
				notify(entry);
			}
		} else {
			maybeAutoOpen(workspaceId, entry);
			if (Date.now() - entry.resourcesAt >= RESOURCE_BACKGROUND_MS) void refreshResources(workspaceId);
		}
		const changed =
			previous.state !== status.state ||
			previous.dashboardUrl !== status.dashboardUrl ||
			previous.error !== status.error ||
			previous.source !== status.source;
		if (changed) {
			entry.registration.update(describe(workspaceId, status));
			notify(entry);
		}
		schedule(workspaceId, status.state === "idle" && !entry.launchedHere ? IDLE_POLL_MS : ACTIVE_POLL_MS);
	};

	const routeKey = (scripts: WorkspaceScripts) =>
		scripts.map((script) => `${script.type}|${script.lifecycle}|${script.port ?? ""}|${script.publicProxyUrl ?? ""}`).join(";");

	const applyScripts = (workspaceId: string, scripts: WorkspaceScripts | undefined) => {
		const entry = entries.get(workspaceId);
		if (!entry) return;
		const next = scripts ?? [];
		const unchanged = routeKey(entry.scripts) === routeKey(next);
		const before = targetFor(workspaceId).url;
		entry.scripts = next;
		if (unchanged) return;
		if (!entry.registration || entry.status.state === "idle") return;
		if (targetFor(workspaceId).url !== before) maybeAutoOpen(workspaceId, entry);
		notify(entry);
	};

	const schedule = (workspaceId: string, delay: number) => {
		const entry = entries.get(workspaceId);
		if (!entry || stopped) return;
		entry.cancelPoll?.();
		const handle = setTimeout(() => {
			entry.cancelPoll = null;
			void poll(workspaceId);
		}, delay);
		entry.cancelPoll = () => clearTimeout(handle);
	};

	const poll = async (workspaceId: string) => {
		const entry = entries.get(workspaceId);
		if (!entry || !entry.registration || stopped) return;
		try {
			applyStatus(workspaceId, await client.rpc(aspireStatusRpc, { workspaceId }));
		} catch (error) {
			if (!stopped) console.error("[aspire] status poll failed", error);
			schedule(workspaceId, IDLE_POLL_MS);
		}
	};

	const launch = async (workspaceId: string) => {
		const entry = entryFor(workspaceId);
		entry.launchedHere = true;
		entry.openedUrl = null;
		try {
			applyStatus(workspaceId, await client.rpc(launchAspireRpc, { workspaceId }));
		} catch (error) {
			entry.launchedHere = false;
			throw error;
		}
	};

	const stopAspire = async (workspaceId: string) => {
		applyStatus(workspaceId, await client.rpc(stopAspireRpc, { workspaceId }));
	};

	const sync = async (workspaceId: string, force: boolean, scripts?: WorkspaceScripts) => {
		const entry = entryFor(workspaceId);
		if (scripts) entry.scripts = scripts;
		if (entry.busy || stopped) return;
		if (!force && entry.registration && Date.now() - entry.detectedAt < REDETECT_MS) return;
		entry.busy = true;
		try {
			const { appHost } = await client.rpc(detectAspireRpc, { workspaceId });
			entry.detectedAt = Date.now();
			if (stopped) return;
			if (appHost && !entry.registration) {
				entry.registration = client.addHeaderButton({ id: "aspire", workspaceId, button: describe(workspaceId, entry.status) });
				void poll(workspaceId);
			} else if (!appHost && entry.registration) {
				unregister(workspaceId);
			}
		} catch (error) {
			if (!stopped) console.error(`[aspire] detection failed for ${workspaceId}`, error);
		} finally {
			entry.busy = false;
		}
	};

	const unregister = (workspaceId: string) => {
		const entry = entries.get(workspaceId);
		if (!entry) return;
		entry.cancelPoll?.();
		entry.registration?.remove();
		entries.delete(workspaceId);
	};

	const unsubscribe = client.paseo.workspaces.subscribe((update) => {
		if (update.kind === "upsert") {
			applyScripts(update.workspace.id, update.workspace.scripts);
			void sync(update.workspace.id, false, update.workspace.scripts);
		} else if (update.kind === "remove") unregister(update.id);
	});

	void client.paseo.workspaces
		.list({ subscribe: {} })
		.then(({ entries: workspaces }) => {
			for (const workspace of workspaces) void sync(workspace.id, true, workspace.scripts);
		})
		.catch((error) => {
			if (!stopped) console.error("[aspire] workspace list failed", error);
		});

	return () => {
		stopped = true;
		unsubscribe();
		for (const workspaceId of [...entries.keys()]) unregister(workspaceId);
	};
}
