import { afterEach, describe, expect, mock, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  __getDefaultServiceNameForTests,
  __getExplicitNodeSecretBackendForTests,
  __getSelectedSecretBackendKindForTests,
  __getWindowsCredentialScriptForTests,
  __resetSecretWarningStateForTests,
  __setSecretRuntimeOverrideForTests,
  deleteSecretValue,
  getSecretValue,
  isKeychainAvailable,
  setSecretValue,
  setServiceName,
} from "@/utils/secrets";

type BunSecretFixture = {
  get: (options: { service: string; name: string }) => Promise<string | null>;
  set: (options: {
    service: string;
    name: string;
    value: string;
    allowUnrestrictedAccess?: boolean;
  }) => Promise<void>;
  delete: (options: { service: string; name: string }) => Promise<boolean>;
};

const DEFAULT_SERVICE_NAME = __getDefaultServiceNameForTests();
const posixTest = process.platform === "win32" ? test.skip : test;
const macosTest = process.platform === "darwin" ? test : test.skip;
const tempDirs: string[] = [];
const bunSecretsForInterop = (
  globalThis as typeof globalThis & { Bun?: { secrets?: BunSecretFixture } }
).Bun?.secrets;
const explicitNodeBackendForInterop = __getExplicitNodeSecretBackendForTests();
const INTEROP_SERVICE_NAME = `letta-code-interop-${process.platform}-${randomUUID()}`;
const INTEROP_PROBE_NAME = `probe-${randomUUID()}`;
const interopAvailable = await computeInteropAvailable();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function fakeBunSecrets(
  overrides: Partial<BunSecretFixture> = {},
): BunSecretFixture {
  return {
    get: overrides.get ?? (async () => null),
    set: overrides.set ?? (async () => {}),
    delete: overrides.delete ?? (async () => false),
  };
}

async function computeInteropAvailable(): Promise<boolean> {
  if (!bunSecretsForInterop || !explicitNodeBackendForInterop) {
    return false;
  }

  try {
    await bunSecretsForInterop.get({
      service: INTEROP_SERVICE_NAME,
      name: INTEROP_PROBE_NAME,
    });
    return await explicitNodeBackendForInterop.isAvailable({
      service: INTEROP_SERVICE_NAME,
      name: INTEROP_PROBE_NAME,
    });
  } catch {
    return false;
  }
}

afterEach(() => {
  __setSecretRuntimeOverrideForTests(null);
  __resetSecretWarningStateForTests();
  setServiceName(DEFAULT_SERVICE_NAME);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Secret backend selection", () => {
  test("selects Bun secrets before platform fallbacks", () => {
    __setSecretRuntimeOverrideForTests({
      platform: "linux",
      bunSecrets: fakeBunSecrets(),
    });

    expect(__getSelectedSecretBackendKindForTests()).toBe("bun");
  });

  test("makes Bun-written macOS entries available to headless runtimes", async () => {
    const set = mock(async () => {});
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: fakeBunSecrets({ set }),
    });

    setServiceName(`letta-code-bun-access-${randomUUID()}`);
    await setSecretValue("api-key", "credential-value");

    expect(set).toHaveBeenCalledWith({
      service: expect.any(String),
      name: "api-key",
      value: "credential-value",
      allowUnrestrictedAccess: true,
    });
  });

  test("normalizes empty values to deletion across runtimes", async () => {
    const set = mock(async () => {});
    const remove = mock(async () => true);
    __setSecretRuntimeOverrideForTests({
      platform: "linux",
      bunSecrets: fakeBunSecrets({ set, delete: remove }),
    });

    setServiceName(`letta-code-empty-${randomUUID()}`);
    await setSecretValue("api-key", "");

    expect(set).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({
      service: expect.any(String),
      name: "api-key",
    });
  });

  test("selects explicit Node backends by platform when Bun is absent", () => {
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: null,
    });
    expect(__getSelectedSecretBackendKindForTests()).toBe("macos-keyring");

    __setSecretRuntimeOverrideForTests({ platform: "win32", bunSecrets: null });
    expect(__getSelectedSecretBackendKindForTests()).toBe(
      "windows-credential-manager",
    );

    __setSecretRuntimeOverrideForTests({ platform: "linux", bunSecrets: null });
    expect(__getSelectedSecretBackendKindForTests()).toBe(
      "linux-secret-service",
    );

    __setSecretRuntimeOverrideForTests({
      platform: "freebsd",
      bunSecrets: null,
    });
    expect(__getSelectedSecretBackendKindForTests()).toBe(null);
  });

  test("does not cache transient negative availability failures", async () => {
    let calls = 0;
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: fakeBunSecrets({
        get: async () => {
          calls += 1;
          if (calls === 1) {
            throw new Error("transient keychain failure");
          }
          return null;
        },
      }),
    });

    expect(await isKeychainAvailable()).toBe(false);
    expect(await isKeychainAvailable()).toBe(true);
    expect(calls).toBe(2);
  });

  test("honors LETTA_SKIP_KEYCHAIN_CHECK without probing", async () => {
    const originalSkip = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    const get = mock(async () => null);
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: fakeBunSecrets({ get }),
    });

    try {
      process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
      expect(await isKeychainAvailable()).toBe(false);
      expect(get).not.toHaveBeenCalled();
    } finally {
      if (originalSkip === undefined) {
        delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
      } else {
        process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkip;
      }
    }
  });

  test("preserves Bun duplicate-item replacement", async () => {
    const operations: string[] = [];
    let setCalls = 0;
    setServiceName(`letta-code-duplicate-test-${randomUUID()}`);
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: fakeBunSecrets({
        set: async (options) => {
          operations.push(`set:${options.name}`);
          setCalls += 1;
          if (setCalls === 1) {
            throw new Error("already exists in the keychain (code: -25299)");
          }
        },
        delete: async (options) => {
          operations.push(`delete:${options.name}`);
          return true;
        },
      }),
    });

    await setSecretValue("duplicate-name", "credential-value");

    expect(operations).toEqual([
      "set:duplicate-name",
      "delete:duplicate-name",
      "set:duplicate-name",
    ]);
  });
});

