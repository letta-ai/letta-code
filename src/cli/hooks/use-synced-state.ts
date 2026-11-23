import { useCallback, useRef, useState } from "react";

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
