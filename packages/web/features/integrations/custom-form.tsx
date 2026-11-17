import { Integration, type IntegrationTransport } from "@tomte/contract/events";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorOf, readJson } from "@/host/api.ts";

import { addCustomIntegration } from "./api.ts";
import { signIn } from "./auth.tsx";
import { TRANSPORT_LABEL } from "./model.ts";

type Transport = IntegrationTransport["type"];
const TRANSPORTS = Object.entries(TRANSPORT_LABEL).map(([value, label]) => ({ value, label }));
const isTransport = (v: string): v is Transport => v in TRANSPORT_LABEL;

/** Adds a custom MCP server; `onDone` gets the new integration's id. */
export function CustomForm({ onDone }: { onDone: (id: string) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [token, setToken] = useState("");
  const [oauth, setOauth] = useState(false);
  const [skillsDir, setSkillsDir] = useState("");
  const [error, submit, busy] = useActionState(async () => {
    const wantsSignIn = oauth && transport !== "stdio";
    const tab = wantsSignIn ? window.open("", "_blank") : null;
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const at = line.indexOf("=");
      if (line.trim() && at > 0) env[line.slice(0, at).trim()] = line.slice(at + 1);
    }
    const r = await addCustomIntegration(
      transport === "stdio"
        ? { name, transport, command: url, args: args.split(/\s+/).filter(Boolean), env, skillsDir }
        : { name, url, transport, token: oauth ? undefined : token, oauth, skillsDir },
    );
    if (!r.ok) {
      tab?.close();
      return errorOf(r);
    }
    const body = await readJson(r, Integration);
    const signInError = wantsSignIn ? await signIn(body.id, tab) : undefined;
    // The server exists now; a failed sign-in is retried from its detail page, not by adding it again.
    if (signInError) toast.error(signInError);
    onDone(body.id);
    return "";
  }, "");
  return (
    <form action={submit} className="flex flex-col gap-6">
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="custom-name">Name</FieldLabel>
          <Input
            id="custom-name"
            placeholder="cfdocs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="custom-transport">Transport</FieldLabel>
          <Select
            items={TRANSPORTS}
            value={transport}
            onValueChange={(v) => v && isTransport(v) && setTransport(v)}
          >
            <SelectTrigger id="custom-transport" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSPORTS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {transport === "stdio" ? (
          <>
            <Field>
              <FieldLabel htmlFor="custom-command">Command</FieldLabel>
              <Input
                id="custom-command"
                placeholder="npx"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-args">Arguments</FieldLabel>
              <Input
                id="custom-args"
                placeholder="-y some-mcp-server"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-env">Environment</FieldLabel>
              <Textarea
                id="custom-env"
                className="font-mono text-xs"
                placeholder="API_KEY=…"
                autoComplete="off"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
              />
              <FieldDescription>
                One KEY=value per line. Values are stored in the keychain.
              </FieldDescription>
            </Field>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="custom-url">URL</FieldLabel>
              <Input
                id="custom-url"
                placeholder="https://example.com/mcp"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <Field orientation="horizontal">
              <Switch id="custom-oauth" checked={oauth} onCheckedChange={setOauth} />
              <FieldLabel htmlFor="custom-oauth">Sign in with OAuth</FieldLabel>
            </Field>
            {!oauth && (
              <Field>
                <FieldLabel htmlFor="custom-token">Bearer token</FieldLabel>
                <Input
                  id="custom-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <FieldDescription>Optional.</FieldDescription>
              </Field>
            )}
          </>
        )}
        <Field>
          <FieldLabel htmlFor="custom-skills">Local skills folder</FieldLabel>
          <Input
            id="custom-skills"
            className="font-mono text-xs"
            placeholder="/Users/me/skills"
            value={skillsDir}
            onChange={(e) => setSkillsDir(e.target.value)}
          />
          <FieldDescription>Optional absolute path.</FieldDescription>
        </Field>
        {!busy && error && <FieldError className="break-words">{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {busy ? "Connecting…" : "Add server"}
        </Button>
      </DialogFooter>
    </form>
  );
}
