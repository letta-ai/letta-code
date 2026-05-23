export interface DefaultStatuslineRendererActivation {
  hideFooterContent: boolean;
  isBashMode: boolean;
  modeActive: boolean;
  preemptionActive: boolean;
  statusLineActive: boolean;
  statusLineRight?: string;
  transientHintActive: boolean;
}

export function shouldRenderDefaultStatuslineRenderer({
  hideFooterContent,
  isBashMode,
  modeActive,
  preemptionActive,
  statusLineActive,
  statusLineRight,
  transientHintActive,
}: DefaultStatuslineRendererActivation): boolean {
  return (
    !hideFooterContent &&
    !preemptionActive &&
    !transientHintActive &&
    !statusLineActive &&
    !isBashMode &&
    !statusLineRight &&
    !modeActive
  );
}
