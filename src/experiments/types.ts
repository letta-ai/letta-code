export type ExperimentId =
  | "artifacts"
  | "conversation_titles"
  | "desktop_conversation_bootstrap"
  | "diffs"
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
