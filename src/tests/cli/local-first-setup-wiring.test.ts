import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

describe("local-first setup wiring", () => {
  test("setup menu offers local mode and persists that choice", () => {
    const source = readSource("../../auth/setup-ui.tsx");

    expect(source).toContain('const LOCAL_MODE_LABEL = "Proceed locally"');
    expect(source).toContain(
      'const AUTH_LOGIN_LABEL = "Login to Constellation"',
    );
    expect(source).toContain(
      "const [selectedOption, setSelectedOption] = useState(1)",
    );
    expect(source).toContain('configureBackendMode("local")');
    expect(source).toContain(
      'settingsManager.updateSettings({ preferredBackendMode: "local" })',
    );
    expect(source).toContain("letta --backend api");
    expect(source).toContain("Agents you create are local to this");
    expect(source).toContain("chat.letta.com");
    expect(source).toContain("Welcome to Letta Code.");
    expect(source).not.toContain("Welcome to Letta Code!");
    expect(source).not.toContain("How do you want to start?");
    expect(source).not.toContain("Choose where your agents should live");
  });

  test("successful cloud login records the api backend preference", () => {
    const source = readSource("../../auth/setup-ui.tsx");
    const start = source.indexOf("settingsManager.updateSettings({");
    const end = source.indexOf("await settingsManager.flush();", start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('preferredBackendMode: "api"');
  });

  test("startup honors saved local preference only when cloud credentials are absent", () => {
    const source = readSource("../../index.ts");
    const start = source.indexOf('settings.preferredBackendMode === "local"');
    const end = source.indexOf('configureBackendMode("local")', start);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const segment = source.slice(start - 120, end + 60);
    expect(segment).toContain("!explicitBackendMode");
    expect(segment).toContain("baseURL === LETTA_CLOUD_API_URL");
    expect(segment).toContain("!apiKey");
    expect(segment).toContain("!settings.refreshToken");
  });
});
