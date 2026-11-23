import { useInput, useStdin } from "ink";
import { useCallback, useEffect, useState } from "react";

export function useSuspend() {
  const { stdin, isRawModeSupported } = useStdin();
  const [resumeKey, setResumeKey] = useState(0);

  const forceUpdate = useCallback(() => {
    setResumeKey((prev) => prev + 1);
  }, []);

  useInput((input, key) => {
    if (key.ctrl && input === "z") {
      if (stdin && isRawModeSupported) {
        stdin.setRawMode(false);
      }

      process.kill(process.pid, "SIGTSTP");
      return;
    }
  });

  useEffect(() => {
    const handleResume = () => {
      if (stdin && isRawModeSupported && stdin.setRawMode) {
        stdin.setRawMode(true);
      }

      process.stdout.write("\x1B[H\x1B[2J");

      forceUpdate();
    };

    process.on("SIGCONT", handleResume);

    return () => {
      process.off("SIGCONT", handleResume);
    };
  }, [stdin, isRawModeSupported, forceUpdate]);

  return resumeKey;
}
