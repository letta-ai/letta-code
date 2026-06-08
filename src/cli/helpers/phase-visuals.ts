import { colors } from "@/cli/components/colors.js";

export type ExecutionPhase =
  | "requesting"
  | "thinking"
  | "toolUse"
  | "responding"
  | null;

export type PhaseOverlay = "sin-pulse" | "two-sided" | null;

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
  /** Whole-word overlay period in ms. Larger = slower light/dark breathing. */
  overlayPeriodMs?: number;
  /**
   * Whether the bright-cell sweep is rendered. Defaults to true. Set false
   * for phases where the row should breathe color without any horizontal
   * traversal — useful when the breathe alone communicates activity.
   */
  hasSweep?: boolean;
  /** `two-sided` overlay: color reached on the upper lobe of the sin curve. */
  lighterColor?: string;
  /** `two-sided` overlay: color reached on the lower lobe of the sin curve. */
  deeperColor?: string;
};

const DEFAULT_SIN_PULSE_OVERLAY_PERIOD_MS = 2000;
const DEFAULT_TWO_SIDED_OVERLAY_PERIOD_MS = 3000;

const REQUESTING: PhaseVisual = {
  tickMs: 50,
  direction: "ltr",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: null,
};

const THINKING: PhaseVisual = {
  tickMs: 200,
  direction: "ltr",
  // Shared base across all phases so phase entry doesn't cause a color jump.
  // The thinking-specific "breath" comes from the two-sided overlay below,
  // which oscillates symmetrically toward a near-white anchor on one lobe and
  // a deep-saturated-purple anchor on the other. Anchors intentionally far
  // from the base to give the row a visible "deep contemplation" sway.
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: "two-sided",
  overlayPeriodMs: 6000,
  hasSweep: false,
  lighterColor: "#D8D8FF",
  deeperColor: "#2828A0",
};

const TOOL_USE: PhaseVisual = {
  tickMs: 200,
  direction: "rtl",
  baseColor: colors.status.processing,
  shimmerColor: colors.status.processingShimmer,
  overlay: "sin-pulse",
};

const RESPONDING: PhaseVisual = {
  // Between requesting (50ms) and thinking/toolUse (200ms) — the model is
  // producing tokens, the row should feel responsive rather than contemplative.
  tickMs: 100,
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
 * Compute the effective base color for a phase at phase-local time `t` (ms).
 * Caller is responsible for passing time measured from phase-entry, not from
 * a global clock — that way the curve always begins at its anchor when the
 * phase becomes active, instead of landing mid-cycle.
 *
 *  - `sin-pulse`: blends baseColor → shimmerColor on a 2s cos curve by
 *    default. Anchored at baseColor (calm) and breathes lighter.
 *  - `two-sided`: 3s sin curve by default. Positive lobe blends baseColor → lighterColor,
 *    negative lobe blends baseColor → deeperColor. Crosses through unblended
 *    baseColor twice per period — so phase entry and every half-period look
 *    identical to neighboring phases' resting color (no jump).
 */
export function effectiveBaseColor(visual: PhaseVisual, t: number): string {
  if (!visual.overlay) return visual.baseColor;
  if (visual.overlay === "sin-pulse") {
    const periodMs =
      visual.overlayPeriodMs ?? DEFAULT_SIN_PULSE_OVERLAY_PERIOD_MS;
    const f = (1 - Math.cos((t * 2 * Math.PI) / periodMs)) / 2;
    return blendHex(visual.baseColor, visual.shimmerColor, f * 0.55);
  }
  if (visual.overlay === "two-sided") {
    const periodMs =
      visual.overlayPeriodMs ?? DEFAULT_TWO_SIDED_OVERLAY_PERIOD_MS;
    const f = Math.sin((t * 2 * Math.PI) / periodMs);
    if (f >= 0 && visual.lighterColor) {
      return blendHex(visual.baseColor, visual.lighterColor, f * 0.85);
    }
    if (f < 0 && visual.deeperColor) {
      return blendHex(visual.baseColor, visual.deeperColor, -f * 0.85);
    }
    return visual.baseColor;
  }
  return visual.baseColor;
}
