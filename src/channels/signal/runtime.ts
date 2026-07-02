import {
  ensureChannelRuntimeInstalled,
  loadChannelRuntimeModule,
} from "@/channels/runtime-deps";

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

export async function loadSignalQrCodeTerminalModule(): Promise<QrCodeTerminalModule> {
  return loadChannelRuntimeModule<QrCodeTerminalModule>(
    "signal",
    "qrcode-terminal",
  );
}

export async function ensureSignalRuntimeInstalled(): Promise<boolean> {
  return ensureChannelRuntimeInstalled("signal");
}

export function renderSignalQrTerminal(
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
