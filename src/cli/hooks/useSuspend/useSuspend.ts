import { useInput, useStdin } from "ink";
import { useCallback, useEffect, useState } from "react";

export function useSuspend() {
  const { stdin, isRawModeSupported } = useStdin();
  // Use a state variable to force a re-render when needed
  const [resumeKey, setResumeKey] = useState(0);

  const forceUpdate = useCallback(() => {
    setResumeKey((prev) => prev + 1);
  }, []);

  useInput((input, key) => {
    // Handle CTRL-Z for suspend
    if (key.ctrl && input === "z") {
      if (stdin && isRawModeSupported) {
        stdin.setRawMode(false);
      }

      process.kill(process.pid, "SIGTSTP");
      return;
    }
  });

  // Handle the SIGCONT (fg command) resume
  useEffect(() => {
    const handleResume = () => {
      if (stdin && isRawModeSupported && stdin.setRawMode) {
        stdin.setRawMode(true);
      }

      // clear the console
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
