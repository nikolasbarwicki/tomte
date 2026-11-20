// Draws every brand asset from the two master marks in brand/ (committed; rerun after changing a master):
//   bun run brand:assets
// Masters: brand/tomte-light.svg (warm paper ground) and brand/tomte-dark.svg (charcoal ground), each a 100-unit square
// holding a ground rect, the body path and the eyes path. Everything else is derived from them:
//   .github/assets/      README logos, banners, download buttons, the social preview PNG (upload it in repo settings)
//   packages/web/public/ favicon.svg, following the browser's colour scheme
//   brand/               app-icon.png (Windows, Linux) and app-icon-mac.png (macOS grid), read by package:desktop
//   packages/desktop/assets/ trayTemplate.png and @2x, the body as a black template image macOS tints
// PNGs are rendered by headless Chrome (CHROME_PATH, as the smokes use).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page } from "playwright-core";

const ROOT = join(import.meta.dir, "..");
const BRAND = join(ROOT, "brand");
const GITHUB = join(ROOT, ".github/assets");
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TAGLINE = "Self-hosted AI bots with the hood open";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
/** Corner radius of a tile as a share of its side: Apple's app icon rounding, used for every tile. */
const ROUNDING = 0.2237;

type Mark = {
  ground: string;
  body: string;
  bodyPath: string;
  eyes: string;
  eyesPath: string;
  eyesWidth: string;
};

function attr(svg: string, element: string, name: string): string {
  const tag = svg.match(new RegExp(`<${element}\\b[^>]*\\b${name}="[^"]*"[^>]*>`, "g")) ?? [];
  const value = tag[0]?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  if (value === undefined) throw new Error(`master mark has no <${element} ${name}>`);
  return value;
}

function readMark(file: string): Mark {
  const svg = readFileSync(join(BRAND, file), "utf8");
  const paths = svg.match(/<path\b[^>]*>/g) ?? [];
  const [body, eyes] = paths;
  if (paths.length !== 2 || body === undefined || eyes === undefined)
    throw new Error(`${file}: expected a body path and an eyes path`);
  return {
    ground: attr(svg, "rect", "fill"),
    body: attr(body, "path", "fill"),
    bodyPath: attr(body, "path", "d"),
    eyes: attr(eyes, "path", "stroke"),
    eyesPath: attr(eyes, "path", "d"),
    eyesWidth: attr(eyes, "path", "stroke-width"),
  };
}

const MARKS = { light: readMark("tomte-light.svg"), dark: readMark("tomte-dark.svg") } as const;
type Theme = keyof typeof MARKS;

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>\n`;

/** The body and eyes in the master's 100-unit space; colours may be CSS (`currentColor`, a class) or literal. */
function figure(m: Mark, body: string, eyes: string): string {
  return `<path d="${m.bodyPath}" fill="${body}"/><path d="${m.eyesPath}" stroke="${eyes}" stroke-width="${m.eyesWidth}" stroke-linecap="round" fill="none"/>`;
}

/** A rounded tile of the mark at (x, y), `size` wide. The light tile gets a hairline so it holds on a white page. */
function tile(theme: Theme, x: number, y: number, size: number): string {
  const m = MARKS[theme];
  const r = 100 * ROUNDING;
  const edge = theme === "light" ? ` stroke="#1C1A17" stroke-opacity="0.1" stroke-width="0.6"` : "";
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 100 100"><rect x="0.3" y="0.3" width="99.4" height="99.4" rx="${r}" fill="${m.ground}"${edge}/>${figure(m, m.body, m.eyes)}</svg>`;
}

/** The body alone in one colour with the eyes cut out, in the master's 100-unit space. */
function silhouette(color: string): string {
  const m = MARKS.light;
  return `<mask id="eyes" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><path d="${m.eyesPath}" stroke="#000" stroke-width="${m.eyesWidth}" stroke-linecap="round" fill="none"/></mask><path d="${m.bodyPath}" fill="${color}" mask="url(#eyes)"/>`;
}

/** Text colours on GitHub's own page backgrounds; the banners have no background of their own. */
const PAGE = {
  light: { fg: "#1f2328", muted: "#59636e" },
  dark: { fg: "#f0f6fc", muted: "#9198a1" },
} as const;

function banner(theme: Theme): string {
  const t = PAGE[theme];
  return svg(
    1280,
    320,
    `${tile(theme, 120, 80, 160)}<text x="330" y="180" font-family="${FONT}" font-size="104" font-weight="700" fill="${t.fg}">Tomte</text><text x="334" y="232" font-family="${FONT}" font-size="30" fill="${t.muted}">${TAGLINE}</text>`,
  );
}

