import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repoRoot = process.cwd();
const checkerPath = join(repoRoot, "scripts", "check-test-mock-isolation.js");

let fixtureRoot: string | null = null;

function writeFixtureFile(relativePath: string, contents: string): void {
  if (!fixtureRoot) {
    throw new Error("fixture root not initialized");
  }
  const filePath = join(fixtureRoot, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

async function runChecker(): Promise<{
  exitCode: number;
  output: string;
}> {
  if (!fixtureRoot) {
    throw new Error("fixture root not initialized");
  }

  const proc = Bun.spawn({
    cmd: [process.execPath, "run", checkerPath],
    cwd: fixtureRoot,
    env: {
      ...process.env,
      LETTA_MOCK_ISOLATION_TESTS_DIR: join(fixtureRoot, "src", "tests"),
    },
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

afterEach(() => {
  if (fixtureRoot) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = null;
  }
});

test("mock isolation checker allows scoped mocks with restore hooks", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mock-isolation-ok-"));
  writeFixtureFile(
    "src/tests/scoped.test.ts",
    `import { afterEach, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

test("uses a scoped mock", () => {
  mock.module("../../safe/module", () => ({ value: 1 }));
});
`,
  );

  const result = await runChecker();

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("No unsafe mock.module() usage found");
});

test("mock isolation checker rejects mocks without restore hooks", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mock-isolation-no-restore-"));
  writeFixtureFile(
    "src/tests/leaky.test.ts",
    `import { mock, test } from "bun:test";

test("leaks", () => {
  mock.module("../../safe/module", () => ({ value: 1 }));
});
`,
  );

  const result = await runChecker();

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "missing: top-level afterEach/afterAll mock.restore() hook",
  );
});

test("mock isolation checker rejects forbidden shared module mocks", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mock-isolation-forbidden-"));
  writeFixtureFile(
    "src/tests/channels/config-leak.test.ts",
    `import { afterEach, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

test("mocks shared channel config", () => {
  mock.module("../../channels/config", () => ({ getChannelDir: () => "/tmp" }));
});
`,
  );

  const result = await runChecker();

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "forbidden shared module mock: ../../channels/config",
  );
  expect(result.output).toContain("__testOverrideChannelsRoot");
});

test("mock isolation checker rejects new top-level internal mocks", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mock-isolation-top-level-"));
  writeFixtureFile(
    "src/tests/new-top-level.test.ts",
    `import { afterAll, mock, test } from "bun:test";

mock.module("../../some/internal", () => ({ value: 1 }));

afterAll(() => {
  mock.restore();
});

test("uses top-level mock", () => {});
`,
  );

  const result = await runChecker();

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "unsafe top-level internal module mock: ../../some/internal",
  );
});

test("mock isolation checker rejects partial channel runtime mocks", async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "mock-isolation-partial-"));
  writeFixtureFile(
    "src/channels/telegram/runtime.ts",
    `export async function loadGrammyModule() {}
export function isTelegramRuntimeInstalled() { return true; }
export async function installTelegramRuntime() {}
export async function ensureTelegramRuntimeInstalled() { return false; }
`,
  );
  writeFixtureFile(
    "src/tests/channels/partial-runtime.test.ts",
    `import { afterEach, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

test("partially mocks runtime", () => {
  mock.module("../../channels/telegram/runtime", () => ({
    loadGrammyModule: async () => ({}),
  }));
});
`,
  );

  const result = await runChecker();

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "partial channel runtime mock: ../../channels/telegram/runtime",
  );
  expect(result.output).toContain("isTelegramRuntimeInstalled");
  expect(result.output).toContain("ensureTelegramRuntimeInstalled");
});
