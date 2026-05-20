import { useCallback, useRef, useState } from "react";

/**
 * A custom hook that keeps a React state and ref in sync.
 * Useful when you need immediate access to state values in async callbacks
 * that may close over stale state. The ref is updated synchronously before
 * the state, ensuring reliable checks in async operations.
 *
 * @param initialValue - The initial state value
 * @returns A tuple of [state, setState, ref]
 */
export function useSyncedState(
  initialValue: boolean,
): [boolean, (value: boolean) => void, React.MutableRefObject<boolean>] {
  const [state, setState] = useState(initialValue);
  const ref = useRef(initialValue);

  const setSyncedState = useCallback((value: boolean) => {
    ref.current = value;
    setState(value);
  }, []);

  return [state, setSyncedState, ref];
}