describe("Secret backend command protocols", () => {
  posixTest(
    "uses macOS security status and stdin without leaking values to argv",
    async () => {
      const dir = makeTempDir("letta-macos-security-");
      const securityPath = join(dir, "security");
      const argvLog = join(dir, "argv.log");
      const stdinLog = join(dir, "stdin.log");
      writeExecutable(
        securityPath,
        `#!/bin/sh
printf '%s\\n' "$@" > "$MACOS_ARGV_LOG"
case "$1" in
  add-generic-password)
    cat > "$MACOS_STDIN_LOG"
    exit 0
    ;;
  find-generic-password)
    case "$MACOS_TEST_MODE" in
      missing) echo 'item not found' >&2; exit 44 ;;
      denied) echo 'interaction not allowed' >&2; exit 51 ;;
      *) printf 'stored-value\\n'; exit 0 ;;
    esac
    ;;
  delete-generic-password)
    case "$MACOS_TEST_MODE" in
      missing) exit 44 ;;
      denied) echo 'interaction not allowed' >&2; exit 51 ;;
      *) exit 0 ;;
    esac
    ;;
esac
exit 2
`,
      );
      __setSecretRuntimeOverrideForTests({
        platform: "darwin",
        bunSecrets: null,
        bunExecutablePath: null,
        macSecurityPath: securityPath,
        env: {
          MACOS_ARGV_LOG: argvLog,
          MACOS_STDIN_LOG: stdinLog,
        },
      });
      const backend = __getExplicitNodeSecretBackendForTests("darwin");
      expect(backend).not.toBeNull();

      await backend?.set({
        service: "letta-code-test",
        name: "api-key",
        value: "credential-value",
      });
      const argvLogValue = readFileSync(argvLog, "utf8");
      expect(argvLogValue).toContain("add-generic-password");
      expect(argvLogValue).toContain("-A");
      expect(argvLogValue.trim().endsWith("-w")).toBe(true);
      expect(argvLogValue).not.toContain("credential-value");
      expect(readFileSync(stdinLog, "utf8")).toBe(
        "credential-value\ncredential-value\n",
      );

      expect(
        await backend?.get({ service: "letta-code-test", name: "api-key" }),
      ).toBe("stored-value");

      __setSecretRuntimeOverrideForTests({
        platform: "darwin",
        bunSecrets: null,
        bunExecutablePath: null,
        macSecurityPath: securityPath,
        env: {
          MACOS_ARGV_LOG: argvLog,
          MACOS_STDIN_LOG: stdinLog,
          MACOS_TEST_MODE: "missing",
        },
      });
      expect(
        await backend?.get({ service: "letta-code-test", name: "missing" }),
      ).toBeNull();
      expect(
        await backend?.delete({ service: "letta-code-test", name: "missing" }),
      ).toBe(false);

      __setSecretRuntimeOverrideForTests({
        platform: "darwin",
        bunSecrets: null,
        bunExecutablePath: null,
        macSecurityPath: securityPath,
        env: {
          MACOS_ARGV_LOG: argvLog,
          MACOS_STDIN_LOG: stdinLog,
          MACOS_TEST_MODE: "denied",
        },
      });
      await expect(
        backend?.get({ service: "letta-code-test", name: "api-key" }),
      ).rejects.toThrow("interaction not allowed");
      await expect(
        backend?.delete({ service: "letta-code-test", name: "api-key" }),
      ).rejects.toThrow("interaction not allowed");
      await expect(
        backend?.set({
          service: "letta-code-test",
          name: "api-key",
          value: "line-one\nline-two",
        }),
      ).rejects.toThrow("does not accept line breaks");
    },
  );

  posixTest(
    "runs Bun macOS migration outside project config scope",
    async () => {
      const projectDir = makeTempDir("letta-bun-project-");
      const bunDir = makeTempDir("letta-bun-bin-");
      const bunPath = join(bunDir, "bun");
      const cwdLog = join(projectDir, "cwd.log");
      const envLog = join(projectDir, "env.log");
      writeFileSync(
        join(projectDir, "bunfig.toml"),
        'preload = ["./bad.ts"]\n',
      );
      writeExecutable(
        bunPath,
        `#!/bin/sh
pwd > "$BUN_CWD_LOG"
printf '%s|%s|%s\\n' "$BUN_CONFIG" "$BUN_CONFIG_PATH" "$BUN_OPTIONS" > "$BUN_ENV_LOG"
printf '{"ok":true,"valueBase64":null}\\n'
`,
      );
      __setSecretRuntimeOverrideForTests({
        platform: "darwin",
        bunSecrets: null,
        bunExecutablePath: bunPath,
        macSecurityPath: null,
        env: {
          BUN_CWD_LOG: cwdLog,
          BUN_ENV_LOG: envLog,
          BUN_CONFIG: join(projectDir, "bunfig.toml"),
          BUN_CONFIG_PATH: join(projectDir, "bunfig.toml"),
          BUN_OPTIONS: "--preload ./bad.ts",
        },
      });
      const backend = __getExplicitNodeSecretBackendForTests("darwin");
      expect(backend).not.toBeNull();

      await backend?.get({ service: "letta-code-test", name: "api-key" });

      const helperCwd = readFileSync(cwdLog, "utf8").trim();
      expect(helperCwd).toContain("letta-bun-keychain-");
      expect(helperCwd).not.toBe(projectDir);
      expect(readFileSync(envLog, "utf8").trim()).toBe("||");
    },
  );

  posixTest(
    "uses secret-tool attrs and stdin without leaking values to argv",
    async () => {
      const dir = makeTempDir("letta-secret-tool-");
      const logPath = join(dir, "secret-tool.log");
      const service = `letta-code-linux-protocol-${randomUUID()}`;
      writeExecutable(
        join(dir, "secret-tool"),
        `#!/bin/sh
printf '%s\n' "$*" >> "$SECRET_TOOL_LOG"
if [ "$1" = "store" ]; then
  IFS= read -r stdin || true
  printf 'stdin-bytes:%s\n' "\${#stdin}" >> "$SECRET_TOOL_LOG"
  case "$*" in
    *credential-value*) exit 64 ;;
  esac
  exit 0
fi
if [ "$1" = "lookup" ]; then
  if [ "$5" = "missing-name" ]; then exit 1; fi
  printf '%s' 'lookup-value'
  exit 0
fi
if [ "$1" = "clear" ]; then
  exit 0
fi
exit 2
`,
      );
      setServiceName(service);
      __setSecretRuntimeOverrideForTests({
        platform: "linux",
        bunSecrets: null,
        env: {
          PATH: dir,
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/letta-fake-bus",
          SECRET_TOOL_LOG: logPath,
        },
      });

      await setSecretValue("secret-name", "credential-value");
      expect(await getSecretValue("secret-name", "test secret")).toBe(
        "lookup-value",
      );
      expect(await deleteSecretValue("secret-name")).toBe(true);
      expect(await getSecretValue("missing-name", "missing secret")).toBe(null);

      const log = readFileSync(logPath, "utf8");
      expect(log).toContain(
        `store --label ${service}/secret-name service ${service} account secret-name xdg:schema com.oven-sh.bun.Secret`,
      );
      expect(log).toContain(
        `lookup service ${service} account secret-name xdg:schema com.oven-sh.bun.Secret`,
      );
      expect(log).toContain(
        `clear service ${service} account secret-name xdg:schema com.oven-sh.bun.Secret`,
      );
      expect(log).toContain("stdin-bytes:16");
      expect(log).not.toContain("credential-value");
    },
  );

  posixTest("treats headless Linux Secret Service as unavailable", async () => {
    const dir = makeTempDir("letta-secret-tool-headless-");
    writeExecutable(join(dir, "secret-tool"), "#!/bin/sh\nexit 0\n");
    __setSecretRuntimeOverrideForTests({
      platform: "linux",
      bunSecrets: null,
      env: { PATH: dir, DBUS_SESSION_BUS_ADDRESS: "" },
    });

    expect(await isKeychainAvailable()).toBe(false);
  });

  posixTest(
    "sends Windows credential payloads on stdin, not argv",
    async () => {
      const dir = makeTempDir("letta-powershell-");
      const logPath = join(dir, "powershell.log");
      const stdinPath = join(dir, "powershell.stdin.json");
      const powershellPath = join(dir, "powershell.exe");
      writeExecutable(
        powershellPath,
        `#!/bin/sh
printf '%s\n' "$*" > "$POWERSHELL_LOG"
cat > "$POWERSHELL_STDIN"
printf '{"ok":true}\n'
`,
      );
      setServiceName(`letta-code-windows-protocol-${randomUUID()}`);
      __setSecretRuntimeOverrideForTests({
        platform: "win32",
        bunSecrets: null,
        powerShellPath: powershellPath,
        env: { POWERSHELL_LOG: logPath, POWERSHELL_STDIN: stdinPath },
      });

      await setSecretValue("win-name", "credential-value");

      const argvLog = readFileSync(logPath, "utf8");
      const stdinJson = readFileSync(stdinPath, "utf8");
      expect(argvLog).toContain("-EncodedCommand");
      expect(argvLog).not.toContain("credential-value");
      expect(stdinJson).not.toContain("credential-value");
      expect(stdinJson).toContain(
        Buffer.from("credential-value", "utf8").toString("base64"),
      );
    },
  );

  test("uses Windows enterprise-persist generic credentials", () => {
    const script = __getWindowsCredentialScriptForTests();
    expect(script).toContain("CRED_TYPE_GENERIC = 1");
    expect(script).toContain("CRED_PERSIST_ENTERPRISE = 3");
    expect(script).toContain('return "$service/$name"');
    expect(script).not.toContain("CRED_PERSIST_LOCAL_MACHINE");
  });
});

