export type ExperimentId =
  | "cloud_monitors"
  | "cloud_watch_pr"
  | "artifacts"
  | "conversation_titles"
  | "desktop_conversation_bootstrap"
  | "diffs";

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

export function isRemoteExperimentId(value: unknown): value is ExperimentId {
  return (
    value === "conversation_titles" ||
    value === "desktop_conversation_bootstrap"
  );
}
