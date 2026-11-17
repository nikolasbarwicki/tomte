import type { Routine } from "@tomte/contract/events";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { dateTime } from "@/lib/format.ts";

import { DAYS, type Preset } from "./schedule.ts";
import { useRoutineForm } from "./use-routine-form.ts";

const REPEAT: { value: Preset["kind"]; label: string }[] = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "once", label: "Once" },
  { value: "custom", label: "Custom (cron)" },
];
const isRepeat = (v: unknown): v is Preset["kind"] => REPEAT.some((r) => r.value === v);
const DAY_ITEMS = DAYS.map((d, i) => ({ value: i, label: d }));

export function RoutineForm({
  botId,
  routine,
  onDone,
}: {
  botId: string;
  routine?: Routine | undefined;
  onDone: () => void;
}) {
  const { fields, set, preview, error, busy, submit } = useRoutineForm({ botId, routine, onDone });
  const { name, instruction, kind, minute, time, day, at, expr, tz, catchUp, notifyResult } =
    fields;

  return (
    <form className="grid gap-4" action={submit}>
      <DialogHeader>
        <DialogTitle>{routine ? "Edit routine" : "New routine"}</DialogTitle>
        <DialogDescription>
          The bot runs the instruction on its own at the times below and keeps a record of each run.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="routine-name">Name</FieldLabel>
          <Input
            id="routine-name"
            autoFocus
            placeholder="e.g. Morning digest"
            value={name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="routine-instruction">Instruction</FieldLabel>
          <Textarea
            id="routine-instruction"
            className="min-h-24"
            placeholder="What should the bot do each time?"
            value={instruction}
            onChange={(e) => set({ instruction: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Repeat</FieldLabel>
            <Select
              items={REPEAT}
              value={kind}
              onValueChange={(v) => isRepeat(v) && set({ kind: v })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPEAT.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {kind === "hourly" && (
            <Field>
              <FieldLabel htmlFor="routine-minute">At minute</FieldLabel>
              <Input
                id="routine-minute"
                type="number"
                min={0}
                max={59}
                value={minute}
                onChange={(e) => set({ minute: Number(e.target.value) })}
              />
            </Field>
          )}
          {(kind === "daily" || kind === "weekdays") && (
            <Field>
              <FieldLabel htmlFor="routine-time">At</FieldLabel>
              <Input
                id="routine-time"
                type="time"
                value={time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </Field>
          )}
          {kind === "once" && (
            <Field>
              <FieldLabel htmlFor="routine-at">On</FieldLabel>
              <Input
                id="routine-at"
                type="datetime-local"
                value={at}
                onChange={(e) => set({ at: e.target.value })}
              />
            </Field>
          )}
          {kind === "custom" && (
            <Field>
              <FieldLabel htmlFor="routine-cron">Cron expression</FieldLabel>
              <Input
                id="routine-cron"
                className="font-mono"
                placeholder="30 8 * * 1"
                value={expr}
                onChange={(e) => set({ expr: e.target.value })}
              />
              <FieldDescription className="text-xs">
                Minute, hour, day of month, month, day of week.
              </FieldDescription>
            </Field>
          )}
          {kind === "weekly" && (
            <Field>
              <FieldLabel>On</FieldLabel>
              <Select
                items={DAY_ITEMS}
                value={day}
                onValueChange={(v) => typeof v === "number" && set({ day: v })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_ITEMS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === "weekly" && (
            <Field>
              <FieldLabel htmlFor="routine-time">At</FieldLabel>
              <Input
                id="routine-time"
                type="time"
                value={time}
                onChange={(e) => set({ time: e.target.value })}
              />
            </Field>
          )}
          {kind !== "once" && (
            <Field>
              <FieldLabel htmlFor="routine-tz">Time zone</FieldLabel>
              <Input
                id="routine-tz"
                placeholder="Europe/Warsaw"
                value={tz}
                onChange={(e) => set({ tz: e.target.value })}
              />
            </Field>
          )}
        </div>
        <Field orientation="horizontal">
          <Checkbox
            id="routine-catchup"
            checked={catchUp}
            onCheckedChange={(checked) => set({ catchUp: checked })}
          />
          <FieldLabel htmlFor="routine-catchup" className="font-normal">
            Catch up on a missed run after downtime (up to 12 h)
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="routine-notify-result"
            checked={notifyResult}
            onCheckedChange={(checked) => set({ notifyResult: checked })}
          />
          <FieldContent>
            <FieldLabel htmlFor="routine-notify-result" className="font-normal">
              Send the result to my phone
            </FieldLabel>
            <FieldDescription className="text-xs">
              Needs a linked channel (Settings › Channels)
            </FieldDescription>
          </FieldContent>
        </Field>
        <div className="bg-muted/50 rounded-lg p-3 text-xs">
          {preview.error ? (
            <span className="text-destructive">{preview.error}</span>
          ) : preview.next?.length ? (
            <>
              <p className="mb-1 font-medium">Next runs</p>
              <ul className="text-muted-foreground grid gap-0.5">
                {preview.next.map((t) => (
                  <li key={t}>{dateTime(t)}</li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-muted-foreground">Working out the next runs…</span>
          )}
        </div>
        {error && <FieldError>{error}</FieldError>}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={busy || !name.trim() || !instruction.trim()}>
          {busy && <Spinner />} {routine ? "Save" : "Create routine"}
        </Button>
      </DialogFooter>
    </form>
  );
}
