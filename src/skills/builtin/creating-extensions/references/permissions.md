# Extension permission recipes

Use permission overlays when trusted local code should participate in tool approval decisions. Prefer permissions over `tool_start` denial for policy: permissions run before approval UI and again before execution on final tool arguments.

## Capability

```ts
letta.capabilities.permissions
```

Guard registrations when writing portable extensions:

```ts
export default function activate(letta) {
  if (!letta.capabilities.permissions) return;

  return letta.permissions.register({
    id: "plan-mode",
    description: "Allow read-only tools and writes only to the active plan file.",
    check(event) {
      if (!isPlanModeActive(event.conversationId)) return;

      if (isReadOnlyTool(event.toolName, event.args)) {
        return { decision: "allow" };
      }

      if (isActivePlanFileWrite(event.toolName, event.args)) {
        return { decision: "allow", reason: "active plan file" };
      }

      return {
        decision: "deny",
        reason: "Plan mode is active. You can only read files or update the plan file.",
      };
    },
  });
}
```

## Event shape

```ts
{
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: "approval" | "execution";
}
```

## Return values

Return one of:

```ts
{ decision: "allow", reason?: string }
{ decision: "ask", reason?: string }
{ decision: "deny", reason?: string }
undefined // no opinion
```

Composition rules across overlays:

- `deny` wins
- then `ask`
- then `allow`
- `undefined` means no opinion

User/configured hard denials still win before extension overlays. Extension overlays can override normal auto-allow/default approval behavior, including unrestricted/yolo mode.

## Two phases

Permission overlays run during approval classification (`phase: "approval"`) and again immediately before execution (`phase: "execution"`) after any `tool_start` argument transforms.

During execution, `ask` cannot reopen approval yet, so use `deny` for execution-time blocking behavior.

## Rules

- Keep checks fast and deterministic.
- Return `undefined` when the overlay is not active for the current conversation/state.
- Prefer path-scoped allow rules over broad allow rules.
- Do not mutate `event.args`; use `tool_start` for argument transforms.
- For policy decisions, prefer this API over `tool_start` denial.

For a complete worked example that uses permission overlays for plan-mode enforcement, see `plan-mode.md`.
