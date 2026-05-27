import {
  functionToolForm,
  type JsonSchema,
  type ModelFacingToolForm,
} from "./model-facing-tool";

export type ToolArgs = Record<string, unknown>;
export type ToolRunner = (args: ToolArgs) => Promise<unknown>;
export type TypedToolImplementation<
  TArgs extends object = ToolArgs,
  TResult = unknown,
> = (args: TArgs) => Promise<TResult>;

export interface ToolAssets {
  schema: JsonSchema;
  description: string;
  modelForm: ModelFacingToolForm;
  impl: ToolRunner;
}

export function defineTool<TArgs extends object, TResult>(input: {
  schema: JsonSchema;
  description: string;
  modelForm?: ModelFacingToolForm;
  impl: TypedToolImplementation<TArgs, TResult>;
}): ToolAssets {
  return {
    schema: input.schema,
    description: input.description,
    modelForm:
      input.modelForm ??
      functionToolForm({
        description: input.description,
        parameters: input.schema,
      }),
    impl: (args) => input.impl(args as TArgs),
  };
}
