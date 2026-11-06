import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

import { pair } from "./api.ts";

/** What an unpaired browser sees: it trades a pairing code from `host pair` for a session on this device. */
export function Login() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, submit, busy] = useActionState(async () => (await pair(code, name)) ?? "", "");
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Pair this browser</CardTitle>
          <CardDescription>
            Run <code className="font-mono">host pair</code> on the machine that runs the host, then
            enter the code it prints.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={submit}>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="pair-code">Pairing code</FieldLabel>
                <Input
                  id="pair-code"
                  autoFocus
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  placeholder="ABCD-EFGH-JKLM"
                  className="font-mono"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="pair-name">Device name</FieldLabel>
                <Input
                  id="pair-name"
                  autoComplete="off"
                  placeholder="Work laptop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <FieldDescription>Shown in the host's device list.</FieldDescription>
              </Field>
              {!busy && error && <FieldError className="break-words">{error}</FieldError>}
              <Button type="submit" disabled={busy || !code.trim() || !name.trim()}>
                {busy && <Spinner data-icon="inline-start" />}
                Pair
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
