import { createContext, type ReactNode, useContext, useMemo } from "react";

export type TokenStreamingStyle = "plain" | "typewriter-glow";

export type TokenStreamingConfig = {
  enabled: boolean;
  style: TokenStreamingStyle;
  /** Max UI redraw rate for streaming text animations (typewriter/glow). */
  refreshIntervalMs: number;
  /** Typewriter reveal speed (chars/sec). */
  typewriterCharsPerSecond: number;
  /** Number of trailing characters to highlight as "new". */
  glowChars: number;
  /** Time for the glow highlight to fade back to normal (ms). */
  glowFadeMs: number;
};

const DEFAULT_CONFIG: TokenStreamingConfig = {
  enabled: false,
  style: "plain",
  // 60fps cap by default for smoother typewriter/glow.
  refreshIntervalMs: 16,
  typewriterCharsPerSecond: 300,
  glowChars: 6,
  glowFadeMs: 140,
};

const StreamingTextContext =
  createContext<TokenStreamingConfig>(DEFAULT_CONFIG);

export function useTokenStreamingConfig(): TokenStreamingConfig {
  return useContext(StreamingTextContext);
}

export function TokenStreamingProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: TokenStreamingConfig;
}) {
  const value = useMemo(() => config, [config]);
  return (
    <StreamingTextContext.Provider value={value}>
      {children}
    </StreamingTextContext.Provider>
  );
}
