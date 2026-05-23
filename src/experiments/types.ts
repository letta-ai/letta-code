export type ExperimentId =
  | "conversation_titles"
  | "desktop_conversation_bootstrap"
  | "node"
  | "tui_cron";

export type ExperimentSource = "override" | "env" | "default";

export interface ExperimentDefinition {
  id: ExperimentId;
  label: string;
  description: string;
  envVar?: string;
}

export interface ExperimentSnapshot extends ExperimentDefinition {
  enabled: boolean;
  source: ExperimentSource;
  override: boolean | null;
}
