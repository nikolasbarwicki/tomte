// Draws the desktop app's tray icon into packages/desktop/assets/ (committed; rerun only to change the glyph):
//   bun run icons:desktop
// A ring with a dot in it, black on transparent, as `trayTemplate.png` (18px) and `trayTemplate@2x.png` (36px).
// macOS reads the "Template" name as a template image and tints it for the menu bar's light and dark looks.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const OUT = join(import.meta.dir, "../packages/desktop/assets");

/** Coverage of the pixel at (x, y), 0..1, from a signed distance to the glyph's edge in units of the icon's size. */
function alpha(x: number, y: number, size: number): number {
  const edge = (distance: number) => Math.min(1, Math.max(0, 0.5 - distance * size));
  const d = Math.hypot((x + 0.5) / size - 0.5, (y + 0.5) / size - 0.5);
  const ring = edge(Math.abs(d - 0.38) - 0.07);
  const dot = edge(d - 0.14);
  return Math.max(ring, dot);
}

function crc(buf: Buffer): number {
  return Bun.hash.crc32(buf);
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), body.length + 4);
  return out;
}

function png(size: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      rows[y * (size * 4 + 1) + 1 + x * 4 + 3] = Math.round(alpha(x, y, size) * 255);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(join(OUT, "trayTemplate.png"), png(18));
writeFileSync(join(OUT, "trayTemplate@2x.png"), png(36));
console.log(`wrote tray icons to ${OUT}`);
