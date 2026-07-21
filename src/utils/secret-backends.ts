import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SecretLocator {
  service: string;
  name: string;
}

export interface SecretSetOptions extends SecretLocator {
  value: string;
}

export type SecretBackendKind =
  | "bun"
  | "macos-keyring"
  | "windows-credential-manager"
  | "linux-secret-service";

export interface SecretBackend {
  kind: SecretBackendKind;
  get(options: SecretLocator): Promise<string | null>;
  set(options: SecretSetOptions): Promise<void>;
  delete(options: SecretLocator): Promise<boolean>;
  isAvailable(probe: SecretLocator): Promise<boolean>;
}

export interface BunSecretsLike {
  get(options: SecretLocator): Promise<string | null> | string | null;
  set(options: SecretSetOptions): Promise<void> | void;
  delete(options: SecretLocator): Promise<boolean> | boolean;
}

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

type KeyringModule = {
  Entry: new (service: string, name: string) => KeyringEntry;
};

type SecretRuntimeOverride = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  bunSecrets?: BunSecretsLike | null;
  powerShellPath?: string | null;
};

type SecretRuntime = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  bunSecrets: BunSecretsLike | null;
  powerShellPath?: string | null;
};

const SECRET_COMMAND_TIMEOUT_MS = 10_000;
const SECRET_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_CREDENTIAL_MAX_BLOB_BYTES = 2_560;
const BUN_LINUX_SECRET_SCHEMA = "com.oven-sh.bun.Secret";

const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'

$inputJson = [Console]::In.ReadToEnd()
$request = $inputJson | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class LettaCredentialNative {
  public const int CRED_TYPE_GENERIC = 1;
  public const int CRED_PERSIST_ENTERPRISE = 3;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr buffer);
}
"@

function Write-LettaJson($value) {
  $value | ConvertTo-Json -Compress -Depth 4
}

function Get-LettaCredentialTarget([string]$service, [string]$name) {
  return "$service/$name"
}

function Read-LettaCredentialBase64([string]$target) {
  $credentialPtr = [IntPtr]::Zero
  $ok = [LettaCredentialNative]::CredRead($target, [uint32][LettaCredentialNative]::CRED_TYPE_GENERIC, 0, [ref]$credentialPtr)
  if (-not $ok) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) {
      return $null
    }
    throw "CredRead failed with Windows error code $code"
  }

  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type][LettaCredentialNative+CREDENTIAL])
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    if ($bytes.Length -gt 0) {
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
    }
    return [Convert]::ToBase64String($bytes)
  } finally {
    if ($credentialPtr -ne [IntPtr]::Zero) {
      [LettaCredentialNative]::CredFree($credentialPtr)
    }
  }
}

function Get-LettaCredential([string]$target) {
  Write-LettaJson @{ ok = $true; valueBase64 = Read-LettaCredentialBase64 $target }
}

function Set-LettaCredential([string]$target, [string]$name, [string]$valueBase64) {
  $bytes = [Convert]::FromBase64String($valueBase64)
  $blob = [IntPtr]::Zero
  if ($bytes.Length -gt 0) {
    $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  }

  try {
    $credential = New-Object LettaCredentialNative+CREDENTIAL
    $credential.Flags = 0
    $credential.Type = [uint32][LettaCredentialNative]::CRED_TYPE_GENERIC
    $credential.TargetName = $target
    $credential.CredentialBlobSize = [uint32]$bytes.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = [uint32][LettaCredentialNative]::CRED_PERSIST_ENTERPRISE
    $credential.AttributeCount = 0
    $credential.Attributes = [IntPtr]::Zero
    $credential.TargetAlias = $null
    $credential.UserName = $name

    $ok = [LettaCredentialNative]::CredWrite([ref]$credential, 0)
    if (-not $ok) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "CredWrite failed with Windows error code $code"
    }

    Write-LettaJson @{ ok = $true }
  } finally {
    if ($blob -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
    }
  }
}

function Remove-LettaCredential([string]$target) {
  $ok = [LettaCredentialNative]::CredDelete($target, [uint32][LettaCredentialNative]::CRED_TYPE_GENERIC, 0)
  if (-not $ok) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($code -eq 1168) {
      Write-LettaJson @{ ok = $true; deleted = $false }
      return
    }
    throw "CredDelete failed with Windows error code $code"
  }

  Write-LettaJson @{ ok = $true; deleted = $true }
}

