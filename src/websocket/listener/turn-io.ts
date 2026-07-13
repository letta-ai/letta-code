import type { sendMessageStream } from "@/agent/message";
import { sendMessageStream as defaultSendMessageStream } from "@/agent/message";
import type { drainStreamWithResume } from "@/cli/helpers/stream";
import { drainStreamWithResume as defaultDrainStreamWithResume } from "@/cli/helpers/stream";

type SendMessageStream = typeof sendMessageStream;
type DrainStreamWithResume = typeof drainStreamWithResume;

let sendMessageStreamImpl: SendMessageStream = defaultSendMessageStream;
let drainStreamWithResumeImpl: DrainStreamWithResume =
  defaultDrainStreamWithResume;

export function listenerSendMessageStream(
  ...args: Parameters<SendMessageStream>
): ReturnType<SendMessageStream> {
  return sendMessageStreamImpl(...args);
}

export function listenerDrainStreamWithResume(
  ...args: Parameters<DrainStreamWithResume>
): ReturnType<DrainStreamWithResume> {
  return drainStreamWithResumeImpl(...args);
}

export const __listenerTurnIoTestUtils = {
  setSendMessageStreamForTests(impl: SendMessageStream | null): void {
    sendMessageStreamImpl = impl ?? defaultSendMessageStream;
  },
  setDrainStreamWithResumeForTests(impl: DrainStreamWithResume | null): void {
    drainStreamWithResumeImpl = impl ?? defaultDrainStreamWithResume;
  },
  resetForTests(): void {
    sendMessageStreamImpl = defaultSendMessageStream;
    drainStreamWithResumeImpl = defaultDrainStreamWithResume;
  },
};
