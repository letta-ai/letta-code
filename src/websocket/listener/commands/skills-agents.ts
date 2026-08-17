import type WebSocket from "ws";
import { resolveModel } from "@/agent/model";
import { settingsManager } from "@/settings-manager";
import type { CreateAgentCommand } from "@/types/protocol_v2";
import type {
  SkillCatalogInstallCommand,
  SkillCatalogPreviewCommand,
  SkillDisableCommand,
  SkillEnableCommand,
} from "@/types/skill-catalog-protocol";
import { isCreateAgentCommand } from "@/websocket/listener/protocol-inbound";
import {
  isSkillCatalogInstallCommand,
  isSkillCatalogPreviewCommand,
  isSkillDisableCommand,
  isSkillEnableCommand,
} from "@/websocket/listener/skill-protocol-inbound";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export type SkillCommand = SkillEnableCommand | SkillDisableCommand;

type SkillAgentCommandContext = {
  socket: WebSocket;
  safeSocketSend: SafeSocketSend;
  runDetachedListenerTask: RunDetachedListenerTask;
};

function emitSkillsUpdated(
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): void {
  safeSocketSend(
    socket,
    {
      type: "skills_updated",
      timestamp: Date.now(),
    },
    "listener_skill_send_failed",
    "listener_skill_command",
  );
}

