export interface DefaultStatuslineRendererActivation {
  hideFooterContent: boolean;
  isBashMode: boolean;
  modeActive: boolean;
  preemptionActive: boolean;
  transientHintActive: boolean;
}

export function shouldRenderDefaultStatuslineRenderer({
  hideFooterContent,
  isBashMode,
  modeActive,
  preemptionActive,
  transientHintActive,
}: DefaultStatuslineRendererActivation): boolean {
  return (
    !hideFooterContent &&
    !preemptionActive &&
    !transientHintActive &&
    !isBashMode &&
    !modeActive
  );
}
