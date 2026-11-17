/** A form field in an accessibility snapshot, with its accessible name. */
const FIELD = /^\s*- (?:textbox|searchbox|combobox|spinbutton)\s+"([^"]*)"/;
const PASSWORD_FIELD = /pass/i;

/** The bot-protection products whose interstitial pages are recognised. Vendors only: no site is named anywhere. */
export type BotWallVendor = "cloudflare" | "datadome" | "perimeterx" | "imperva";

export const VENDOR_NAMES: Record<BotWallVendor, string> = {
  cloudflare: "Cloudflare",
  datadome: "DataDome",
  perimeterx: "PerimeterX",
  imperva: "Imperva",
};

/** A page with no more visible text than this is an interstitial, not an article that quotes one. */
const NEARLY_EMPTY_CHARS = 800;
/** A sign-in form is a small page, or one headed like a sign-in page. */
const SIGN_IN_PAGE_CHARS = 1_500;

/** A vendor's phrases: anywhere on a nearly empty page, or, on a page of any size, as a whole heading or title. */
interface Marker {
  vendor: BotWallVendor;
  /** The phrase, matched anywhere on a nearly empty page. */
  text: RegExp;
  /** What a heading or the title must be, as a whole, to count whatever the page's size. */
  title: RegExp;
}

// Most specific vendors first: "verify you are human" appears on several of them, and Cloudflare's wording is the broadest.
const MARKERS: readonly Marker[] = [
  {
    vendor: "datadome",
    text: /datadome|captcha-delivery\.com|please enable js and disable any ad blocker/i,
    title: /^datadome\W*$/i,
  },
  {
    vendor: "perimeterx",
    text: /press\s*&\s*hold to confirm you are a human|px-captcha|perimeterx|access to this page has been denied/i,
    title:
      /^(?:press\s*&\s*hold to confirm you are a human.*|access to this page has been denied\W*)$/i,
  },
  {
    vendor: "imperva",
    text: /request unsuccessful\.?\s*incapsula incident id|_incapsula_resource|powered by imperva|incapsula incident/i,
    title: /^request unsuccessful\.?\s*incapsula.*$/i,
  },
  {
    vendor: "cloudflare",
    text: /just a moment|verify you are human by completing the action below|checking if the site connection is secure|performing security verification|needs to review the security of your connection|checking your browser before accessing|cloudflare ray id|attention required!? \| cloudflare|enable javascript and cookies to continue/i,
    title: /^(?:just a moment\W*|attention required!? \| cloudflare|verify you are human\W*)$/i,
  },
];

const SIGN_IN_TITLE = /^\s*(?:sign|log)[\s-]?(?:in|on)\b|\b(?:sign|log)[\s-]?in to\b/i;

interface Unit {
  role: string;
  text: string;
}

const LINE = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/;

/** The visible text of an accessibility snapshot, one unit per line: the quoted name and anything after a colon. */
function units(snapshot: string): Unit[] {
  const out: Unit[] = [];
  for (const line of snapshot.split("\n")) {
    const m = LINE.exec(line);
    if (!m) {
      const plain = line.trim();
      if (plain) out.push({ role: "text", text: plain });
      continue;
    }
    const role = m[1] ?? "text";
    const attrs = (m[3] ?? "").replace(/\s*\[[^\]]*\]/g, "");
    const after = attrs.startsWith(":") ? attrs.slice(1).trim() : "";
    for (const text of [m[2] ?? "", after]) if (text) out.push({ role, text });
  }
  return out;
}

/** The vendor whose interstitial this page is, or nothing. A phrase quoted in a long page's body is not a wall. */
export function detectBotWall(snapshot: string, title?: string): BotWallVendor | undefined {
  const all = units(snapshot);
  const empty = all.reduce((n, u) => n + u.text.length, 0) <= NEARLY_EMPTY_CHARS;
  const heads = [title ?? "", ...all.filter((u) => u.role === "heading").map((u) => u.text)].map(
    (t) => t.trim(),
  );
  for (const m of MARKERS) {
    if (heads.some((h) => m.title.test(h))) return m.vendor;
    if (empty && (m.text.test(title ?? "") || all.some((u) => m.text.test(u.text))))
      return m.vendor;
  }
  return undefined;
}

/** Whether the page is a sign-in form: a password field on a small page or one headed like a sign-in page. */
export function detectLoginWall(snapshot: string, title?: string): boolean {
  const all = units(snapshot);
  const fields = snapshot.split("\n").flatMap((l) => FIELD.exec(l)?.[1] ?? []);
  if (!fields.some((n) => PASSWORD_FIELD.test(n))) return false;
  if (all.reduce((n, u) => n + u.text.length, 0) <= SIGN_IN_PAGE_CHARS) return true;
  return [title ?? "", ...all.filter((u) => u.role === "heading").map((u) => u.text)].some((h) =>
    SIGN_IN_TITLE.test(h),
  );
}
