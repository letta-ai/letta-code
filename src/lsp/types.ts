/**
 * LSP Infrastructure Types
 * Based on Language Server Protocol specification
 */

import type { ChildProcess } from "node:child_process";

/**
 * LSP Diagnostic severity levels
 */
export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

/**
 * Position in a text document (0-based)
 */
export interface Position {
  line: number;
  character: number;
}

/**
 * Range in a text document
 */
export interface Range {
  start: Position;
  end: Position;
}

/**
 * LSP Diagnostic
 */
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

/**
 * LSP Server process handle
 */
export interface LSPServerProcess {
  process: ChildProcess;
  initialization?: Record<string, unknown>;
}

/**
 * LSP Server definition
 */
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

/**
 * Text document for LSP
 */
export interface TextDocument {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

/**
 * JSON-RPC Request
 */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

/**
 * JSON-RPC Response
 */
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

/**
 * JSON-RPC Notification
 */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/**
 * LSP Initialize params
 */
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

/**
 * LSP Initialize result
 */
export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: {
    name: string;
    version?: string;
  };
}

export interface ServerCapabilities {
  textDocumentSync?: number | TextDocumentSyncOptions;
  // Add more as needed
}

export interface TextDocumentSyncOptions {
  openClose?: boolean;
  change?: number;
}
