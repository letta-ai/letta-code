/**
 * AnimationContext - Global context for controlling animations based on overflow
 *
 * When the live content area exceeds the terminal viewport, Ink's clearTerminal
 * behavior causes severe flickering on every re-render. This context provides
 * a global `shouldAnimate` flag that components (like BlinkDot) can consume
 * to disable animations when content would overflow.
 *
 * The parent (App.tsx) calculates total live content height and determines
 * if animations should be disabled, then provides this via context.
 */

import { createContext, type ReactNode, useContext } from "react";

interface AnimationContextValue {
  /**
   * Whether animations should be enabled.
   * False when live content would overflow the viewport.
   */
  shouldAnimate: boolean;
}

const AnimationContext = createContext<AnimationContextValue>({
  shouldAnimate: true,
});

/**
 * Hook to access the animation context.
 * Returns { shouldAnimate: true } if used outside of a provider.
 */
export function useAnimation(): AnimationContextValue {
  return useContext(AnimationContext);
}

interface AnimationProviderProps {
  children: ReactNode;
  shouldAnimate: boolean;
}

/**
 * Provider component that controls animation state for all descendants.
 * Wrap the live content area with this and pass shouldAnimate based on
 * overflow detection.
 */
export function AnimationProvider({
  children,
  shouldAnimate,
}: AnimationProviderProps) {
  return (
    <AnimationContext.Provider value={{ shouldAnimate }}>
      {children}
    </AnimationContext.Provider>
  );
}
