# paseo-plugins

Personal [Paseo](https://paseo.sh) plugins. Each subdirectory is one plugin.

| Plugin | Description | Install |
| --- | --- | --- |
| [`open-in-vscode`](./open-in-vscode) | Workspace header button that opens the workspace in VS Code | `paseo plugin add tskimmett/paseo-plugins:open-in-vscode` |

## Developing

```bash
cd <plugin>
npm install
npm run typecheck
paseo plugin install "$PWD"
```
