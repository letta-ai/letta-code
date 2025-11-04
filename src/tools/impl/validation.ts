export function validateRequiredParams<T extends object>(
  args: T,
  required: string[],
  toolName: string,
): void {
  const missing = required.filter((key) => !(key in args));
  if (missing.length > 0) {
    const received = Object.keys(args).join(", ");
    throw new Error(
      `${toolName} tool missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Received parameters: ${received}`,
    );
  }
}

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Validates that parameter values match their expected types from the JSON schema.
 * Throws a clear error if types don't match.
 */
export function validateParamTypes(
  args: Record<string, unknown>,
  schema: JsonSchema,
  toolName: string,
): void {
  if (!schema.properties) return;

  for (const [paramName, paramSchema] of Object.entries(schema.properties)) {
    const value = args[paramName];

    // Skip undefined optional parameters
    if (value === undefined) continue;

    const expectedType = paramSchema.type;
    if (!expectedType) continue;

    const actualType = getJsonSchemaType(value);

    if (actualType !== expectedType) {
      const article = ["array", "object", "integer"].includes(expectedType)
        ? "an"
        : "a";
      throw new Error(
        `${toolName}: Parameter '${paramName}' must be ${article} ${expectedType}, received ${actualType}`,
      );
    }

    // Additional validation for arrays to ensure they contain the right element types
    if (expectedType === "array" && Array.isArray(value) && paramSchema.items) {
      const itemType = paramSchema.items.type;
      if (itemType) {
        for (let i = 0; i < value.length; i++) {
          const itemActualType = getJsonSchemaType(value[i]);
          if (itemActualType !== itemType) {
            const article = ["array", "object", "integer"].includes(itemType)
              ? "an"
              : "a";
            throw new Error(
              `${toolName}: Parameter '${paramName}[${i}]' must be ${article} ${itemType}, received ${itemActualType}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Gets the JSON Schema type name for a JavaScript value.
 */
function getJsonSchemaType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (typeof value === "string") return "string";
  return "unknown";
}
