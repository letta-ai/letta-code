import { Box, Text } from "ink";
import SpinnerLib from "ink-spinner";
import {
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { models } from "../../agent/model";
import { SYSTEM_PROMPTS } from "../../agent/promptAssets";
import { permissionMode } from "../../permissions/mode";
import { colors } from "../components/colors";
import type { InputProps } from "../components/InputRich";
import { ShimmerText } from "../components/ShimmerText";
import {
  type AdvancedDiffResult,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "../helpers/diff";
import { parsePatchOperations } from "../helpers/formatArgsDisplay";
import { safeJsonParseOr } from "../helpers/safeJsonParse";
import type { ApprovalRequest } from "../helpers/stream";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
  isShellTool,
} from "../helpers/toolNameMapping";

import {
  ensureWebTuiConnected,
  logToServer,
  onServerMessage,
  sendToServer,
  webTuiEnabled,
} from "./ipc";

function getQuestionsFromApproval(approval: ApprovalRequest) {
  const parsed = safeJsonParseOr<Record<string, unknown>>(
    approval.toolArgs,
    {},
  );
  return (
    (parsed.questions as Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>) || []
  );
}

function formatDisplayPath(filePath: string): string {
  const { relative } = require("node:path");
  const cwd = process.cwd();
  const relativePath = relative(cwd, filePath);
  if (relativePath.startsWith("..")) return filePath;
  return relativePath;
}

function getWriteHeader(filePath: string): string {
  const displayPath = formatDisplayPath(filePath);
  const { existsSync } = require("node:fs");
  try {
    if (existsSync(filePath)) return `Overwrite ${displayPath}?`;
  } catch {
    // ignore
  }
  return `Write to ${displayPath}?`;
}

function getFileApprovalHeader(
  toolName: string,
  toolArgs: Record<string, unknown>,
): string {
  if (isPatchTool(toolName) && typeof toolArgs.input === "string") {
    const operations = parsePatchOperations(toolArgs.input);
    if (operations.length > 1) {
      return `Apply patch to ${operations.length} files?`;
    }
    const op = operations[0];
    if (op) {
      const displayPath = formatDisplayPath(op.path);
      if (op.kind === "add") return `Write to ${displayPath}?`;
      if (op.kind === "update") return `Update ${displayPath}?`;
      if (op.kind === "delete") return `Delete ${displayPath}?`;
    }
    return "Apply patch?";
  }

  const filePath =
    typeof toolArgs.file_path === "string" ? toolArgs.file_path : "";
  const displayPath = filePath ? formatDisplayPath(filePath) : "(no file)";

  if (isFileWriteTool(toolName) && filePath) {
    return getWriteHeader(filePath);
  }

  if (isFileEditTool(toolName) && filePath) {
    if (Array.isArray(toolArgs.edits)) {
      return `Update ${displayPath}? (${toolArgs.edits.length} edits)`;
    }
    return `Update ${displayPath}?`;
  }

  return `${toolName} requires approval`;
}

type AppType = typeof import("../App").default;
type AppProps = Parameters<AppType>[0];
type CliUi = NonNullable<AppProps["ui"]>;
type RenderOverlayArgs = Parameters<NonNullable<CliUi["renderOverlay"]>>[0];
type RenderLiveItemArgs = Parameters<NonNullable<CliUi["renderLiveItem"]>>[0];

type ToolsetId =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";

const TOOLSETS: Array<{ id: ToolsetId; label: string }> = [
  { id: "default", label: "Default" },
  { id: "codex", label: "Codex" },
  { id: "codex_snake", label: "Codex Snake" },
  { id: "gemini", label: "Gemini" },
  { id: "gemini_snake", label: "Gemini Snake" },
  { id: "none", label: "None" },
];

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType<{ type?: string }>;

function WebTuiInput({
  onSubmit,
  onInterrupt,
  streaming,
  thinkingMessage,
  agentName,
  visible,
}: InputProps) {
  const onSubmitRef = useRef(onSubmit);
  const onInterruptRef = useRef(onInterrupt);

  const [shimmerOffset, setShimmerOffset] = useState(-3);

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    onInterruptRef.current = onInterrupt;
  }, [onInterrupt]);

  useEffect(() => {
    ensureWebTuiConnected();

    return onServerMessage((msg) => {
      if (msg.type === "runner.submit") {
        onSubmitRef.current(msg.text);
      } else if (msg.type === "runner.interrupt") {
        onInterruptRef.current?.();
      }
    });
  }, []);

  // Replicate the TUI's streaming status line (spinner + shimmering "<agent> is processing…")
  // while still using the web composer as the actual input.
  useEffect(() => {
    if (!streaming || !visible) return;

    const id = setInterval(() => {
      setShimmerOffset((prev) => {
        const prefixLen = agentName ? agentName.length + 1 : 0;
        const len = prefixLen + thinkingMessage.length;
        const next = prev + 1;
        return next > len + 3 ? -3 : next;
      });
    }, 120);

    return () => clearInterval(id);
  }, [streaming, visible, agentName, thinkingMessage]);

  if (!visible) return null;

  return (
    <Box flexDirection="column">
      {streaming && (
        <Box flexDirection="row" marginBottom={1}>
          <Box width={2} flexShrink={0}>
            <Text color={colors.status.processing}>
              <Spinner type="layer" />
            </Text>
          </Box>
          <Box flexGrow={1} flexDirection="row">
            <ShimmerText
              boldPrefix={agentName || undefined}
              message={thinkingMessage}
              shimmerOffset={shimmerOffset}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}

function WebTuiBridge({ args }: { args: RenderOverlayArgs }) {
  const argsRef = useRef<RenderOverlayArgs | null>(null);
  const lastSentRef = useRef<string>("");
  const lastToolUiSentRef = useRef<string>("");
  argsRef.current = args;

  const options = useMemo(
    () => ({
      models: models.map((m) => ({ id: m.id, label: m.label })),
      toolsets: TOOLSETS,
      systemPrompts: SYSTEM_PROMPTS.map((p) => ({ id: p.id, label: p.label })),
    }),
    [],
  );

  useEffect(() => {
    ensureWebTuiConnected();

    return onServerMessage((msg) => {
      const cur = argsRef.current;
      if (!cur) return;

      if (msg.type === "runner.tool_ui.event") {
        if (msg.event.type === "ask_user_question.submit") {
          const payload = msg.event.payload as unknown;
          if (!payload || typeof payload !== "object") return;
          const answers = (payload as { answers?: unknown }).answers;
          if (!answers || typeof answers !== "object") return;
          void cur.onQuestionSubmit(answers as Record<string, string>);
          return;
        }

        if (msg.event.type === "approval.approve") {
          void cur.onApproveCurrent();
          return;
        }

        if (msg.event.type === "approval.approve_always") {
          const payload = msg.event.payload as unknown;
          const scope =
            payload && typeof payload === "object"
              ? ((payload as { scope?: unknown }).scope as
                  | "project"
                  | "session"
                  | undefined)
              : undefined;
          void cur.onApproveAlways(scope);
          return;
        }

        if (msg.event.type === "approval.deny") {
          const payload = msg.event.payload as unknown;
          const reason =
            payload && typeof payload === "object"
              ? (payload as { reason?: unknown }).reason
              : undefined;
          if (typeof reason === "string" && reason.trim()) {
            void cur.onDenyCurrent(reason.trim());
          }
          return;
        }

        if (msg.event.type === "approval.cancel") {
          cur.onCancelApprovals();
          return;
        }

        if (msg.event.type === "enter_plan_mode.approve") {
          void cur.onApproveCurrent();
          return;
        }

        if (msg.event.type === "enter_plan_mode.reject") {
          void cur.onDenyCurrent(
            "User chose to skip plan mode and start implementing directly.",
          );
          return;
        }

        if (msg.event.type === "exit_plan_mode.approve_accept_edits") {
          void cur.onPlanApprove(true);
          return;
        }

        if (msg.event.type === "exit_plan_mode.approve_manual") {
          void cur.onPlanApprove(false);
          return;
        }

        if (msg.event.type === "exit_plan_mode.keep_planning") {
          const payload = msg.event.payload as unknown;
          const reason =
            payload && typeof payload === "object"
              ? (payload as { reason?: unknown }).reason
              : undefined;
          void cur.onPlanKeepPlanning(
            typeof reason === "string" && reason.trim()
              ? reason.trim()
              : "User wants to keep planning",
          );
          return;
        }
        return;
      }

      if (msg.type !== "runner.ui_action") return;

      const action = msg.action;

      if (action.type === "overlay.open") {
        cur.openOverlay(action.overlay);
      } else if (action.type === "overlay.close") {
        cur.closeOverlay();
      } else if (action.type === "model.select") {
        void cur.onSelectModel(action.modelId).catch((err) => {
          logToServer("error", `onSelectModel failed: ${err}`);
        });
      } else if (action.type === "toolset.select") {
        const nextToolset = TOOLSETS.find((t) => t.id === action.toolset)?.id;
        if (!nextToolset) {
          logToServer("warn", `Unknown toolset: ${action.toolset}`);
          return;
        }
        void cur.onSelectToolset(nextToolset).catch((err) => {
          logToServer("error", `onSelectToolset failed: ${err}`);
        });
      } else if (action.type === "system.select") {
        void cur.onSelectSystemPrompt(action.promptId).catch((err) => {
          logToServer("error", `onSelectSystemPrompt failed: ${err}`);
        });
      } else if (action.type === "agent.select") {
        void cur.onSelectAgent(action.agentId).catch((err) => {
          logToServer("error", `onSelectAgent failed: ${err}`);
        });
      } else if (action.type === "approval.approveCurrent") {
        void cur.onApproveCurrent().catch((err) => {
          logToServer("error", `onApproveCurrent failed: ${err}`);
        });
      } else if (action.type === "approval.approveAlways") {
        void cur.onApproveAlways(action.scope).catch((err) => {
          logToServer("error", `onApproveAlways failed: ${err}`);
        });
      } else if (action.type === "approval.denyCurrent") {
        void cur.onDenyCurrent(action.reason).catch((err) => {
          logToServer("error", `onDenyCurrent failed: ${err}`);
        });
      } else if (action.type === "approval.cancel") {
        cur.onCancelApprovals();
      }
    });
  }, []);

  // Emit tool-specific UI state for the web to render (general seam: tool_ui.state)
  useEffect(() => {
    const approval = args.currentApproval;
    if (!approval) return;

    const parsedArgs = safeJsonParseOr<Record<string, unknown>>(
      approval.toolArgs,
      {},
    );
    const allowPersistence =
      args.currentApprovalContext?.allowPersistence ?? true;
    const approveAlwaysText = args.currentApprovalContext?.approveAlwaysText;

    let frame: { kind: string; payload: unknown } | null = null;

    if (approval.toolName === "AskUserQuestion") {
      const questions = getQuestionsFromApproval(approval);
      frame = {
        kind: "ask_user_question",
        payload: { questions },
      };
    } else if (approval.toolName === "EnterPlanMode") {
      frame = { kind: "enter_plan_mode", payload: {} };
    } else if (approval.toolName === "ExitPlanMode") {
      const planFilePath = permissionMode.getPlanFilePath();
      let planContent: string | null = null;
      if (planFilePath) {
        const { existsSync, readFileSync } = require("node:fs");
        try {
          if (existsSync(planFilePath)) {
            planContent = readFileSync(planFilePath, "utf-8");
          }
        } catch {
          // ignore
        }
      }
      frame = {
        kind: "exit_plan_mode",
        payload: { planFilePath, planContent },
      };
    } else if (isShellTool(approval.toolName)) {
      const cmdVal = parsedArgs.command;
      const command = Array.isArray(cmdVal)
        ? cmdVal.join(" ")
        : typeof cmdVal === "string"
          ? cmdVal
          : "";
      const descVal = parsedArgs.description ?? parsedArgs.justification;
      const description = typeof descVal === "string" ? descVal : undefined;
      frame = {
        kind: "bash_approval",
        payload: { command, description, allowPersistence, approveAlwaysText },
      };
    } else if (
      isFileWriteTool(approval.toolName) ||
      isFileEditTool(approval.toolName) ||
      isPatchTool(approval.toolName)
    ) {
      const headerText = getFileApprovalHeader(approval.toolName, parsedArgs);
      let diff: AdvancedDiffResult | null = null;

      const filePath =
        typeof parsedArgs.file_path === "string" ? parsedArgs.file_path : null;

      if (filePath && isFileWriteTool(approval.toolName)) {
        diff = computeAdvancedDiff({
          kind: "write",
          filePath,
          content:
            typeof parsedArgs.content === "string" ? parsedArgs.content : "",
        });
      } else if (filePath && isFileEditTool(approval.toolName)) {
        if (Array.isArray(parsedArgs.edits)) {
          diff = computeAdvancedDiff({
            kind: "multi_edit",
            filePath,
            edits: parsedArgs.edits as Array<{
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>,
          });
        } else {
          diff = computeAdvancedDiff({
            kind: "edit",
            filePath,
            oldString:
              typeof parsedArgs.old_string === "string"
                ? parsedArgs.old_string
                : "",
            newString:
              typeof parsedArgs.new_string === "string"
                ? parsedArgs.new_string
                : "",
            replaceAll:
              typeof parsedArgs.replace_all === "boolean"
                ? parsedArgs.replace_all
                : undefined,
          });
        }
      }

      const patchInput =
        typeof parsedArgs.input === "string" ? parsedArgs.input : null;
      const patchOperations = patchInput
        ? parsePatchOperations(patchInput).map((op) => {
            const displayPath = formatDisplayPath(op.path);
            if (op.kind === "add" || op.kind === "update") {
              return {
                kind: op.kind,
                path: op.path,
                displayPath,
                diff: parsePatchToAdvancedDiff(op.patchLines, op.path),
              };
            }
            return { kind: op.kind, path: op.path, displayPath };
          })
        : null;

      frame = {
        kind: "file_edit_approval",
        payload: {
          toolName: approval.toolName,
          headerText,
          allowPersistence,
          approveAlwaysText,
          diff,
          patchOperations,
        },
      };
    }

    if (!frame) return;

    const encoded = JSON.stringify({
      toolCallId: approval.toolCallId,
      frame,
    });
    if (encoded === lastToolUiSentRef.current) return;
    lastToolUiSentRef.current = encoded;
    sendToServer({
      type: "runner.tool_ui.state",
      toolCallId: approval.toolCallId,
      toolName: approval.toolName,
      state: frame,
    });
  }, [args.currentApproval, args.currentApprovalContext]);

  useEffect(() => {
    const state = {
      activeOverlay: args.activeOverlay,
      pendingApprovals: args.pendingApprovals.map((a) => ({
        toolCallId: a.toolCallId,
        toolName: a.toolName,
        toolArgs: a.toolArgs,
      })),
      currentApprovalIndex: args.currentApprovalIndex,
      currentApproval: args.currentApproval
        ? {
            toolCallId: args.currentApproval.toolCallId,
            toolName: args.currentApproval.toolName,
            toolArgs: args.currentApproval.toolArgs,
          }
        : undefined,
      agentId: args.agentId,
      agentName: args.agentName,
      currentModelId: args.currentModelId,
      currentToolset: args.currentToolset,
      currentSystemPromptId: args.currentSystemPromptId,
      options,
    };

    const encoded = JSON.stringify(state);
    if (encoded === lastSentRef.current) return;
    lastSentRef.current = encoded;

    sendToServer({ type: "runner.ui_state", state });
  }, [
    args.activeOverlay,
    args.pendingApprovals,
    args.currentApprovalIndex,
    args.currentApproval,
    args.agentId,
    args.agentName,
    args.currentModelId,
    args.currentToolset,
    args.currentSystemPromptId,
    options,
  ]);

  return null;
}

export function createWebTuiUi(): CliUi {
  if (!webTuiEnabled()) {
    return {};
  }

  return {
    Input: WebTuiInput,
    renderLiveItem: (args: RenderLiveItemArgs, next) => {
      if (
        args.currentApproval &&
        args.item.kind === "tool_call" &&
        args.item.toolCallId === args.currentApproval.toolCallId
      ) {
        return null;
      }
      return next();
    },
    renderOverlay: (args: RenderOverlayArgs) => <WebTuiBridge args={args} />,
  };
}
