import type { BotSummary, CredentialEntry } from "@claudebot/contract/events";
import { KeyRound, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useActionState, useState, useTransition } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Page } from "@/components/page.tsx";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorOf } from "@/host/api.ts";

import { addCredential, removeCredential, revokeCredential, updateCredential } from "./api.ts";

/** Which form the dialog shows: a new credential, or an existing one being edited. */
type Editing = { entry?: CredentialEntry } | null;

/** The global Credentials screen; passwords are write-only and never shown or pre-filled. */
export function Credentials({
  credentials,
  bots,
}: {
  credentials: CredentialEntry[];
  bots: BotSummary[];
}) {
  const [editing, setEditing] = useState<Editing>(null);
  const botName = (id: string) =>
    bots.find((b) => b.id === id)?.name ?? `deleted bot (${id.slice(0, 8)})`;
  const byBot = new Map<string, CredentialEntry[]>();
  for (const c of credentials)
    for (const g of c.grants) byBot.set(g.botId, [...(byBot.get(g.botId) ?? []), c]);
  return (
    <Page
      title="Credentials"
      description="Website logins your bots can use. Passwords stay in the OS keychain and are never shown again."
      actions={
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus data-icon="inline-start" />
          Add credential
        </Button>
      }
    >
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing?.entry ? `Edit ${editing.entry.label}` : "Add credential"}
            </DialogTitle>
            <DialogDescription>
              {editing?.entry
                ? "The password is never shown. Enter a new one to replace it."
                : "Bots ask before they first use a login."}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <CredentialForm
              key={editing.entry?.id ?? "new"}
              entry={editing.entry}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {credentials.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>No credentials yet</EmptyTitle>
            <EmptyDescription>
              Save a website login so your bots can sign in with your permission.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => setEditing({})}>
              <Plus data-icon="inline-start" />
              Add credential
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
          {credentials.map((c) => (
            <CredentialCard
              key={c.id}
              entry={c}
              botName={botName}
              onEdit={() => setEditing({ entry: c })}
            />
          ))}
        </div>
      )}
      {byBot.size > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Access by bot</h2>
          <Card>
            <CardContent className="flex flex-col divide-y">
              {[...byBot].map(([botId, entries]) => (
                <div key={botId} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <h3 className="text-sm font-medium">{botName(botId)}</h3>
                  <ul className="flex flex-col">
                    {entries.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground truncate text-sm">{e.label}</span>
                        <RevokeButton botId={botId} credentialId={e.id} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </Page>
  );
}

function CredentialCard({
  entry: c,
  botName,
  onEdit,
}: {
  entry: CredentialEntry;
  botName: (id: string) => string;
  onEdit: () => void;
}) {
  const [removing, startRemoving] = useTransition();
  const remove = async () => {
    const ok = await confirmAction({
      title: `Delete "${c.label}"?`,
      description: "Its password and every bot's access are removed.",
      action: "Delete",
      destructive: true,
    });
    if (ok)
      startRemoving(async () => {
        await removeCredential(c.id);
      });
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="truncate">{c.label}</CardTitle>
        <CardDescription className="truncate" title={c.signInUrl}>
          {c.username} · {c.origin}
        </CardDescription>
        <CardAction>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={removing}
                  aria-label={`${c.label} actions`}
                />
              }
            >
              {removing ? <Spinner /> : <MoreHorizontal />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <h4 className="text-muted-foreground text-xs font-medium">Bots with access</h4>
        {c.grants.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            None yet. A bot asks the first time it wants to sign in.
          </p>
        ) : (
          <ul className="flex flex-col">
            {c.grants.map((g) => (
              <li key={g.botId} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{botName(g.botId)}</span>
                <RevokeButton botId={g.botId} credentialId={c.id} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function CredentialForm({
  entry,
  onDone,
}: {
  entry?: CredentialEntry | undefined;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(entry?.label ?? "");
  const [signInUrl, setSignInUrl] = useState(entry?.signInUrl ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, submit, busy] = useActionState(async () => {
    const r = await (entry
      ? updateCredential(entry.id, { label, signInUrl, username, password })
      : addCredential({ label, signInUrl, username, password }));
    if (!r.ok) return errorOf(r);
    setPassword("");
    onDone();
    return "";
  }, "");
  return (
    <form action={submit} className="flex flex-col gap-6">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="cred-label">Label</FieldLabel>
          <Input
            id="cred-label"
            placeholder="GitHub"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cred-url">Sign-in URL</FieldLabel>
          <Input
            id="cred-url"
            type="url"
            placeholder="https://github.com/login"
            value={signInUrl}
            onChange={(e) => setSignInUrl(e.target.value)}
          />
          <FieldDescription>Must start with https://.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="cred-username">Username</FieldLabel>
          <Input
            id="cred-username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="cred-password">{entry ? "New password" : "Password"}</FieldLabel>
          <Input
            id="cred-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {entry && <FieldDescription>Leave empty to keep the current one</FieldDescription>}
        </Field>
        {!busy && error && <FieldError className="break-words">{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {entry ? "Save" : "Add credential"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RevokeButton({ botId, credentialId }: { botId: string; credentialId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await revokeCredential(botId, credentialId);
        })
      }
    >
      {pending && <Spinner data-icon="inline-start" />}
      Revoke
    </Button>
  );
}
