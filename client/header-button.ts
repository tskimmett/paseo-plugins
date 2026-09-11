import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { openInVsCodeRpc } from "../shared/open";
import { VsCodeIcon } from "./vscode-icon";

export function contributeHeaderButtons(client: PluginClientContext) {
	const buttons = new Map<string, PluginButtonRegistration>();
	let stopped = false;

	const register = (workspaceId: string) => {
		if (stopped || buttons.has(workspaceId)) return;
		buttons.set(
			workspaceId,
			client.addHeaderButton({
				id: "open-in-vscode",
				workspaceId,
				button: {
					title: "Open in VS Code",
					icon: VsCodeIcon,
					behavior: {
						kind: "action",
						async onPress() {
							await client.rpc(openInVsCodeRpc, { workspaceId });
						},
					},
				},
			}),
		);
	};

	const unregister = (workspaceId: string) => {
		buttons.get(workspaceId)?.remove();
		buttons.delete(workspaceId);
	};

	const unsubscribe = client.paseo.workspaces.subscribe((update) => {
		if (update.kind === "upsert") register(update.workspace.id);
		else if (update.kind === "remove") unregister(update.id);
	});

	void client.paseo.workspaces
		.list({ subscribe: {} })
		.then(({ entries }) => {
			for (const workspace of entries) register(workspace.id);
		})
		.catch((error) => {
			if (!stopped) console.error("[open-in-vscode] workspace list failed", error);
		});

	return () => {
		stopped = true;
		unsubscribe();
		for (const button of buttons.values()) button.remove();
		buttons.clear();
	};
}
