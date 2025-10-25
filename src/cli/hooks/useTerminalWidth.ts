import { useEffect, useState } from "react";

const getStdout = () => {
  if (typeof process === "undefined") return undefined;
  const stdout = process.stdout as NodeJS.WriteStream | undefined;
  return stdout && typeof stdout.on === "function" ? stdout : undefined;
};

const getTerminalWidth = () => getStdout()?.columns ?? 80;

type Listener = (columns: number) => void;

const listeners = new Set<Listener>();
let resizeHandlerRegistered = false;
let trackedColumns = getTerminalWidth();

const resizeHandler = () => {
  const nextColumns = getTerminalWidth();
  if (nextColumns === trackedColumns) {
    return;
  }
  trackedColumns = nextColumns;
  for (const listener of listeners) {
    listener(nextColumns);
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
  if (!resizeHandlerRegistered || listeners.size > 0) return;
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
    const listener: Listener = (value) => {
      setColumns(value);
    };
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      removeResizeHandlerIfIdle();
    };
  }, []);

  return columns;
}
