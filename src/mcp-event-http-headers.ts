import { isRecord } from "@/utils/type-guards";

interface HeaderDeclaration {
  path: string[];
  name: string;
}

export function eventHeaderDeclarations(schema: unknown): HeaderDeclaration[] {
  const declarations: HeaderDeclaration[] = [];
  const names = new Set<string>();
  function visit(node: unknown, path: string[] | null) {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, null);
      return;
    }
    if (!isRecord(node)) return;
    if (Object.hasOwn(node, "x-mcp-header")) {
      const name = node["x-mcp-header"];
      if (
        !path?.length ||
        typeof name !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        names.has(name.toLowerCase()) ||
        !["integer", "string", "boolean"].includes(String(node.type))
      ) {
        throw new Error("Invalid x-mcp-header declaration");
      }
      names.add(name.toLowerCase());
      declarations.push({ path, name });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "properties" && isRecord(child)) {
        for (const [property, propertySchema] of Object.entries(child)) {
          visit(propertySchema, path && [...path, property]);
        }
      } else if (
        !["x-mcp-header", "default", "examples", "enum", "const"].includes(key)
      ) {
        visit(child, null);
      }
    }
  }
  visit(schema, []);
  return declarations;
}

export function encodeEventHeader(value: string): string {
  if (
    value.length > 0 &&
    value.trim() === value &&
    /^[\t\x20-\x7e]+$/.test(value) &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
  )
    return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function eventHttpHeaders(
  declarations: HeaderDeclaration[],
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of declarations) {
    let value: unknown = args;
    for (const key of header.path) {
      value =
        isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    }
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      Number.isSafeInteger(value)
    ) {
      headers[`Mcp-Param-${header.name}`] = encodeEventHeader(String(value));
    }
  }
  return headers;
}
