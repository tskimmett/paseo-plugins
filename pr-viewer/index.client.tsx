import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePrPill } from "./client/pr-pill";

export default function contribute(client: PluginClientContext) {
	return contributePrPill(client);
}
