export type WhatsAppConnectionStatus =
  | "idle"
  | "qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "logged_out"
  | "error";

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  qr?: string;
  qrTerminal?: string;
  phoneJid?: string;
  lid?: string;
  lastError?: string;
  updatedAt: string;
}

type Listener = (accountId: string, state: WhatsAppConnectionState) => void;

const states = new Map<string, WhatsAppConnectionState>();
const listeners = new Set<Listener>();

export function getWhatsAppConnectionState(
  accountId: string,
): WhatsAppConnectionState {
  return (
    states.get(accountId) ?? {
      status: "idle",
      updatedAt: new Date(0).toISOString(),
    }
  );
}

export function setWhatsAppConnectionState(
  accountId: string,
  patch: Omit<Partial<WhatsAppConnectionState>, "updatedAt">,
): WhatsAppConnectionState {
  const existing = getWhatsAppConnectionState(accountId);
  const next: WhatsAppConnectionState = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (patch.status && patch.status !== "qr") {
    delete next.qr;
    delete next.qrTerminal;
  }
  states.set(accountId, next);
  for (const listener of listeners) {
    listener(accountId, next);
  }
  return next;
}

export function clearWhatsAppConnectionState(accountId: string): void {
  states.delete(accountId);
}

export function subscribeWhatsAppConnectionState(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toWhatsAppConnectionConfig(
  accountId: string,
): Record<string, unknown> {
  const state = getWhatsAppConnectionState(accountId);
  return {
    connection_status: state.status,
    has_qr: Boolean(state.qr),
    ...(state.qr ? { qr: state.qr } : {}),
    ...(state.qrTerminal ? { qr_terminal: state.qrTerminal } : {}),
    ...(state.phoneJid ? { phone_jid: state.phoneJid } : {}),
    ...(state.lid ? { lid: state.lid } : {}),
    ...(state.lastError ? { last_error: state.lastError } : {}),
    connection_updated_at: state.updatedAt,
  };
}
