import {
  ensureChannelRuntimeInstalled,
  installChannelRuntime,
  isChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";

export type WhatsAppRuntimeModule = Record<string, unknown> & {
  default?: unknown;
  makeWASocket?: unknown;
  useMultiFileAuthState?: unknown;
  fetchLatestBaileysVersion?: unknown;
  DisconnectReason?: Record<string, number>;
  downloadContentFromMessage?: unknown;
  makeCacheableSignalKeyStore?: unknown;
};

export type QrCodeTerminalModule = {
  default?: {
    generate?: (
      input: string,
      options?: { small?: boolean },
      callback?: (output: string) => void,
    ) => void;
  };
  generate?: (
    input: string,
    options?: { small?: boolean },
    callback?: (output: string) => void,
  ) => void;
};

export async function loadWhatsAppModule(): Promise<WhatsAppRuntimeModule> {
  return loadChannelRuntimeModule<WhatsAppRuntimeModule>(
    "whatsapp",
    "@whiskeysockets/baileys",
  );
}

export async function loadQrCodeTerminalModule(): Promise<QrCodeTerminalModule> {
  return loadChannelRuntimeModule<QrCodeTerminalModule>(
    "whatsapp",
    "qrcode-terminal",
  );
}

export function isWhatsAppRuntimeInstalled(): boolean {
  return isChannelRuntimeInstalled("whatsapp");
}

export async function installWhatsAppRuntime(): Promise<void> {
  await installChannelRuntime("whatsapp");
}

export async function ensureWhatsAppRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("whatsapp");
}
