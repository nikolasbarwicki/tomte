import {
  WarningCircleIcon,
  CheckCircleIcon,
  ProhibitIcon,
  ListChecksIcon,
} from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useChat } from "@/host/hooks.ts";

import { groupTasks, waitsFor, type TaskRow } from "./model.ts";

const ENDED = {
  done: [<CheckCircleIcon key="i" />, "Done"],
  failed: [<WarningCircleIcon key="i" />, "Failed"],
  cancelled: [<ProhibitIcon key="i" />, "Stopped"],
} as const;

/** The Tasks section of a double-loop bot: what runs now with its status line and findings, what is queued and what waits for what, and what ended lately. */
export function TasksTab() {
  const { items } = useChat();
  const { running, queued, recent } = useMemo(() => groupTasks(items), [items]);
  if (running.length + queued.length + recent.length === 0)
    return (
      <Empty className="border border-dashed p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon />
          </EmptyMedia>
          <EmptyTitle className="text-sm">No tasks yet</EmptyTitle>
          <EmptyDescription className="text-xs">
            Work the bot runs in the background shows up here while it runs.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <div className="grid gap-5" data-testid="tasks-tab">
      <Section title="Running" count={running.length}>
        {running.map((t) => (
          <RunningTask key={t.taskId} task={t} />
        ))}
      </Section>
      <Section title="Queued" count={queued.length}>
        {queued.map((t) => (
          <li key={t.taskId} className="grid gap-0.5" data-task={t.taskId} data-state={t.state}>
            <span className="text-sm font-medium">{t.goal}</span>
            <span className="text-muted-foreground text-xs">Waits for {waitsFor(t, items)}</span>
          </li>
        ))}
      </Section>
      <Section title="Recent" count={recent.length}>
        {recent.map((t) => (
          <EndedTask key={t.taskId} task={t} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="grid gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {title} <span className="tabular-nums">{count}</span>
      </h3>
      <ul className="grid gap-3">{children}</ul>
    </section>
  );
}

function RunningTask({ task }: { task: TaskRow }) {
  const interrupted = task.state === "interrupted";
  return (
    <li className="grid gap-1" data-task={task.taskId} data-state={task.state}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          {interrupted ? <ProhibitIcon className="size-4" /> : <Spinner className="text-primary" />}
        </span>
        <span className="text-sm font-medium">{task.goal}</span>
      </div>
      {interrupted ? (
        <p className="text-muted-foreground pl-6 text-xs">
          Interrupted by a restart of the host; the bot can continue it.
        </p>
      ) : (
        task.status && <p className="text-muted-foreground pl-6 text-xs">{task.status}</p>
      )}
      {task.findings && task.findings.length > 0 && (
        <ul className="list-disc pl-10 text-xs" aria-label="Findings">
          {task.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function EndedTask({ task }: { task: TaskRow }) {
  if (task.state !== "done" && task.state !== "failed" && task.state !== "cancelled") return null;
  const [icon, label] = ENDED[task.state];
  return (
    <li
      className="text-muted-foreground flex items-start gap-2 text-sm"
      data-task={task.taskId}
      data-state={task.state}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
      <span>
        {label}: <span className="text-foreground">{task.goal}</span>
      </span>
    </li>
  );
}
