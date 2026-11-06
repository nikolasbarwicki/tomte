import { ArrowRight } from "lucide-react";
import { Section } from "./parts.tsx";

export function TryIt({ examples, onTry }: { examples: string[]; onTry: (prompt: string) => void }) {
  return (
    <Section title="Try it" description="Opens a chat with the prompt filled in; nothing is sent until you send it.">
      <ul className="divide-y">
        {examples.map((p) => (
          <li key={p}>
            <button type="button" onClick={() => onTry(p)} className="group flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
              <span className="min-w-0 flex-1">“{p}”</span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
