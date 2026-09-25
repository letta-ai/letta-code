import { describe, expect, test } from "bun:test";
import {
  createTrayItem,
  deleteTrayItem,
  listTrayItems,
  type TrayMarkdownletPayloadV1,
  updateTrayItem,
} from "./tray";

const payload: TrayMarkdownletPayloadV1 = {
  version: 1,
  type: "markdownlet",
  title: "Open pull requests",
  markdown: "| PR | Status |\n| --- | --- |\n| #123 | CI |",
};

describe("Tray API", () => {
  test("lists scoped Tray items with encoded IDs", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const request = async <T>(method: string, path: string): Promise<T> => {
      calls.push({ method, path });
      return { items: [] } as T;
    };

    await expect(listTrayItems("agent/1", "conv/1", request)).resolves.toEqual(
      [],
    );
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/v1/agents/agent%2F1/conversations/conv%2F1/tray",
      },
    ]);
  });

  test("creates, updates, and deletes Tray items", async () => {
    const calls: Array<{
      method: string;
      path: string;
      body?: Record<string, unknown>;
    }> = [];
    const request = async <T>(
      method: string,
      path: string,
      body?: Record<string, unknown>,
    ): Promise<T> => {
      calls.push({ method, path, body });
      return {} as T;
    };

    await createTrayItem("agent-1", "conv-1", payload, request);
    await updateTrayItem("agent-1", "conv-1", "tray/1", payload, request);
    await deleteTrayItem("agent-1", "conv-1", "tray/1", request);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/agents/agent-1/conversations/conv-1/tray",
        body: { payload },
      },
      {
        method: "PATCH",
        path: "/v1/agents/agent-1/conversations/conv-1/tray/tray%2F1",
        body: { payload },
      },
      {
        method: "DELETE",
        path: "/v1/agents/agent-1/conversations/conv-1/tray/tray%2F1",
        body: undefined,
      },
    ]);
  });
});