describe("Bun.secrets and explicit Node backend interoperability", () => {
  test("requires a working cross-runtime backend in platform CI", () => {
    if (!process.env.CI) return;
    expect(interopAvailable).toBe(true);
  });

  test.skipIf(!interopAvailable)(
    "reads and deletes the same OS entries both ways",
    async () => {
      if (!bunSecretsForInterop || !explicitNodeBackendForInterop) return;

      const bunToNodeName = `bun-to-node-${randomUUID()}`;
      const nodeToBunName = `node-to-bun-${randomUUID()}`;
      const bunToNodeValue = `test-secret-${randomUUID()}`;
      const nodeToBunValue = `test-secret-${randomUUID()}`;

      try {
        await Promise.allSettled([
          bunSecretsForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
          bunSecretsForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
          explicitNodeBackendForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
          explicitNodeBackendForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
        ]);

        await bunSecretsForInterop.set({
          service: INTEROP_SERVICE_NAME,
          name: bunToNodeName,
          value: bunToNodeValue,
        });
        expect(
          await explicitNodeBackendForInterop.get({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
        ).toBe(bunToNodeValue);
        expect(
          await explicitNodeBackendForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
        ).toBe(true);
        expect(
          await bunSecretsForInterop.get({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
        ).toBe(null);

        await explicitNodeBackendForInterop.set({
          service: INTEROP_SERVICE_NAME,
          name: nodeToBunName,
          value: nodeToBunValue,
        });
        expect(
          await bunSecretsForInterop.get({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
        ).toBe(nodeToBunValue);
        expect(
          await bunSecretsForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
        ).toBe(true);
        expect(
          await explicitNodeBackendForInterop.get({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
        ).toBe(null);
      } finally {
        await Promise.allSettled([
          bunSecretsForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
          bunSecretsForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
          explicitNodeBackendForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: bunToNodeName,
          }),
          explicitNodeBackendForInterop.delete({
            service: INTEROP_SERVICE_NAME,
            name: nodeToBunName,
          }),
        ]);
      }
    },
    30_000,
  );

  macosTest(
    "preserves legacy Bun entries across a real Node process boundary",
    async () => {
      if (!bunSecretsForInterop) return;
      const outputDir = makeTempDir("letta-node-secret-backend-");
      const build = await Bun.build({
        entrypoints: [join(process.cwd(), "src/utils/secret-backends.ts")],
        outdir: outputDir,
        target: "node",
        format: "esm",
      });
      expect(build.success).toBe(true);

      const moduleUrl = pathToFileURL(
        join(outputDir, "secret-backends.js"),
      ).href;
      const service = `letta-code-process-interop-${randomUUID()}`;
      const bunName = `from-bun-${randomUUID()}`;
      const nodeName = `from-node-${randomUUID()}`;
      const bunValue = `bun-value-${randomUUID()}`;
      const nodeValue = `node-value-${randomUUID()}`;

      try {
        // No allowUnrestrictedAccess flag: this models entries written before
        // the runtime-independent backend shipped.
        await bunSecretsForInterop.set({
          service,
          name: bunName,
          value: bunValue,
        });

        const node = spawnSync("node", ["--input-type=module"], {
          input: `
const { createExplicitNodeSecretBackend } = await import(process.env.MODULE_URL);
const backend = createExplicitNodeSecretBackend("darwin");
if (!backend) throw new Error("missing macOS backend");
const value = await backend.get({ service: process.env.SERVICE, name: process.env.BUN_NAME });
if (value !== process.env.BUN_VALUE) throw new Error("Bun-to-Node value mismatch");
await backend.set({ service: process.env.SERVICE, name: process.env.NODE_NAME, value: process.env.NODE_VALUE });
`,
          env: {
            ...process.env,
            MODULE_URL: moduleUrl,
            SERVICE: service,
            BUN_NAME: bunName,
            NODE_NAME: nodeName,
            BUN_VALUE: bunValue,
            NODE_VALUE: nodeValue,
          },
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(node.status, `${node.stdout}\n${node.stderr}`).toBe(0);

        const restartedNode = spawnSync("node", ["--input-type=module"], {
          input: `
const { createExplicitNodeSecretBackend } = await import(process.env.MODULE_URL);
const backend = createExplicitNodeSecretBackend("darwin");
if (!backend) throw new Error("missing macOS backend");
const bunValue = await backend.get({ service: process.env.SERVICE, name: process.env.BUN_NAME });
const nodeValue = await backend.get({ service: process.env.SERVICE, name: process.env.NODE_NAME });
if (bunValue !== process.env.BUN_VALUE) throw new Error("legacy value missing after restart");
if (nodeValue !== process.env.NODE_VALUE) throw new Error("Node value missing after restart");
if (!(await backend.delete({ service: process.env.SERVICE, name: process.env.BUN_NAME }))) {
  throw new Error("Node failed to delete the legacy Bun entry after restart");
}
if (!(await backend.delete({ service: process.env.SERVICE, name: process.env.NODE_NAME }))) {
  throw new Error("Node failed to delete its entry after restart");
}
`,
          env: {
            ...process.env,
            MODULE_URL: moduleUrl,
            SERVICE: service,
            BUN_NAME: bunName,
            NODE_NAME: nodeName,
            BUN_VALUE: bunValue,
            NODE_VALUE: nodeValue,
          },
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(
          restartedNode.status,
          `${restartedNode.stdout}\n${restartedNode.stderr}`,
        ).toBe(0);

        expect(
          await bunSecretsForInterop.get({ service, name: bunName }),
        ).toBeNull();
        expect(
          await bunSecretsForInterop.get({ service, name: nodeName }),
        ).toBeNull();
      } finally {
        await Promise.allSettled([
          bunSecretsForInterop.delete({ service, name: bunName }),
          bunSecretsForInterop.delete({ service, name: nodeName }),
          explicitNodeBackendForInterop?.delete({ service, name: bunName }),
          explicitNodeBackendForInterop?.delete({ service, name: nodeName }),
        ]);
      }
    },
    60_000,
  );
});
