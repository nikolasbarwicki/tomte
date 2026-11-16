import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useHostInfo, usePublicHostInfo } from "@/host/hooks.ts";

import { Group, Row } from "./parts.tsx";

/** About: versions, the Claude CLI and browser engine this host uses, and the Updates card (not yet wired). */
export function About() {
  const publicInfo = usePublicHostInfo();
  const info = useHostInfo();
  const version = publicInfo?.version;
  return (
    <div className="flex flex-col gap-8">
      <Group title="Versions">
        <Card>
          <CardContent>
            <dl className="flex flex-col divide-y">
              <Row label="Version" mono>
                {version ?? "…"}
              </Row>
              <Row label="API version" mono>
                {publicInfo?.apiVersion ?? "…"}
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
        <Card>
          <CardHeader>
            <CardTitle>Release channel</CardTitle>
            <CardDescription>
              {version === undefined ? "…" : version.includes("-") ? "Pre-release" : "Stable"}
            </CardDescription>
            <CardAction>
              <Badge variant="secondary">Coming soon</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              The desktop app updates itself today; this page cannot check or install updates yet.
            </p>
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="auto-update" className="text-sm">
                Download updates automatically
              </label>
              <Switch id="auto-update" disabled />
            </div>
            <Button variant="outline" size="sm" className="self-start" disabled>
              Check for updates
            </Button>
          </CardContent>
        </Card>
      </Group>
    </div>
  );
}
