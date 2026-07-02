import { describe, expect, test } from "bun:test";
import {
  listMcpServersWithTimeout,
  MCP_SERVERS_LIST_TIMEOUT_MESSAGE,
} from "./McpSelector";

describe("listMcpServersWithTimeout", () => {
  test("passes an abort signal and disables retries", async () => {
    let capturedOptions:
      | { maxRetries?: number; signal?: AbortSignal | null }
      | undefined;
    const servers: never[] = [];

    await expect(
      listMcpServersWithTimeout({
        mcpServers: {
          list: (options) => {
            capturedOptions = options;
            return Promise.resolve(servers);
          },
        },
      }),
    ).resolves.toBe(servers);

    expect(capturedOptions?.maxRetries).toBe(0);
    expect(capturedOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rewrites aborts to the retryable MCP list timeout message", async () => {
    await expect(
      listMcpServersWithTimeout(
        {
          mcpServers: {
            list: (options) =>
              new Promise((_, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("raw abort")),
                  { once: true },
                );
              }),
          },
        },
        1,
      ),
    ).rejects.toThrow(MCP_SERVERS_LIST_TIMEOUT_MESSAGE);
  });

  test("rejects on timeout even if the client ignores abort", async () => {
    await expect(
      listMcpServersWithTimeout(
        {
          mcpServers: {
            list: () => new Promise(() => {}),
          },
        },
        1,
      ),
    ).rejects.toThrow(MCP_SERVERS_LIST_TIMEOUT_MESSAGE);
  });
});
