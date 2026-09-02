import { expect, test } from "bun:test";
import { HttpsProxyAgent } from "https-proxy-agent";
import { resolveTelegramBotConfig } from "./bot-config";

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

function withProxyEnvironment(
  values: Partial<Record<(typeof PROXY_ENVIRONMENT_KEYS)[number], string>>,
  run: () => void,
): void {
  const previous = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("resolves HTTPS_PROXY for the Telegram Bot API", () => {
  withProxyEnvironment({ HTTPS_PROXY: "http://proxy.example:8080" }, () => {
    const agent = resolveTelegramBotConfig()?.client?.baseFetchConfig?.agent as
      | HttpsProxyAgent<string>
      | undefined;

    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    expect(agent?.proxy.href).toBe("http://proxy.example:8080/");
  });
});

test("respects NO_PROXY for the Telegram Bot API", () => {
  withProxyEnvironment(
    {
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "api.telegram.org",
    },
    () => {
      expect(resolveTelegramBotConfig()).toBeUndefined();
    },
  );
});
