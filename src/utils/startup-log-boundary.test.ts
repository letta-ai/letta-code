import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const unixDescribe = process.platform === "win32" ? describe.skip : describe;
const token = "12345678-1234-4567-89ab-123456789abc";
const marker = `\n[letta-startup-end:${token}]\n`;
let directory: string;
let source: string;
let bundle: string;

beforeAll(async () => {
  directory = await mkdtemp(join(root, ".startup-boundary-test-"));
  source = join(directory, "probe.ts");
  bundle = join(directory, "probe.js");
  await writeFile(
    source,
    `import { sealStartupLogs } from "@/utils/startup-log-boundary";
import { writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

assert.equal(process.env.LETTA_STARTUP_LOG_MARKER, undefined);
assert.equal(process.env.LETTA_STARTUP_LOG_OWNER_PID, undefined);
if (process.argv[2] === "owned-child") {
  // Intentionally omit env: Bun inherits both original env vars despite deletion.
  const code = 'const raw = { marker: process.env.LETTA_STARTUP_LOG_MARKER, owner: process.env.LETTA_STARTUP_LOG_OWNER_PID }; import(' + JSON.stringify(process.argv[3]) + ').then(({ sealStartupLogs }) => { sealStartupLogs(); sealStartupLogs(); if (process.env.LETTA_STARTUP_LOG_MARKER !== undefined || process.env.LETTA_STARTUP_LOG_OWNER_PID !== undefined) throw new Error("env not consumed"); process.stdout.write(JSON.stringify(raw)); });';
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  // Any marker emitted by the child makes this JSON parse fail.
  const raw = JSON.parse(child.stdout);
  if (process.versions.bun) {
    assert.equal(raw.marker, "${token}");
    assert.equal(raw.owner, String(process.pid));
  } else {
    assert.deepEqual(raw, {});
  }
  writeSync(1, "child did not seal\\n");
}
const args = ["-e", 'process.stdout.write(JSON.stringify([process.env.LETTA_STARTUP_LOG_MARKER, process.env.LETTA_STARTUP_LOG_OWNER_PID]))'];
// Explicit-env sync and default async children observe both env deletions.
const child = spawnSync(process.execPath, args, { encoding: "utf8", env: process.env });
assert.equal(child.stdout, "[null,null]");
const asyncChild = spawn(process.execPath, args);
let inherited = "";
asyncChild.stdout.on("data", (data) => { inherited += data; });
await new Promise((resolve) => asyncChild.on("close", resolve));
assert.equal(inherited, "[null,null]");
if (process.argv[2] !== "failure") writeSync(1, "startup stdout");
writeSync(2, "\\nstartup stderr\\n");
if (process.argv[2] === "failure" || process.argv[2] === "invalid") {
  let first;
  try { sealStartupLogs(); } catch (error) { first = error; }
  assert.ok(first);
  assert.throws(() => sealStartupLogs(), (error) => error === first);
  writeSync(2, "blocked twice\\n");
} else {
  sealStartupLogs();
  writeSync(2, "user stderr\\n");
  process.env.LETTA_STARTUP_LOG_MARKER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  process.env.LETTA_STARTUP_LOG_OWNER_PID = String(process.pid);
  sealStartupLogs();
  writeSync(1, "user stdout\\n");
}
`,
  );
  const result = await Bun.build({
    entrypoints: [source],
    outdir: directory,
    naming: "probe.js",
    target: "node",
    format: "esm",
  });
  expect(result.success).toBe(true);
  const boundaryBuild = await Bun.build({
    entrypoints: [join(root, "src/utils/startup-log-boundary.ts")],
    outdir: directory,
    naming: "boundary.js",
    target: "node",
    format: "esm",
  });
  expect(boundaryBuild.success).toBe(true);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const runtime of ["bun", "node"]) {
  unixDescribe(`${runtime} process startup boundary`, () => {
    function run(mode: string, value?: string, owner?: string) {
      const env = { ...process.env };
      delete env.LETTA_STARTUP_LOG_MARKER;
      delete env.LETTA_STARTUP_LOG_OWNER_PID;
      if (value !== undefined) env.LETTA_STARTUP_LOG_MARKER = value;
      if (owner !== undefined && owner !== "self") {
        env.LETTA_STARTUP_LOG_OWNER_PID = owner;
      }
      // Both descriptors point at the SAME pipe, as in a Cloud launch.
      const result = spawnSync(
        "sh",
        [
          "-c",
          (owner === "self" ? "export LETTA_STARTUP_LOG_OWNER_PID=$$; " : "") +
            (mode === "failure"
              ? 'exec "$@" 2>&1 1</dev/null'
              : 'exec "$@" 2>&1'),
          "probe",
          runtime,
          runtime === "bun" ? source : bundle,
          mode,
          runtime === "bun"
            ? join(root, "src/utils/startup-log-boundary.ts")
            : join(directory, "boundary.js"),
        ],
        { cwd: directory, env, encoding: "utf8", timeout: 20_000 },
      );
      expect(result.error).toBeUndefined();
      if (result.status !== 0) throw new Error(result.stdout);
      return result.stdout;
    }

    test("writes exact one-shot marker synchronously ahead of either output stream", () => {
      expect(run("normal", token)).toBe(
        `startup stdout\nstartup stderr\n${marker}user stderr\nuser stdout\n`,
      );
    });

    test("the exec owner's matching PID seals even after a default spawnSync child", () => {
      expect(run("owned-child", token, "self")).toBe(
        `child did not seal\nstartup stdout\nstartup stderr\n${marker}user stderr\nuser stdout\n`,
      );
    });

    test.each([token, "invalid-uuid"])(
      "a different owner ignores marker %j entirely",
      (value) => {
        expect(run("normal", value, "9007199254740991")).toBe(
          "startup stdout\nstartup stderr\nuser stderr\nuser stdout\n",
        );
      },
    );

    test.each([
      "",
      "0",
      "-1",
      "01",
      "1.5",
      "1e2",
      "1\n",
      " 1",
      "NaN",
      "9007199254740992",
    ])("malformed owner %j blocks content with a sticky failure", (owner) => {
      expect(run("invalid", token, owner)).toBe(
        "startup stdout\nstartup stderr\nblocked twice\n",
      );
    });

    test("malformed owner without a marker still fails closed", () => {
      expect(run("invalid", undefined, "invalid-owner")).toBe(
        "startup stdout\nstartup stderr\nblocked twice\n",
      );
    });

    test("does nothing without opt-in, including a late env assignment", () => {
      expect(run("normal")).toBe(
        "startup stdout\nstartup stderr\nuser stderr\nuser stdout\n",
      );
    });

    test("a real unwritable output descriptor blocks content and stays failed", () => {
      expect(run("failure", token, "self")).toBe(
        "\nstartup stderr\nblocked twice\n",
      );
    });

    test.each(["", "not-a-uuid", `${token}\nforged`])(
      "invalid opt-in %j fails closed without reflecting its value",
      (value) => {
        expect(run("invalid", value, "self")).toBe(
          "startup stdout\nstartup stderr\nblocked twice\n",
        );
      },
    );
  });
}
