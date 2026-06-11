import { describe, expect, test } from "bun:test";
import type { WsProtocolMessage } from "@/types/app-server-protocol";

describe("app-server protocol export", () => {
  test("covers command response messages emitted by the listener", () => {
    const messages = [
      {
        type: "cron_list_response",
        request_id: "req",
        tasks: [],
        success: true,
      },
      {
        type: "cron_update_response",
        request_id: "req",
        success: true,
      },
      {
        type: "skills_updated",
        timestamp: 1,
      },
      {
        type: "list_memory_response",
        request_id: "req",
        entries: [],
        done: true,
        total: 0,
        success: true,
      },
      {
        type: "search_files_response",
        request_id: "req",
        files: [],
        success: true,
      },
      {
        type: "terminal_output",
        terminal_id: "term",
        data: "hello",
      },
      {
        type: "search_branches_response",
        request_id: "req",
        branches: [],
        success: true,
      },
      {
        type: "get_reflection_settings_response",
        request_id: "req",
        success: true,
        reflection_settings: null,
      },
      {
        type: "agent_list_response",
        request_id: "req",
        success: true,
        agents: [],
      },
      {
        type: "agent_update_response",
        request_id: "req",
        success: true,
        agent: null,
      },
      {
        type: "agent_delete_response",
        request_id: "req",
        success: true,
        agent_id: "agent-1",
      },
      {
        type: "conversation_list_response",
        request_id: "req",
        success: true,
        conversations: [],
      },
      {
        type: "conversation_update_response",
        request_id: "req",
        success: true,
        conversation: null,
      },
      {
        type: "conversation_recompile_response",
        request_id: "req",
        success: true,
        result: null,
      },
      {
        type: "conversation_fork_response",
        request_id: "req",
        success: true,
        conversation: null,
      },
      {
        type: "conversation_messages_list_response",
        request_id: "req",
        success: true,
        messages: [],
      },
      {
        type: "conversation_compact_response",
        request_id: "req",
        success: true,
        compaction: null,
      },
      {
        type: "runtime_start_response",
        request_id: "req",
        success: true,
        runtime: null,
        agent: null,
        conversation: null,
        created: { agent: false, conversation: false },
      },
      {
        type: "external_tools_register_response",
        request_id: "req",
        success: true,
        tool_names: ["council-write"],
      },
      {
        type: "external_tool_call_request",
        request_id: "req",
        tool_call_id: "call-1",
        tool_name: "council-write",
        input: {},
      },
    ] satisfies WsProtocolMessage[];

    expect(messages.map((message) => message.type)).toEqual([
      "cron_list_response",
      "cron_update_response",
      "skills_updated",
      "list_memory_response",
      "search_files_response",
      "terminal_output",
      "search_branches_response",
      "get_reflection_settings_response",
      "agent_list_response",
      "agent_update_response",
      "agent_delete_response",
      "conversation_list_response",
      "conversation_update_response",
      "conversation_recompile_response",
      "conversation_fork_response",
      "conversation_messages_list_response",
      "conversation_compact_response",
      "runtime_start_response",
      "external_tools_register_response",
      "external_tool_call_request",
    ]);
  });
});
