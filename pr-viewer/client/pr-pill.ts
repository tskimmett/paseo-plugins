import { openExternalUrl } from "@getpaseo/plugin/client";
import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";

const VIEWER_BASE_URL = "https://proud-mud-03aa2ab0f.6.azurestaticapps.net";
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

type PullRequest = { url: string; number?: number };
type Pill = { registration: PluginButtonRegistration; viewerUrl: string };

/** Maps a GitHub PR URL to the same owner/repo/pull/number path on the custom viewer. */
export function viewerUrlFor(pullRequest: PullRequest) {
	let pathname: string;
	try {
		pathname = new URL(pullRequest.url).pathname;
	} catch {
		return null;
	}
	const match = PR_PATH.exec(pathname);
	return match ? `${VIEWER_BASE_URL}/${match[1]}/${match[2]}/pull/${match[3]}` : null;
}

export function contributePrPill(client: PluginClientContext) {
	const pullRequests = new Map<string, PullRequest>();
	const agents = new Map<string, string>();
	const pills = new Map<string, Pill>();
	const lifetime = new AbortController();

	const describe = (viewerUrl: string, number: number | undefined) => ({
		title: "Open pull request in viewer",
		icon: "GitPullRequest",
		label: number === undefined ? "PR" : `PR #${number}`,
		behavior: { kind: "action" as const, onPress: () => openExternalUrl(viewerUrl) },
	});

	const reconcile = (agentId: string) => {
		const workspaceId = agents.get(agentId);
		const pullRequest = workspaceId ? pullRequests.get(workspaceId) : undefined;
		const viewerUrl = pullRequest ? viewerUrlFor(pullRequest) : null;
		const existing = pills.get(agentId);
		if (!workspaceId || !pullRequest || !viewerUrl) {
			existing?.registration.remove();
			pills.delete(agentId);
			return;
		}
		if (existing?.viewerUrl === viewerUrl) return;
		existing?.registration.remove();
		const registration = client.addComposerPill({
			id: "pr-viewer",
			workspaceId,
			agentId,
			button: describe(viewerUrl, pullRequest.number),
		});
		pills.set(agentId, { registration, viewerUrl });
	};

	const reconcileWorkspace = (workspaceId: string) => {
		for (const [agentId, agentWorkspaceId] of agents) {
			if (agentWorkspaceId === workspaceId) reconcile(agentId);
		}
	};

	const setPullRequest = (workspaceId: string, pullRequest: PullRequest | null | undefined) => {
		if (pullRequest) pullRequests.set(workspaceId, pullRequest);
		else pullRequests.delete(workspaceId);
		reconcileWorkspace(workspaceId);
	};

	const removeAgent = (agentId: string) => {
		agents.delete(agentId);
		reconcile(agentId);
	};

	let releaseWorkspaces: (() => Promise<void> | void) | null = null;

	const observe = async () => {
		const [workspaceList, agentList] = await Promise.all([
			client.paseo.workspaces.list({ subscribe: {} }),
			client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }),
		]);
		releaseWorkspaces = () => workspaceList.subscription?.release();
		if (lifetime.signal.aborted) return releaseWorkspaces();
		workspaceList.subscription?.subscribe({
			snapshot: ({ entries }) => {
				const current = new Set(entries.map((workspace) => workspace.id));
				for (const workspaceId of [...pullRequests.keys()]) {
					if (!current.has(workspaceId)) setPullRequest(workspaceId, null);
				}
				for (const workspace of entries) setPullRequest(workspace.id, workspace.githubRuntime?.pullRequest);
			},
			update: (message) => {
				if (message.type !== "workspace_update") return;
				const update = message.payload;
				if (update.kind === "upsert") setPullRequest(update.workspace.id, update.workspace.githubRuntime?.pullRequest);
				else setPullRequest(update.id, null);
			},
		});
		agentList.subscription?.subscribe({
			snapshot: ({ entries }) => {
				const current = new Set(entries.map(({ agent }) => agent.id));
				for (const agentId of [...agents.keys()]) {
					if (!current.has(agentId)) removeAgent(agentId);
				}
				for (const { agent } of entries) {
					if (!agent.workspaceId) continue;
					agents.set(agent.id, agent.workspaceId);
					reconcile(agent.id);
				}
			},
			update: (message) => {
				if (message.type !== "agent_update") return;
				const update = message.payload;
				if (update.kind === "upsert") {
					if (!update.agent.workspaceId) return removeAgent(update.agent.id);
					agents.set(update.agent.id, update.agent.workspaceId);
					reconcile(update.agent.id);
				} else removeAgent(update.agentId);
			},
		});
	};

	observe().catch((error) => {
		if (!lifetime.signal.aborted) console.error("PR pill observation failed", error);
	});

	return () => {
		lifetime.abort();
		void releaseWorkspaces?.();
		for (const pill of pills.values()) pill.registration.remove();
		pills.clear();
	};
}
