import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawn } from "node:child_process";
import { focusVsCodeWindow, isWsl } from "./focus";
import { openInVsCodeRpc } from "../shared/open";

const CODE_BIN = process.env.PASEO_VSCODE_BIN ?? "code";

export async function openInVsCode(
	{ workspaceId }: RpcInput<typeof openInVsCodeRpc>,
	{ paseo }: PluginHandlerContext,
) {
	const workspace = paseo.workspaces.ref(workspaceId);
	await workspace.refresh();
	const directory = workspace.directory;
	if (!directory) {
		throw new Error(`Workspace ${workspaceId} has no directory`);
	}
	await launch(directory);
	if (isWsl()) void focusVsCodeWindow(directory);
	return { directory };
}

function launch(directory: string) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(CODE_BIN, [directory], {
			detached: true,
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		child.once("error", (error: Error) => {
			reject(new Error(`Failed to start ${CODE_BIN}: ${error.message}`));
		});
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
