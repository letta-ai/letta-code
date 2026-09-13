import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = process.cwd();
let fixtureRoot: string | null = null;

function createFixtureRoot(prefix: string): void {
  fixtureRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
}

function writeFixtureFile(relativePath: string, contents: string): void {
  if (!fixtureRoot) throw new Error("fixture root not initialized");
  const filePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function sourceLines(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `const value${index} = ${index};`,
  ).join("\n");
}

async function runChecker(scriptName: string): Promise<{
  exitCode: number;
  output: string;
}> {
  if (!fixtureRoot) throw new Error("fixture root not initialized");
  const proc = Bun.spawn({
    cmd: ["node", join(repoRoot, "scripts", scriptName)],
    cwd: fixtureRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

function setSizeFixture(lines: number, baseline?: number): void {
  writeFixtureFile("src/example.ts", sourceLines(lines));
  writeFixtureFile(
    "scripts/source-file-size-baseline.json",
    `${JSON.stringify(
      baseline === undefined ? {} : { "src/example.ts": baseline },
      null,
      2,
    )}\n`,
  );
}

function setOwnershipFixture(adapterSource: string): void {
  writeFixtureFile("src/channels/slack/adapter.ts", adapterSource);
  writeFixtureFile(
    "src/channels/slack/plugin.ts",
    'import { createSlackAdapter } from "./adapter";\nvoid createSlackAdapter;\n',
  );
}

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

test("source size checker accepts a new file at the limit", async () => {
  createFixtureRoot("source-size-limit-");
  setSizeFixture(1000);

  const result = await runChecker("check-source-file-size.js");

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("maximum 1000 lines");
});

test("source size checker rejects a new oversized file", async () => {
  createFixtureRoot("source-size-oversized-");
  setSizeFixture(1001);

  const result = await runChecker("check-source-file-size.js");

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("1001 lines exceeds the 1000-line limit");
});

test("source size checker freezes and ratchets legacy baselines", async () => {
  createFixtureRoot("source-size-ratchet-");
  setSizeFixture(1002, 1002);
  expect((await runChecker("check-source-file-size.js")).exitCode).toBe(0);

  setSizeFixture(1003, 1002);
  const growth = await runChecker("check-source-file-size.js");
  expect(growth.exitCode).toBe(1);
  expect(growth.output).toContain("grew from the 1002-line baseline");

  setSizeFixture(1001, 1002);
  const shrink = await runChecker("check-source-file-size.js");
  expect(shrink.exitCode).toBe(1);
  expect(shrink.output).toContain("ratchet the baseline down");
});

test("module ownership checker permits the adapter's real entrypoints", async () => {
  createFixtureRoot("module-ownership-entrypoints-");
  setOwnershipFixture("export function createSlackAdapter(): void {}\n");

  const result = await runChecker("check-module-ownership.js");

  expect(result.exitCode).toBe(0);
});

test("module ownership checker rejects convenience adapter imports", async () => {
  createFixtureRoot("module-ownership-import-");
  setOwnershipFixture("export function createSlackAdapter(): void {}\n");
  writeFixtureFile(
    "src/channels/service.ts",
    'import { createSlackAdapter } from "./slack/adapter";\nvoid createSlackAdapter;\n',
  );

  const result = await runChecker("check-module-ownership.js");

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "import ./slack/adapter from its owning module",
  );
});

test("module ownership checker rejects forwarding adapter exports", async () => {
  createFixtureRoot("module-ownership-forwarding-");
  setOwnershipFixture(
    'export { resolveSlackAccountDisplayName } from "./account-display";\nexport function createSlackAdapter(): void {}\n',
  );
  writeFixtureFile(
    "src/channels/slack/account-display.ts",
    "export function resolveSlackAccountDisplayName(): string { return 'Slack'; }\n",
  );

  const result = await runChecker("check-module-ownership.js");

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("forwarding exports hide module ownership");
});
