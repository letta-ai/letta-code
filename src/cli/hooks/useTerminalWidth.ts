import { useEffect, useState } from "react";

const getStdout = () => {
  if (typeof process === "undefined") return undefined;
  const stdout = process.stdout as NodeJS.WriteStream | undefined;
  return stdout && typeof stdout.on === "function" ? stdout : undefined;
};

const getTerminalWidth = () => getStdout()?.columns ?? 80;
const getTerminalRows = () => getStdout()?.rows ?? 24;

type WidthListener = (columns: number) => void;
type RowsListener = (rows: number) => void;

const widthListeners = new Set<WidthListener>();
const rowsListeners = new Set<RowsListener>();
let resizeHandlerRegistered = false;
let trackedColumns = getTerminalWidth();
let trackedRows = getTerminalRows();

const resizeHandler = () => {
  const nextColumns = getTerminalWidth();
  const nextRows = getTerminalRows();

  if (nextColumns !== trackedColumns) {
    trackedColumns = nextColumns;
    for (const listener of widthListeners) {
      listener(nextColumns);
    }
  }

  if (nextRows !== trackedRows) {
    trackedRows = nextRows;
    for (const listener of rowsListeners) {
      listener(nextRows);
    }
  }
};

const ensureResizeHandler = () => {
  if (resizeHandlerRegistered) return;
  const stdout = getStdout();
  if (!stdout) return;
  stdout.on("resize", resizeHandler);
  resizeHandlerRegistered = true;
};

const removeResizeHandlerIfIdle = () => {
  if (!resizeHandlerRegistered) return;
  if (widthListeners.size > 0 || rowsListeners.size > 0) return;
  const stdout = getStdout();
  if (!stdout) return;
  stdout.off("resize", resizeHandler);
  resizeHandlerRegistered = false;
};

/**
 * Hook to get terminal width and reactively update on resize
 * Uses a shared resize listener to avoid exceeding WriteStream listener limits.
 */
export function useTerminalWidth(): number {
  const [columns, setColumns] = useState(trackedColumns);

  useEffect(() => {
    ensureResizeHandler();
    const listener: WidthListener = (value) => {
      setColumns(value);
    };
    widthListeners.add(listener);

    return () => {
      widthListeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return columns;
}

/**
 * Hook to get terminal rows and reactively update on resize.
 * Uses the same shared resize listener as useTerminalWidth.
 */
export function useTerminalRows(): number {
  const [rows, setRows] = useState(trackedRows);

  useEffect(() => {
    ensureResizeHandler();
    const listener: RowsListener = (value) => {
      setRows(value);
    };
    rowsListeners.add(listener);

    return () => {
      rowsListeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return rows;
}
