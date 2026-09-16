# Aspire dashboard from the Paseo mobile app: investigation report

Uncommitted working note, 2026-09-13. Companion to the uncommitted prototype in this directory (see "Prototype" below). Everything marked **verified** was exercised on this machine (WSL2 Ubuntu, Paseo 0.8.0, Aspire CLI 13.5.3, .NET 10.0.110). Everything marked *inferred* comes from reading daemon source or docs without running it.

## Verdict

There is no way today for a phone connected through the Paseo relay to reach the Aspire dashboard without the user adding a public HTTP entry point to the daemon. The relay carries only the daemon WebSocket protocol; Paseo's own workspace-service links have the same gap (verified in the client bundle). The one path that fits Paseo's design is:

1. run the app host as a Paseo workspace **service** so the daemon registers a proxy route for the dashboard port,
2. bind the dashboard to plain HTTP on the Paseo-assigned port,
3. have the daemon expose services publicly via `daemon.serviceProxy.publicBaseUrl` behind a wildcard tunnel or reverse proxy,
4. have the plugin open `<publicProxyUrl>/login?t=<token>` on iOS/Android.

Steps 1, 2 and 4 are prototyped and typecheck. Step 3 is the user's infrastructure and was not set up here (it needs a `config.json` edit and DNS). Two upstream Paseo issues limit the result: WebSocket upgrades do not pass through the service proxy on the main daemon port (the dashboard falls back to long polling, verified), and plugins cannot register routes or start scripts through the SDK (the prototype shells out to `paseo script start`).

## Verified facts

| Area | Finding | How verified |
| --- | --- | --- |
| Relay | Relay transport (`relay-transport.js`) frames only `ping/pong/sync/connected/disconnected` plus the E2EE daemon socket. File downloads travel as binary WebSocket frames (`FileTransferOpcode`), not HTTP. No HTTP tunnelling exists. | Read daemon and client dist |
| Service proxy | Host-header reverse proxy on the daemon's own listener (`service-proxy.js`). Routes are `<script>--<branch>--<project>.localhost:6767`, registered only by the workspace-script launcher. Upstream is always `http://127.0.0.1:<port>`. | Read source; `paseo script ls --json` |
| Proxy HTTP | Query strings and `x-forwarded-host/proto/port` pass through. | `curl` through a registered route |
| Proxy HTTPS upstream | Returns `502 Bad Gateway` (pointed a route at the live Cognito dashboard port 46633). | `curl` |
| Proxy WebSocket | Broken on the main listener: `websocket-server.js` creates `new WebSocketServer({ server, path: "/ws" })`; the `ws` library (8.21.3) answers every non-`/ws` upgrade with `400 Bad Request` even though the proxy handler also pipes it. Only `/ws` paths "work", with a doubled 101. | Raw upgrade requests direct vs via proxy; ws source |
| Blazor fallback | Through the proxy the Aspire dashboard logs "Failed to connect via WebSockets, using the Long Polling fallback" and renders (resource list visible). | Opened in a Paseo browser tab, read console/network logs |
| Aspire HTTP dashboard | `ASPNETCORE_URLS=http://localhost:18899 ASPIRE_ALLOW_UNSECURED_TRANSPORT=true aspire run …` prints `Dashboard: http://localhost:18899/login?t=<32 hex>`. The port is served by Aspire's DCP proxy; the dashboard process itself binds another random port and gets `DASHBOARD__FRONTEND__PUBLICURL=http://localhost:18899`. | Throwaway app host under `/tmp/aspire-probe` |
| Dashboard behind proxy | Login redirects relative to the forwarded host; auth cookies set; root returns 200; unauthenticated root redirects to `/login`. | `curl` via proxy |
| Token source | Dashboard env has `DASHBOARD__FRONTEND__BROWSERTOKEN` and `DASHBOARD__FRONTEND__PUBLICURL`; the existing `discoverExternalUrl` read `ASPNETCORE_URLS` (internal bind) instead of `PUBLICURL`. | `/proc/<pid>/environ` |
| Cognito app host | `Program.cs` sets `ASPIRE_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS=true`, so its dashboard runs with `AuthMode=Unsecured` (no token). Resource links are custom `https://<worktree>.localhost/` Caddy hostnames set via `WithUrls`. | Read source and live env |
| Client link logic | `resolveWorkspaceScriptLink` in the app bundle offers `public` (publicProxyUrl), `paseo` (`*.localhost:6767`) and `direct` (`http://<daemon-host>:<port>` only for `directTcp` connections, else `http://localhost:<port>`). Over relay only `public` can work. | Read web bundle |
| Public base URL | `daemon.serviceProxy.publicBaseUrl` / `PASEO_SERVICE_PROXY_PUBLIC_BASE_URL` builds `https://<label>.<base-host>`; not configured here. Plugins cannot read it (`MutableDaemonConfig` has no `serviceProxy`). Workspace payloads do include `scripts[].publicProxyUrl`, so the client can pick it up. | Read source and typings |
| Port plan | Adding a service to `paseo.json` after the workspace has a port plan fails with "missing from workspace service port plan" until a new workspace is created. Cause: `ensureWorkspaceServicePortPlan` returns the cached in-memory plan without merging new services; the plan is released only on workspace archive (or daemon restart). | Observed twice; source read by subagent |
| Script execution | Workspace script commands are not run with `sh -c`. The daemon opens the user's `$SHELL` interactively (no args) in a PTY and types `<command>\r` into it, so `$PASEO_PORT` expands in that shell and rc files run. | Source (`worktree-bootstrap.js`, `terminal/terminal.js`) read by subagent |
| WSL network | NAT mode, WSL `172.31.182.202`, Windows Wi-Fi `192.168.1.12`, no `netsh portproxy`, daemon bound to `127.0.0.1:6767`. No Tailscale on WSL or Windows. `cloudflared` 2025.8.1 is installed on Windows with two idle named tunnels (`bbb-dev`, `opencode`). | `wslinfo`, `ipconfig.exe`, `netsh.exe`, `cloudflared.exe tunnel list` |
| Tunnel tools | WSL has none of `cloudflared`, `ngrok`, `tailscale`, `devtunnel`; `caddy` is present. | `command -v` |
| Plugin client | `Platform.OS` from react-native is available; `PluginHostProps.layout.platform` exists on icon/content props only. No connection-type API is exposed to plugins. | SDK typings |

