import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { usePublicHostInfo } from "@/host/hooks.ts";

import { Group, Row } from "./parts.tsx";

const MODE = {
  local: "Local — runs on this computer",
  remote: "Remote — a server you connect to",
};

/** Connections & devices: which host this page talks to, then `devices` (the paired devices, from the devices feature). */
export function Connections({ devices }: { devices: ReactNode }) {
  const info = usePublicHostInfo();
  return (
    <div className="flex flex-col gap-8">
      <Group
        title="This host"
        description="In the desktop app, switch hosts from the tray or the Connections entry of the app menu."
      >
        <Card>
          <CardContent>
            <dl className="flex flex-col divide-y">
              <Row label="Mode">{info ? MODE[info.mode] : "…"}</Row>
              <Row label="Address" mono>
                {window.location.host}
              </Row>
              <Row label="Version" mono>
                {info?.version ?? "…"}
              </Row>
            </dl>
          </CardContent>
        </Card>
      </Group>
      {devices}
    </div>
  );
}
