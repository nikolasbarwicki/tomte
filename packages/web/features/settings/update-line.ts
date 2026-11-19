import { updateFailedText, type UpdateStatus } from "@tomte/contract/host-status";

/** What the Updates card says of a host's update status: a headline, a line under it and, when there is one, the release notes. */
export interface UpdateLine {
  title: string;
  detail: string;
  notesUrl?: string;
}

/** `now` is the clock, so "checked" reads the same in a test. */
export function updateLine(status: UpdateStatus | undefined, now = Date.now()): UpdateLine {
  if (status === undefined) return { title: "…", detail: "" };
  switch (status.status) {
    case "bundled":
      return {
        title: "Updated with the app",
        detail: "The desktop app replaces this host's program when it updates.",
      };
    case "unmanaged":
      return { title: "Can't update from here", detail: `${capitalized(status.reason)}.` };
    case "current": {
      if (status.checkedAt === 0)
        return { title: "Checking for updates…", detail: "The release feed has not answered yet." };
      const { skipped } = status;
      if (skipped === undefined)
        return { title: "Up to date", detail: `Checked ${ago(now - status.checkedAt)}.` };
      return {
        title: "Up to date",
        detail: `Checked ${ago(now - status.checkedAt)}. ${skipped.version} is skipped because you rolled back from it: it is not offered or installed automatically until a newer release is out.${
          skipped.raisesShellApi
            ? " It changes what the desktop app and this host say to each other; update the app as well."
            : ""
        }`,
        ...(/^https?:\/\//.test(skipped.notesUrl) && { notesUrl: skipped.notesUrl }),
      };
    }
    case "available":
      return {
        title: `${status.version} available`,
        detail: status.raisesShellApi
          ? "This release changes what the desktop app and this host say to each other; update the app as well."
          : "A newer release is out.",
        // The link opens in the system browser; only a web page is one.
        ...(/^https?:\/\//.test(status.notesUrl) && { notesUrl: status.notesUrl }),
      };
    case "draining": {
      const waiting = `${
        status.running === 0
          ? "Nothing is running."
          : `Waiting for ${status.running} ${status.running === 1 ? "thing" : "things"} to finish.`
      } New messages are refused until ${status.rollback ? "the rollback" : "the update"} is done.${
        status.overdue
          ? ` This is taking longer than 30 minutes; ${status.rollback ? "Roll back now" : "Update now"} stops whatever is still running.`
          : ""
      }`;
      return {
        title: status.rollback
          ? `Rolling back to ${status.version} when idle`
          : `Updating to ${status.version} when idle`,
        detail: waiting,
      };
    }
    case "applying":
      return {
        title: status.rollback
          ? `Rolling back to ${status.version}…`
          : `Updating to ${status.version}…`,
        detail: "The host is being replaced and restarts; this page reconnects when it is back.",
      };
    case "failed":
      return { title: `${updateFailedText(status)}.`, detail: `${capitalized(status.reason)}.` };
  }
}

const capitalized = (s: string) => s.slice(0, 1).toUpperCase() + s.slice(1);

/** The one wording of what restoring the pre-update database copy costs, for the confirmation and the card. */
export function restoreWarning(restoreTo: { version: string; snapshotAt: number }): string {
  return `${restoreTo.version} cannot open the database as it is now. Going back restores the copy taken ${new Date(restoreTo.snapshotAt).toLocaleString()}, before the update. Everything that changed since is lost (messages, memory, routine runs and settings), and that cannot be undone.`;
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}
