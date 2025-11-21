export function slugify(value: string): string {
  const normalized = value.normalize("NFKD");
  const withoutMarks = normalized.replace(/[\u0300-\u036f]/g, "");
  const replaced = withoutMarks.replace(/[^a-zA-Z0-9]+/g, "-");
  const trimmed = replaced.replace(/^-+|-+$/g, "");
  return trimmed.toLowerCase();
}