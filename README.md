# paseo-plugins

Personal [Paseo](https://paseo.sh) plugins. Each subdirectory is one plugin.

| Plugin | Description | Install |
| --- | --- | --- |
| [`open-in-vscode`](./open-in-vscode) | Workspace header button that opens the workspace in VS Code | `paseo plugin add tskimmett/paseo-plugins:open-in-vscode` |
| [`aspire`](./aspire) | Workspace header button that launches the workspace's .NET Aspire app host, opens the dashboard, and stops it | `paseo plugin add tskimmett/paseo-plugins:aspire` |

## Developing

```bash
cd <plugin>
npm install
npm run typecheck
paseo plugin install "$PWD"
```
