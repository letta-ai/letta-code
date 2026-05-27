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
  fallback: FunctionToolForm & {
    inputField?: string;
  };
};

export type ModelFacingToolForm = FunctionToolForm | CustomToolForm;

export type FunctionToolPayload = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ProviderRuntimeCustomToolPayload = {
  type: "custom";
  name: string;
  description: string;
  format?: CustomToolInputFormat;
  fallback: {
    description?: string;
    parameters: JsonSchema;
    inputField?: string;
  };
};

export type ProviderRuntimeToolPayload =
  | FunctionToolPayload
  | ProviderRuntimeCustomToolPayload;

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

export function serializeFunctionToolPayload(
  name: string,
  form: ModelFacingToolForm,
): FunctionToolPayload {
  if (form.type === "custom") {
    return {
      name,
      description: form.fallback.description,
      parameters: form.fallback.parameters,
    };
  }

  return {
    name,
    description: form.description,
    parameters: form.parameters,
  };
}

export function serializeProviderRuntimeToolPayload(
  name: string,
  form: ModelFacingToolForm,
): ProviderRuntimeToolPayload {
  if (form.type === "custom") {
    return {
      type: "custom",
      name,
      description: form.description,
      ...(form.format ? { format: form.format } : {}),
      fallback: {
        description: form.fallback.description,
        parameters: form.fallback.parameters,
        ...(form.fallback.inputField
          ? { inputField: form.fallback.inputField }
          : {}),
      },
    };
  }

  return serializeFunctionToolPayload(name, form);
}
