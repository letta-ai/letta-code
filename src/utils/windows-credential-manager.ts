import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const WINDOWS_CREDENTIAL_MAX_BLOB_BYTES = 2_560;
const WINDOWS_CREDENTIAL_TIMEOUT_MS = 10_000;

const WINDOWS_CREDENTIAL_SCRIPT = `
$ErrorActionPreference = 'Stop'

$inputJson = [Console]::In.ReadToEnd()
$request = $inputJson | ConvertFrom-Json

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class LettaCredentialNative {
  public const int CRED_TYPE_GENERIC = 1;
  public const int CRED_PERSIST_LOCAL_MACHINE = 2;

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

function Get-LettaCredentials([string]$service, $names) {
  $values = @{}
  foreach ($name in @($names)) {
    $nameString = [string]$name
    $target = Get-LettaCredentialTarget $service $nameString
    $values[$nameString] = Read-LettaCredentialBase64 $target
  }
  Write-LettaJson @{ ok = $true; valuesBase64 = $values }
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
    $credential.Persist = [uint32][LettaCredentialNative]::CRED_PERSIST_LOCAL_MACHINE
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
  if ($request.operation -eq 'probe') {
    Write-LettaJson @{ ok = $true; available = $true }
    exit 0
  }

  $target = Get-LettaCredentialTarget ([string]$request.service) ([string]$request.name)
  switch ([string]$request.operation) {
    'get' { Get-LettaCredential $target }
    'getMany' { Get-LettaCredentials ([string]$request.service) $request.names }
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

interface WindowsCredentialRequest {
  operation: "probe" | "get" | "getMany" | "set" | "delete";
  service?: string;
  name?: string;
  names?: string[];
  valueBase64?: string;
}

interface WindowsCredentialResponse {
  ok?: boolean;
  available?: boolean;
  valueBase64?: string | null;
  valuesBase64?: Record<string, string | null>;
  deleted?: boolean;
  error?: string;
}

let availabilityCache: boolean | null = null;

function findExecutableOnPath(executable: string): string | null {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  for (const path of paths) {
    if (!path) {
      continue;
    }

    const candidate = join(path, executable);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function getPowerShellPath(): string | null {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
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
    findExecutableOnPath("powershell.exe") ?? findExecutableOnPath("pwsh.exe")
  );
}

function parseCredentialResponse(stdout: string): WindowsCredentialResponse {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Windows Credential Manager command returned no output");
  }
  return JSON.parse(trimmed) as WindowsCredentialResponse;
}

async function runWindowsCredentialCommand(
  request: WindowsCredentialRequest,
): Promise<WindowsCredentialResponse> {
  if (process.platform !== "win32") {
    throw new Error("Windows Credential Manager is only available on Windows");
  }

  const powershellPath = getPowerShellPath();
  if (!powershellPath) {
    throw new Error("PowerShell is unavailable");
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        WINDOWS_CREDENTIAL_ENCODED_COMMAND,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("Windows Credential Manager command timed out"));
    }, WINDOWS_CREDENTIAL_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      try {
        const response = parseCredentialResponse(stdout);
        if (code === 0 && response.ok !== false) {
          resolve(response);
          return;
        }
        reject(
          new Error(
            response.error ||
              stderr.trim() ||
              `Windows Credential Manager command failed with exit code ${code}`,
          ),
        );
      } catch (error) {
        reject(
          new Error(
            stderr.trim() ||
              (error instanceof Error ? error.message : String(error)),
          ),
        );
      }
    });

    if (!child.stdin) {
      child.kill();
      reject(new Error("Windows Credential Manager command stdin unavailable"));
      return;
    }

    child.stdin.end(JSON.stringify(request));
  });
}

export async function isWindowsCredentialManagerAvailable(): Promise<boolean> {
  if (process.platform !== "win32") {
    return false;
  }
  if (availabilityCache !== null) {
    return availabilityCache;
  }

  try {
    const response = await runWindowsCredentialCommand({ operation: "probe" });
    availabilityCache = response.available === true;
  } catch {
    availabilityCache = false;
  }

  return availabilityCache;
}

export async function getWindowsCredential(
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

export async function getWindowsCredentials(
  service: string,
  names: string[],
): Promise<Record<string, string | null>> {
  const response = await runWindowsCredentialCommand({
    operation: "getMany",
    service,
    names,
  });
  const valuesBase64 = response.valuesBase64 ?? {};
  const values: Record<string, string | null> = {};

  for (const name of names) {
    const valueBase64 = valuesBase64[name];
    values[name] =
      valueBase64 === null || valueBase64 === undefined
        ? null
        : Buffer.from(valueBase64, "base64").toString("utf8");
  }

  return values;
}

export async function setWindowsCredential(
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

export async function deleteWindowsCredential(
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

export function __resetWindowsCredentialManagerAvailabilityForTests(): void {
  availabilityCache = null;
}
