export function renderLinuxAutostart(executablePath: string): string {
  const escapedPath = executablePath.replace(/([\\"`$])/g, "\\$1");
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Letta Daemon
Comment=Keep this computer available to Letta agents
Exec="${escapedPath}"
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}
