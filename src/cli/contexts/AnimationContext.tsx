import { createContext, type ReactNode, useContext, useMemo } from "react";

interface AnimationContextValue {
  shouldAnimate: boolean;
}

const AnimationContext = createContext<AnimationContextValue>({
  shouldAnimate: true,
});

export function useAnimation(): AnimationContextValue {
  return useContext(AnimationContext);
}

interface AnimationProviderProps {
  children: ReactNode;
  shouldAnimate: boolean;
}

export function AnimationProvider({
  children,
  shouldAnimate,
}: AnimationProviderProps) {
  const contextValue = useMemo(() => ({ shouldAnimate }), [shouldAnimate]);

  return (
    <AnimationContext.Provider value={contextValue}>
      {children}
    </AnimationContext.Provider>
  );
}
