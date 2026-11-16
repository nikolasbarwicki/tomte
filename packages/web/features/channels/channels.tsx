import type { ChannelEntry, ChannelLinkCodeResponse } from "@claudebot/contract/api";
import { CheckIcon, CopyIcon, ExternalLinkIcon, Link2Icon, SendIcon } from "lucide-react";
import { useActionState, useCallback, useEffect, useState, useTransition } from "react";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { dateTime } from "@/lib/format.ts";

import { createLinkCode, listChannels, setTelegramToken, unlinkChannel } from "./api.ts";

const NAMES: Record<string, string> = { telegram: "Telegram" };
const nameOf = (kind: string) => NAMES[kind] ?? kind;
/** How often the page asks again, so a link made in the chat app or a bot token Telegram turns down shows without a reload. */
const REFRESH_MS = 3000;

/** The Channels screen: every channel the host runs, whether it is running, the account linked to it, and one-time codes to link or relink. */
export function Channels() {
  const [channels, setChannels] = useState<ChannelEntry[]>();
  const [error, setError] = useState<string>();
  const [code, setCode] = useState<{ kind: string } & ChannelLinkCodeResponse>();

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
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <Page
      title="Channels"
      description="Where the host reaches you outside the web UI. Link your account with a one-time code; messages from any other account are ignored."
    >
      <LinkCodeDialog
        link={code}
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
                onCode={(made) => setCode({ kind: c.kind, ...made })}
                onChanged={() => void refresh()}
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

/** One line for what a channel's transport is doing, in words that say what to do when it is not running. */
function statusText(c: ChannelEntry): string {
  const { state, detail, username } = c.status;
  if (state === "unconfigured") return "No bot token yet";
  if (state === "starting") return "Starting…";
  if (state === "failed") return `Not running: ${detail ?? "unknown error"}`;
  return username ? `Running as @${username}` : "Running";
}

function ChannelRow({
  channel: c,
  onCode,
  onChanged,
}: {
  channel: ChannelEntry;
  onCode: (made: ChannelLinkCodeResponse) => void;
  onChanged: () => void;
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
      if (await unlinkChannel(c.kind)) onChanged();
    });
  };

  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
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
          <span
            data-testid={`${c.kind}-status`}
            className={
              c.status.state === "failed"
                ? "text-destructive text-xs break-words"
                : "text-muted-foreground text-xs"
            }
          >
            {statusText(c)}
          </span>
        </div>
        {c.link && (
          <Button variant="outline" size="sm" disabled={unlinking} onClick={() => void unlink()}>
            {unlinking && <Spinner data-icon="inline-start" />}
            Unlink
          </Button>
        )}
        <Button size="sm" disabled={creating || c.status.state !== "running"} onClick={link}>
          {creating ? <Spinner data-icon="inline-start" /> : <Link2Icon data-icon="inline-start" />}
          Link account
        </Button>
      </div>
      {c.kind === "telegram" && <TelegramTokenForm onSaved={onChanged} />}
    </div>
  );
}

/** The bot token field. The token is sent once, checked by the host with Telegram and never shown again, so the field is always empty. */
function TelegramTokenForm({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [failure, submit, busy] = useActionState(async () => {
    const reason = await setTelegramToken(token);
    if (reason !== undefined) return reason;
    setToken("");
    onSaved();
    toast.success("Telegram bot token saved");
    return "";
  }, "");
  const error = busy ? "" : failure;
  return (
    <form action={submit}>
      <FieldGroup className="gap-3">
        <Field data-invalid={!!error || undefined}>
          <FieldLabel htmlFor="telegram-token">Bot token</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id="telegram-token"
              type="password"
              autoComplete="off"
              placeholder="Paste the token from BotFather"
              aria-invalid={!!error || undefined}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !token.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              Save token
            </Button>
          </div>
          <FieldDescription>
            Create a bot with @BotFather and paste its token. Saving it replaces the earlier token;
            it is stored in the host's secrets and cannot be shown again.
          </FieldDescription>
          {error && <FieldError>{error}</FieldError>}
        </Field>
      </FieldGroup>
    </form>
  );
}

function LinkCodeDialog({
  link,
  channel,
  onClose,
}: {
  link: ChannelLinkCodeResponse | undefined;
  channel: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const code = link?.code;
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
        {link?.url && (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground inline-flex items-center gap-1 text-sm break-all underline"
          >
            {link.url}
            <ExternalLinkIcon className="size-3 shrink-0" />
          </a>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
