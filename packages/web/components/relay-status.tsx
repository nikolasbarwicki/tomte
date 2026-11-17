import type { Relay } from "@tomte/contract/events";

import { Button } from "@/components/ui/button";
import { act } from "@/host/api.ts";

/** Tries the relay of an answer again; the host answers a retry that is already running or done with no change. */
const retryRelay = (botId: string, id: string) =>
  act("/api/bots/events/relay/retry", { botId, id });

/**
 * Whether the answer to a needs-you item reached the sender's agent (ADR-0008): on its way, delivered, or not delivered
 * with the reason and a Retry. It is only shown for items that carry a reply target.
 */
export function RelayStatus({ botId, id, relay }: { botId: string; id: string; relay: Relay }) {
  if (relay.state === "pending") return <span role="status">Sending your reply…</span>;
  if (relay.state === "relayed") return <span role="status">Reply delivered</span>;
  return (
    <span role="alert" className="text-destructive inline-flex flex-wrap items-center gap-1.5">
      Reply not delivered{relay.error ? `: ${relay.error}` : ""}
      <Button variant="outline" size="xs" onClick={() => void retryRelay(botId, id)}>
        Retry
      </Button>
    </span>
  );
}
