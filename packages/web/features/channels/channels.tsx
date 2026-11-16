import type { ChannelEntry } from "@claudebot/contract/api";
import { CheckIcon, CopyIcon, Link2Icon, SendIcon } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { confirmAction } from "@/components/confirm.tsx";
import { Page } from "@/components/page.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { dateTime } from "@/lib/format.ts";

import { createLinkCode, listChannels, unlinkChannel } from "./api.ts";

const NAMES: Record<string, string> = { telegram: "Telegram" };
const nameOf = (kind: string) => NAMES[kind] ?? kind;

/** The Channels screen: every channel the host runs, the account linked to it, and one-time codes to link or relink. */
export function Channels() {
  const [channels, setChannels] = useState<ChannelEntry[]>();
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<{ kind: string; code: string }>();

  const refresh = useCallback(
    () =>
      listChannels().then(
        (c) => {
          setChannels(c);
          setError(undefined);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Page
      title="Channels"
      description="Where the host reaches you outside the web UI. Link your account with a one-time code; messages from any other account are ignored."
    >
      <LinkCodeDialog
        code={code?.code}
        channel={code ? nameOf(code.kind) : ""}
        onClose={() => {
          setCode(undefined);
          void refresh();
        }}
      />
      {error && <p className="text-destructive text-sm break-words">{error}</p>}
      {channels && (
        <Card>
          <CardContent className="flex flex-col divide-y">
            {channels.map((c) => (
              <ChannelRow
                key={c.kind}
                channel={c}
                onCode={(code) => setCode({ kind: c.kind, code })}
                onUnlinked={() => void refresh()}
              />
            ))}
            {channels.length === 0 && (
              <p className="text-muted-foreground text-sm">No channel is set up on this host.</p>
            )}
          </CardContent>
        </Card>
      )}
    </Page>
  );
}

function ChannelRow({
  channel: c,
  onCode,
  onUnlinked,
}: {
  channel: ChannelEntry;
  onCode: (code: string) => void;
  onUnlinked: () => void;
}) {
  const [creating, startCreating] = useTransition();
  const [unlinking, startUnlinking] = useTransition();
  const name = nameOf(c.kind);

  const link = () =>
    startCreating(async () => {
      try {
        onCode(await createLinkCode(c.kind));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    });

  const unlink = async () => {
    const ok = await confirmAction({
      title: `Unlink ${name}?`,
      description: "Nothing is sent to that account until you link one again with a new code.",
      action: "Unlink",
      destructive: true,
    });
    if (!ok) return;
    startUnlinking(async () => {
      if (await unlinkChannel(c.kind)) onUnlinked();
    });
  };

  return (
    <div className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <SendIcon className="text-muted-foreground size-5 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {c.link ? (
            <Badge variant="secondary">Linked</Badge>
          ) : (
            <Badge variant="outline">Not linked</Badge>
          )}
        </div>
        <span className="text-muted-foreground truncate text-xs">
          {c.link ? `${c.link.label} · linked ${dateTime(c.link.linkedAt)}` : "Not linked"}
        </span>
      </div>
      {c.link && (
        <Button variant="outline" size="sm" disabled={unlinking} onClick={() => void unlink()}>
          {unlinking && <Spinner data-icon="inline-start" />}
          Unlink
        </Button>
      )}
      <Button size="sm" disabled={creating} onClick={link}>
        {creating ? <Spinner data-icon="inline-start" /> : <Link2Icon data-icon="inline-start" />}
        Link account
      </Button>
    </div>
  );
}

function LinkCodeDialog({
  code,
  channel,
  onClose,
}: {
  code: string | undefined;
  channel: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={code !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link code</DialogTitle>
          <DialogDescription>
            Send this code to the {channel} bot from the account you want to link. It works once and
            expires in 10 minutes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-4">
          <code className="font-mono text-xl tracking-widest">{code}</code>
          <Button variant="ghost" size="icon-sm" aria-label="Copy code" onClick={() => void copy()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
