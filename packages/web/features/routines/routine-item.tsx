import { RoutineRun, type Routine, type RunStatus } from "@claudebot/contract/events";
import { ChevronRightIcon, EllipsisIcon, PencilIcon, PlayIcon, TrashIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Streamdown } from "streamdown";
import { z } from "zod";

import { confirmAction } from "@/components/confirm.tsx";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { readJson } from "@/host/api.ts";
import { dateTime, duration, tokenCount } from "@/lib/format.ts";
import { cn } from "@/lib/utils";

import { deleteRoutine, routineRuns, runRoutine, setRoutineActive } from "./api.ts";
import { describe } from "./schedule.ts";

const RUN_STATUS: Record<RunStatus, { label: string; style: string }> = {
  running: { label: "Running", style: "bg-amber-500/10 text-amber-700 dark:text-amber-400" },
  waiting: { label: "Waiting for you", style: "bg-sky-500/10 text-sky-700 dark:text-sky-400" },
  succeeded: {
    label: "Succeeded",
    style: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  failed: { label: "Failed", style: "bg-destructive/10 text-destructive" },
  interrupted: { label: "Interrupted", style: "bg-destructive/10 text-destructive" },
  skipped: { label: "Skipped", style: "bg-muted text-muted-foreground" },
};

function RunBadge({ status }: { status: RunStatus }) {
  const { label, style } = RUN_STATUS[status];
  return (
    <Badge variant="secondary" className={style}>
      {status === "running" && <Spinner className="size-3" />}
      {label}
    </Badge>
  );
}

export function RoutineItem({ r, onEdit }: { r: Routine; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [toggling, toggle] = useTransition();
  const [starting, startRun] = useTransition();
  const [removing, startRemoving] = useTransition();
  const [runs, setRuns] = useState<RoutineRun[]>();
  const lastRunId = r.lastRun?.id;
  useEffect(() => {
    if (!open) return;
    void routineRuns(r.id).then(
      async (res) => res.ok && setRuns(await readJson(res, z.array(RoutineRun))),
    );
  }, [open, r.id, lastRunId, r.lastRun?.status]);

  const status = r.running ? "running" : r.lastRun?.status;
  const parked = !r.running && r.lastRun?.status === "waiting";
  const next = !r.active
    ? r.pausedReason === "failures"
      ? "Paused after 5 failed runs"
      : "Paused"
    : r.nextRunAt
      ? `Next run ${dateTime(r.nextRunAt)}`
      : "No runs left";
  const remove = async () => {
    if (
      await confirmAction({
        title: `Delete routine "${r.name}"?`,
        description: "It stops running. This cannot be undone.",
        action: "Delete",
        destructive: true,
      })
    ) {
      startRemoving(async () => {
        await deleteRoutine(r.id);
      });
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
          disabled={toggling}
          onCheckedChange={(active) =>
            toggle(async () => {
              await setRoutineActive(r.id, active);
            })
          }
        />
        <div className="grid min-w-0 flex-1 gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn("truncate text-sm font-medium", !r.active && "text-muted-foreground")}
              title={r.instruction}
            >
              {r.name}
            </span>
            {status && <RunBadge status={status} />}
          </div>
          <span className="text-muted-foreground text-xs">{describe(r.schedule)}</span>
          <span className="text-muted-foreground text-xs">{next}</span>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Run now"
                disabled={r.running || parked || starting}
                onClick={() =>
                  startRun(async () => {
                    await runRoutine(r.id);
                  })
                }
              />
            }
          >
            {r.running || starting ? <Spinner /> : <PlayIcon />}
          </TooltipTrigger>
          <TooltipContent>
            {r.running ? "Running…" : parked ? "Waiting for you" : "Run now"}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={removing}
                aria-label={`Actions for ${r.name}`}
              />
            }
          >
            {removing ? <Spinner /> : <EllipsisIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void remove()}>
              <TrashIcon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group/runs text-muted-foreground hover:text-foreground flex w-full items-center gap-1 border-t px-3 py-1.5 text-xs">
          <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open/runs:rotate-90" />
          Run history
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-1 px-3 pb-3">
            {!runs ? (
              <Spinner className="text-muted-foreground mx-auto my-2" />
            ) : runs.length === 0 ? (
              <p className="text-muted-foreground py-1 text-xs">No runs yet.</p>
            ) : (
              runs.map((run) => <RunRow key={run.id} run={run} />)
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function runUsage(run: RoutineRun) {
  const u = run.usage;
  const cached = u ? u.cacheReadTokens + u.cacheCreationTokens : 0;
  return [
    u && u.inputTokens + u.outputTokens + cached > 0
      ? `${tokenCount(u.inputTokens)} in · ${tokenCount(u.outputTokens)} out${cached > 0 ? ` · ${tokenCount(cached)} cached` : ""}`
      : undefined,
    run.costUsd ? `est. $${run.costUsd.toFixed(2)}` : undefined,
    run.parkedMs > 0 ? `parked ${duration(run.parkedMs)}` : undefined,
  ].filter((s) => s !== undefined);
}

function RunRow({ run }: { run: RoutineRun }) {
  const hasBody = !!(run.error || run.output);
  const used = runUsage(run);
  return (
    <Collapsible disabled={!hasBody}>
      <CollapsibleTrigger className="group/run hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs disabled:hover:bg-transparent">
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform group-data-panel-open/run:rotate-90",
            !hasBody && "invisible",
          )}
        />
        <RunBadge status={run.status} />
        <span className="text-muted-foreground truncate">
          {[
            dateTime(run.startedAt),
            run.trigger === "manual" ? "test run" : "scheduled",
            ...used,
          ].join(" · ")}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="bg-muted/50 mt-1 mb-2 grid gap-2 rounded-md p-3 text-sm">
          {run.error && <p className="text-destructive text-xs">{run.error}</p>}
          {run.output && <Streamdown linkSafety={{ enabled: false }}>{run.output}</Streamdown>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
