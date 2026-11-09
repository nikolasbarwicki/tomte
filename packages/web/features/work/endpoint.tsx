import { CopyIcon, KeyRoundIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import { eventAccess, rotateEventToken } from "./api.ts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The bot's events URL with the actions to copy it, copy the event token and replace the token. The token is never kept on the page: each action asks the host for it. */
export function EventsEndpoint({ botId }: { botId: string }) {
  const [url, setUrl] = useState<string>();
  const [busy, run] = useTransition();
  useEffect(() => {
    let current = true;
    eventAccess(botId).then(
      (a) => current && setUrl(a.url),
      (e: unknown) => current && toast.error(message(e)),
    );
    return () => {
      current = false;
    };
  }, [botId]);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch (e) {
      toast.error(message(e));
    }
  };
  const attempt = (f: () => Promise<void>) =>
    run(async () => {
      try {
        await f();
      } catch (e) {
        toast.error(message(e));
      }
    });
  const rotate = async () => {
    const ok = await confirmAction({
      title: "Replace the event token?",
      description:
        "The current token stops working at once. Running sessions of this bot keep the old one until their next session, and scripts you set up by hand need the new token. The new token is copied to your clipboard.",
      action: "Replace",
      destructive: true,
    });
    if (ok)
      attempt(async () => {
        await copy((await rotateEventToken(botId)).token, "New event token");
      });
  };

  return (
    <section className="grid gap-2 border-t pt-3">
      <div>
        <h3 className="text-sm font-medium">Events endpoint</h3>
        <p className="text-muted-foreground text-xs">
          A script posts events here with this bot&apos;s event token as a bearer token.
        </p>
      </div>
      <code className="bg-muted/50 rounded-lg px-2 py-1.5 text-xs break-all">
        {url ?? "Loading…"}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!url}
          onClick={() => url && void copy(url, "URL")}
        >
          <CopyIcon /> Copy URL
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() =>
            attempt(async () => {
              await copy((await eventAccess(botId)).token, "Event token");
            })
          }
        >
          <KeyRoundIcon /> Copy token
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void rotate()}>
          {busy ? <Spinner /> : <RefreshCwIcon />} Replace token
        </Button>
      </div>
    </section>
  );
}
