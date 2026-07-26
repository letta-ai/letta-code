export function formatChannelInlineCode(value: string): string {
  const longestBacktickRun = (value.match(/`+/g) ?? []).reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  const needsPadding = value.startsWith("`") || value.endsWith("`");
  return needsPadding
    ? `${fence} ${value} ${fence}`
    : `${fence}${value}${fence}`;
}
