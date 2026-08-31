import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

// Tool return content can be a string or array of text/image content parts
export type ToolReturnContent = string | Array<TextContent | ImageContent>;

export type ToolExecutionResult = {
  toolReturn: ToolReturnContent;
  status: "success" | "error";
  stdout?: string[];
  stderr?: string[];
};
