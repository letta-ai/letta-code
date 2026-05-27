import { ConstellationLoginView } from "@/auth/ConstellationLoginView";
import { OverlayShell } from "@/cli/components/OverlayShell";

interface ConstellationLoginOverlayProps {
  onComplete: () => void;
  onAlreadyLoggedIn: () => void;
  onCancel: () => void;
}

export function ConstellationLoginOverlay({
  onComplete,
  onAlreadyLoggedIn,
  onCancel,
}: ConstellationLoginOverlayProps) {
  return (
    <OverlayShell command="/login" title="Login to Constellation">
      <ConstellationLoginView
        onComplete={onComplete}
        onAlreadyLoggedIn={onAlreadyLoggedIn}
        onCancel={onCancel}
      />
    </OverlayShell>
  );
}
