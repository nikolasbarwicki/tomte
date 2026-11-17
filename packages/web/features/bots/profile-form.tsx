import type { BotSummary } from "@tomte/contract/events";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { BotAvatar } from "@/components/bot-avatar.tsx";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { errorOf } from "@/host/api.ts";
import { useBots } from "@/host/hooks.ts";

import { updateProfile } from "./api.ts";
import { AvatarPicker } from "./avatar-picker.tsx";
import { ChiefOfStaffText } from "./chief-of-staff-field.tsx";

/** The profile page: rename the bot, rewrite its purpose, pick another avatar, make it the Chief of Staff. Saving replaces all of them at once. */
export function ProfileForm({ bot }: { bot: BotSummary }) {
  const [name, setName] = useState(bot.name);
  const [purpose, setPurpose] = useState(bot.purpose);
  const [avatar, setAvatar] = useState(bot.avatar);
  const [chiefOfStaff, setChiefOfStaff] = useState(bot.chiefOfStaff);
  const holder = useBots()?.find((b) => b.chiefOfStaff && b.id !== bot.id)?.name;
  const changed =
    name !== bot.name ||
    purpose !== bot.purpose ||
    avatar.shape !== bot.avatar.shape ||
    avatar.color !== bot.avatar.color ||
    chiefOfStaff !== bot.chiefOfStaff;
  const [error, save, saving] = useActionState(async () => {
    const r = await updateProfile({ botId: bot.id, name, purpose, ...avatar, chiefOfStaff });
    if (!r.ok) return errorOf(r);
    toast.success("Profile saved");
    return "";
  }, "");
  return (
    <form action={save} className="grid gap-4" data-testid="bot-profile">
      <FieldGroup className="gap-4">
        <div className="flex items-end gap-3">
          <BotAvatar avatar={avatar} className="bg-muted size-14 rounded-xl p-1" />
          <Field className="flex-1">
            <FieldLabel htmlFor="profile-name">Name</FieldLabel>
            <Input
              id="profile-name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="profile-purpose">Purpose</FieldLabel>
          <Textarea
            id="profile-purpose"
            placeholder="What is this bot for?"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
          <FieldDescription>
            Other bots see it when they pick who to hand work to. A new name or purpose reaches{" "}
            {bot.name} from its next session.
          </FieldDescription>
        </Field>
        <AvatarPicker avatar={avatar} onChange={setAvatar} />
        <Field orientation="horizontal">
          <ChiefOfStaffText id="profile-chief-of-staff" holder={holder} />
          <Switch
            id="profile-chief-of-staff"
            checked={chiefOfStaff}
            onCheckedChange={setChiefOfStaff}
          />
        </Field>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <div className="flex justify-end">
        <Button type="submit" disabled={saving || !changed || !name.trim()}>
          {saving && <Spinner />} Save
        </Button>
      </div>
    </form>
  );
}
