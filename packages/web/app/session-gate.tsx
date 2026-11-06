import { useEffect, type ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { Login } from "@/features/login/index.ts";
import { probeSession } from "@/host/api.ts";
import { useSession } from "@/host/hooks.ts";

/**
 * Shows the app only while the host accepts this browser. The host-info route is out of scope, so the page learns
 * it is unpaired from a 401 on its first API call; the app mounts, and opens its event stream, only once paired.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  useEffect(() => {
    void probeSession();
  }, []);
  if (session === "paired") return children;
  if (session === "unpaired") return <Login />;
  return (
    <div className="flex min-h-svh items-center justify-center">
      <Spinner className="text-muted-foreground size-5" />
    </div>
  );
}
