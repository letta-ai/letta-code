import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useAnimation } from "../contexts/AnimationContext.js";
import { useTokenStreamingConfig } from "../contexts/StreamingTextContext";
import {
  type BoldSpan,
  formatStreamingHeaders,
} from "../helpers/streamingHeaderFormat";
import { colors } from "./colors.js";
import { Text } from "./Text";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function computeMaxCharsPerTick(
  backlog: number,
  desiredBacklog: number,
): number {
  // Keep increments small so it reads as per-character typing.
  // Higher backlog still ramps up, but avoids huge visual "blasts".
  if (backlog <= desiredBacklog * 3) return 1;
  if (backlog <= desiredBacklog * 6) return 2;
  if (backlog <= 400) return 3;
  if (backlog <= 1200) return 6;
  return 12;
}

function renderSlice(
  slice: string,
  globalStart: number,
  boldSpans: BoldSpan[],
  dimColor: boolean | undefined,
  color?: string,
): Array<string | ReactNode> {
  if (!slice) return [];

  const sliceStart = globalStart;
  const sliceEnd = globalStart + slice.length;
  const intersections: Array<{ start: number; end: number }> = [];
  for (const s of boldSpans) {
    const a = Math.max(sliceStart, s.start);
    const b = Math.min(sliceEnd, s.end);
    if (a < b) intersections.push({ start: a, end: b });
  }
  intersections.sort((a, b) => a.start - b.start);

  // Merge overlaps.
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of intersections) {
    const last = merged[merged.length - 1];
    if (!last || s.start > last.end) {
      merged.push({ start: s.start, end: s.end });
    } else {
      last.end = Math.max(last.end, s.end);
    }
  }

  const mk = (t: string, bold: boolean, absStart: number) => {
    if (!t) return null;
    if (!bold && !color) return t;
    const absEnd = absStart + t.length;
    return (
      <Text
        key={`${absStart}:${absEnd}:${bold ? "b" : "n"}:${color ?? ""}`}
        bold={bold}
        dimColor={dimColor}
        color={color}
      >
        {t}
      </Text>
    );
  };

  if (merged.length === 0) {
    const n = mk(slice, false, globalStart);
    return n ? [n] : [];
  }

  const out: Array<string | ReactNode> = [];
  let cursor = 0;
  for (const span of merged) {
    const a = Math.max(0, span.start - sliceStart);
    const b = Math.max(0, span.end - sliceStart);

    const before = slice.slice(cursor, a);
    const bold = slice.slice(a, b);
    const nb = mk(before, false, globalStart + cursor);
    const bb = mk(bold, true, globalStart + a);
    if (nb) out.push(nb);
    if (bb) out.push(bb);
    cursor = b;
  }

  const after = slice.slice(cursor);
  const na = mk(after, false, globalStart + cursor);
  if (na) out.push(na);
  return out;
}

/**
 * Streaming-only renderer.
 * - Reveals text at a controlled speed (typewriter).
 * - Highlights the newest trailing characters and fades them back to normal.
 *
 * Notes:
 * - This intentionally does NOT run markdown rendering while streaming.
 *   Markdown parsing + per-letter highlighting is expensive and brittle for
 *   incomplete markdown sequences.
 */
