import { crc32 } from "node:zlib";

/** One member of an archive; `data` is absent for a folder, whose `name` ends in "/". */
export interface ZipEntry {
  /** `/`-separated and relative. */
  name: string;
  /** Milliseconds since the epoch. */
  mtime: number;
  data?: Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
}

const UTF8_NAMES = 0x800;
const DATA_DESCRIPTOR = 0x8;
const ZIP64_VERSION = 45;
const FOLDER_VERSION = 20;
const UNIX = 3 << 8;
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
const FOLDER_ATTRIBUTES = ((0o40755 << 16) | 0x10) >>> 0;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** Local time in MS-DOS form; the format cannot hold a date before 1980. */
function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** What the central directory needs to remember about a member once its bytes have gone out. */
interface Written {
  name: Uint8Array;
  folder: boolean;
  time: number;
  date: number;
  crc: number;
  size: number;
  offset: number;
}

function centralRecord(w: Written): Uint8Array {
  const out = new Uint8Array(46 + w.name.length + 28);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, UNIX | ZIP64_VERSION, true);
  v.setUint16(6, ZIP64_VERSION, true);
  v.setUint16(8, UTF8_NAMES | (w.folder ? 0 : DATA_DESCRIPTOR), true);
  v.setUint16(12, w.time, true);
  v.setUint16(14, w.date, true);
  v.setUint32(16, w.crc, true);
  v.setUint32(20, U32_MAX, true);
  v.setUint32(24, U32_MAX, true);
  v.setUint16(28, w.name.length, true);
  v.setUint16(30, 28, true);
  v.setUint32(38, w.folder ? FOLDER_ATTRIBUTES : FILE_ATTRIBUTES, true);
  v.setUint32(42, U32_MAX, true);
  out.set(w.name, 46);
  const extra = 46 + w.name.length;
  v.setUint16(extra, 1, true);
  v.setUint16(extra + 2, 24, true);
  v.setBigUint64(extra + 4, BigInt(w.size), true);
  v.setBigUint64(extra + 12, BigInt(w.size), true);
  v.setBigUint64(extra + 20, BigInt(w.offset), true);
  return out;
}

function trailer(count: number, directorySize: number, directoryOffset: number): Uint8Array {
  const out = new Uint8Array(56 + 20 + 22);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x06064b50, true);
  v.setBigUint64(4, 44n, true);
  v.setUint16(12, UNIX | ZIP64_VERSION, true);
  v.setUint16(14, ZIP64_VERSION, true);
  v.setBigUint64(24, BigInt(count), true);
  v.setBigUint64(32, BigInt(count), true);
  v.setBigUint64(40, BigInt(directorySize), true);
  v.setBigUint64(48, BigInt(directoryOffset), true);
  v.setUint32(56, 0x07064b50, true);
  v.setBigUint64(64, BigInt(directoryOffset + directorySize), true);
  v.setUint32(72, 1, true);
  v.setUint32(76, 0x06054b50, true);
  v.setUint16(84, U16_MAX, true);
  v.setUint16(86, U16_MAX, true);
  v.setUint32(88, U32_MAX, true);
  v.setUint32(92, U32_MAX, true);
  return out;
}

/**
 * A store-only ZIP64 archive of `entries`, produced as it is read: a member's bytes go out as they arrive, so memory
 * holds one chunk and the central directory (about 100 bytes a member), never a file. Sizes and checksums follow each
 * file in a data descriptor, so no member is read twice and the archive stays valid when a file's size differs from
 * what a listing said. Every size and offset is 64-bit, whatever the archive's size.
 */
export async function* zip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
): AsyncGenerator<Uint8Array> {
  const written: Written[] = [];
  let offset = 0;
  for await (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    if (name.length > U16_MAX) throw new Error(`a name is too long for a zip: ${entry.name}`);
    const folder = entry.data === undefined;
    const { time, date } = dosDateTime(entry.mtime);
    const header = new Uint8Array(30 + name.length + (folder ? 0 : 20));
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, folder ? FOLDER_VERSION : ZIP64_VERSION, true);
    v.setUint16(6, UTF8_NAMES | (folder ? 0 : DATA_DESCRIPTOR), true);
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint16(26, name.length, true);
    header.set(name, 30);
    if (!folder) {
      v.setUint32(18, U32_MAX, true);
      v.setUint32(22, U32_MAX, true);
      v.setUint16(28, 20, true);
      const extra = 30 + name.length;
      v.setUint16(extra, 1, true);
      v.setUint16(extra + 2, 16, true);
    }
    const start = offset;
    yield header;
    offset += header.length;

    let crc = 0;
    let size = 0;
    if (entry.data) {
      for await (const chunk of entry.data) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        offset += chunk.length;
        yield chunk;
      }
      const descriptor = new Uint8Array(24);
      const d = new DataView(descriptor.buffer);
      d.setUint32(0, 0x08074b50, true);
      d.setUint32(4, crc, true);
      d.setBigUint64(8, BigInt(size), true);
      d.setBigUint64(16, BigInt(size), true);
      yield descriptor;
      offset += descriptor.length;
    }
    written.push({ name, folder, time, date, crc, size, offset: start });
  }

  const records = written.map(centralRecord);
  const directorySize = records.reduce((n, r) => n + r.length, 0);
  yield* records;
  yield trailer(written.length, directorySize, offset);
}
