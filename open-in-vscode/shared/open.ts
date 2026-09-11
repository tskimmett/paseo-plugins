import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const openInVsCodeRpc = defineRpc({
	name: "vscode.open",
	input: z.object({ workspaceId: z.string() }),
	output: z.object({ directory: z.string() }),
});
