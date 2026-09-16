import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const appHostSchema = z.object({
	directory: z.string(),
	projectPath: z.string(),
	kind: z.enum(["csproj", "single-file"]),
});

export const aspireStatusSchema = z.object({
	state: z.enum(["idle", "starting", "running"]),
	source: z.enum(["plugin", "script", "external"]).nullable(),
	pid: z.number().nullable(),
	dashboardUrl: z.string().nullable(),
	startedAt: z.string().nullable(),
	error: z.string().nullable(),
});

export const aspireResourceSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	type: z.string(),
	state: z.string().nullable(),
	health: z.string().nullable(),
	urls: z.array(z.object({ name: z.string(), url: z.string() })),
});

export const aspireResourcesSchema = z.object({
	resources: z.array(aspireResourceSchema),
	updatedAt: z.string().nullable(),
	error: z.string().nullable(),
});

export type AppHost = z.infer<typeof appHostSchema>;
export type AspireStatus = z.infer<typeof aspireStatusSchema>;
export type AspireResource = z.infer<typeof aspireResourceSchema>;
export type AspireResources = z.infer<typeof aspireResourcesSchema>;

const workspaceInput = z.object({ workspaceId: z.string() });

export const detectAspireRpc = defineRpc({
	name: "aspire.detect",
	input: workspaceInput,
	output: z.object({ appHost: appHostSchema.nullable() }),
});

export const launchAspireRpc = defineRpc({
	name: "aspire.launch",
	input: workspaceInput,
	output: aspireStatusSchema,
});

export const aspireStatusRpc = defineRpc({
	name: "aspire.status",
	input: workspaceInput,
	output: aspireStatusSchema,
});

export const stopAspireRpc = defineRpc({
	name: "aspire.stop",
	input: workspaceInput,
	output: aspireStatusSchema,
});

export const aspireResourcesRpc = defineRpc({
	name: "aspire.resources",
	input: workspaceInput,
	output: aspireResourcesSchema,
});

export const EMPTY_RESOURCES: AspireResources = { resources: [], updatedAt: null, error: null };

export const IDLE_STATUS: AspireStatus = {
	state: "idle",
	source: null,
	pid: null,
	dashboardUrl: null,
	startedAt: null,
	error: null,
};
