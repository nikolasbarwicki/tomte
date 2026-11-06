import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";
import { AlarmClockIcon, ChevronRightIcon, EllipsisIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Routine, RoutineRun, RunStatus } from "@claudebot/contract/events";
import { act, errorOf, post } from "./api.ts";
import { confirmAction } from "./confirm.tsx";
import { dateTime } from "./format.ts";
import { DAYS, browserZone, describe, fromSchedule, toSchedule, type Preset } from "./schedule.ts";

export function Routines({ botId, routines }: { botId: string; routines: Routine[] }) {
  const [editing, setEditing] = useState<Routine>();
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const edit = (r?: Routine) => {
    setEditing(r);
    setFormKey((k) => k + 1);
    setOpen(true);
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Instructions this bot runs on a schedule.</p>
        <Button variant="outline" size="sm" onClick={() => edit()}>
          <PlusIcon /> New routine
        </Button>
      </div>
      {routines.length === 0 ? (
        <Empty className="border border-dashed p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlarmClockIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No routines yet</EmptyTitle>
            <EmptyDescription className="text-xs">Have the bot do something every morning, every hour or once at a set time. You can also ask it in chat to set one up.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" onClick={() => edit()}>
              <PlusIcon /> New routine
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ul className="grid gap-2">
          {routines.map((r) => (
            <RoutineItem key={r.id} r={r} onEdit={() => edit(r)} />
          ))}
        </ul>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <RoutineForm key={formKey} botId={botId} routine={editing} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

const RUN_STATUS: Record<RunStatus, string> = {
  running: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  succeeded: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  interrupted: "bg-destructive/10 text-destructive",
  skipped: "bg-muted text-muted-foreground",
};

function RunBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant="secondary" className={cn("capitalize", RUN_STATUS[status])}>
      {status === "running" && <Spinner className="size-3" />}
      {status}
    </Badge>
  );
}

function RoutineItem({ r, onEdit }: { r: Routine; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[]>();
  const lastRunId = r.lastRun?.id;
  useEffect(() => {
    if (!open) return;
    post("/api/routines/runs", { id: r.id }).then(async (res) => res.ok && setRuns(await res.json()));
  }, [open, r.id, lastRunId, r.lastRun?.status]);

  const status = r.running ? "running" : r.lastRun?.status;
  const next = !r.active ? "Paused" : r.nextRunAt ? `Next run ${dateTime(r.nextRunAt)}` : "No runs left";
  const remove = async () => {
    if (await confirmAction({ title: `Delete routine "${r.name}"?`, description: "It stops running. This cannot be undone.", action: "Delete", destructive: true })) {
      await act("/api/routines/delete", { id: r.id });
    }
  };

  return (
    <li className={cn("rounded-lg border", !r.active && "bg-muted/30")}>
      <div className="flex items-start gap-3 p-3">
        <Switch
          size="sm"
          className="mt-0.5"
          checked={r.active}
          aria-label={r.active ? `Pause ${r.name}` : `Resume ${r.name}`}
          onCheckedChange={(active) => act("/api/routines/update", { id: r.id, active })}
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-sm font-medium", !r.active && "text-muted-foreground")} title={r.instruction}>
              {r.name}
            </span>
            {status && <RunBadge status={status} />}
          </div>
          <span className="text-xs text-muted-foreground">{describe(r.schedule)}</span>
          <span className="text-xs text-muted-foreground">{next}</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={<Button variant="ghost" size="icon-xs" aria-label="Run now" disabled={r.running} onClick={() => act("/api/routines/run", { id: r.id })} />}
          >
            {r.running ? <Spinner /> : <PlayIcon />}
          </TooltipTrigger>
          <TooltipContent>{r.running ? "Running…" : "Run now"}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${r.name}`} />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={remove}>
              <TrashIcon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group/runs flex w-full items-center gap-1 border-t px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open/runs:rotate-90" />
          Run history
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-1 px-3 pb-3">
            {!runs ? (
              <Spinner className="mx-auto my-2 text-muted-foreground" />
            ) : runs.length === 0 ? (
              <p className="py-1 text-xs text-muted-foreground">No runs yet.</p>
            ) : (
              runs.map((run) => <RunRow key={run.id} run={run} />)
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function RunRow({ run }: { run: RoutineRun }) {
  const hasBody = !!(run.error || run.output);
  return (
    <Collapsible disabled={!hasBody}>
      <CollapsibleTrigger className="group/run flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-muted/60 disabled:hover:bg-transparent">
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open/run:rotate-90", !hasBody && "invisible")} />
        <RunBadge status={run.status} />
        <span className="truncate text-muted-foreground">
          {dateTime(run.startedAt)} · {run.trigger === "manual" ? "test run" : "scheduled"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-2 grid gap-2 rounded-md bg-muted/50 p-3 text-sm">
          {run.error && <p className="text-xs text-destructive">{run.error}</p>}
          {run.output && <Streamdown linkSafety={{ enabled: false }}>{run.output}</Streamdown>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Epoch ms to the local "YYYY-MM-DDTHH:MM" a datetime-local input expects. */
const localInput = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

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

function RoutineForm({ botId, routine, onDone }: { botId: string; routine?: Routine; onDone: () => void }) {
  const initial: Preset = routine ? fromSchedule(routine.schedule) : { kind: "daily", time: "09:00" };
  const [name, setName] = useState(routine?.name ?? "");
  const [instruction, setInstruction] = useState(routine?.instruction ?? "");
  const [kind, setKind] = useState<Preset["kind"]>(initial.kind);
  const [minute, setMinute] = useState(initial.kind === "hourly" ? initial.minute : 0);
  const [time, setTime] = useState("time" in initial ? initial.time : "09:00");
  const [day, setDay] = useState(initial.kind === "weekly" ? initial.day : 1);
  const [at, setAt] = useState(localInput(initial.kind === "once" ? initial.at : Date.now() + 60 * 60_000));
  const [expr, setExpr] = useState(initial.kind === "custom" ? initial.expr : routine?.schedule.kind === "cron" ? routine.schedule.expr : "0 9 * * *");
  const [tz, setTz] = useState(routine?.schedule.kind === "cron" ? routine.schedule.tz : browserZone());
  const [catchUp, setCatchUp] = useState(routine?.catchUp ?? true);
  const [preview, setPreview] = useState<{ next?: number[]; error?: string }>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const preset: Preset =
    kind === "hourly"
      ? { kind, minute }
      : kind === "weekly"
        ? { kind, day, time }
        : kind === "daily" || kind === "weekdays"
          ? { kind, time }
          : kind === "once"
            ? { kind, at: new Date(at).getTime() }
            : { kind, expr };
  const schedule = toSchedule(preset, tz.trim());
  const scheduleKey = JSON.stringify(schedule);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await post("/api/routines/preview", { schedule });
      setPreview(await res.json());
    }, 300);
    return () => clearTimeout(t);
  }, [scheduleKey]);

  const submit = async () => {
    setBusy(true);
    const payload = { name, instruction, schedule, catchUp };
    const res = routine ? await post("/api/routines/update", { id: routine.id, ...payload }) : await post("/api/routines/create", { botId, ...payload });
    setBusy(false);
    if (!res.ok) return setError(await errorOf(res));
    onDone();
  };

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{routine ? "Edit routine" : "New routine"}</DialogTitle>
        <DialogDescription>The bot runs the instruction on its own at the times below and keeps a record of each run.</DialogDescription>
      </DialogHeader>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="routine-name">Name</FieldLabel>
          <Input id="routine-name" autoFocus placeholder="e.g. Morning digest" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="routine-instruction">Instruction</FieldLabel>
          <Textarea id="routine-instruction" className="min-h-24" placeholder="What should the bot do each time?" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel>Repeat</FieldLabel>
            <Select items={REPEAT} value={kind} onValueChange={(v) => isRepeat(v) && setKind(v)}>
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
              <Input id="routine-minute" type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(Number(e.target.value))} />
            </Field>
          )}
          {(kind === "daily" || kind === "weekdays") && (
            <Field>
              <FieldLabel htmlFor="routine-time">At</FieldLabel>
              <Input id="routine-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
          {kind === "once" && (
            <Field>
              <FieldLabel htmlFor="routine-at">On</FieldLabel>
              <Input id="routine-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </Field>
          )}
          {kind === "custom" && (
            <Field>
              <FieldLabel htmlFor="routine-cron">Cron expression</FieldLabel>
              <Input id="routine-cron" className="font-mono" placeholder="30 8 * * 1" value={expr} onChange={(e) => setExpr(e.target.value)} />
              <FieldDescription className="text-xs">Minute, hour, day of month, month, day of week.</FieldDescription>
            </Field>
          )}
          {kind === "weekly" && (
            <Field>
              <FieldLabel>On</FieldLabel>
              <Select items={DAY_ITEMS} value={day} onValueChange={(v) => typeof v === "number" && setDay(v)}>
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
              <Input id="routine-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
          {kind !== "once" && (
            <Field>
              <FieldLabel htmlFor="routine-tz">Time zone</FieldLabel>
              <Input id="routine-tz" placeholder="Europe/Warsaw" value={tz} onChange={(e) => setTz(e.target.value)} />
            </Field>
          )}
        </div>
        <Field orientation="horizontal">
          <Checkbox id="routine-catchup" checked={catchUp} onCheckedChange={setCatchUp} />
          <FieldLabel htmlFor="routine-catchup" className="font-normal">
            Catch up on a missed run after downtime (up to 12 h)
          </FieldLabel>
        </Field>
        <div className="rounded-lg bg-muted/50 p-3 text-xs">
          {preview.error ? (
            <span className="text-destructive">{preview.error}</span>
          ) : preview.next?.length ? (
            <>
              <p className="mb-1 font-medium">Next runs</p>
              <ul className="grid gap-0.5 text-muted-foreground">
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
