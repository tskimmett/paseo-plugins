# paseo-open-vscode

A [Paseo](https://paseo.sh) plugin that adds an **Open in VS Code** button to the workspace header.

Pressing it launches `code <workspace directory>` on the daemon machine. On WSL it also brings the VS Code window to the foreground, since Windows otherwise opens it behind Paseo.

## Install

```bash
paseo plugin add tskimmett/paseo-open-vscode
```

Or from a local checkout:

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-open-vscode
```

Plugins must be enabled on the daemon (Settings → Plugins → Enable plugins).

## Configuration

Set `PASEO_VSCODE_BIN` in the daemon's environment to use a different launcher, such as `code-insiders` or `cursor`. Defaults to `code` from the daemon's `PATH`.

## Layout

- `shared/open.ts` – RPC contract
- `server/open.ts` – launches VS Code for the workspace directory
- `server/focus.ts` – WSL-only window activation via PowerShell
- `client/header-button.ts` – registers the header button per workspace
- `client/vscode-icon.tsx` – embedded VS Code logo
