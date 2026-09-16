import type { PluginServerContext } from "@getpaseo/plugin/server";
import { aspireResources, aspireStatus, detectAspire, forgetWorkspace, launchAspire, stopAspire } from "./server/aspire";
import { getStatus, restoreState, shutdown, stateLocation, stop } from "./server/process";
import { aspireResourcesRpc, aspireStatusRpc, detectAspireRpc, launchAspireRpc, stopAspireRpc } from "./shared/aspire";

export default function contribute(server: PluginServerContext) {
	restoreState();
	console.log(`[aspire] state directory ${stateLocation()}`);
	server.handle(detectAspireRpc, detectAspire);
	server.handle(launchAspireRpc, launchAspire);
	server.handle(aspireStatusRpc, aspireStatus);
	server.handle(stopAspireRpc, stopAspire);
	server.handle(aspireResourcesRpc, aspireResources);
	const offArchived = server.on("workspace.archived", async ({ workspace }) => {
		forgetWorkspace(workspace.id);
		if (getStatus(workspace.id).source === "plugin") await stop(workspace.id);
	});
	return () => {
		offArchived();
		shutdown();
	};
}
