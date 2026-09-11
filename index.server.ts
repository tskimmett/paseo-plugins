import type { PluginServerContext } from "@getpaseo/plugin/server";
import { openInVsCode } from "./server/open";
import { openInVsCodeRpc } from "./shared/open";

export default function contribute(server: PluginServerContext) {
	server.handle(openInVsCodeRpc, openInVsCode);
	return () => {};
}
