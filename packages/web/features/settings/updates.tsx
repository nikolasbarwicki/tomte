import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { HostStatus } from "@tomte/contract/host-status";
import type { UpdateAction } from "@tomte/contract/update";
import type { ReactNode } from "react";

import { confirmAction } from "@/components/confirm.tsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

import { runUpdate } from "./api.ts";
import { restoreWarning, updateLine } from "./update-line.ts";

/** Update now (or Roll back now) stops whatever runs, so it asks first. */
async function updateNow(version: string, rollback: boolean) {
  const ok = await confirmAction({
    title: rollback ? `Roll back to ${version} now?` : `Update to ${version} now?`,
    description:
      "Everything that is running stops: turns, tasks and routine runs are interrupted, and are not run again.",
    action: rollback ? "Roll back now" : "Update now",
    destructive: true,
  });
  if (ok) await runUpdate({ op: "apply", when: "now" });
}

/** A click: the host answers with its status event, and a refusal is shown as a toast. */
const send = (action: UpdateAction) => void runUpdate(action);
const updateWhenIdle = () => send({ op: "apply", when: "idle" });

async function rollBack(version: string) {
  const ok = await confirmAction({
    title: `Roll back to ${version}?`,
    description:
      "The host waits for running work to finish, refuses new messages meanwhile, then restarts on the earlier version. Your data is kept. The release you leave is skipped: it is not offered or installed automatically until a newer one is out.",
    action: "Roll back when idle",
  });
  if (ok) await runUpdate({ op: "rollback", when: "idle", restoreSnapshot: false });
}

/** Across a schema change, going back is a different thing: it replaces the database, so it is its own, destructive confirmation. */
async function restoreAndRollBack(restoreTo: NonNullable<HostStatus["restoreTo"]>) {
  const ok = await confirmAction({
    title: `Restore ${restoreTo.version} and its database?`,
    description: restoreWarning(restoreTo),
    action: "Restore the database and roll back",
    destructive: true,
  });
  if (ok) await runUpdate({ op: "rollback", when: "idle", restoreSnapshot: true });
}

/** The way back to the earlier version, when the host offers one: a plain rollback, or the restore that costs the database. */
function RollbackButton({ status }: { status: HostStatus }): ReactNode {
  if (status.rollbackTo !== undefined) {
    const version = status.rollbackTo;
    return (
      <Button variant="outline" size="sm" onClick={() => void rollBack(version)}>
        Roll back to {version}
      </Button>
    );
  }
  if (status.restoreTo !== undefined) {
    const restoreTo = status.restoreTo;
    return (
      <Button variant="outline" size="sm" onClick={() => void restoreAndRollBack(restoreTo)}>
        Restore {restoreTo.version} and its database…
      </Button>
    );
  }
  return null;
}

/** What the owner can do about the update in `status`; nothing on a host that cannot update itself, or while the helper is replacing it. */
function Actions({
  status,
  update,
}: {
  status: HostStatus;
  update: HostStatus["update"];
}): ReactNode {
  switch (update.status) {
    case "current":
      return (
        <>
          <Button variant="outline" size="sm" onClick={() => send({ op: "check" })}>
            Check for updates
          </Button>
          {update.skipped && (
            <Button variant="outline" size="sm" onClick={updateWhenIdle}>
              Install {update.skipped.version} anyway
            </Button>
          )}
          <RollbackButton status={status} />
        </>
      );
    case "available":
      return (
        <>
          <Button size="sm" onClick={updateWhenIdle}>
            Update when idle
          </Button>
          <Button variant="outline" size="sm" onClick={() => void updateNow(update.version, false)}>
            Update now
          </Button>
          <RollbackButton status={status} />
        </>
      );
    case "draining":
      return (
        <>
          <Button variant="outline" size="sm" onClick={() => send({ op: "cancel" })}>
            Cancel
          </Button>
          {update.overdue && (
            <Button
              size="sm"
              onClick={() => void updateNow(update.version, update.rollback === true)}
            >
              {update.rollback ? "Roll back now" : "Update now"}
            </Button>
          )}
        </>
      );
    case "failed":
      return (
        <>
          {!update.rollback && (
            <Button size="sm" onClick={updateWhenIdle}>
              Try again when idle
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => send({ op: "cancel" })}>
            Dismiss
          </Button>
        </>
      );
    default:
      return null;
  }
}

/** The Updates card of About: the host's update status, what can be done about it and the automatic-update setting. */
export function UpdatesCard({ status }: { status: HostStatus | undefined }) {
  const update = status?.update;
  const line = updateLine(update);
  const managed =
    update !== undefined && update.status !== "bundled" && update.status !== "unmanaged";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{line.title}</CardTitle>
        {line.detail && <CardDescription>{line.detail}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {update && status && (
          <div className="flex flex-wrap items-center gap-2">
            <Actions status={status} update={update} />
            {line.notesUrl && (
              <a
                href={line.notesUrl}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground inline-flex items-center gap-1 text-sm underline"
              >
                Release notes
                <ArrowSquareOutIcon className="size-3 shrink-0" />
              </a>
            )}
          </div>
        )}
        {status?.restoreTo && (update?.status === "current" || update?.status === "available") && (
          <p className="text-muted-foreground text-sm" data-restore-note>
            {restoreWarning(status.restoreTo)}
          </p>
        )}
        {managed && status && (
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              Update automatically when idle
              <span className="text-muted-foreground block text-xs">
                Off by default: a server you have not looked at restarts only if you turn this on.
              </span>
            </span>
            <Switch
              checked={status.autoUpdate}
              onCheckedChange={(enabled) => send({ op: "auto", enabled })}
            />
          </label>
        )}
      </CardContent>
    </Card>
  );
}
