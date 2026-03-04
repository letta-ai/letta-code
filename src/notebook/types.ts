/**
 * Type definitions for Jupyter Notebook (.ipynb) files.
 * Based on nbformat v4 schema.
 */

export interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: CellOutput[];
  execution_count?: number | null;
}

export interface CellOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  text?: string | string[];
  data?: Record<string, string | string[]>;
  name?: string;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata: {
    kernelspec?: {
      display_name: string;
      language: string;
      name: string;
    };
    language_info?: {
      name: string;
      version?: string;
    };
    [key: string]: unknown;
  };
  nbformat: number;
  nbformat_minor: number;
}

export interface CellSnapshot {
  index: number;
  cell_type: string;
  source: string;
  outputs: string[];
  execution_count: number | null;
}

export type CellLanguage =
  | "python"
  | "markdown"
  | "javascript"
  | "typescript"
  | "r"
  | "sql"
  | "shell"
  | "raw"
  | "other";
