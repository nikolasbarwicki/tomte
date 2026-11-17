import type { BotSummary } from "@tomte/contract/events";
import { GlobeIcon } from "lucide-react";
import { useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { useHostInfo } from "@/host/hooks.ts";

import { setBrowserEnabled } from "./api.ts";
import { BrowserPanel } from "./browser-panel.tsx";

export function BrowserTab({ bot }: { bot: BotSummary }) {
  const info = useHostInfo();
  const unavailable = info?.browser.status === "unavailable" ? info.browser.reason : undefined;
  const [pending, startTransition] = useTransition();
  return (
    <div className="grid gap-4">
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="browser-enabled">
            <GlobeIcon className="size-4" /> Web browser
          </FieldLabel>
          <FieldDescription className="text-xs">
            Gives {bot.name} its own browser. It starts on the bot's first browser call, not when
            you switch it on.
          </FieldDescription>
        </FieldContent>
        <Switch
          id="browser-enabled"
          checked={bot.browser.enabled}
          disabled={pending || (!!unavailable && !bot.browser.enabled)}
          onCheckedChange={(enabled) =>
            startTransition(async () => {
              await setBrowserEnabled(bot.id, enabled);
            })
          }
        />
      </Field>
      {unavailable && (
        <Alert>
          <AlertDescription>Unavailable: {unavailable}</AlertDescription>
        </Alert>
      )}
      {bot.browser.enabled && (
        <BrowserPanel key={bot.id} botId={bot.id} botName={bot.name} headed={bot.browser.headed} />
      )}
    </div>
  );
}
