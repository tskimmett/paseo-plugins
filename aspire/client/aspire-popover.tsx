import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AspireResource, AspireResources, AspireStatus } from "../shared/aspire";

const RESOURCE_POLL_MS = 3_000;
const POPOVER_WIDTH = 340;

export type LinkTarget = { url: string; reason: null } | { url: null; reason: string };

export type PopoverModel = {
	subscribe(listener: () => void): () => void;
	getVersion(): number;
	getStatus(): AspireStatus;
	getResources(): AspireResources | null;
	refreshResources(): Promise<void>;
	resolve(url: string): LinkTarget;
	open(url: string): Promise<void>;
	stop(): Promise<void>;
};

const HIDDEN_STATES = new Set(["Hidden"]);

function displayHost(url: string) {
	const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(url);
	if (!match) return url;
	const [, host, path] = match;
	return path && path !== "/" ? `${host}${path}` : host;
}

function stateColor(theme: PluginTheme, state: string | null, health: string | null) {
	if (state === "Running" && (health === "Healthy" || health === null)) return theme.colors.statusSuccess;
	if (state === "Running") return theme.colors.statusWarning;
	if (state === "FailedToStart" || state === "Exited" || health === "Unhealthy") return theme.colors.statusDanger;
	if (state === "Starting" || state === "Waiting") return theme.colors.statusWarning;
	return theme.colors.foregroundMuted;
}

export function createAspirePopover(model: PopoverModel) {
	return function AspirePopover({ theme, close, layout }: PluginButtonContentProps) {
		useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion);
		const status = model.getStatus();
		const resources = model.getResources();
		const active = status.state !== "idle";
		const [actionError, setActionError] = useState<string | null>(null);
		const [stopping, setStopping] = useState(false);

		useEffect(() => {
			if (!active) return;
			let live = true;
			let cancel: (() => void) | null = null;
			const load = async () => {
				await model.refreshResources();
				if (!live) return;
				const handle = setTimeout(load, RESOURCE_POLL_MS);
				cancel = () => clearTimeout(handle);
			};
			void load();
			return () => {
				live = false;
				cancel?.();
			};
		}, [active]);

		const openLink = async (url: string) => {
			setActionError(null);
			try {
				await model.open(url);
				close();
			} catch (error) {
				setActionError(describeError(error));
			}
		};

		const onStop = async () => {
			setActionError(null);
			setStopping(true);
			try {
				await model.stop();
				close();
			} catch (error) {
				setActionError(describeError(error));
			} finally {
				setStopping(false);
			}
		};

		const dashboard = status.dashboardUrl ? model.resolve(status.dashboardUrl) : null;
		const visible = (resources?.resources ?? []).filter((resource) => !HIDDEN_STATES.has(resource.state ?? ""));

		return (
			<View style={layout.compact ? { gap: 8, alignSelf: "stretch" } : { gap: 8, width: POPOVER_WIDTH }}>
				<View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
					<View style={{ flexShrink: 1 }}>
						<Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>Aspire app host</Text>
						<Text style={{ color: statusColor(theme, status), fontSize: 12 }}>{statusText(status)}</Text>
					</View>
					{active ? (
						<Pressable
							accessibilityRole="button"
							onPress={onStop}
							disabled={stopping}
							style={({ pressed }) => ({
								paddingHorizontal: 10,
								paddingVertical: 6,
								borderRadius: 6,
								borderWidth: 1,
								borderColor: theme.colors.border,
								backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
								opacity: stopping ? 0.5 : 1,
							})}
						>
							<Text style={{ color: theme.colors.statusDanger, fontSize: 12, fontWeight: "600" }}>{stopping ? "Stopping…" : "Stop"}</Text>
						</Pressable>
					) : null}
				</View>

				{active ? (
					<LinkRow
						theme={theme}
						title="Dashboard"
						subtitle={dashboard?.url ? displayHost(status.dashboardUrl ?? dashboard.url) : dashboard?.reason ?? "Waiting for the dashboard URL…"}
						disabled={!dashboard?.url}
						onPress={() => (dashboard?.url ? openLink(status.dashboardUrl ?? dashboard.url) : undefined)}
						emphasized
					/>
				) : null}

				{active ? (
					<View style={{ gap: 4 }}>
						<View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 20 }}>
							<Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>Resources</Text>
							{resources === null ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
							{resources?.error && visible.length > 0 ? (
								<Text numberOfLines={1} style={{ color: theme.colors.statusWarning, fontSize: 11, flexShrink: 1 }}>
									stale: {resources.error}
								</Text>
							) : null}
						</View>
						{visible.length > 0 ? (
							<View style={{ gap: 2 }}>
								{visible.map((resource) => (
									<ResourceRow key={resource.name} theme={theme} resource={resource} resolve={model.resolve} onOpen={openLink} />
								))}
							</View>
						) : resources !== null && !resources.error ? (
							<Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No resources reported yet.</Text>
						) : null}
						{resources?.error && visible.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{resources.error}</Text> : null}
					</View>
				) : null}

				{status.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{status.error}</Text> : null}
				{actionError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{actionError}</Text> : null}
			</View>
		);
	};
}

