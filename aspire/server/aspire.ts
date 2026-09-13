import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AppHost } from "../shared/aspire";
import { aspireStatusRpc, detectAspireRpc, launchAspireRpc, stopAspireRpc } from "../shared/aspire";
import { findAppHost } from "./detect";
import { getStatus, launch, refresh, stop } from "./process";

const DETECT_CACHE_MS = 15_000;
const detectCache = new Map<string, { at: number; directory: string; appHost: AppHost | null }>();

async function workspaceDirectory(workspaceId: string, { paseo }: PluginHandlerContext) {
	const workspace = paseo.workspaces.ref(workspaceId);
	await workspace.refresh();
	const directory = workspace.directory;
	if (!directory) throw new Error(`Workspace ${workspaceId} has no directory`);
	return directory;
}

async function detect(workspaceId: string, directory: string) {
	const cached = detectCache.get(workspaceId);
	if (cached && cached.directory === directory && Date.now() - cached.at < DETECT_CACHE_MS) return cached.appHost;
	const appHost = await findAppHost(directory);
	detectCache.set(workspaceId, { at: Date.now(), directory, appHost });
	return appHost;
}

export function forgetWorkspace(workspaceId: string) {
	detectCache.delete(workspaceId);
}

export async function detectAspire({ workspaceId }: RpcInput<typeof detectAspireRpc>, context: PluginHandlerContext) {
	const directory = await workspaceDirectory(workspaceId, context);
	return { appHost: await detect(workspaceId, directory) };
}

export async function launchAspire({ workspaceId }: RpcInput<typeof launchAspireRpc>, context: PluginHandlerContext) {
	const directory = await workspaceDirectory(workspaceId, context);
	const appHost = await detect(workspaceId, directory);
	if (!appHost) throw new Error("No Aspire app host found in this workspace");
	const current = await refresh(workspaceId, directory, appHost);
	if (current.state !== "idle") return current;
	return launch(workspaceId, appHost);
}

export async function aspireStatus({ workspaceId }: RpcInput<typeof aspireStatusRpc>, context: PluginHandlerContext) {
	const directory = await workspaceDirectory(workspaceId, context);
	const appHost = await detect(workspaceId, directory);
	if (!appHost) return getStatus(workspaceId);
	return refresh(workspaceId, directory, appHost);
}

export async function stopAspire({ workspaceId }: RpcInput<typeof stopAspireRpc>) {
	return stop(workspaceId);
}
