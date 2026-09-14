import { expect, mock, test } from "bun:test";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  resolveTelegramBotConfig,
  resolveTelegramProxyAgent,
} from "./bot-config";
import { fetchTelegramFile, type TelegramFileFetch } from "./media";

const PROXY_ENVIRONMENT_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "npm_config_https_proxy",
  "npm_config_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

async function withProxyEnvironment(
  values: Partial<Record<(typeof PROXY_ENVIRONMENT_KEYS)[number], string>>,
  run: () => void | Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      delete process.env[key];
    }
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      const value = previous[key];
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  }
}

test("resolves HTTPS_PROXY for the Telegram Bot API", async () => {
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://proxy.example:8080" },
    () => {
      const agent = resolveTelegramBotConfig()?.client?.baseFetchConfig
        ?.agent as HttpsProxyAgent<string> | undefined;

      expect(agent).toBeInstanceOf(HttpsProxyAgent);
      expect(agent?.proxy.href).toBe("http://proxy.example:8080/");
    },
  );
});

test("rejects a SOCKS ALL_PROXY instead of treating it as an HTTP proxy", async () => {
  await withProxyEnvironment(
    { ALL_PROXY: "socks5://proxy.example:1080" },
    () => {
      expect(() =>
        resolveTelegramProxyAgent("https://api.telegram.org"),
      ).toThrow(
        'Unsupported Telegram proxy protocol "socks5". Use an http or https proxy.',
      );
    },
  );
});

test("rejects unsupported Telegram proxy protocols", async () => {
  await withProxyEnvironment({ HTTPS_PROXY: "ftp://proxy.example:21" }, () => {
    expect(() => resolveTelegramProxyAgent("https://api.telegram.org")).toThrow(
      'Unsupported Telegram proxy protocol "ftp"',
    );
  });
});

test("respects NO_PROXY for the Telegram Bot API", async () => {
  await withProxyEnvironment(
    {
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "api.telegram.org",
    },
    () => {
      expect(resolveTelegramBotConfig()).toBeUndefined();
    },
  );
});

test("routes Telegram file downloads through the resolved proxy agent", async () => {
  await withProxyEnvironment(
    { HTTPS_PROXY: "http://proxy.example:8080" },
    async () => {
      let receivedAgent: unknown;
      const fileFetch = mock(async (_url, init) => {
        receivedAgent = init?.agent;
        return new Response("attachment");
      }) as TelegramFileFetch;

      const response = await fetchTelegramFile(
        "https://api.telegram.org/file/bot-token/photos/photo.jpg",
        1_000,
        fileFetch,
      );

      expect(await response.text()).toBe("attachment");
      expect(receivedAgent).toBeInstanceOf(HttpsProxyAgent);
    },
  );
});

test("routes Telegram file downloads directly when NO_PROXY matches", async () => {
  await withProxyEnvironment(
    {
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "api.telegram.org",
    },
    async () => {
      let receivedAgent: unknown = "unset";
      const fileFetch = mock(async (_url, init) => {
        receivedAgent = init?.agent;
        return new Response("attachment");
      }) as TelegramFileFetch;

      await fetchTelegramFile(
        "https://api.telegram.org/file/bot-token/photos/photo.jpg",
        1_000,
        fileFetch,
      );

      expect(receivedAgent).toBeUndefined();
    },
  );
});
