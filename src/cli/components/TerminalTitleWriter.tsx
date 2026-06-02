import { memo, useEffect, useMemo, useRef } from "react";
import {
  clearTerminalTitle,
  setTerminalTitle,
} from "@/cli/helpers/terminal-title";
import {
  renderActionRequiredWindowTitle,
  renderWindowTitle,
  resolveWindowTitleConfig,
  TERMINAL_TITLE_ACTION_REQUIRED_INTERVAL_MS,
  TERMINAL_TITLE_ACTION_REQUIRED_PREFIX,
  TERMINAL_TITLE_ACTION_REQUIRED_PREFIX_HIDDEN,
  TERMINAL_TITLE_SPINNER_FRAMES,
  TERMINAL_TITLE_SPINNER_INTERVAL_MS,
  titleUsesActivity,
  type WindowTitleData,
} from "@/cli/helpers/window-title-config";
import { useFrameCycle } from "./spinners/use-frame-cycle";

const TERMINAL_TITLE_ACTION_REQUIRED_FRAMES = [
  TERMINAL_TITLE_ACTION_REQUIRED_PREFIX,
  TERMINAL_TITLE_ACTION_REQUIRED_PREFIX_HIDDEN,
] as const;

export interface TerminalTitleWriterProps {
  projectDirectory: string;
  /** Changes when /title closes after persisting settings, so config is re-read. */
  configRefreshKey: unknown;
  titleData: WindowTitleData;
  shouldAnimate: boolean;
  hasActiveProgress: boolean;
  requiresAction: boolean;
  previewTitle: string | null | undefined;
}

/**
 * Side-effect-only terminal-title writer.
 *
 * Keeping animation state here prevents the 10Hz title spinner from re-rendering
 * AppCoordinator/AppView while still sharing Codex's frame cadence and title
 * rendering rules.
 */
export const TerminalTitleWriter = memo(function TerminalTitleWriter({
  projectDirectory,
  configRefreshKey,
  titleData,
  shouldAnimate,
  hasActiveProgress,
  requiresAction,
  previewTitle,
}: TerminalTitleWriterProps) {
  const lastManagedTerminalTitleRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: configRefreshKey changes after /title persists settings; recompute the config on close.
  const terminalTitleItems = useMemo(
    () => resolveWindowTitleConfig(projectDirectory),
    [projectDirectory, configRefreshKey],
  );
  const terminalTitleUsesActivity = titleUsesActivity(terminalTitleItems);
  const terminalTitleShowsActionRequired =
    requiresAction && terminalTitleUsesActivity;
  const terminalTitleHasActiveProgress =
    !terminalTitleShowsActionRequired && hasActiveProgress;
  const terminalTitleSpinnerFrameIndex = useFrameCycle(
    TERMINAL_TITLE_SPINNER_FRAMES,
    TERMINAL_TITLE_SPINNER_INTERVAL_MS,
    shouldAnimate &&
      terminalTitleUsesActivity &&
      terminalTitleHasActiveProgress,
  );
  const terminalTitleActionFrameIndex = useFrameCycle(
    TERMINAL_TITLE_ACTION_REQUIRED_FRAMES,
    TERMINAL_TITLE_ACTION_REQUIRED_INTERVAL_MS,
    shouldAnimate && terminalTitleShowsActionRequired,
  );
  const terminalTitleActionPrefix =
    TERMINAL_TITLE_ACTION_REQUIRED_FRAMES[terminalTitleActionFrameIndex] ??
    TERMINAL_TITLE_ACTION_REQUIRED_PREFIX;
  const terminalTitleData = useMemo<WindowTitleData>(
    () => ({
      ...titleData,
      activityFrame:
        shouldAnimate && terminalTitleHasActiveProgress
          ? (TERMINAL_TITLE_SPINNER_FRAMES[terminalTitleSpinnerFrameIndex] ??
            null)
          : null,
    }),
    [
      shouldAnimate,
      terminalTitleHasActiveProgress,
      terminalTitleSpinnerFrameIndex,
      titleData,
    ],
  );
  const computedTitle = useMemo(
    () =>
      terminalTitleShowsActionRequired
        ? renderActionRequiredWindowTitle(
            terminalTitleItems,
            terminalTitleData,
            terminalTitleActionPrefix,
          )
        : renderWindowTitle(terminalTitleItems, terminalTitleData),
    [
      terminalTitleActionPrefix,
      terminalTitleData,
      terminalTitleItems,
      terminalTitleShowsActionRequired,
    ],
  );
  const title = previewTitle === undefined ? computedTitle : previewTitle;

  useEffect(() => {
    if (title === lastManagedTerminalTitleRef.current) {
      return;
    }

    if (title === null) {
      if (lastManagedTerminalTitleRef.current !== null) {
        clearTerminalTitle();
        lastManagedTerminalTitleRef.current = null;
      }
      return;
    }

    const result = setTerminalTitle(title);
    if (result === "applied") {
      lastManagedTerminalTitleRef.current = title;
      return;
    }

    if (lastManagedTerminalTitleRef.current !== null) {
      clearTerminalTitle();
      lastManagedTerminalTitleRef.current = null;
    }
  }, [title]);

  useEffect(() => {
    return () => {
      if (lastManagedTerminalTitleRef.current !== null) {
        clearTerminalTitle();
        lastManagedTerminalTitleRef.current = null;
      }
    };
  }, []);

  return null;
});
