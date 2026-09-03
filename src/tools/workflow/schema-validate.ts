/**
 * Minimal JSON Schema validator for StructuredOutput results.
 *
 * Supports the subset workflow scripts realistically use: type, properties,
 * required, items, enum, const, additionalProperties (boolean), anyOf,
 * minimum/maximum, minItems/maxItems, minLength/maxLength. Unknown keywords
 * are ignored (permissive), matching how the model-facing schema is already
 * the primary enforcement layer.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function typeMatches(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  return declared === "number" && actual === "integer";
}

function validateAt(
  value: unknown,
  schema: Schema,
  path: string,
  issues: ValidationIssue[],
): void {
  const declaredType = schema.type;
  if (typeof declaredType === "string") {
    if (!typeMatches(declaredType, typeOf(value))) {
      issues.push({
        path,
        message: `expected ${declaredType}, got ${typeOf(value)}`,
      });
      return;
    }
  } else if (Array.isArray(declaredType)) {
    if (
      !declaredType.some(
        (t) => typeof t === "string" && typeMatches(t, typeOf(value)),
      )
    ) {
      issues.push({
        path,
        message: `expected one of [${declaredType.join(", ")}], got ${typeOf(value)}`,
      });
      return;
    }
  }

  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => deepEqual(e, value))
  ) {
    issues.push({
      path,
      message: `value not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
    });
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    issues.push({
      path,
      message: `expected const ${JSON.stringify(schema.const)}`,
    });
  }

  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.some((sub) => {
      const subIssues: ValidationIssue[] = [];
      validateAt(value, sub as Schema, path, subIssues);
      return subIssues.length === 0;
    });
    if (!matched)
      issues.push({ path, message: "value matched no anyOf branch" });
  }

  if (typeof value === "string") {
    if (
      typeof schema.minLength === "number" &&
      value.length < schema.minLength
    ) {
      issues.push({
        path,
        message: `string shorter than minLength ${schema.minLength}`,
      });
    }
    if (
      typeof schema.maxLength === "number" &&
      value.length > schema.maxLength
    ) {
      issues.push({
        path,
        message: `string longer than maxLength ${schema.maxLength}`,
      });
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      issues.push({ path, message: `below minimum ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      issues.push({ path, message: `above maximum ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path, message: `fewer than minItems ${schema.minItems}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      issues.push({ path, message: `more than maxItems ${schema.maxItems}` });
    }
    if (
      schema.items &&
      typeof schema.items === "object" &&
      !Array.isArray(schema.items)
    ) {
      for (let i = 0; i < value.length; i++) {
        validateAt(value[i], schema.items as Schema, `${path}[${i}]`, issues);
      }
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties =
      schema.properties && typeof schema.properties === "object"
        ? (schema.properties as Record<string, Schema>)
        : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in record)) {
          issues.push({ path, message: `missing required property "${key}"` });
        }
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (key in record) validateAt(record[key], sub, `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          issues.push({ path, message: `unexpected property "${key}"` });
        }
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate value against schema; empty array means valid. */
export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateAt(value, schema, "$", issues);
  return issues;
}
