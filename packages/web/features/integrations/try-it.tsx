import { ArrowRightIcon } from "@phosphor-icons/react";

import { Section } from "./parts.tsx";

export function TryIt({
  examples,
  onTry,
}: {
  examples: string[];
  onTry: (prompt: string) => void;
}) {
  return (
    <Section
      title="Try it"
      description="Opens a chat with the prompt filled in; nothing is sent until you send it."
    >
      <ul className="divide-y">
        {examples.map((p) => (
          <li key={p}>
            <button
              type="button"
              onClick={() => onTry(p)}
              className="group hover:bg-muted/50 focus-visible:bg-muted/50 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm outline-none"
            >
              <span className="min-w-0 flex-1">“{p}”</span>
              <ArrowRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
