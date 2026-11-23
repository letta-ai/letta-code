import type { ChildProcess } from "node:child_process";

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LSPServerProcess {
  process: ChildProcess;
  initialization?: Record<string, unknown>;
}

export interface LSPServerInfo {
  id: string;
  extensions: string[];
  command: string[];
  env?: Record<string, string>;
  initialization?: Record<string, unknown>;
  autoInstall?: {
    check: () => Promise<boolean>;
    install: () => Promise<void>;
  };
}

export interface TextDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface InitializeParams {
  processId: number | null;
  rootUri: string | null;
  capabilities: ClientCapabilities;
  initializationOptions?: unknown;
}

export interface ClientCapabilities {
  textDocument?: {
    publishDiagnostics?: {
      relatedInformation?: boolean;
      tagSupport?: { valueSet: number[] };
      versionSupport?: boolean;
    };
  };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: {
    name: string;
    version?: string;
  };
}

export interface ServerCapabilities {
  textDocumentSync?: number | TextDocumentSyncOptions;
}

export interface TextDocumentSyncOptions {
  openClose?: boolean;
  change?: number;
}
