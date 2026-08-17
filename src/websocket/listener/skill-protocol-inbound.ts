import type {
  SkillCatalogInstallCommand,
  SkillCatalogPreviewCommand,
  SkillDisableCommand,
  SkillEnableCommand,
} from "@/types/skill-catalog-protocol";

export function isSkillEnableCommand(
  value: unknown,
): value is SkillEnableCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    skill_path?: unknown;
  };
  return (
    command.type === "skill_enable" &&
    typeof command.request_id === "string" &&
    typeof command.skill_path === "string"
  );
}

export function isSkillDisableCommand(
  value: unknown,
): value is SkillDisableCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    name?: unknown;
  };
  return (
    command.type === "skill_disable" &&
    typeof command.request_id === "string" &&
    typeof command.name === "string"
  );
}

function isCatalogSkillReference(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const skill = value as {
    source?: unknown;
    name?: unknown;
    identifier?: unknown;
  };
  return (
    typeof skill.source === "string" &&
    typeof skill.name === "string" &&
    (skill.identifier === undefined || typeof skill.identifier === "string")
  );
}

export function isSkillCatalogPreviewCommand(
  value: unknown,
): value is SkillCatalogPreviewCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    skill?: unknown;
  };
  return (
    command.type === "skill_catalog_preview" &&
    typeof command.request_id === "string" &&
    isCatalogSkillReference(command.skill)
  );
}

export function isSkillCatalogInstallCommand(
  value: unknown,
): value is SkillCatalogInstallCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    skill?: unknown;
  };
  return (
    command.type === "skill_catalog_install" &&
    typeof command.request_id === "string" &&
    typeof command.agent_id === "string" &&
    isCatalogSkillReference(command.skill)
  );
}