## Ranked approaches

### 1. Paseo service route + public base URL (recommended)

Mechanism: `paseo.json` defines an `aspire` service whose command binds the dashboard to `http://127.0.0.1:$PASEO_PORT` with `ASPIRE_ALLOW_UNSECURED_TRANSPORT=true` and `ASPIRE_DASHBOARD_FORWARDEDHEADERS_ENABLED=true`. The daemon registers `aspire--<branch>--<project>.localhost:6767` and, with `publicBaseUrl`, `https://aspire--<branch>--<project>.<base-host>`. The plugin opens `<publicProxyUrl>/login?t=<token>` on the phone.

- URL the phone opens: `https://aspire--<branch>--<project>.<base-host>/login?t=<token>`.
- Token: survives (query string forwarded, verified locally on the `.localhost` route).
- WebSockets: **no** on the main listener (upstream bug); Blazor falls back to long polling and works, with higher latency. A standalone proxy listener (`daemon.serviceProxy.listen`) has no `ws` server attached and should pass upgrades (*inferred*); untested because it needs a daemon restart.
- Resource links: **no**. Cognito's `https://<worktree>.localhost/` links and Aspire's default `localhost` endpoint URLs stay unreachable from the phone.
- User infrastructure: `daemon.serviceProxy.publicBaseUrl`, `daemon.hostnames` for the base domain, and a wildcard-host tunnel or reverse proxy to `127.0.0.1:6767`. The Windows `cloudflared` install plus an existing Cloudflare account makes a named tunnel with `*.paseo.<domain>` the natural choice; add Cloudflare Access, because the proxied dashboard is otherwise protected only by the browser token, and Cognito's app host disables even that.
- Verified: everything except the public hostname hop and the phone itself (no `publicBaseUrl` configured, no phone in the loop).
- Plugin changes (prototyped): `shared/aspire.ts` +1 enum value; `server/process.ts` about +70 lines (script-mode launch via `paseo script start`, `PUBLICURL` preference, dashboard match by `ASPIRE_CLI_PID`, capture helper, pending state); `server/aspire.ts` 1 line; `client/header-button.ts` about +60 lines (workspace `scripts` tracking, `resolveDashboardTarget`, `Platform.OS` gate, disabled menu item with reason); `README.md` section. Follow-ups before merging: persist the script-launched set so a plugin reload keeps `source: "script"`, and decide whether script mode should also be used for **Stop** of app hosts started from the Paseo scripts UI.

### 2. Plugin-managed tunnel of the dashboard port

Mechanism: spawn `cloudflared tunnel --url http://127.0.0.1:<dcp-port>` (quick tunnel) or `devtunnel host -p <port>` next to the app host and hand the tunnel URL to the client. Works over any connection, WebSockets pass, no Paseo config.

- Cons: publishes the dashboard on the internet behind only the browser token (none for Cognito); needs a tunnel binary on the daemon host (none in WSL today; `cloudflared.exe` on Windows cannot see WSL loopback without extra forwarding); quick tunnels are rate limited and unauthenticated; resource links still `localhost`.
- Not prototyped. *Inferred* from tool docs. Worth offering as an opt-in setting only if the user accepts the exposure.

### 3. LAN or VPN bind

Mechanism: switch WSL to mirrored networking or add `netsh interface portproxy`, bind the dashboard (or the daemon) to a LAN/Tailscale address, and open `http://<host-ip>:<port>/login?t=…` from a phone on the same network or tailnet.

