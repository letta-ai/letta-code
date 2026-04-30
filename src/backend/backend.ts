import type { getClient } from "./api/client";
import { getClient as getApiClient } from "./api/client";
import {
  type ForkConversationOptions,
  forkConversation as forkConversationRequest,
} from "./api/conversations";

export type APIClient = Awaited<ReturnType<typeof getClient>>;

export type ConversationMessageCreateParams = Parameters<
  APIClient["conversations"]["messages"]["create"]
>;
export type ConversationMessageCreateBody = ConversationMessageCreateParams[1];
export type ConversationMessageCreateOptions =
  ConversationMessageCreateParams[2];

export type ConversationMessageStreamParams = Parameters<
  APIClient["conversations"]["messages"]["stream"]
>;
export type ConversationMessageStreamBody = ConversationMessageStreamParams[1];
export type ConversationMessageStreamOptions =
  ConversationMessageStreamParams[2];

export type RunMessageStreamParams = Parameters<
  APIClient["runs"]["messages"]["stream"]
>;
export type RunMessageStreamBody = RunMessageStreamParams[1];
export type RunMessageStreamOptions = RunMessageStreamParams[2];

export interface Backend {
  createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: ConversationMessageCreateOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["create"]>>
  >;

  streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: ConversationMessageStreamOptions,
  ): Promise<
    Awaited<ReturnType<APIClient["conversations"]["messages"]["stream"]>>
  >;

  cancelConversation(
    conversationIdOrAgentId: string,
  ): Promise<Awaited<ReturnType<APIClient["conversations"]["cancel"]>>>;

  retrieveRun(
    runId: string,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["retrieve"]>>>;

  streamRunMessages(
    runId: string,
    body: RunMessageStreamBody,
    options?: RunMessageStreamOptions,
  ): Promise<Awaited<ReturnType<APIClient["runs"]["messages"]["stream"]>>>;

  forkConversation(
    conversationId: string,
    options?: ForkConversationOptions,
  ): ReturnType<typeof forkConversationRequest>;
}

export class APIBackend implements Backend {
  private async getClient(): Promise<APIClient> {
    return getApiClient();
  }

  async createConversationMessageStream(
    conversationId: string,
    body: ConversationMessageCreateBody,
    options?: ConversationMessageCreateOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.create(conversationId, body, options);
  }

  async streamConversationMessages(
    conversationId: string,
    body: ConversationMessageStreamBody,
    options?: ConversationMessageStreamOptions,
  ) {
    const client = await this.getClient();
    return client.conversations.messages.stream(conversationId, body, options);
  }

  async cancelConversation(conversationIdOrAgentId: string) {
    const client = await this.getClient();
    return client.conversations.cancel(conversationIdOrAgentId);
  }

  async retrieveRun(runId: string) {
    const client = await this.getClient();
    return client.runs.retrieve(runId);
  }

  async streamRunMessages(
    runId: string,
    body: RunMessageStreamBody,
    options?: RunMessageStreamOptions,
  ) {
    const client = await this.getClient();
    return client.runs.messages.stream(runId, body, options);
  }

  forkConversation(conversationId: string, options?: ForkConversationOptions) {
    return forkConversationRequest(conversationId, options);
  }
}

let backend: Backend = new APIBackend();

export function getBackend(): Backend {
  return backend;
}

export function __testSetBackend(nextBackend: Backend | null): void {
  backend = nextBackend ?? new APIBackend();
}
