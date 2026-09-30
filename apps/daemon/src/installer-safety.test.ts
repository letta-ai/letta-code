import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readInstaller(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${name}`, import.meta.url)),
    "utf8",
  );
}

test("shell installer uses release artifact names and exact macOS identity", () => {
  const installer = readInstaller("install.sh");

  expect(installer).toContain('if [ "$ARCH" = "x64" ]; then ARCH=x86_64; fi');
  expect(installer).toContain('ASSET="letta-daemon-linux-$ARCH.AppImage"');
  expect(installer).toContain('EXPECTED_MAC_TEAM_ID="Q3QJ94H24K"');
  expect(installer).toContain("pkill -KILL");
});

test("Windows installer pins the signer and launches after silent install", () => {
  const installer = readInstaller("install.ps1");

  expect(installer).toContain(
    'expectedSignerThumbprint = "C10BB76AD4EE815242406A1E3E1117FFEC743D4F"',
  );
  expect(installer).toContain('Get-Process -Name "Letta Daemon"');
  expect(installer).toContain('"/S", "--force-run"');
});
