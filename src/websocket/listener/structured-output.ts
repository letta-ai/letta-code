export function validateResponseFormat(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "response_format must be an object";
  }
  const format = value as Record<string, unknown>;
  if (format.type !== "json_schema")
    return "response_format.type must be json_schema";
  const jsonSchema = format.json_schema;
  if (
    !jsonSchema ||
    typeof jsonSchema !== "object" ||
    Array.isArray(jsonSchema)
  ) {
    return "response_format.json_schema must be an object";
  }
  const schema = (jsonSchema as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return "response_format.json_schema.schema must be an object";
  }
  return null;
}

export function assertValidResponseFormat(value: unknown): void {
  const error = validateResponseFormat(value);
  if (error) throw new Error(`Protocol violation: ${error}`);
}
