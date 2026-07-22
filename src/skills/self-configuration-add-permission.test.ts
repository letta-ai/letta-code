import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, normalize } from "node:path";

const repoRoot = process.cwd();
const addPermissionScript = join(
  repoRoot,
  "src",
  "skills",
  "builtin",
  "self-configuration",
  "scripts",
  "add_permission.py",
);
const tempDirs: string[] = [];

function expectPathSuffix(value: unknown, suffixParts: string[]): void {
  expect(typeof value).toBe("string");
  expect(normalize(value as string).endsWith(join(...suffixParts))).toBe(true);
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runAddPermission(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete childEnv.HOME;
  delete childEnv.USERPROFILE;
  delete childEnv.HOMEDRIVE;
  delete childEnv.HOMEPATH;
  Object.assign(childEnv, env);
  if (env.HOME !== undefined && env.USERPROFILE === undefined) {
    childEnv.USERPROFILE = env.HOME;
  }

  const proc = Bun.spawn({
    cmd: ["python3", addPermissionScript, ...args],
    cwd: repoRoot,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
  }
});

test("add_permission refuses user-scope writes without confirmation", async () => {
  const root = makeTempDir("self-config-add-permission-user-");
  const homeDir = join(root, "home");
  const settingsPath = join(homeDir, ".letta", "settings.json");
  writeJson(settingsPath, { permissions: { allow: [] } });
  const before = readFileSync(settingsPath, "utf8");

  const result = await runAddPermission(
    ["--rule", "Bash(git status:*)", "--type", "allow", "--scope", "user"],
    { HOME: homeDir },
  );

  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--confirm-user-scope");
  expect(readFileSync(settingsPath, "utf8")).toBe(before);
});

test("add_permission preserves malformed JSON byte-for-byte", async () => {
  const root = makeTempDir("self-config-add-permission-malformed-");
  const cwd = join(root, "project");
  const settingsPath = join(cwd, ".letta", "settings.json");
  const malformed = '{"permissions": {"allow": [}\n';
  mkdirSync(join(cwd, ".letta"), { recursive: true });
  writeFileSync(settingsPath, malformed, "utf8");

  const result = await runAddPermission([
    "--rule",
    "Read(src/**)",
    "--type",
    "allow",
    "--scope",
    "project",
    "--cwd",
    cwd,
  ]);

  expect(result.stdout).toBe("");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Malformed JSON");
  expect(readFileSync(settingsPath, "utf8")).toBe(malformed);
});

test("add_permission dry run does not require user confirmation or write", async () => {
  const root = makeTempDir("self-config-add-permission-dry-run-");
  const homeDir = join(root, "home");
  const settingsPath = join(homeDir, ".letta", "settings.json");

  const result = await runAddPermission(
    [
      "--rule",
      "Bash(git diff:*)",
      "--type",
      "allow",
      "--scope",
      "user",
      "--dry-run",
    ],
    { HOME: homeDir },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({
    scope: "user",
    type: "allow",
    rule: "Bash(git diff:*)",
    would_add: true,
  });
  expectPathSuffix(output.path, [
    basename(root),
    "home",
    ".letta",
    "settings.json",
  ]);
  expect(() => readFileSync(settingsPath, "utf8")).toThrow();
});

test("add_permission confirmed user write succeeds and preserves file mode", async () => {
  const root = makeTempDir("self-config-add-permission-confirmed-");
  const homeDir = join(root, "home");
  const settingsPath = join(homeDir, ".letta", "settings.json");
  writeJson(settingsPath, { permissions: { allow: [] } });
  chmodSync(settingsPath, 0o640);
  const beforeMode = statSync(settingsPath).mode & 0o777;

  const result = await runAddPermission(
    [
      "--rule",
      "Bash(git diff:*)",
      "--type",
      "allow",
      "--scope",
      "user",
      "--confirm-user-scope",
    ],
    { HOME: homeDir },
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
    permissions: { allow: ["Bash(git diff:*)"] },
  });
  expect(statSync(settingsPath).mode & 0o777).toBe(beforeMode);
});
