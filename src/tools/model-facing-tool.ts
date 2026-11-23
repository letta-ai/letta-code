export interface JsonSchema {
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
}

export type FunctionToolForm = {
  type: "function";
  description: string;
  parameters: JsonSchema;
};

export type CustomToolInputFormat =
  | { type: "text" }
  | {
      type: "grammar";
      syntax: "lark" | "regex";
      definition: string;
    };

export type CustomToolForm = {
  type: "custom";
  description: string;
  format?: CustomToolInputFormat;
  functionFallback: FunctionToolForm;
};

export type ModelFacingToolForm = FunctionToolForm | CustomToolForm;

export type FunctionOnlyToolPayload = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export function functionToolForm(input: {
  description: string;
  parameters: JsonSchema;
}): FunctionToolForm {
  return {
    type: "function",
    description: input.description,
    parameters: input.parameters,
  };
}

export function serializeFunctionOnlyToolPayload(
  name: string,
  form: ModelFacingToolForm,
): FunctionOnlyToolPayload {
  if (form.type === "custom") {
    return {
      name,
      description: form.functionFallback.description,
      parameters: form.functionFallback.parameters,
    };
  }

  return {
    name,
    description: form.description,
    parameters: form.parameters,
  };
}
