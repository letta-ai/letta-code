import { memo } from "react";
import { colors } from "./colors.js";
import { Text } from "./Text";

interface ShimmerTextProps {
  color?: string;
  boldPrefix?: string;
  message: string;
  shimmerOffset: number;
  wrap?:
    | "wrap"
    | "truncate"
    | "truncate-start"
    | "truncate-middle"
    | "truncate-end";
}

export const ShimmerText = memo(function ShimmerText({
  color = colors.status.processing,
  boldPrefix,
  message,
  shimmerOffset,
  wrap,
}: ShimmerTextProps) {
  const prefix = boldPrefix ? `${boldPrefix} ` : "";
  const prefixLen = prefix.length;
  const fullText = `${prefix}${message}…`;

  // Avoid per-character ANSI styling. Rendering shimmer with a small number of
  // <Text> spans keeps Ink's wrapping/truncation behavior stable during resize.
  const start = Math.max(0, shimmerOffset);
  const end = Math.max(start, shimmerOffset + 3);

  type Segment = { key: string; text: string; color?: string; bold?: boolean };
  const segments: Segment[] = [];

  const pushRegion = (
    text: string,
    regionStart: number,
    regionColor?: string,
  ) => {
    if (!text) return;

    const regionEnd = regionStart + text.length;
    const crossesPrefix = regionStart < prefixLen && regionEnd > prefixLen;

    if (!crossesPrefix) {
      const bold = regionStart < prefixLen;
      segments.push({
        key: `${regionStart}:${regionColor ?? ""}:${bold ? "b" : "n"}`,
        text,
        color: regionColor,
        bold,
      });
      return;
    }

    const cut = Math.max(0, prefixLen - regionStart);
    const left = text.slice(0, cut);
    const right = text.slice(cut);

    if (left)
      segments.push({
        key: `${regionStart}:${regionColor ?? ""}:b`,
        text: left,
        color: regionColor,
        bold: true,
      });
    if (right)
      segments.push({
        key: `${prefixLen}:${regionColor ?? ""}:n`,
        text: right,
        color: regionColor,
        bold: false,
      });
  };

  const before = fullText.slice(0, start);
  const shimmer = fullText.slice(start, end);
  const after = fullText.slice(end);

  pushRegion(before, 0, color);
  pushRegion(shimmer, start, colors.status.processingShimmer);
  pushRegion(after, end, color);

  return (
    <Text wrap={wrap}>
      {segments.map((seg) => (
        <Text key={seg.key} color={seg.color} bold={seg.bold}>
          {seg.text}
        </Text>
      ))}
    </Text>
  );
});
