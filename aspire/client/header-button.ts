import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";
import type { AspireStatus } from "../shared/aspire";
import { IDLE_STATUS, aspireStatusRpc, detectAspireRpc, launchAspireRpc, stopAspireRpc } from "../shared/aspire";
import { AspireIcon } from "./aspire-icon";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;
const REDETECT_MS = 60_000;

type Entry = {
	registration: PluginButtonRegistration | null;
	status: AspireStatus;
	cancelPoll: (() => void) | null;
	detectedAt: number;
	launchedHere: boolean;
	openedUrl: string | null;
	busy: boolean;
};

export function contributeHeaderButtons(client: PluginClientContext) {
	const entries = new Map<string, Entry>();
	let stopped = false;

	const entryFor = (workspaceId: string) => {
		let entry = entries.get(workspaceId);
		if (!entry) {
			entry = { registration: null, status: IDLE_STATUS, cancelPoll: null, detectedAt: 0, launchedHere: false, openedUrl: null, busy: false };
			entries.set(workspaceId, entry);
		}
		return entry;
	};

	const openDashboard = async (workspaceId: string) => {
		const url = entries.get(workspaceId)?.status.dashboardUrl;
		if (!url) throw new Error("Aspire dashboard URL is not known yet");
		await Linking.openURL(url);
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
			behavior: {
				kind: "menu",
				items: [
					{
						kind: "item",
						id: "open-dashboard",
						title: "Open dashboard",
						icon: "ExternalLink",
						disabled: !status.dashboardUrl,
						behavior: { kind: "action", onPress: () => openDashboard(workspaceId) },
					},
					{ kind: "separator", id: "stop-divider" },
					{
						kind: "item",
						id: "stop",
						title: "Stop",
						icon: "Square",
						behavior: { kind: "action", onPress: () => stopAspire(workspaceId) },
					},
				],
			},
		};
	};

	const applyStatus = (workspaceId: string, status: AspireStatus) => {
		const entry = entries.get(workspaceId);
		if (!entry || !entry.registration) return;
		const previous = entry.status;
		entry.status = status;
		if (status.state === "idle") {
			entry.launchedHere = false;
			entry.openedUrl = null;
		} else if (entry.launchedHere && status.dashboardUrl && entry.openedUrl !== status.dashboardUrl) {
			entry.openedUrl = status.dashboardUrl;
			void Linking.openURL(status.dashboardUrl).catch((error) => {
				console.error("[aspire] failed to open dashboard", error);
			});
		}
		const changed =
			previous.state !== status.state || previous.dashboardUrl !== status.dashboardUrl || previous.error !== status.error;
		if (changed) entry.registration.update(describe(workspaceId, status));
		schedule(workspaceId, status.state === "idle" && !entry.launchedHere ? IDLE_POLL_MS : ACTIVE_POLL_MS);
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

	const sync = async (workspaceId: string, force: boolean) => {
		const entry = entryFor(workspaceId);
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
		if (update.kind === "upsert") void sync(update.workspace.id, false);
		else if (update.kind === "remove") unregister(update.id);
	});

	void client.paseo.workspaces
		.list({ subscribe: {} })
		.then(({ entries: workspaces }) => {
			for (const workspace of workspaces) void sync(workspace.id, true);
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
