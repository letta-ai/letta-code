import { useEffect } from "react";

const PROGRESS_INDETERMINATE = "\x1b]9;4;3;0\x07";
const PROGRESS_CLEAR = "\x1b]9;4;0;0\x07";

export function useProgressIndicator(active = true): void {
  useEffect(() => {
    if (!active) return;

    process.stdout.write(PROGRESS_INDETERMINATE);

    return () => {
      process.stdout.write(PROGRESS_CLEAR);
    };
  }, [active]);
}
