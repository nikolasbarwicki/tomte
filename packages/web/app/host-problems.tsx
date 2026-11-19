import { WarningIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { updateFailedText, type HostProblem } from "@tomte/contract/host-status";

import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What each problem says and the one click that fixes it. */
function describe(problem: HostProblem) {
  switch (problem.kind) {
    case "claude-signed-out":
      return problem.reason === "token-rejected"
        ? ({
            text: "Claude rejected the long-lived token on this host, so no bot can run.",
            action: "Replace token",
            to: "models",
          } as const)
        : ({
            text: "Claude is signed out on this host, so no bot can run.",
            action: "Sign in",
            to: "models",
          } as const);
    case "update-failed":
      return { text: `${updateFailedText(problem)}.`, action: "Details", to: "about" } as const;
  }
}

/**
 * The host's problems, one banner row each, above every page. The list is the host's own status, so a row goes the moment its cause
 * does and cannot be dismissed.
 */
export function HostProblems({ problems }: { problems: readonly HostProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <div
      data-host-problems
      className="flex shrink-0 flex-col gap-1.5 pt-2 pr-2 pl-[calc(--spacing(2)+var(--titlebar-inset,0px))] md:pl-2"
    >
      {problems.map((problem) => {
        const { text, action, to } = describe(problem);
        return (
          <Alert
            key={problem.kind}
            variant="destructive"
            data-host-problem={problem.kind}
            className="bg-destructive/5 flex items-center gap-2"
          >
            <WarningIcon weight="fill" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{text}</span>
            <Link
              to="/settings/$section"
              params={{ section: to }}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
            >
              {action}
            </Link>
          </Alert>
        );
      })}
    </div>
  );
}
