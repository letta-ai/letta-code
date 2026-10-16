import { expect, test } from "bun:test";
import { createChannelTurnProgressBuilder } from "./progress-builder";

test.each(["UpdatePlan", "TodoWrite"])(
  "projects %s only after successful execution",
  (name) => {
    const builder = createChannelTurnProgressBuilder();
    const args =
      name === "UpdatePlan"
        ? {
            plan: [
              { step: "Inspect the failure", status: "completed" },
              { step: "Repair it", status: "in_progress" },
            ],
          }
        : {
            todos: [
              {
                content: "Inspect the failure",
                activeForm: "Inspecting",
                status: "completed",
              },
              {
                content: "Repair it",
                activeForm: "Repairing",
                status: "in_progress",
              },
            ],
          };
    const started = builder.buildUpdates({
      message_type: "client_tool_start",
      tool_call_id: "call-1",
      tool_name: name,
      tool_args: JSON.stringify(args),
    });
    expect(started[0]?.plan).toBeUndefined();
    const ended = builder.buildUpdates({
      message_type: "client_tool_end",
      tool_call_id: "call-1",
      status: "success",
    });
    expect(ended[0]?.plan).toEqual([
      { id: "plan-0", title: "Inspect the failure", status: "complete" },
      { id: "plan-1", title: "Repair it", status: "in_progress" },
    ]);
  },
);

test("failed tools, arbitrary tools and malformed plans never publish plan content", () => {
  for (const [name, status, args] of [
    ["UpdatePlan", "error", { plan: [{ step: "hidden", status: "pending" }] }],
    ["Bash", "success", { plan: [{ step: "private", status: "pending" }] }],
    [
      "UpdatePlan",
      "success",
      { plan: [{ step: "bad status", status: "oops" }] },
    ],
  ] as const) {
    const builder = createChannelTurnProgressBuilder();
    builder.buildUpdates({
      message_type: "client_tool_start",
      tool_call_id: "call-1",
      tool_name: name,
      tool_args: JSON.stringify(args),
    });
    expect(
      builder.buildUpdates({
        message_type: "client_tool_end",
        tool_call_id: "call-1",
        status,
      })[0]?.plan,
    ).toBeUndefined();
  }
});
