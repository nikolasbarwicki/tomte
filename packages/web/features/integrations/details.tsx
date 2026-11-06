import type { Integration } from "@claudebot/contract/events";

import { dateTime } from "@/lib/format.ts";

import { TRANSPORT_LABEL, endpoint } from "./model.ts";
import { Row, Section } from "./parts.tsx";

export function Details({ integration: i }: { integration: Integration }) {
  return (
    <Section title="Details">
      <dl className="divide-y">
        <Row label="Server">
          <span className="font-mono text-xs break-all">{endpoint(i)}</span>
        </Row>
        <Row label="Transport">{TRANSPORT_LABEL[i.transport.type]}</Row>
        <Row label="Tool names">
          <code className="font-mono text-xs">mcp__{i.name}__…</code>
        </Row>
        <Row label="Source">{i.catalogId === null ? "Custom server" : "Built-in catalog"}</Row>
        {i.catalogId === null && <Row label="Added">{dateTime(i.createdAt)}</Row>}
      </dl>
    </Section>
  );
}
