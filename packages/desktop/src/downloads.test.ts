import { describe, expect, test } from "bun:test";

import { fileManagerName, freePath, handleDownload, type DownloadsDeps } from "./downloads.ts";
import type { Note } from "./needs-you-banner.ts";

describe("where a download is saved", () => {
  test("a free name is used as it is", () => {
    expect(freePath("/dl", "Ada.zip", () => false)).toBe("/dl/Ada.zip");
  });

  test("a taken name gets the next free number before its extension", () => {
    const taken = new Set(["/dl/Ada.zip", "/dl/Ada (1).zip"]);
    expect(freePath("/dl", "Ada.zip", (p) => taken.has(p))).toBe("/dl/Ada (2).zip");
  });

  test("a name without an extension is numbered at its end", () => {
    expect(freePath("/dl", "notes", (p) => p === "/dl/notes")).toBe("/dl/notes (1)");
  });

  test("a name that tries to leave the folder stays inside it", () => {
    expect(freePath("/dl", "../../etc/passwd", () => false)).toBe("/dl/passwd");
  });
});

/** A download item the test finishes by hand. */
function item(name: string) {
  let done: ((event: unknown, state: string) => void) | undefined;
  const saved: string[] = [];
  return {
    saved,
    finish: (state: string) => done?.({}, state),
    item: {
      getFilename: () => name,
      setSavePath: (path: string) => void saved.push(path),
      once(_event: "done", listener: (event: unknown, state: string) => void) {
        done = listener;
      },
    },
  };
}

function deps(existing: string[] = []) {
  const notes: Note[] = [];
  const revealed: string[] = [];
  const logged: string[] = [];
  const value: DownloadsDeps = {
    folder: () => "/home/me/Downloads",
    exists: (p) => existing.includes(p),
    notify: (n) => void notes.push(n),
    reveal: (p) => void revealed.push(p),
    fileManager: "Finder",
    log: (m) => void logged.push(m),
  };
  return { value, notes, revealed, logged };
}

describe("a download the window starts", () => {
  test("is saved without asking, announced when it completes, and revealed on click", () => {
    const d = deps();
    const download = item("Ada.zip");
    handleDownload(download.item, d.value);

    expect(download.saved).toEqual(["/home/me/Downloads/Ada.zip"]);
    expect(d.notes).toEqual([]);

    download.finish("completed");

    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]).toMatchObject({
      title: "Downloaded Ada.zip",
      body: "Click to show it in Finder.",
    });
    expect(d.revealed).toEqual([]);
    d.notes[0]!.onClick();
    expect(d.revealed).toEqual(["/home/me/Downloads/Ada.zip"]);
  });

  test("never replaces a file already there, and reveals the one it saved", () => {
    const d = deps(["/home/me/Downloads/Ada.zip"]);
    const download = item("Ada.zip");
    handleDownload(download.item, d.value);
    download.finish("completed");

    expect(download.saved).toEqual(["/home/me/Downloads/Ada (1).zip"]);
    d.notes[0]!.onClick();
    expect(d.revealed).toEqual(["/home/me/Downloads/Ada (1).zip"]);
  });

  test("a cancelled download says nothing", () => {
    const d = deps();
    const download = item("Ada.zip");
    handleDownload(download.item, d.value);
    download.finish("cancelled");
    expect(d.notes).toEqual([]);
  });

  test("an interrupted download is announced as failed and reveals nothing", () => {
    const d = deps();
    const download = item("Ada.zip");
    handleDownload(download.item, d.value);
    download.finish("interrupted");

    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]!.title).toBe("Download of Ada.zip failed");
    d.notes[0]!.onClick();
    expect(d.revealed).toEqual([]);
    expect(d.logged).toHaveLength(1);
  });
});

test("the file manager is named for the platform", () => {
  expect(fileManagerName("darwin")).toBe("Finder");
  expect(fileManagerName("win32")).toBe("File Explorer");
  expect(fileManagerName("linux")).toBe("the file manager");
});
