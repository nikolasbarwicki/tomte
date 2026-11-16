import { CheckIcon, CopyIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useHostInfo } from "@/host/hooks.ts";
import { withoutTransitions } from "@/lib/theme.ts";

import { Group } from "./parts.tsx";

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

/** General: the theme and the folder bots work in. */
export function General() {
  return (
    <div className="flex flex-col gap-6">
      <Group title="Appearance">
        <ThemeItem />
      </Group>
      <Group title="Workspace">
        <WorkspaceItem />
      </Group>
    </div>
  );
}

function ThemeItem() {
  const { theme, setTheme } = useTheme();
  const current = THEMES.find((t) => t.value === theme)?.value ?? "system";
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>Theme</ItemTitle>
        <ItemDescription>System follows your device's light or dark setting.</ItemDescription>
      </ItemContent>
      <ItemActions>
        <ToggleGroup
          size="sm"
          variant="outline"
          spacing={0}
          aria-label="Theme"
          value={[current]}
          onValueChange={(values: string[]) => {
            const next = THEMES.find((t) => t.value === values[0])?.value;
            if (next && next !== current) withoutTransitions(() => setTheme(next));
          }}
        >
          {THEMES.map((t) => (
            <ToggleGroupItem key={t.value} value={t.value} className="px-2.5 text-xs">
              {t.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </ItemActions>
    </Item>
  );
}

function WorkspaceItem() {
  const cwd = useHostInfo()?.cwd;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!cwd) return;
    await navigator.clipboard.writeText(cwd);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Item variant="outline">
      <ItemContent>
        <ItemTitle>Workspace folder</ItemTitle>
        <ItemDescription>
          Bots run in this folder on the host, so the files they read and write live here.
        </ItemDescription>
      </ItemContent>
      <ItemFooter className="bg-muted/50 rounded-md py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={cwd}>
          {cwd ?? "…"}
        </code>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy folder path"
          disabled={!cwd}
          onClick={() => void copy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </ItemFooter>
    </Item>
  );
}