export async function handleSkillCommand(
  parsed: SkillCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<boolean> {
  const {
    existsSync,
    lstatSync,
    mkdirSync,
    rmdirSync,
    symlinkSync,
    unlinkSync,
  } = await import("node:fs");
  const { basename, join } = await import("node:path");

  // Compute skills dir dynamically to respect LETTA_HOME (important for tests)
  const lettaHome =
    process.env.LETTA_HOME ||
    join(process.env.HOME || process.env.USERPROFILE || "~", ".letta");
  const globalSkillsDir = join(lettaHome, "skills");

  if (parsed.type === "skill_enable") {
    try {
      // Validate the skill path exists
      if (!existsSync(parsed.skill_path)) {
        safeSocketSend(
          socket,
          {
            type: "skill_enable_response",
            request_id: parsed.request_id,
            success: false,
            error: `Path does not exist: ${parsed.skill_path}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      // Check it contains a SKILL.md
      const skillMdPath = join(parsed.skill_path, "SKILL.md");
      if (!existsSync(skillMdPath)) {
        safeSocketSend(
          socket,
          {
            type: "skill_enable_response",
            request_id: parsed.request_id,
            success: false,
            error: `No SKILL.md found in ${parsed.skill_path}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      const linkName = basename(parsed.skill_path);
      const linkPath = join(globalSkillsDir, linkName);

      // Ensure ~/.letta/skills/ exists
      mkdirSync(globalSkillsDir, { recursive: true });

      // If symlink/junction already exists, remove it first
      if (existsSync(linkPath)) {
        const stat = lstatSync(linkPath);
        if (stat.isSymbolicLink()) {
          if (process.platform === "win32") {
            rmdirSync(linkPath);
          } else {
            unlinkSync(linkPath);
          }
        } else {
          safeSocketSend(
            socket,
            {
              type: "skill_enable_response",
              request_id: parsed.request_id,
              success: false,
              error: `${linkPath} already exists and is not a symlink — refusing to overwrite`,
            },
            "listener_skill_send_failed",
            "listener_skill_command",
          );
          return true;
        }
      }

      // Use junctions on Windows — they don't require admin/Developer Mode
      const linkType = process.platform === "win32" ? "junction" : "dir";
      symlinkSync(parsed.skill_path, linkPath, linkType);

      safeSocketSend(
        socket,
        {
          type: "skill_enable_response",
          request_id: parsed.request_id,
          success: true,
          name: linkName,
          skill_path: parsed.skill_path,
          link_path: linkPath,
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
      emitSkillsUpdated(socket, safeSocketSend);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "skill_enable_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to enable skill",
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
    }
    return true;
  }

  if (parsed.type === "skill_disable") {
    try {
      const linkPath = join(globalSkillsDir, parsed.name);

      if (!existsSync(linkPath)) {
        safeSocketSend(
          socket,
          {
            type: "skill_disable_response",
            request_id: parsed.request_id,
            success: false,
            error: `Skill not found: ${parsed.name}`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        safeSocketSend(
          socket,
          {
            type: "skill_disable_response",
            request_id: parsed.request_id,
            success: false,
            error: `${parsed.name} is not a symlink — refusing to delete. Remove it manually if intended.`,
          },
          "listener_skill_send_failed",
          "listener_skill_command",
        );
        return true;
      }

      if (process.platform === "win32") {
        rmdirSync(linkPath);
      } else {
        unlinkSync(linkPath);
      }

      safeSocketSend(
        socket,
        {
          type: "skill_disable_response",
          request_id: parsed.request_id,
          success: true,
          name: parsed.name,
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
      emitSkillsUpdated(socket, safeSocketSend);
    } catch (err) {
      safeSocketSend(
        socket,
        {
          type: "skill_disable_response",
          request_id: parsed.request_id,
          success: false,
          error: err instanceof Error ? err.message : "Failed to disable skill",
        },
        "listener_skill_send_failed",
        "listener_skill_command",
      );
    }
    return true;
  }

  return false;
}

export async function handleCreateAgentCommand(
  parsed: CreateAgentCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<void> {
  try {
    // Pre-validate model so invalid requests soft-fail before createAgent().
    if (parsed.model) {
      const resolved = resolveModel(parsed.model);
      if (!resolved) {
        safeSocketSend(
          socket,
          {
            type: "create_agent_response",
            request_id: parsed.request_id,
            success: false,
            error: `Unknown model "${parsed.model}"`,
          },
          "listener_create_agent_send_failed",
          "listener_create_agent",
        );
        return;
      }
    }

    const { createAgentForPersonality } = await import("@/agent/personality");
    const result = await createAgentForPersonality({
      personalityId: parsed.personality,
      model: parsed.model,
      ...(parsed.tags && { tags: parsed.tags }),
    });

    // Pin the agent globally (favorites it) unless explicitly disabled
    if (parsed.pin_global !== false) {
      settingsManager.pinAgent(result.agent.id);
    }

    safeSocketSend(
      socket,
      {
        type: "create_agent_response",
        request_id: parsed.request_id,
        success: true,
        agent_id: result.agent.id,
        name: result.agent.name,
        model: result.agent.model ?? null,
      },
      "listener_create_agent_send_failed",
      "listener_create_agent",
    );
  } catch (err) {
    safeSocketSend(
      socket,
      {
        type: "create_agent_response",
        request_id: parsed.request_id,
        success: false,
        error: err instanceof Error ? err.message : "Failed to create agent",
      },
      "listener_create_agent_send_failed",
      "listener_create_agent",
    );
  }
}

async function handleSkillCatalogPreviewCommand(
  parsed: SkillCatalogPreviewCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<void> {
  try {
    const { previewCatalogSkill } = await import("@/agent/skill-catalog");
    const preview = await previewCatalogSkill(parsed.skill);
    safeSocketSend(
      socket,
      {
        type: "skill_catalog_preview_response",
        request_id: parsed.request_id,
        success: true,
        skill: {
          name: preview.name,
          ...(preview.description ? { description: preview.description } : {}),
          skill_md: preview.skillMd,
          source: preview.source,
          ...(preview.sourceUrl ? { source_url: preview.sourceUrl } : {}),
        },
      },
      "listener_skill_catalog_send_failed",
      "listener_skill_catalog_preview",
    );
  } catch (error) {
    safeSocketSend(
      socket,
      {
        type: "skill_catalog_preview_response",
        request_id: parsed.request_id,
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to preview skill",
      },
      "listener_skill_catalog_send_failed",
      "listener_skill_catalog_preview",
    );
  }
}

async function handleSkillCatalogInstallCommand(
  parsed: SkillCatalogInstallCommand,
  socket: WebSocket,
  safeSocketSend: SafeSocketSend,
): Promise<void> {
  try {
    const { installCatalogSkill } = await import("@/agent/skill-catalog");
    const result = await installCatalogSkill({
      reference: parsed.skill,
      agentId: parsed.agent_id,
    });
    if (result.memorySync?.status === "push_failed") {
      throw new Error(result.memorySync.summary);
    }
    safeSocketSend(
      socket,
      {
        type: "memory_updated",
        affected_paths: [`skills/${result.name}`],
        timestamp: Date.now(),
      },
      "listener_skill_catalog_send_failed",
      "listener_skill_catalog_install",
    );
    safeSocketSend(
      socket,
      {
        type: "skill_catalog_install_response",
        request_id: parsed.request_id,
        success: true,
        name: result.name,
        source: result.source,
        committed: result.committed,
        ...(result.commitSha ? { commit_sha: result.commitSha } : {}),
      },
      "listener_skill_catalog_send_failed",
      "listener_skill_catalog_install",
    );
  } catch (error) {
    safeSocketSend(
      socket,
      {
        type: "skill_catalog_install_response",
        request_id: parsed.request_id,
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to install skill",
      },
      "listener_skill_catalog_send_failed",
      "listener_skill_catalog_install",
    );
  }
}

export function handleSkillAgentProtocolCommand(
  parsed: unknown,
  context: SkillAgentCommandContext,
): boolean {
  const { socket, safeSocketSend, runDetachedListenerTask } = context;

  if (isSkillEnableCommand(parsed) || isSkillDisableCommand(parsed)) {
    runDetachedListenerTask("skill_command", async () => {
      await handleSkillCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  if (isSkillCatalogPreviewCommand(parsed)) {
    runDetachedListenerTask("skill_catalog_preview", async () => {
      await handleSkillCatalogPreviewCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  if (isSkillCatalogInstallCommand(parsed)) {
    runDetachedListenerTask("skill_catalog_install", async () => {
      await handleSkillCatalogInstallCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  if (isCreateAgentCommand(parsed)) {
    runDetachedListenerTask("create_agent_command", async () => {
      await handleCreateAgentCommand(parsed, socket, safeSocketSend);
    });
    return true;
  }

  return false;
}
