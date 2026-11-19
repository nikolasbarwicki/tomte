// Browser smoke of file uploads:
//   bun scripts/smoke-files-ui.ts             (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as the other smokes; the host runs with a 1 MiB per-file cap (`--max-upload-mib 1`) so a refusal is quick. The
// page streams each picked file to `/api/files/upload`. Covers: a picked file landing in the files folder, a taken name renamed
// with a toast that says from what, a picked folder keeping its tree, a file over the cap refused with the cap named and
// nothing written, and the composer's attachments (a file, a folder, the same folder again in a new one) saved under
// `attachments/` and delivered to the bot with their absolute paths. Dropping needs the OS's drag and drop and is not driven
// here. Exits non-zero on the first failed check.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { botFilesPath } from "../packages/host/src/bots/index.ts";
import { startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("files-ui", { hostFlags: () => ["--max-upload-mib", "1"] });
const { host, page, check, pageErrors, runDir } = smoke;
const botId = host.createBot("Filer");
const files = botFilesPath(host.dataRoot, botId);

const source = join(runDir, "source");
mkdirSync(join(source, "tree", "sub"), { recursive: true });
writeFileSync(join(source, "report.txt"), "the report");
writeFileSync(join(source, "tree", "a.md"), "A");
writeFileSync(join(source, "tree", "sub", "b.md"), "B");
writeFileSync(join(source, "big.bin"), Buffer.alloc(2 * 2 ** 20, 1));

const panel = page.locator("[data-panel-section]");
const composer = page.locator("form");
/** A hidden input that picks files, or with `folder` a folder; the first one inside `scope`. */
const picker = (scope: typeof panel, folder: boolean) =>
  scope.locator(
    folder ? "input[type=file][webkitdirectory]" : "input[type=file]:not([webkitdirectory])",
  );
const toast = (text: string | RegExp) => page.locator("[data-sonner-toast]", { hasText: text });

try {
  await page.goto(`${host.clientUrl}/bots/${botId}?panel=files`);
  const uploadFiles = panel.getByRole("button", { name: "Upload files" });
  await uploadFiles.waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent?.includes("Upload files") && !b.disabled,
    ),
  );

  console.log(
    "a picked file lands in the files folder; the same name again is renamed and the toast says from what",
  );
  await picker(panel, false).setInputFiles(join(source, "report.txt"));
  await toast("Uploaded report.txt").waitFor();
  check(
    readFileSync(join(files, "report.txt"), "utf8") === "the report",
    "report.txt is saved with its bytes",
  );
  await panel.getByText("report.txt", { exact: true }).waitFor();
  await picker(panel, false).setInputFiles(join(source, "report.txt"));
  await toast("report.txt was taken; saved as report 2.txt").waitFor();
  check(existsSync(join(files, "report 2.txt")), "the second copy is report 2.txt");

  console.log("a picked folder keeps its tree");
  await picker(panel, true).setInputFiles(join(source, "tree"));
  await toast("Uploaded 2 files").waitFor();
  check(readFileSync(join(files, "tree", "a.md"), "utf8") === "A", "tree/a.md is saved");
  check(readFileSync(join(files, "tree", "sub", "b.md"), "utf8") === "B", "tree/sub/b.md is saved");
  await panel.getByText("tree/sub/b.md", { exact: true }).waitFor();

  console.log("a file over the cap is refused with the cap named, before anything is sent");
  await picker(panel, false).setInputFiles(join(source, "big.bin"));
  await toast("the upload limit is 1.0 MB per file").waitFor();
  check(!existsSync(join(files, "big.bin")), "nothing of big.bin is saved");

  console.log("the composer's attachments are uploaded when the message is sent");
  const box = page.getByRole("textbox", { name: "Message Filer", exact: true });
  await picker(composer, false).setInputFiles(join(source, "report.txt"));
  await picker(composer, true).setInputFiles(join(source, "tree"));
  await box.fill("read these");
  await box.press("Enter");
  await host.until(() => host.messagesOf(botId).length === 1);
  const sent = host.messagesOf(botId)[0]!;
  check(sent.startsWith("read these\n"), "the message carries its text");
  check(
    sent.includes(`<attachment kind="file" path="${join(files, "attachments", "report.txt")}"/>`),
    "the bot is told where the file is",
  );
  check(
    sent.includes(`<attachment kind="folder" path="${join(files, "attachments", "tree")}"/>`),
    "the bot is told where the folder is",
  );
  check(
    readFileSync(join(files, "attachments", "tree", "sub", "b.md"), "utf8") === "B",
    "the attached folder keeps its tree",
  );

  console.log("the same folder attached again goes into a new one");
  await picker(composer, true).setInputFiles(join(source, "tree"));
  await box.fill("again");
  await box.press("Enter");
  await host.until(() => host.messagesOf(botId).length === 2);
  check(
    host.messagesOf(botId)[1]!.includes(`path="${join(files, "attachments", "tree 2")}"`),
    "the second copy is attachments/tree 2",
  );
  check(
    readFileSync(join(files, "attachments", "tree 2", "a.md"), "utf8") === "A" &&
      readFileSync(join(files, "attachments", "tree", "a.md"), "utf8") === "A",
    "both folders hold their files",
  );

  check(pageErrors.length === 0, `no page errors ${pageErrors.join("; ")}`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
