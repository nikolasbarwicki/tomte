import { FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";

/**
 * The label and description of the Chief of Staff switch, shared by the profile page (a switch) and the New bot form (a checkbox).
 * `holder` is the name of the other bot that has the role now: turning it on takes it from that bot.
 */
export function ChiefOfStaffText({ id, holder }: { id: string; holder: string | undefined }) {
  return (
    <FieldContent>
      <FieldLabel htmlFor={id} className="font-normal">
        Chief of Staff
      </FieldLabel>
      <FieldDescription className="text-xs">
        This bot supervises your other bots: it splits your goals up, hands the parts to the right
        bot, keeps a log and briefs you. Nothing else about it changes. Only one bot has this role.
        {holder && ` Turning this on removes it from ${holder}.`}
      </FieldDescription>
    </FieldContent>
  );
}
