export const FEISHU_RUNTIME_PACKAGE = "@larksuiteoapi/node-sdk@1.67.0";
export const FEISHU_RUNTIME_MODULE = "@larksuiteoapi/node-sdk";

export const FEISHU_API_DOMAINS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

export interface LarkClientConfigLike {
  appId: string;
  appSecret: string;
  domain?: unknown;
  appType?: unknown;
}

export interface LarkCreateMessageRequestLike {
  params: { receive_id_type: string };
  data: {
    receive_id: string;
    msg_type: string;
    content: string;
  };
}

export interface LarkReplyMessageRequestLike {
  path: { message_id: string };
  data: {
    msg_type: string;
    content: string;
    reply_in_thread?: boolean;
  };
}

export interface LarkMessageApiLike {
  create: (
    request: LarkCreateMessageRequestLike,
  ) => Promise<{ data?: { message_id?: string } } | undefined>;
  reply?: (
    request: LarkReplyMessageRequestLike,
  ) => Promise<{ data?: { message_id?: string } } | undefined>;
}

export interface LarkClientLike {
  im: {
    v1: {
      message: LarkMessageApiLike;
    };
  };
  request?: (config: { url: string; method: string }) => Promise<unknown>;
}

export interface LarkEventDispatcherLike {
  register: (
    handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>,
  ) => LarkEventDispatcherLike;
}

export interface LarkWsClientLike {
  start: (options: {
    eventDispatcher: LarkEventDispatcherLike;
  }) => Promise<void> | void;
  close?: () => void;
}

export interface LarkRuntimeModuleLike {
  Domain?: {
    Feishu?: unknown;
    Lark?: unknown;
  };
  AppType?: {
    SelfBuild?: unknown;
  };
  Client: new (config: LarkClientConfigLike) => LarkClientLike;
  WSClient: new (config: LarkClientConfigLike) => LarkWsClientLike;
  EventDispatcher: new (config?: object) => LarkEventDispatcherLike;
}