try {
  $target = Get-LettaCredentialTarget ([string]$request.service) ([string]$request.name)
  switch ([string]$request.operation) {
    'get' { Get-LettaCredential $target }
    'set' { Set-LettaCredential $target ([string]$request.name) ([string]$request.valueBase64) }
    'delete' { Remove-LettaCredential $target }
    default { throw "Unknown credential operation: $($request.operation)" }
  }
} catch {
  Write-LettaJson @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
`;

const WINDOWS_CREDENTIAL_ENCODED_COMMAND = Buffer.from(
  WINDOWS_CREDENTIAL_SCRIPT,
  "utf16le",
).toString("base64");

interface SecretCommandResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

interface WindowsCredentialRequest {
  operation: "get" | "set" | "delete";
  service: string;
  name: string;
  valueBase64?: string;
}

interface WindowsCredentialResponse {
  ok?: boolean;
  valueBase64?: string | null;
  deleted?: boolean;
  error?: string;
}

let runtimeOverrideForTests: SecretRuntimeOverride | null = null;

export function __setSecretRuntimeOverrideForTests(
  override: SecretRuntimeOverride | null,
): void {
  runtimeOverrideForTests = override;
}

export function __getWindowsCredentialScriptForTests(): string {
  return WINDOWS_CREDENTIAL_SCRIPT;
}

function getRuntimeBunSecrets(): BunSecretsLike | null {
  const runtime = globalThis as typeof globalThis & {
    Bun?: { secrets?: BunSecretsLike };
  };
  return runtime.Bun?.secrets ?? null;
}

function getRuntime(): SecretRuntime {
  const override = runtimeOverrideForTests;
  const env = { ...process.env, ...(override?.env ?? {}) };
  const bunSecrets =
    override && Object.hasOwn(override, "bunSecrets")
      ? (override.bunSecrets ?? null)
      : getRuntimeBunSecrets();

  return {
    platform: override?.platform ?? process.platform,
    env,
    bunSecrets,
    powerShellPath: override?.powerShellPath,
  };
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" ? value : undefined;
}

function appendOutputChunk(
  chunks: Buffer[],
  chunk: Buffer | string,
  currentBytes: number,
): { chunks: Buffer[]; bytes: number } {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  chunks.push(buffer);
  return { chunks, bytes: currentBytes + buffer.byteLength };
}

function runSecretCommand(
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
    windowsHide?: boolean;
  },
): Promise<SecretCommandResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: options.windowsHide,
    });

    const timeout = setTimeout(() => {
      fail(new Error("Secret storage command timed out"));
    }, options.timeoutMs ?? SECRET_COMMAND_TIMEOUT_MS);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(error);
    }

    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = appendOutputChunk(stdoutChunks, chunk, stdoutBytes);
      stdoutBytes = next.bytes;
      if (stdoutBytes > SECRET_COMMAND_MAX_OUTPUT_BYTES) {
        fail(new Error("Secret storage command stdout exceeded output limit"));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = appendOutputChunk(stderrChunks, chunk, stderrBytes);
      stderrBytes = next.bytes;
      if (stderrBytes > SECRET_COMMAND_MAX_OUTPUT_BYTES) {
        fail(new Error("Secret storage command stderr exceeded output limit"));
      }
    });

    child.on("error", (error) => {
      fail(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks),
      });
    });

    child.stdin.on("error", () => {
      // The close path reports the command failure; some tools close stdin early.
    });
    child.stdin.end(options.input ?? "");
  });
}

function findExecutableOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const pathValue = getEnvValue(env, "PATH") ?? getEnvValue(env, "Path") ?? "";
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function getPowerShellPath(runtime: SecretRuntime): string | null {
  if (runtime.powerShellPath !== undefined) {
    return runtime.powerShellPath;
  }

  const systemRoot = getEnvValue(runtime.env, "SystemRoot") || "C:\\Windows";
  const bundledPath = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  if (existsSync(bundledPath)) {
    return bundledPath;
  }

  return (
    findExecutableOnPath("powershell.exe", runtime.env) ??
    findExecutableOnPath("pwsh.exe", runtime.env)
  );
}

function commandError(
  commandName: string,
  operation: string,
  result: SecretCommandResult,
): Error {
  const stderr = result.stderr.toString("utf8").trim();
  const detail = stderr || `exit code ${result.code ?? "unknown"}`;
  return new Error(`${commandName} ${operation} failed: ${detail}`);
}

function createBunSecretBackend(bunSecrets: BunSecretsLike): SecretBackend {
  return {
    kind: "bun",
    get: async (options) => bunSecrets.get(options),
    set: async (options) => {
      await bunSecrets.set(options);
    },
    delete: async (options) => bunSecrets.delete(options),
    isAvailable: async (probe) => {
      await bunSecrets.get(probe);
      return true;
    },
  };
}

function isMacKeyringMissingError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error))
    .toLowerCase()
    .trim();
  return (
    message.includes("not found") ||
    message.includes("no entry") ||
    message.includes("no matching") ||
    message.includes("not exist") ||
    message.includes("could not find") ||
    message.includes("specified item could not be found") ||
    message.includes("code: -25300") ||
    message.includes("osstatus -25300")
  );
}

async function loadMacKeyringModule(): Promise<KeyringModule> {
  return (await import("@napi-rs/keyring")) as KeyringModule;
}

async function createMacKeyringEntry(
  service: string,
  name: string,
): Promise<KeyringEntry> {
  const { Entry } = await loadMacKeyringModule();
  return new Entry(service, name);
}

function createMacKeyringBackend(): SecretBackend {
  const backend: SecretBackend = {
    kind: "macos-keyring",
    get: async ({ service, name }) => {
      try {
        return (
          (await createMacKeyringEntry(service, name)).getPassword() ?? null
        );
      } catch (error) {
        if (isMacKeyringMissingError(error)) return null;
        throw error;
      }
    },
    set: async ({ service, name, value }) => {
      (await createMacKeyringEntry(service, name)).setPassword(value);
    },
    delete: async ({ service, name }) => {
      try {
        const deleted = (
          await createMacKeyringEntry(service, name)
        ).deletePassword();
        return deleted !== false;
      } catch (error) {
        if (isMacKeyringMissingError(error)) return false;
        throw error;
      }
    },
    isAvailable: async (probe) => {
      try {
        await backend.get(probe);
        return true;
      } catch {
        return false;
      }
    },
  };
  return backend;
}

async function runWindowsCredentialCommand(
  request: WindowsCredentialRequest,
): Promise<WindowsCredentialResponse> {
  const runtime = getRuntime();
  if (runtime.platform !== "win32") {
    throw new Error("Windows Credential Manager is only available on Windows");
  }

  const powershellPath = getPowerShellPath(runtime);
  if (!powershellPath) {
    throw new Error("PowerShell is unavailable");
  }

  const result = await runSecretCommand(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      WINDOWS_CREDENTIAL_ENCODED_COMMAND,
    ],
    {
      env: runtime.env,
      input: JSON.stringify(request),
      windowsHide: true,
    },
  );

  let response: WindowsCredentialResponse;
  try {
    const output = result.stdout.toString("utf8").trim();
    if (!output) {
      throw new Error("empty output");
    }
    response = JSON.parse(output) as WindowsCredentialResponse;
  } catch {
    throw commandError("Windows Credential Manager", request.operation, result);
  }

  if (result.code === 0 && response.ok !== false) {
    return response;
  }

  throw new Error(
    response.error ||
      result.stderr.toString("utf8").trim() ||
      `Windows Credential Manager ${request.operation} failed`,
  );
}

async function getWindowsCredential(
  service: string,
  name: string,
): Promise<string | null> {
  const response = await runWindowsCredentialCommand({
    operation: "get",
    service,
    name,
  });
  if (response.valueBase64 === null || response.valueBase64 === undefined) {
    return null;
  }
  return Buffer.from(response.valueBase64, "base64").toString("utf8");
}

async function setWindowsCredential(
  service: string,
  name: string,
  value: string,
): Promise<void> {
  const valueBuffer = Buffer.from(value, "utf8");
  if (valueBuffer.byteLength > WINDOWS_CREDENTIAL_MAX_BLOB_BYTES) {
    throw new Error(
      `Windows Credential Manager value is too large (${valueBuffer.byteLength} bytes; max ${WINDOWS_CREDENTIAL_MAX_BLOB_BYTES} bytes)`,
    );
  }

  await runWindowsCredentialCommand({
    operation: "set",
    service,
    name,
    valueBase64: valueBuffer.toString("base64"),
  });
}

async function deleteWindowsCredential(
  service: string,
  name: string,
): Promise<boolean> {
  const response = await runWindowsCredentialCommand({
    operation: "delete",
    service,
    name,
  });
  return response.deleted === true;
}

function createWindowsCredentialBackend(): SecretBackend {
  return {
    kind: "windows-credential-manager",
    get: ({ service, name }) => getWindowsCredential(service, name),
    set: ({ service, name, value }) =>
      setWindowsCredential(service, name, value),
    delete: ({ service, name }) => deleteWindowsCredential(service, name),
    isAvailable: async ({ service, name }) => {
      try {
        await getWindowsCredential(service, name);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function getSecretToolPath(runtime: SecretRuntime): string | null {
  return findExecutableOnPath("secret-tool", runtime.env);
}

function hasLinuxSecretServiceSession(runtime: SecretRuntime): boolean {
  return Boolean(getEnvValue(runtime.env, "DBUS_SESSION_BUS_ADDRESS")?.trim());
}

function linuxSecretServiceUnavailableError(): Error {
  return new Error(
    "Linux Secret Service is unavailable; DBUS_SESSION_BUS_ADDRESS and secret-tool are required",
  );
}

async function runSecretTool(
  args: string[],
  input?: string,
): Promise<SecretCommandResult> {
  const runtime = getRuntime();
  if (!hasLinuxSecretServiceSession(runtime)) {
    throw linuxSecretServiceUnavailableError();
  }

  const secretToolPath = getSecretToolPath(runtime);
  if (!secretToolPath) {
    throw linuxSecretServiceUnavailableError();
  }

  return runSecretCommand(secretToolPath, args, {
    env: runtime.env,
    input,
  });
}

async function lookupLinuxSecret(
  service: string,
  name: string,
): Promise<{ found: true; value: string } | { found: false }> {
  const result = await runSecretTool([
    "lookup",
    "service",
    service,
    "account",
    name,
    "xdg:schema",
    BUN_LINUX_SECRET_SCHEMA,
  ]);

  if (result.code === 0) {
    return { found: true, value: result.stdout.toString("utf8") };
  }

  if (
    result.code === 1 &&
    result.stdout.byteLength === 0 &&
    result.stderr.toString("utf8").trim() === ""
  ) {
    return { found: false };
  }

  throw commandError("secret-tool", "lookup", result);
}

function createLinuxSecretServiceBackend(): SecretBackend {
  return {
    kind: "linux-secret-service",
    get: async ({ service, name }) => {
      const result = await lookupLinuxSecret(service, name);
      return result.found ? result.value : null;
    },
    set: async ({ service, name, value }) => {
      const result = await runSecretTool(
        [
          "store",
          "--label",
          `${service}/${name}`,
          "service",
          service,
          "account",
          name,
          "xdg:schema",
          BUN_LINUX_SECRET_SCHEMA,
        ],
        value,
      );
      if (result.code !== 0) {
        throw commandError("secret-tool", "store", result);
      }
    },
    delete: async ({ service, name }) => {
      const existing = await lookupLinuxSecret(service, name);
      if (!existing.found) return false;

      const result = await runSecretTool([
        "clear",
        "service",
        service,
        "account",
        name,
        "xdg:schema",
        BUN_LINUX_SECRET_SCHEMA,
      ]);
      if (result.code === 0) return true;
      if (
        result.code === 1 &&
        result.stdout.byteLength === 0 &&
        result.stderr.toString("utf8").trim() === ""
      ) {
        return false;
      }
      throw commandError("secret-tool", "clear", result);
    },
    isAvailable: async (probe) => {
      const runtime = getRuntime();
      if (
        !hasLinuxSecretServiceSession(runtime) ||
        !getSecretToolPath(runtime)
      ) {
        return false;
      }

      try {
        await lookupLinuxSecret(probe.service, probe.name);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createExplicitNodeSecretBackend(
  platform: NodeJS.Platform = getRuntime().platform,
): SecretBackend | null {
  switch (platform) {
    case "darwin":
      return createMacKeyringBackend();
    case "win32":
      return createWindowsCredentialBackend();
    case "linux":
      return createLinuxSecretServiceBackend();
    default:
      return null;
  }
}

export function getSecretBackend(): SecretBackend | null {
  const runtime = getRuntime();
  if (runtime.bunSecrets) {
    return createBunSecretBackend(runtime.bunSecrets);
  }
  return createExplicitNodeSecretBackend(runtime.platform);
}

export function __getSelectedSecretBackendKindForTests(): SecretBackendKind | null {
  return getSecretBackend()?.kind ?? null;
}
