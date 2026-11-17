import {
  AlarmIcon,
  BrainIcon,
  CursorClickIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  HandshakeIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PlugIcon,
  TerminalIcon,
  type Icon,
} from "@phosphor-icons/react";

import type { Item } from "@/host/transcript.ts";

export type ToolItem = Extract<Item, { kind: "tool" }>;

/** What a tool call says to a person. */
export interface ToolView {
  /** What the bot did: "Searched the web". */
  done: string;
  /** The same while it runs: "Searching the web". */
  doing: string;
  /** What it did it to, short enough for one line: a query, a host and path, a file name. */
  target?: string | undefined;
  /** The target is code or a path, set in mono. */
  code?: boolean;
  icon: Icon;
  /** Every argument, for the expanded view. */
  args: [string, string][];
}

const parse = (input: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(input);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v));

const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : decodeURIComponent(u.pathname);
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
};

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const words = (snake: string) => capital(snake.replace(/^browser_/, "").replaceAll("_", " "));

/** `mcp__<server>__<tool>`; a server name may hold single underscores. */
const MCP = /^mcp__(.+?)__(.+)$/;

export function toolView(tool: ToolItem): ToolView {
  const input = parse(tool.input);
  const args = Object.entries(input).map(([k, v]): [string, string] => [k, str(v)]);
  const view = (
    done: string,
    doing: string,
    icon: Icon,
    target?: string,
    code?: boolean,
  ): ToolView => ({ done, doing, icon, target, ...(code && { code }), args });
  switch (tool.name) {
    case "WebSearch":
      return view(
        "Searched the web",
        "Searching the web",
        MagnifyingGlassIcon,
        `“${str(input.query)}”`,
      );
    case "WebFetch":
      return view("Read", "Reading", GlobeIcon, shortUrl(str(input.url)));
    case "Read":
      return view("Read", "Reading", FileTextIcon, fileName(str(input.file_path)), true);
    case "Write":
    case "Edit":
      return view("Edited", "Editing", NotePencilIcon, fileName(str(input.file_path)), true);
    case "Grep":
    case "Glob":
      return view(
        "Searched files for",
        "Searching files for",
        MagnifyingGlassIcon,
        str(input.pattern),
        true,
      );
    case "Bash": {
      const what = str(input.description);
      return view(what || "Ran", what || "Running", TerminalIcon, str(input.command), true);
    }
  }
  const mcp = MCP.exec(tool.name);
  if (!mcp) return view(tool.name, tool.name, PlugIcon, args[0]?.[1]);
  const [, server = "", name = ""] = mcp;
  if (server === "browser") {
    if (name === "browser_open")
      return view("Opened", "Opening", GlobeIcon, shortUrl(str(input.url)));
    if (name === "browser_snapshot")
      return view("Looked at the page", "Looking at the page", EyeIcon);
    if (name === "browser_click")
      return view("Clicked", "Clicking", CursorClickIcon, str(input.element ?? input.ref));
    return view(words(name), words(name), GlobeIcon);
  }
  if (server === "host" && name === "remember")
    return view("Remembered", "Remembering", BrainIcon, str(input.text));
  if (server === "bots" && name === "hand_off")
    return view("Handed off to", "Handing off to", HandshakeIcon, str(input.bot ?? input.name));
  if (server === "routines") return view(words(name), words(name), AlarmIcon);
  const first = args.find(([, v]) => v && v.length < 120)?.[1];
  return view(words(name), words(name), PlugIcon, first);
}
