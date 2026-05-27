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
  // Internal fallback for backends that only accept JSON-schema function tools.
  // This is not part of OpenAI Responses custom tool payloads.
  functionFallback: FunctionToolForm;
};

export type ModelFacingToolForm = FunctionToolForm | CustomToolForm;

export type FunctionOnlyToolPayload = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type CustomCapableCustomToolPayload = {
  type: "custom";
  name: string;
  description: string;
  parameters?: JsonSchema;
  format?: CustomToolInputFormat;
  fallback: {
    description: string;
    parameters: JsonSchema;
  };
};

export type CustomCapableToolPayload =
  | FunctionOnlyToolPayload
  | CustomCapableCustomToolPayload;

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

export function customToolForm(input: {
  description: string;
  format?: CustomToolInputFormat;
  functionFallback: FunctionToolForm;
}): CustomToolForm {
  return {
    type: "custom",
    description: input.description,
    ...(input.format ? { format: input.format } : {}),
    functionFallback: input.functionFallback,
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

export function serializeCustomCapableToolPayload(
  name: string,
  form: ModelFacingToolForm,
): CustomCapableToolPayload {
  if (form.type === "custom") {
    return {
      type: "custom",
      name,
      description: form.description,
      ...(form.format ? { format: form.format } : {}),
      fallback: {
        description: form.functionFallback.description,
        parameters: form.functionFallback.parameters,
      },
    };
  }

  return serializeFunctionOnlyToolPayload(name, form);
}