/** A download button in the mark's plum that reads on both GitHub themes. */
function button(label: string): string {
  const { light, dark } = MARKS;
  const width = Math.round(62 + label.length * 9.4);
  return svg(
    width,
    44,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="43" rx="10" fill="${light.body}" stroke="${dark.body}"/><svg x="12" y="8" width="28" height="28" viewBox="0 0 100 100">${figure(light, light.ground, light.body)}</svg><text x="48" y="28" font-family="${FONT}" font-size="17" font-weight="600" fill="${light.ground}">${label}</text>`,
  );
}

/** The web UI's favicon: the light tile, the dark one when the browser prefers dark. */
function favicon(): string {
  const { light, dark } = MARKS;
  const style = `.g{fill:${light.ground}}.b{fill:${light.body}}.e{stroke:${light.eyes}}@media (prefers-color-scheme:dark){.g{fill:${dark.ground}}.b{fill:${dark.body}}.e{stroke:${dark.eyes}}}`;
  return svg(
    100,
    100,
    `<style>${style}</style><rect class="g" width="100" height="100" rx="${100 * ROUNDING}"/><path class="b" d="${light.bodyPath}"/><path class="e" d="${light.eyesPath}" stroke-width="${light.eyesWidth}" stroke-linecap="round" fill="none"/>`,
  );
}

const social = svg(
  1280,
  640,
  `<rect width="1280" height="640" fill="${MARKS.dark.ground}"/><svg x="530" y="70" width="220" height="220" viewBox="0 0 100 100">${figure(MARKS.dark, MARKS.dark.body, MARKS.dark.ground)}</svg><text x="640" y="430" text-anchor="middle" font-family="${FONT}" font-size="96" font-weight="700" fill="${MARKS.dark.eyes}">Tomte</text><text x="640" y="490" text-anchor="middle" font-family="${FONT}" font-size="32" fill="#a39d93">${TAGLINE}</text>`,
);

/** macOS app icon grid: an 824-unit tile centred on a 1024 canvas. */
const appIconMac = svg(1024, 1024, tile("dark", 100, 100, 824));
const appIcon = svg(1024, 1024, tile("dark", 0, 0, 1024));

async function render(
  page: Page,
  image: string,
  size: { width: number; height: number },
  file: string,
) {
  await page.setViewportSize(size);
  await page.setContent(`<!doctype html><html><body style="margin:0">${image}</body></html>`);
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, ...size } });
}

/** The body's bounds in the 100-unit space, squared and padded, so the tray glyph fills its 18px box. */
async function trayViewBox(page: Page): Promise<string> {
  await page.setContent(
    `<!doctype html><html><body>${svg(100, 100, silhouette("#000"))}</body></html>`,
  );
  const box = await page.evaluate(() => {
    const { x, y, width, height } = document.querySelector<SVGPathElement>("path[mask]")!.getBBox();
    return { x, y, width, height };
  });
  const side = Math.max(box.width, box.height) * 1.04;
  const x = box.x + box.width / 2 - side / 2;
  const y = box.y + box.height / 2 - side / 2;
  return `${x.toFixed(2)} ${y.toFixed(2)} ${side.toFixed(2)} ${side.toFixed(2)}`;
}

mkdirSync(GITHUB, { recursive: true });
for (const theme of ["light", "dark"] as const) {
  writeFileSync(join(GITHUB, `logo-${theme}.svg`), svg(100, 100, tile(theme, 0, 0, 100)));
  writeFileSync(join(GITHUB, `banner-${theme}.svg`), banner(theme));
}
for (const [file, label] of [
  ["download-macos.svg", "Download for macOS"],
  ["download-windows.svg", "Download for Windows"],
  ["download-linux.svg", "Download for Linux"],
] as const)
  writeFileSync(join(GITHUB, file), button(label));
writeFileSync(join(ROOT, "packages/web/public/favicon.svg"), favicon());

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  await render(page, social, { width: 1280, height: 640 }, join(GITHUB, "social-preview.png"));
  await render(page, appIconMac, { width: 1024, height: 1024 }, join(BRAND, "app-icon-mac.png"));
  await render(page, appIcon, { width: 1024, height: 1024 }, join(BRAND, "app-icon.png"));
  const viewBox = await trayViewBox(page);
  for (const [file, size] of [
    ["trayTemplate.png", 18],
    ["trayTemplate@2x.png", 36],
  ] as const) {
    const image = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${silhouette("#000")}</svg>`;
    await render(
      page,
      image,
      { width: size, height: size },
      join(ROOT, "packages/desktop/assets", file),
    );
  }
} finally {
  await browser.close();
}
console.log("wrote brand assets");
