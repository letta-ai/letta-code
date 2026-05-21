import { ConstellationLoginView } from "@/auth/ConstellationLoginView";
import { OverlayShell } from "@/cli/components/OverlayShell";

interface ConstellationLoginOverlayProps {
  onComplete: () => void;
  onAlreadyLoggedIn: () => void;
}

export function ConstellationLoginOverlay({
  onComplete,
  onAlreadyLoggedIn,
}: ConstellationLoginOverlayProps) {
  return (
    <OverlayShell command="/login" title="Login to Constellation">
      <ConstellationLoginView
        onComplete={onComplete}
        onAlreadyLoggedIn={onAlreadyLoggedIn}
      />
    </OverlayShell>
  );
}
