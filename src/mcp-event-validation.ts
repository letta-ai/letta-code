import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const draft7 = new Ajv({
  strict: false,
  validateFormats: false,
  ownProperties: true,
});
const draft2020 = new Ajv2020({
  strict: false,
  validateFormats: false,
  ownProperties: true,
});

export function validateMcpEventArguments(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
) {
  const validator =
    typeof schema.$schema === "string" && schema.$schema.includes("draft-07")
      ? draft7
      : draft2020;
  // Use a per-descriptor validator. Servers may reuse a schema ID with
  // different content, and compilation must never fetch remote references.
  try {
    const validate = validator.compile(schema);
    if (!validate(args)) {
      throw new Error(
        `Invalid MCP event arguments: ${validator.errorsText(validate.errors)}`,
      );
    }
  } finally {
    validator.removeSchema(schema);
  }
}
