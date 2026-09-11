import { execFile } from "node:child_process";
import { basename } from "node:path";

const ACTIVATE_SCRIPT = `
param([string]$Needle)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
	[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
	[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$shell = New-Object -ComObject WScript.Shell
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
	$proc = Get-Process Code -ErrorAction SilentlyContinue |
		Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Needle*" } |
		Select-Object -First 1
	if ($proc) {
		$h = $proc.MainWindowHandle
		if ([Win32]::IsIconic($h)) { [Win32]::ShowWindow($h, 9) | Out-Null }
		$shell.SendKeys('%')
		[Win32]::SetForegroundWindow($h) | Out-Null
		$shell.AppActivate($proc.Id) | Out-Null
		exit 0
	}
	Start-Sleep -Milliseconds 250
}
exit 1
`;

export function isWsl() {
	return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

export function focusVsCodeWindow(directory: string) {
	const needle = basename(directory);
	return new Promise<void>((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ACTIVATE_SCRIPT, "-Needle", needle],
			{ timeout: 20_000, windowsHide: true },
			(error) => {
				if (error) console.error(`[open-in-vscode] focus failed for "${needle}": ${error.message}`);
				resolve();
			},
		);
	});
}
