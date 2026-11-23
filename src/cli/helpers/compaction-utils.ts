export function extractCompactionSummary(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed.type === "system_alert" && typeof parsed.message === "string") {
      const summaryMatch = parsed.message.match(
        /The following is an? (?:in-context recursive )?summary(?: of the (?:previous|prior) messages)?:\s*([\s\S]*)/,
      );
      if (summaryMatch?.[1]) {
        return summaryMatch[1].trim();
      }
      return parsed.message;
    }
  } catch {}
  return null;
}