- Cons: not available here (NAT mode, no Tailscale, daemon on loopback, Windows firewall). Only helps when the phone shares the network. The plugin still needs to know the reachable address; no API exposes it, so it would be a plugin setting.
- Verified only that the prerequisites are absent.

### 4. Aspire Dev Tunnels integration

`Aspire.Hosting.DevTunnels` (`AddDevTunnel`, `WithReference`, `WithAnonymousAccess`) exposes **resource endpoints**, not the dashboard (docs). It needs `devtunnel` CLI and a Microsoft login and requires app host code changes per project. Useful only as the answer for resource links, and not for Cognito, whose `WithUrls` overrides would not be rewritten. Not installed, not prototyped.

### 5. Relay-carried HTTP (upstream only)

Nothing in relay, hub or the app carries HTTP to daemon ports. This is the only approach that would work with zero user infrastructure and belongs in an upstream feature request.

## Client-side detection

`Platform.OS` (`react-native`) is `ios`/`android` on phones and `web` on desktop and browser. The prototype gates on that. The real distinction is connection type (relay vs direct), which the SDK does not expose; a laptop on the relay also cannot open `localhost`, and a phone on Tailscale direct TCP could. Logged below as an upstream ask.

## Prototype status

Files touched, uncommitted: `shared/aspire.ts`, `server/process.ts`, `server/aspire.ts`, `client/header-button.ts`, `README.md`, this file. `npm run typecheck` passes; the client audit is clean.

- Verified by harness (see "Harness run" below).
- Not verified: the in-app button on a phone, the public hostname hop, the client-side `resolveDashboardTarget` in a running app (typecheck only), the disabled-item wording in the header menu.

## Harness run

The server module was compiled to CommonJS under `/tmp/aspire-proto-out` and driven directly (the plugin RPCs cannot be invoked from the CLI). Throwaway workspace `wks_d320ad3809df4491` on `/tmp/aspire-probe` with the `paseo.json` above.

- `launch()` detected the `aspire` service, ran `paseo script start aspire`, returned `state: "starting", source: "script"`, and the next `refresh()` adopted the app host (`source: "script"`, PID of the Aspire CLI). **Verified.**
- The command typed into the script terminal expanded `$PASEO_PORT` (34531 on the second run); the CLI printed `Dashboard: http://127.0.0.1:34531/login?t=…`. **Verified** via terminal capture.
- The dashboard process env carried `DASHBOARD__FRONTEND__PUBLICURL=http://127.0.0.1:34531` and the browser token. **Verified.**
- First run: no dashboard URL after 180 s. Cause: Aspire 13.5 daemonises DCP (its parent becomes PID 652), so the dashboard is not a descendant of the app host and the descendant scan in `discoverExternalUrl` never sees it. This also affects externally started app hosts today. Fixed in the prototype by matching any dashboard whose `ASPIRE_CLI_PID` is in the tracked tree; second run found the login URL on the first `refresh()`. **Verified.**
- `paseo script ls --json` listed the `aspire` route on the same port as the dashboard URL (`http://aspire--aspire-probe-46fd8d82.localhost:6767`, `publicProxyUrl: null` because no `publicBaseUrl` is configured). Login through that route returned 302 to `/` with auth cookies. **Verified.**
- `stop()` ended the app host; `paseo script stop` is used when the instance was adopted as `script` in the same process. In the harness the second process saw it as `external` and used signals, leaving the shell terminal alive until `paseo script stop` was run by hand. **Verified**, with that caveat.
- Plugin state file was backed up before and restored after each harness run.

## Upstream requests for Paseo

1. Service proxy WebSocket passthrough on the main listener: `ws` server with `path: "/ws"` on the same `http.Server` returns 400 for proxied upgrades. Fix by using `noServer: true` and dispatching upgrades manually, or by short-circuiting in the proxy handler.
2. Plugin SDK: a way to register a service route for an arbitrary local port (or start/stop workspace scripts) so plugins do not need `paseo.json` edits and CLI shell-outs.
3. Expose `serviceProxy.publicBaseUrl` (or the resolved `publicProxyUrl`) to plugins in `MutableDaemonConfig` or the workspace payload docs; today only `scripts[].publicProxyUrl` carries it.
4. Expose the active connection kind (relay, directTcp, local) to plugin clients so URL choice does not have to guess from `Platform.OS`.
5. Rebuild the workspace service port plan when `paseo.json` gains a service, instead of failing until the workspace is recreated.
6. Longer term: relay-carried HTTP for service proxy URLs so mobile works with no user infrastructure.

## Throwaway artifacts

`/tmp/aspire-probe` (app host, harness, logs) and `/tmp/paseo-proxy-probe` (proxy echo server, `paseo.json`). Throwaway Paseo workspaces created for them are archived at the end of the session; PID 1895909 from the brief was already gone when the session started and the live Cognito app host (PID tree 3740357 → 3741675) was left untouched.
