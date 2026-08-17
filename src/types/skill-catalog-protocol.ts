export interface SkillEnableCommand {
  type: "skill_enable";
  request_id: string;
  /** Absolute path to the skill directory on the local machine. */
  skill_path: string;
}

export interface SkillEnableResponseMessage {
  type: "skill_enable_response";
  request_id: string;
  success: boolean;
  name?: string;
  skill_path?: string;
  link_path?: string;
  error?: string;
}

export interface SkillDisableCommand {
  type: "skill_disable";
  request_id: string;
  /** Skill name (symlink name in ~/.letta/skills/). */
  name: string;
}

export interface SkillDisableResponseMessage {
  type: "skill_disable_response";
  request_id: string;
  success: boolean;
  name?: string;
  error?: string;
}

export interface CatalogSkillReferenceMessage {
  source: string;
  name: string;
  identifier?: string;
}

export interface SkillCatalogPreviewCommand {
  type: "skill_catalog_preview";
  request_id: string;
  skill: CatalogSkillReferenceMessage;
}

export interface SkillCatalogPreviewResponseMessage {
  type: "skill_catalog_preview_response";
  request_id: string;
  success: boolean;
  skill?: {
    name: string;
    description?: string;
    skill_md: string;
    source: string;
    source_url?: string;
  };
  error?: string;
}

export interface SkillCatalogInstallCommand {
  type: "skill_catalog_install";
  request_id: string;
  agent_id: string;
  skill: CatalogSkillReferenceMessage;
}

export interface SkillCatalogInstallResponseMessage {
  type: "skill_catalog_install_response";
  request_id: string;
  success: boolean;
  name?: string;
  source?: string;
  committed?: boolean;
  commit_sha?: string;
  error?: string;
}

export interface SkillsUpdatedMessage {
  type: "skills_updated";
  timestamp: number;
}
