import { Card, CardContent } from "@/components/ui/card";
import { useHostInfo, useHostStatus, usePublicHostInfo } from "@/host/hooks.ts";

import { Group, Row } from "./parts.tsx";
import { UpdatesCard } from "./updates.tsx";

/** About: versions, the Claude CLI and browser engine this host uses, and the Updates card. */
export function About() {
  const publicInfo = usePublicHostInfo();
  const info = useHostInfo();
  const version = publicInfo?.version;
  const hostStatus = useHostStatus();
  return (
    <div className="flex flex-col gap-8">
      <Group title="Versions">
        <Card>
          <CardContent>
            <dl className="flex flex-col divide-y">
              <Row label="Version" mono>
                {version ?? "…"}
              </Row>
              <Row label="Release channel">
                {version === undefined ? "…" : version.includes("-") ? "Pre-release" : "Stable"}
              </Row>
              <Row label="Shell API" mono>
                {publicInfo
                  ? publicInfo.shellApi.min === publicInfo.shellApi.max
                    ? publicInfo.shellApi.max
                    : `${publicInfo.shellApi.min} to ${publicInfo.shellApi.max}`
                  : "…"}
              </Row>
              <Row label="Claude CLI" mono>
                {info?.cli ?? "…"}
              </Row>
              <Row label="Browser engine" mono={info?.browser.status === "available"}>
                {!info
                  ? "…"
                  : info.browser.status === "available"
                    ? `${info.browser.path} (${info.browser.source})`
                    : `Unavailable: ${info.browser.reason}`}
              </Row>
            </dl>
          </CardContent>
        </Card>
      </Group>
      <Group title="Updates">
        <UpdatesCard status={hostStatus} />
      </Group>
    </div>
  );
}