function ResourceRow({
	theme,
	resource,
	resolve,
	onOpen,
}: {
	theme: PluginTheme;
	resource: AspireResource;
	resolve: (url: string) => LinkTarget;
	onOpen: (url: string) => Promise<void>;
}) {
	const color = stateColor(theme, resource.state, resource.health);
	return (
		<View style={{ gap: 2, paddingVertical: 2 }}>
			<View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
				<View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />
				<Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, flexShrink: 1 }}>
					{resource.displayName}
				</Text>
				<Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
					{resource.state ?? "Unknown"}
				</Text>
			</View>
			{resource.urls.map((entry) => {
				const target = resolve(entry.url);
				return (
					<LinkRow
						key={`${resource.name}:${entry.name}:${entry.url}`}
						theme={theme}
						title={entry.name === "default" ? displayHost(entry.url) : entry.name}
						subtitle={entry.name === "default" ? (target.url ? null : target.reason) : target.url ? displayHost(entry.url) : target.reason}
						disabled={!target.url}
						onPress={() => (target.url ? onOpen(entry.url) : undefined)}
						indent
					/>
				);
			})}
		</View>
	);
}

function LinkRow({
	theme,
	title,
	subtitle,
	disabled,
	onPress,
	emphasized = false,
	indent = false,
}: {
	theme: PluginTheme;
	title: string;
	subtitle: string | null;
	disabled: boolean;
	onPress: () => void | Promise<void>;
	emphasized?: boolean;
	indent?: boolean;
}) {
	return (
		<Pressable
			accessibilityRole="link"
			disabled={disabled}
			onPress={() => void onPress()}
			style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
				flexDirection: "row",
				alignItems: "center",
				gap: 8,
				paddingVertical: emphasized ? 8 : 5,
				paddingHorizontal: 8,
				marginLeft: indent ? 13 : 0,
				borderRadius: 6,
				backgroundColor: pressed || hovered ? theme.colors.surface2 : emphasized ? theme.colors.surface1 : "transparent",
				borderWidth: emphasized ? 1 : 0,
				borderColor: theme.colors.border,
				opacity: disabled ? 0.55 : 1,
			})}
		>
			<View style={{ flexShrink: 1, flexGrow: 1 }}>
				<Text numberOfLines={1} style={{ color: disabled ? theme.colors.foregroundMuted : theme.colors.accent, fontSize: 13, fontWeight: emphasized ? "600" : "400" }}>
					{title}
				</Text>
				{subtitle ? (
					<Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
						{subtitle}
					</Text>
				) : null}
			</View>
			{!disabled ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>↗</Text> : null}
		</Pressable>
	);
}

export function mergeResources(prev: AspireResources | null, next: AspireResources): AspireResources {
	const keepPrevious = prev !== null && prev.resources.length > 0 && next.resources.length === 0;
	const merged = keepPrevious ? { ...prev, error: next.error } : next;
	if (prev && prev.error === merged.error && sameResources(prev.resources, merged.resources)) return prev;
	return merged;
}

function sameResources(a: AspireResource[], b: AspireResource[]) {
	if (a.length !== b.length) return false;
	return a.every((resource, index) => {
		const other = b[index];
		return (
			resource.name === other.name &&
			resource.displayName === other.displayName &&
			resource.state === other.state &&
			resource.health === other.health &&
			resource.urls.length === other.urls.length &&
			resource.urls.every((entry, position) => entry.name === other.urls[position].name && entry.url === other.urls[position].url)
		);
	});
}

function statusText(status: AspireStatus) {
	if (status.state === "idle") return status.error ? "Stopped (last run failed)" : "Stopped";
	const via = status.source === "script" ? " via Paseo script" : status.source === "external" ? " (started outside Paseo)" : "";
	return `${status.state === "running" ? "Running" : "Starting"}${via}`;
}

function statusColor(theme: PluginTheme, status: AspireStatus) {
	if (status.state === "running") return theme.colors.statusSuccess;
	if (status.state === "starting") return theme.colors.statusWarning;
	return theme.colors.foregroundMuted;
}

export function describeError(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
