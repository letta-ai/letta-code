import { useCallback, useRef, useState } from "react";

/**
 * A custom hook that keeps a React state, ref, and optional global flag in sync.
 * Useful when you need immediate access to state values in async callbacks
 * that may close over stale state.
 *
 * @param initialValue - The initial state value
 * @param options.onTrue - Optional callback invoked when value is set to true
 * @returns A tuple of [state, setState, ref]
 */
export function useSyncedState(
  initialValue: boolean,
  options?: { onTrue?: () => void },
): [boolean, (value: boolean) => void, React.MutableRefObject<boolean>] {
  const [state, setState] = useState(initialValue);
  const ref = useRef(initialValue);

  const setSyncedState = useCallback(
    (value: boolean) => {
      ref.current = value;
      if (value && options?.onTrue) {
        options.onTrue();
      }
      setState(value);
    },
    [options],
  );

  return [state, setSyncedState, ref];
}
