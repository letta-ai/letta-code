import type { ModelReasoningEffort } from "@/agent/model";

export function truncateStatuslineText(
  value: string,
  maxChars: number,
): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

export function formatStatuslineReasoningEffort(
  effort: ModelReasoningEffort | null | undefined,
): string | null {
  if (effort === "none") return null;
  if (effort === "xhigh") return "xhigh";
  if (effort === "max") return "max";
  if (effort === "minimal") return "minimal";
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  return null;
}
