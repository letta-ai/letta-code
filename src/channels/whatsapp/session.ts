import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { QrCodeTerminalModule } from "./runtime";
import { loadQrCodeTerminalModule, loadWhatsAppModule } from "./runtime";
import { setWhatsAppConnectionState } from "./state";

const SUPPRESSED_PATTERNS = [
  /^Failed to decrypt message with any known session/,
  /^Session error:/,
  /^Closing open session in favor of incoming prekey bundle/,
  /^Closing session: SessionEntry/,
  /bad mac/i,
];

let filtersInstalled = false;
let suppressContinuation = false;

function shouldDropLine(line: unknown): boolean {
  if (typeof line !== "string") return false;
  if (SUPPRESSED_PATTERNS.some((pattern) => pattern.test(line))) {
    suppressContinuation = true;
    return true;
  }
  if (!suppressContinuation) return false;
  if (line.length === 0) {
    suppressContinuation = false;
    return true;
  }
  if (/^\s+at /.test(line)) return true;
  if (/^\s/.test(line) || line.startsWith("{") || line.startsWith("}"))
    return true;
  suppressContinuation = false;
  return false;
}

export function installWhatsAppConsoleFilters(): void {
  if (filtersInstalled) return;
  filtersInstalled = true;

  const originalError = globalThis.console.error;
  const originalWarn = globalThis.console.warn;
  globalThis.console.error = (...args) => {
    if (shouldDropLine(args[0])) return;
    originalError.apply(globalThis.console, args);
  };
  globalThis.console.warn = (...args) => {
    if (shouldDropLine(args[0])) return;
    originalWarn.apply(globalThis.console, args);
  };

  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]) => {
    try {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const lines = text.split("\n");
      const kept = lines.filter((line) => !shouldDropLine(line));
      if (kept.length === 0) return true;
      return originalStderrWrite(kept.join("\n"), ...(rest as []));
    } catch {
      return originalStderrWrite(chunk as never, ...(rest as []));
    }
  };
}

export function getWhatsAppAuthDir(accountId: string): string {
  return join(homedir(), ".letta", "channels", "whatsapp", "auth", accountId);
}

type WhatsAppSocket = {
  ev?: {
    on?: (event: string, handler: (payload?: unknown) => void) => void;
  };
  ws?: { close?: () => void };
  user?: { id?: string; lid?: string };
};

type WhatsAppRuntimeRecord = Record<string, unknown>;

type WhatsAppConnectionUpdate = Record<string, unknown> & {
  qr?: string;
  connection?: string;
  lastDisconnect?: {
    error?: {
      message?: string;
      output?: { statusCode?: number };
    };
  };
};

type WhatsAppAuthState = {
  creds: unknown;
  keys: unknown;
};

type CreateSocketResult = {
  sock: WhatsAppSocket;
  saveCreds: () => Promise<void>;
  DisconnectReason: Record<string, number>;
  release: () => void;
};

type WhatsAppSessionLease = {
  path: string;
  release: () => void;
};

const activeSessionLeases = new Map<string, string>();

function getWhatsAppSessionLockDir(accountId: string): string {
  return join(getWhatsAppAuthDir(accountId), ".session-lock");
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === "EPERM";
  }
}

function readLeaseOwner(lockDir: string): { pid?: number; command?: string } {
  try {
    const owner = JSON.parse(
      readFileSync(join(lockDir, "owner.json"), "utf8"),
    ) as {
      pid?: unknown;
      command?: unknown;
    };
    return {
      pid: typeof owner.pid === "number" ? owner.pid : undefined,
      command: typeof owner.command === "string" ? owner.command : undefined,
    };
  } catch {
    return {};
  }
}

