# aspire

A [Paseo](https://paseo.sh) plugin that adds an **Aspire** button to the header of every workspace that contains a .NET Aspire app host.

- **Idle**: pressing the button starts the app host on the daemon machine. It prefers `aspire run` when the Aspire CLI is on the daemon's `PATH` and falls back to `dotnet run --project <apphost.csproj>`.
- **Starting / running**: the button turns into a menu with **Open dashboard** and **Stop**. The dashboard login URL is parsed from the app host output and opened automatically for the client that pressed the button.

## Detection

The daemon walks the workspace directory (skipping `bin/`, `obj/`, `node_modules/`, `.git/`, max depth 6) and looks for, in order of preference: a `*.AppHost.csproj`, any `.csproj` that references `Aspire.Hosting.AppHost` or uses `Sdk="Aspire.AppHost.Sdk"`, then a single-file `apphost.cs` (or an `aspire.cs` with an `#:sdk Aspire.AppHost.Sdk` directive). Workspaces without a match get no button. Detection reruns when a workspace is upserted, at most once a minute per workspace.

## Running state

State lives on the daemon:

- App hosts launched by the plugin run detached in their own process group with stdout/stderr redirected to `~/.paseo/plugin-state/aspire/logs/<workspaceId>.log` on the daemon machine. Their PIDs and dashboard URLs are recorded in `~/.paseo/plugin-state/aspire/state.json`, so a plugin reload re-adopts them instead of losing track. (The daemon evaluates the server bundle in memory, so the plugin cannot locate its own source directory at runtime; the state therefore lives under the Paseo home instead.)
- App hosts started outside Paseo are found by scanning `/proc` for an `aspire` or `dotnet` process whose arguments reference the app host project, or whose working directory is inside the workspace and whose arguments include `run`/`watch`. For a detached `aspire run --log-file …` the login URL is read from that log; otherwise the dashboard process's `ASPNETCORE_URLS` and browser token environment are used. An external app host shows as running even before a dashboard URL is known; **Open dashboard** stays disabled until one is found.
- The login URL (`…/login?t=…`) always wins. Other candidate lines (`Dashboard:`, `Now listening on:`, `ASPNETCORE_URLS`, `ASPIRE_DASHBOARD_URL`) are only accepted after a TCP probe confirms something is listening, and the first confirmed one sticks.
- The client polls `aspire.status` every 3 seconds while a launch is in flight or an app host is running, and every 15 seconds while idle.

**Stop** sends `SIGTERM` to the process group (after `aspire stop --apphost …` for externally started hosts), then `SIGKILL` after 8 seconds.

## Limitations

- The Paseo plugin SDK (0.8.0) exposes no API for creating a Paseo browser tab; the daemon's browser tab broker is only reachable by agent MCP tools. The dashboard therefore opens through React Native `Linking.openURL`, which is the system browser on desktop/mobile and a new tab in the web app.
- External detection is Linux-only (`/proc`). On other platforms only plugin-launched app hosts are tracked.
- If several external app hosts exist for the same project (for example stale detached `aspire run` processes), the lowest-PID root process is tracked; **Stop** ends that one and the next poll picks up the remaining one.
- The dashboard URL for an external app host can only be recovered from its CLI log file or the dashboard process environment. If neither yields a URL, **Open dashboard** stays disabled.
- The dashboard login URL contains a token. It is never logged; only the fact that a URL was found is written to the plugin log.

## Install

```bash
paseo plugin add tskimmett/paseo-plugins:aspire
```

Or from a local checkout:

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/aspire
```

Plugins must be enabled on the daemon (Settings → Plugins → Enable plugins).

## Layout

- `shared/aspire.ts` – RPC contracts (`aspire.detect`, `aspire.launch`, `aspire.status`, `aspire.stop`) and the status schema
- `server/detect.ts` – app host discovery
- `server/process.ts` – spawning, log tailing, dashboard URL parsing, external detection, stop, state file
- `server/aspire.ts` – RPC handlers
- `client/header-button.ts` – per-workspace header button, state machine, polling
- `client/aspire-icon.tsx` – embedded Aspire logo
