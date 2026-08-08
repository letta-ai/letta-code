type EventEmitterLike = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
};

export type WhatsAppMessageKey = {
  remoteJid?: string | null;
  id?: string | null;
  fromMe?: boolean | null;
  participant?: string | null;
  senderPn?: string | null;
  senderLid?: string | null;
  participantPn?: string | null;
  participantLid?: string | null;
};

export type WhatsAppSocket = {
  ev?: EventEmitterLike;
  ws?: { close?: () => void };
  user?: { id?: string; lid?: string };
  sendMessage?: (
    jid: string,
    payload: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<{ key?: { id?: string }; message?: unknown }>;
  sendPresenceUpdate?: (presence: string, jid?: string) => Promise<void>;
  groupMetadata?: (jid: string) => Promise<{ subject?: string }>;
  readMessages?: (keys: WhatsAppMessageKey[]) => Promise<unknown>;
};

export type WhatsAppMessage = {
  key?: WhatsAppMessageKey;
  message?: unknown;
  messageTimestamp?: number | { toNumber?: () => number } | null;
  pushName?: string | null;
};