export function acquireWhatsAppSessionLease(
  accountId: string,
  options: {
    lockDir?: string;
    pid?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): WhatsAppSessionLease {
  const lockDir = options.lockDir ?? getWhatsAppSessionLockDir(accountId);
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const activeLock = activeSessionLeases.get(accountId);
  if (activeLock) {
    throw new Error(
      `WhatsApp account ${accountId} already has an active session in this process (${activeLock}).`,
    );
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify(
          {
            accountId,
            pid,
            command: process.argv.join(" "),
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
      );
      activeSessionLeases.set(accountId, lockDir);
      let released = false;
      return {
        path: lockDir,
        release() {
          if (released) return;
          released = true;
          if (activeSessionLeases.get(accountId) === lockDir) {
            activeSessionLeases.delete(accountId);
          }
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "EEXIST") {
        throw error;
      }
      const owner = readLeaseOwner(lockDir);
      // If the owner is the current process (stale lock from a previous
      // container run or in-process retry), clean it up and retry.
      if (owner.pid && (owner.pid === pid || !isProcessAlive(owner.pid))) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      const ownerLabel = owner.pid
        ? `PID ${owner.pid}${owner.command ? ` (${owner.command})` : ""}`
        : "an unknown live process";
      throw new Error(
        `WhatsApp account ${accountId} is already connected by ${ownerLabel}. Stop that process before starting another WhatsApp server.`,
      );
    }
  }

  throw new Error(`Could not acquire WhatsApp session lock for ${accountId}.`);
}

function resolveMakeWASocket(
  mod: WhatsAppRuntimeRecord,
): (options: Record<string, unknown>) => WhatsAppSocket {
  const fn = mod.makeWASocket ?? mod.default;
  if (typeof fn !== "function") {
    throw new Error(
      'Installed WhatsApp runtime did not export "makeWASocket".',
    );
  }
  return fn as (options: Record<string, unknown>) => WhatsAppSocket;
}

function createSilentLogger() {
  const logger = {
    level: "silent",
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

export function renderQrTerminal(
  qrMod: QrCodeTerminalModule | null,
  input: string,
): string | undefined {
  const qrGenerator =
    typeof qrMod?.generate === "function"
      ? qrMod
      : typeof qrMod?.default?.generate === "function"
        ? qrMod.default
        : null;
  if (!qrGenerator) return undefined;
  const generate = qrGenerator.generate;
  if (typeof generate !== "function") return undefined;

  let qrTerminal: string | undefined;
  try {
    generate.call(qrGenerator, input, { small: true }, (output) => {
      qrTerminal = output;
    });
  } catch {
    return undefined;
  }
  return qrTerminal;
}

export async function createWhatsAppSocket(params: {
  accountId: string;
  printQr?: boolean;
  messageStore?: Map<string, unknown>;
  onConnectionUpdate?: (update: WhatsAppConnectionUpdate) => void;
}): Promise<CreateSocketResult> {
  installWhatsAppConsoleFilters();
  const authDir = getWhatsAppAuthDir(params.accountId);
  mkdirSync(authDir, { recursive: true });
  const sessionLease = acquireWhatsAppSessionLease(params.accountId);
  setWhatsAppConnectionState(params.accountId, { status: "connecting" });

  try {
    const mod = await loadWhatsAppModule();
    const runtime = mod as WhatsAppRuntimeRecord;
    const makeWASocket = resolveMakeWASocket(runtime);
    const useMultiFileAuthState = runtime.useMultiFileAuthState;
    if (typeof useMultiFileAuthState !== "function") {
      throw new Error(
        'Installed WhatsApp runtime did not export "useMultiFileAuthState".',
      );
    }
    const { state, saveCreds } = (await (
      useMultiFileAuthState as (
        path: string,
      ) => Promise<{ state: WhatsAppAuthState; saveCreds: () => Promise<void> }>
    )(authDir)) as { state: WhatsAppAuthState; saveCreds: () => Promise<void> };
    const fetchLatestBaileysVersion = runtime.fetchLatestBaileysVersion;
    const { version } =
      typeof fetchLatestBaileysVersion === "function"
        ? await (
            fetchLatestBaileysVersion as () => Promise<{ version?: unknown }>
          )().catch(() => ({ version: undefined }))
        : { version: undefined };
    const logger = createSilentLogger();
    const makeCacheableSignalKeyStore = runtime.makeCacheableSignalKeyStore;
    const auth =
      typeof makeCacheableSignalKeyStore === "function"
        ? {
            creds: state.creds,
            keys: (
              makeCacheableSignalKeyStore as (
                keys: unknown,
                logger: ReturnType<typeof createSilentLogger>,
              ) => unknown
            )(state.keys, logger),
          }
        : state;

    const sock = makeWASocket({
      auth,
      version,
      browser: ["Letta Code", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      logger,
      getMessage: async (key: { id?: string | null }) => {
        if (!key.id) return undefined;
        const stored = params.messageStore?.get(key.id) as
          | { message?: unknown }
          | undefined;
        return stored?.message;
      },
    });

    sock.ev?.on?.("creds.update", () => {
      void saveCreds().catch(() => undefined);
    });

    sock.ev?.on?.("connection.update", async (payload?: unknown) => {
      const update = (payload ?? {}) as WhatsAppConnectionUpdate;
      params.onConnectionUpdate?.(update);
      if (update.qr) {
        const qrMod = await loadQrCodeTerminalModule().catch(() => null);
        const qrTerminal = renderQrTerminal(qrMod, update.qr);
        setWhatsAppConnectionState(params.accountId, {
          status: "qr",
          qr: update.qr,
          qrTerminal,
        });
        if (params.printQr !== false) {
          console.log(
            `\n[WhatsApp:${params.accountId}] Pairing QR. Open WhatsApp → Settings → Linked Devices → Link a Device.\n`,
          );
          if (qrTerminal) {
            console.log(qrTerminal);
          } else {
            console.log(update.qr);
          }
        }
      }
      if (update.connection === "open") {
        setWhatsAppConnectionState(params.accountId, {
          status: "connected",
          phoneJid: sock.user?.id,
          lid: sock.user?.lid,
        });
      }
      if (update.connection === "close") {
        sessionLease.release();
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const disconnectReason = runtime.DisconnectReason as
          | Record<string, number>
          | undefined;
        const loggedOut = statusCode === disconnectReason?.loggedOut;
        setWhatsAppConnectionState(params.accountId, {
          status: loggedOut ? "logged_out" : "disconnected",
          lastError:
            update.lastDisconnect?.error?.message ??
            (statusCode
              ? `Connection closed (${statusCode})`
              : "Connection closed"),
        });
      }
    });

    return {
      sock,
      saveCreds,
      DisconnectReason: (runtime.DisconnectReason ?? {}) as Record<
        string,
        number
      >,
      release: sessionLease.release,
    };
  } catch (error) {
    sessionLease.release();
    throw error;
  }
}