export function TypewriterGlowText({
  text,
  dimColor,
}: {
  text: string;
  dimColor?: boolean;
}) {
  const { shouldAnimate } = useAnimation();
  const cfg = useTokenStreamingConfig();

  // If animations are disabled (overflow/flicker guard), render immediately.
  const target = text ?? "";
  const immediate =
    !cfg.enabled || cfg.style !== "typewriter-glow" || !shouldAnimate;

  const [visibleLen, setVisibleLen] = useState(() =>
    immediate ? target.length : 0,
  );
  const visibleLenRef = useRef<number>(visibleLen);
  const targetLenRef = useRef<number>(target.length);
  const [fadePhase, setFadePhase] = useState<0 | 1 | 2>(2);
  const fadeTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickAtRef = useRef<number>(performance.now());
  const remainderRef = useRef<number>(0);

  // Incoming rate estimation (chars/sec) to make typewriter smooth even when the
  // underlying stream is lumpy.
  const lastTargetLenSeenRef = useRef<number>(target.length);
  const lastIncomingAtRef = useRef<number>(performance.now());
  const incomingRateEmaRef = useRef<number>(0);
  const revealRateRef = useRef<number>(cfg.typewriterCharsPerSecond);

  useEffect(() => {
    visibleLenRef.current = visibleLen;
  }, [visibleLen]);

  useEffect(() => {
    targetLenRef.current = target.length;
  }, [target.length]);

  // Keep visibleLen in bounds when target changes (e.g. normalization changes).
  useEffect(() => {
    if (immediate) {
      setVisibleLen(target.length);
      remainderRef.current = 0;
      return;
    }
    setVisibleLen((prev) => clamp(prev, 0, target.length));
  }, [target.length, immediate]);

  // Update incoming-rate EMA when new content arrives.
  useEffect(() => {
    if (immediate) {
      lastTargetLenSeenRef.current = target.length;
      incomingRateEmaRef.current = 0;
      return;
    }

    const now = performance.now();
    const prevLen = lastTargetLenSeenRef.current;
    const nextLen = target.length;
    lastTargetLenSeenRef.current = nextLen;

    if (nextLen <= prevLen) return;

    const delta = nextLen - prevLen;
    const dtMs = Math.max(1, now - lastIncomingAtRef.current);
    lastIncomingAtRef.current = now;

    // Instantaneous chars/sec, capped to avoid spikes on pathological chunking.
    const inst = Math.min(5000, (delta * 1000) / dtMs);
    const alpha = 0.25;
    const prevEma = incomingRateEmaRef.current;
    incomingRateEmaRef.current =
      prevEma > 0 ? prevEma * (1 - alpha) + inst * alpha : inst;
  }, [immediate, target.length]);

  // Reveal loop (adaptive: follows incoming rate, speeds up to catch up, but
  // tries to add only a few chars per frame when near the head).
  useEffect(() => {
    if (immediate) {
      if (revealTimerRef.current) {
        clearInterval(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      return;
    }

    const intervalMs = clamp(cfg.refreshIntervalMs, 10, 250);
    const baseMaxCps = clamp(cfg.typewriterCharsPerSecond, 60, 2000);
    const minCps = clamp(baseMaxCps * 0.2, 25, 140);
    const maxCps = clamp(baseMaxCps * 3, 300, 2000);

    // Easing time constant for reveal-rate changes.
    const rateTauSec = 0.15;
    const desiredLagSec = 0.12;
    const catchupTimeSec = 0.25;

    lastTickAtRef.current = performance.now();

    if (revealTimerRef.current) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }

    revealTimerRef.current = setInterval(() => {
      const now = performance.now();
      const dtMs = Math.max(0, now - lastTickAtRef.current);
      lastTickAtRef.current = now;

      const targetLen = targetLenRef.current;
      const currentVisible = visibleLenRef.current;
      const backlog = Math.max(0, targetLen - currentVisible);
      if (backlog <= 0) {
        // Keep the interval alive so we can react immediately when new text
        // arrives after a lumpy pause (avoids "nothing for N seconds" then burst).
        return;
      }

      // Decay incoming-rate estimate during pauses.
      const sinceIncomingMs = now - lastIncomingAtRef.current;
      if (sinceIncomingMs > 400) {
        const decay = Math.exp(-(sinceIncomingMs - 400) / 1000 / 1.2);
        incomingRateEmaRef.current *= decay;
      }

      // Backlog-aware target cps.
      const incoming = clamp(incomingRateEmaRef.current, 0, maxCps);
      const desiredBacklog = 10 + incoming * desiredLagSec;
      const error = Math.max(0, backlog - desiredBacklog);

      // Follow observed incoming rate up to baseMaxCps.
      const incomingTarget = clamp(incoming * 1.05, minCps, baseMaxCps);
      const catchupBoost = error > 0 ? error / catchupTimeSec : 0;
      const targetCps = clamp(incomingTarget + catchupBoost, minCps, maxCps);

      // Smoothly lerp reveal rate towards target.
      const dtSec = dtMs / 1000;
      const lerpFactor = 1 - Math.exp(-dtSec / rateTauSec);
      revealRateRef.current =
        revealRateRef.current +
        (targetCps - revealRateRef.current) * lerpFactor;

      // Convert elapsed time into chars to reveal.
      const rawAdd = (revealRateRef.current * dtMs) / 1000;
      const total = remainderRef.current + rawAdd;
      let add = Math.floor(total);
      remainderRef.current = total - add;

      // Ensure progress.
      if (add <= 0) add = 1;

      const cap = computeMaxCharsPerTick(backlog, desiredBacklog);
      add = Math.min(add, cap);

      setVisibleLen((prev) => {
        const next = clamp(prev + add, 0, targetLen);
        visibleLenRef.current = next;
        return next;
      });
    }, intervalMs);

    return () => {
      if (revealTimerRef.current) {
        clearInterval(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };
  }, [cfg.refreshIntervalMs, cfg.typewriterCharsPerSecond, immediate]);

  // Glow fade: when new characters appear, briefly highlight the tail.
  useEffect(() => {
    if (immediate) return;

    // Clear old timers.
    for (const t of fadeTimersRef.current) clearTimeout(t);
    fadeTimersRef.current = [];

    // If nothing is visible yet, skip.
    if (visibleLen === 0) {
      setFadePhase(2);
      return;
    }

    // Reset to bright and fade down.
    setFadePhase(0);
    const total = clamp(cfg.glowFadeMs, 40, 500);
    const t1 = setTimeout(() => setFadePhase(1), Math.floor(total * 0.25));
    const t2 = setTimeout(() => setFadePhase(2), total);
    fadeTimersRef.current = [t1, t2];

    return () => {
      for (const t of fadeTimersRef.current) clearTimeout(t);
      fadeTimersRef.current = [];
    };
  }, [cfg.glowFadeMs, immediate, visibleLen]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearInterval(revealTimerRef.current);
      for (const t of fadeTimersRef.current) clearTimeout(t);
      fadeTimersRef.current = [];
    };
  }, []);

  const displayText = useMemo(() => {
    if (immediate) return target;
    return target.slice(0, clamp(visibleLen, 0, target.length));
  }, [immediate, target, visibleLen]);

  // Render common "**Header**" pattern nicely during streaming (especially for reasoning).
  const { text: displayTextStyled, boldSpans } = useMemo(
    () => formatStreamingHeaders(displayText),
    [displayText],
  );

  // Glow tail: 1 hot, 2 warm, 3 cool (then normal text).
  const glowChars = clamp(cfg.glowChars, 0, 6);
  const glowStart = Math.max(0, displayTextStyled.length - glowChars);
  const prefix = displayTextStyled.slice(0, glowStart);
  const tail = displayTextStyled.slice(glowStart);

  const hotLen = Math.min(1, tail.length);
  const warmLen = Math.min(2, Math.max(0, tail.length - hotLen));
  const coolLen = Math.min(3, Math.max(0, tail.length - hotLen - warmLen));

  const tailA = hotLen > 0 ? tail.slice(-hotLen) : "";
  const tailB =
    warmLen > 0 ? tail.slice(-(hotLen + warmLen), -hotLen || undefined) : "";
  const tailC =
    coolLen > 0
      ? tail.slice(0, Math.max(0, tail.length - hotLen - warmLen))
      : "";

  const hotColor = colors.streamingGlow.hot;
  const warmColor = colors.streamingGlow.warm;
  const coolColor = colors.streamingGlow.cool;

  const tailAColor =
    fadePhase === 0 ? hotColor : fadePhase === 1 ? warmColor : undefined;
  const tailBColor =
    fadePhase === 0 ? warmColor : fadePhase === 1 ? coolColor : undefined;
  const tailCColor = fadePhase === 0 ? coolColor : undefined;

  return (
    <Text dimColor={dimColor} wrap="wrap">
      {renderSlice(prefix, 0, boldSpans, dimColor)}
      {renderSlice(tailC, glowStart, boldSpans, dimColor, tailCColor)}
      {renderSlice(
        tailB,
        glowStart + tailC.length,
        boldSpans,
        dimColor,
        tailBColor,
      )}
      {renderSlice(
        tailA,
        glowStart + tailC.length + tailB.length,
        boldSpans,
        dimColor,
        tailAColor,
      )}
    </Text>
  );
}
