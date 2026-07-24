export type ChannelModelDisplay = {
  modelLabel: string;
  modelHandle: string | null;
};

export function formatChannelModelDisplay(params: ChannelModelDisplay): string {
  const handleText =
    params.modelHandle && params.modelHandle !== params.modelLabel
      ? ` (${params.modelHandle})`
      : "";
  return `${params.modelLabel}${handleText}`;
}
