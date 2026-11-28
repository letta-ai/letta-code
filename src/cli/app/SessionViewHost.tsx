import { AppView } from "@/cli/app/AppView";
import { useSessionView } from "@/cli/app/use-session-view";
export function SessionViewHost(props: Parameters<typeof useSessionView>[0]) {
  return <AppView {...useSessionView(props)} />;
}
