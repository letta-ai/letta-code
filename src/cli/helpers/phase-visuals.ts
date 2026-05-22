import { colors } from "@/cli/components/colors.js";

export type ExecutionPhase =
  | "requesting"
  | "thinking"
  | "toolUse"
  | "responding"
  | null;

export type PhaseOverlay = "sin-pulse" | "warning-blend" | null;

export type PhaseVisual = {
  /** Sweep tick in ms. Smaller = faster bright cell. */
  tickMs: number;
  /** Sweep direction across the text. */
  direction: "ltr" | "rtl";
  /** Color of non-shimmer characters (the resting tint). */
  baseColor: string;
  /** Color of the bright cell. */
  shimmerColor: string;
  /** Optional whole-word color modulation layered under the sweep. */
  overlay: PhaseOverlay;
};

const REQUESTING: PhaseVisual = {
  tickMs: 50,
  direction: "ltr",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: null,
};

const THINKING: PhaseVisual = {
  tickMs: 200,
  direction: "rtl",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: "warning-blend",
};

const TOOL_USE: PhaseVisual = {
  tickMs: 200,
  direction: "rtl",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: "sin-pulse",
};

const RESPONDING: PhaseVisual = {
  tickMs: 200,
  direction: "rtl",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: null,
};

const DEFAULT_VISUAL: PhaseVisual = {
  tickMs: 120,
  direction: "ltr",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: null,
};

export function getPhaseVisual(phase: ExecutionPhase): PhaseVisual {
  switch (phase) {
    case "requesting":
      return REQUESTING;
    case "thinking":
      return THINKING;
    case "toolUse":
      return TOOL_USE;
    case "responding":
      return RESPONDING;
    default:
      return DEFAULT_VISUAL;
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const s = hex.trim().replace(/^#/, "");
  if (s.length !== 3 && s.length !== 6) return null;
  const full =
    s.length === 3
      ? s
          .split("")
          .map((c) => c + c)
          .join("")
      : s;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function toHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * Linear-RGB blend of two hex colors. Falls back to `a` if either side is
 * unparseable (e.g. a named color like "cyan"), which keeps the existing
 * behavior unchanged when overlays are off.
 */
export function blendHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const k = clamp01(t);
  return toHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/**
 * Compute the effective base color for a phase at time `t` (ms). The sweep's
 * bright cell is layered on top of whatever this returns.
 *
 *  - `sin-pulse`: blends baseColor → shimmerColor on a 2s sin curve, mirroring
 *    the tool-use "breathing" in Claude Code v2.1.x.
 *  - `warning-blend`: blends baseColor → warningColor on a slower 3s sin curve
 *    that stays within a warm band (25%–55% mix), giving the thinking row a
 *    visible warm breathing distinct from the cooler tool-use pulse.
 */
export function effectiveBaseColor(
  visual: PhaseVisual,
  warningColor: string,
  t: number,
): string {
  if (!visual.overlay) return visual.baseColor;
  if (visual.overlay === "sin-pulse") {
    const f = (Math.sin((t * Math.PI) / 1000) + 1) / 2;
    return blendHex(visual.baseColor, visual.shimmerColor, f * 0.55);
  }
  if (visual.overlay === "warning-blend") {
    const f = (Math.sin((t * Math.PI) / 1500) + 1) / 2;
    return blendHex(visual.baseColor, warningColor, 0.25 + f * 0.3);
  }
  return visual.baseColor;
}
