import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AppHost } from "../shared/aspire";

const SKIP_DIRECTORIES = new Set(["bin", "obj", "node_modules", ".git"]);
const MAX_DEPTH = 6;
const APP_HOST_MARKER = /Aspire\.Hosting\.AppHost|Sdk="Aspire\.AppHost\.Sdk/;
const SINGLE_FILE_MARKER = /#:sdk\s+Aspire\.AppHost\.Sdk|Aspire\.Hosting\.AppHost/;

type Candidate = AppHost & { depth: number; named: boolean };

export async function findAppHost(root: string): Promise<AppHost | null> {
	const candidates: Candidate[] = [];
	await walk(root, 0, candidates);
	if (candidates.length === 0) return null;
	candidates.sort((a, b) => {
		if (a.kind !== b.kind) return a.kind === "csproj" ? -1 : 1;
		if (a.named !== b.named) return a.named ? -1 : 1;
		if (a.depth !== b.depth) return a.depth - b.depth;
		return a.projectPath.localeCompare(b.projectPath);
	});
	const { depth: _depth, named: _named, ...appHost } = candidates[0];
	return appHost;
}

async function walk(directory: string, depth: number, out: Candidate[]) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}
	const subdirectories: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRECTORIES.has(entry.name) && depth < MAX_DEPTH) subdirectories.push(path);
			continue;
		}
		if (!entry.isFile()) continue;
		const candidate = await classify(path, depth);
		if (candidate) out.push(candidate);
	}
	await Promise.all(subdirectories.map((path) => walk(path, depth + 1, out)));
}

async function classify(path: string, depth: number): Promise<Candidate | null> {
	const name = basename(path);
	const directory = join(path, "..");
	if (name.endsWith(".csproj")) {
		const named = /\.AppHost\.csproj$/i.test(name);
		if (named) return { directory, projectPath: path, kind: "csproj", depth, named };
		if (await matches(path, APP_HOST_MARKER)) {
			return { directory, projectPath: path, kind: "csproj", depth, named: false };
		}
		return null;
	}
	if (name === "apphost.cs" || name === "aspire.cs") {
		if (name === "apphost.cs" || (await matches(path, SINGLE_FILE_MARKER))) {
			return { directory, projectPath: path, kind: "single-file", depth, named: name === "apphost.cs" };
		}
	}
	return null;
}

async function matches(path: string, pattern: RegExp) {
	try {
		const content = await readFile(path, "utf8");
		return pattern.test(content);
	} catch {
		return false;
	}
}
