# aspire

A [Paseo](https://paseo.sh) plugin that adds an **Aspire** button to the header of every workspace that contains a .NET Aspire app host.

- **Idle**: pressing the button starts the app host on the daemon machine. It prefers `aspire run` when the Aspire CLI is on the daemon's `PATH` and falls back to `dotnet run --project <apphost.csproj>`.
- **Starting / running**: the button opens a popover that shows the app host state, a **Dashboard** link, every resource reported by the app host with its state and endpoint URLs, and a **Stop** button. Only pressing a link opens a URL; launching the app host does not open one automatically. Resource links open directly, without going through the dashboard.

Paseo shows at most one plugin header button inline on phones and on windows narrower than 1100px (three otherwise); the rest move into the header's overflow menu in registration order. When another plugin such as *Open in VS Code* registers first, the Aspire button lands in that menu and its popover opens as a sub-page of it.

## Detection

The daemon walks the workspace directory (skipping `bin/`, `obj/`, `node_modules/`, `.git/`, max depth 6) and looks for, in order of preference: a `*.AppHost.csproj`, any `.csproj` that references `Aspire.Hosting.AppHost` or uses `Sdk="Aspire.AppHost.Sdk"`, then a single-file `apphost.cs` (or an `aspire.cs` with an `#:sdk Aspire.AppHost.Sdk` directive). Workspaces without a match get no button. Detection reruns when a workspace is upserted, at most once a minute per workspace.

## Running state

State lives on the daemon:

- App hosts launched by the plugin run detached in their own process group with stdout/stderr redirected to `~/.paseo/plugin-state/aspire/logs/<workspaceId>.log` on the daemon machine. Their PIDs and dashboard URLs are recorded in `~/.paseo/plugin-state/aspire/state.json`, so a plugin reload re-adopts them instead of losing track. (The daemon evaluates the server bundle in memory, so the plugin cannot locate its own source directory at runtime; the state therefore lives under the Paseo home instead.)
- App hosts started outside Paseo are found by scanning `/proc` for an `aspire` or `dotnet` process whose arguments reference the app host project, or whose working directory is inside the workspace and whose arguments include `run`/`watch`. For a detached `aspire run --log-file …` the login URL is read from that log; otherwise the dashboard process's `ASPNETCORE_URLS` and browser token environment are used. An external app host shows as running even before a dashboard URL is known; **Open dashboard** stays disabled until one is found.
- The login URL (`…/login?t=…`) always wins. Other candidate lines (`Dashboard:`, `Now listening on:`, `ASPNETCORE_URLS`, `ASPIRE_DASHBOARD_URL`) are only accepted after a TCP probe confirms something is listening, and the first confirmed one sticks.
- The client polls `aspire.status` every 3 seconds while a launch is in flight or an app host is running, and every 15 seconds while idle.
- While the popover is open the client polls `aspire.resources` every 3 seconds. The daemon answers it with `aspire describe --format json --apphost <project>` (needs the Aspire CLI), cached for 2 seconds so several clients share one run. Resources in the `Hidden` state and URLs flagged internal are omitted.

**Stop** sends `SIGTERM` to the process group (after `aspire stop --apphost …` for externally started hosts), then `SIGKILL` after 8 seconds.

## Mobile and remote clients (prototype)

An external URL opener on a phone opens `https://localhost:<port>/…` *on the phone*, so the default flow only works for clients on the daemon machine. The prototype in this tree adds an opt-in path that rides on Paseo's workspace-script service proxy:

1. Add an `aspire` service to the workspace's `paseo.json`. It must bind the dashboard to plain HTTP on the Paseo-assigned port, because the daemon proxy speaks HTTP to upstreams:

   ```json
   {
   	"scripts": {
   		"aspire": {
   			"type": "service",
   			"command": "sh -c \"ASPNETCORE_URLS=http://127.0.0.1:$PASEO_PORT ASPIRE_ALLOW_UNSECURED_TRANSPORT=true ASPIRE_DASHBOARD_FORWARDEDHEADERS_ENABLED=true exec aspire run --non-interactive --nologo\""
   		}
   	}
   }
   ```

2. When that script exists, **Launch** runs `paseo script start aspire` instead of spawning the app host directly, so the daemon registers a route for the dashboard port. The app host shows up as a supervised Paseo service; the dashboard URL and token are read from the dashboard process environment on the daemon.
3. On iOS/Android the client looks up the running service whose port matches the dashboard URL and opens `<publicProxyUrl>/login?t=…`. That URL only exists when the daemon has `daemon.serviceProxy.publicBaseUrl` set and a wildcard reverse proxy or tunnel (Cloudflare Tunnel, Caddy, nginx) in front of the daemon port. Without it the popover link is disabled with an explanation. The same mapping is applied to resource URLs: a loopback or `*.localhost` resource URL is only enabled on a phone when a running Paseo service exposes that port publicly. Desktop and web clients keep opening the local URL.

Known constraints of this path: the Aspire dashboard falls back to SignalR long polling because the daemon's main listener does not pass WebSocket upgrades through the service proxy; app resource links inside the dashboard stay `localhost` URLs and do not work from the phone; the only auth in front of the proxied dashboard is the Aspire browser token unless the tunnel adds its own.

## Limitations

- Paseo 0.9.0 or newer is required. Popovers do not receive `navigation.openBrowser`, so links use `openExternalUrl` from the popover: the system browser on Electron, a new tab in browser web, or the OS URL handler on mobile. For remote workspaces, `localhost` still means the client device.
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

- `shared/aspire.ts` – RPC contracts (`aspire.detect`, `aspire.launch`, `aspire.status`, `aspire.stop`, `aspire.resources`) and the status/resource schemas
- `server/detect.ts` – app host discovery
- `server/process.ts` – spawning, log tailing, dashboard URL parsing, external detection, stop, state file
- `server/aspire.ts` – RPC handlers
- `client/header-button.ts` – per-workspace header button, state machine, polling
- `client/aspire-popover.tsx` – popover content: state, dashboard link, resource list, stop
- `client/aspire-icon.tsx` – embedded Aspire logo
