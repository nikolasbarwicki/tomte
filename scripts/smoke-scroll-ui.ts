// Browser smoke of the transcript's scrolling:
//   bun scripts/smoke-scroll-ui.ts            (CHROME_PATH names a Chrome/Chromium binary; macOS's Google Chrome by default)
// Same harness as the other smokes. The fake Claude CLI streams long replies word by word from a `loop.json` script; the page is
// sampled while they stream. Covers: every reply, short or long, ends with its last line in view; wheel turns down while already
// at the end keep following (they used to stop it); scrolling up stops following, the scroll-to-end button resumes it; a message
// sent while scrolled up jumps to the end; a reload opens at the end. Exits non-zero on the first failed check.
import { startSmoke } from "./smoke-kit.ts";

const smoke = await startSmoke("scroll-ui");
const { host, page, check, pageErrors } = smoke;
const botId = host.createBot("Scroll");

const usage = { input_tokens: 1, output_tokens: 1 };
const streamEvent = (event: object) => ({
  emit: { type: "stream_event", event, parent_tool_use_id: null },
});
/** A reply of `paragraphs` paragraphs streamed word by word, `delay` ms apart, as one assistant message. */
const reply = (match: string, paragraphs: number, delay: number) => {
  const text = Array.from(
    { length: paragraphs },
    (_, i) =>
      `Paragraph ${i} of ${match}. ${"Lorem ipsum dolor sit amet, consectetur elit. ".repeat(4)}\n\n`,
  ).join("");
  const id = `msg_${match}`;
  const message = { id, type: "message", role: "assistant", model: "fake", usage };
  const steps: Record<string, unknown>[] = [
    streamEvent({ type: "message_start", message: { ...message, content: [], stop_reason: null } }),
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];
  for (const word of text.split(/(?<=\s)/).filter(Boolean))
    steps.push(
      streamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: word },
      }),
      { sleep: delay },
    );
  steps.push(
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }),
    streamEvent({ type: "message_stop" }),
    {
      emit: {
        type: "assistant",
        message: { ...message, content: [{ type: "text", text }], stop_reason: "end_turn" },
        parent_tool_use_id: null,
      },
    },
    { result: text },
  );
  return { match, steps };
};
host.loopScript(
  reply("short-reply", 1, 0),
  reply("wheel-at-end", 20, 8),
  reply("scroll-up", 12, 8),
  reply("send-while-up", 12, 0),
);

const box = page.getByRole("textbox", { name: "Message Scroll", exact: true });
const viewport = page.getByRole("region", { name: "Messages" });
const toEnd = page.getByRole("button", { name: "Scroll to end" });
/** `below`: px from the last row's bottom down to the viewport's (> 0: under the fold). `top`: the viewport's scroll position. */
const position = () =>
  viewport.evaluate((vp) => {
    const rows = [...vp.querySelector('[role="log"]')!.children].filter(
      (c) => !c.hasAttribute("aria-hidden"),
    );
    return {
      below: Math.round(
        rows.at(-1)!.getBoundingClientRect().bottom - vp.getBoundingClientRect().bottom,
      ),
      top: Math.round(vp.scrollTop),
    };
  });
/**
 * The largest `below` over `ms`, read on every resize of the rows. The observer is created after the page's own, so its callback
 * runs after the page's in the same frame: it reads what gets painted, not the layout between a new word and the follow.
 */
const worstBelow = async (ms: number) => {
  const sampler = await viewport.evaluateHandle((vp) => {
    const log = vp.querySelector('[role="log"]')!;
    const state = { worst: -Infinity, observer: undefined as ResizeObserver | undefined };
    state.observer = new ResizeObserver(() => {
      const rows = [...log.children].filter((c) => !c.hasAttribute("aria-hidden"));
      const below = rows.at(-1)!.getBoundingClientRect().bottom - vp.getBoundingClientRect().bottom;
      state.worst = Math.max(state.worst, Math.round(below));
    });
    for (const el of [log, ...log.children]) state.observer.observe(el);
    return state;
  });
  await Bun.sleep(ms);
  return sampler.evaluate((state) => {
    state.observer!.disconnect();
    return state.worst;
  });
};
/** Waits until the streaming reply (the row above the presence line) is taller than the viewport. */
const overflowing = () =>
  page.waitForFunction(() => {
    const vp = document.querySelector('[role="region"][aria-label="Messages"]')!;
    const presence = vp.querySelector('[role="status"]')?.closest('[role="log"] > *');
    const row = presence?.previousElementSibling;
    return (
      row !== null && row !== undefined && row.getBoundingClientRect().height > vp.clientHeight
    );
  });
const idle = () =>
  page.waitForFunction(() => !document.querySelector('[role="status"] .shimmer'), undefined, {
    timeout: 20_000,
  });
const send = async (text: string) => {
  await box.fill(text);
  await box.press("Enter");
};
const wheel = async (deltaY: number) => {
  const b = (await viewport.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, deltaY);
    await Bun.sleep(16);
  }
};
// A row's bottom within a pixel of the viewport's, or above it: the newest line is in view.
const inView = (below: number) => below <= 1;

try {
  await page.goto(`${host.clientUrl}/bots/${botId}`);
  await box.waitFor();

  console.log("a short reply");
  await send("short-reply");
  await idle();
  check(inView((await position()).below), "the short reply is in view");

  console.log("a long streamed reply, with wheel turns down while at the end");
  await send("wheel-at-end");
  await overflowing();
  await wheel(120);
  const during = await worstBelow(2000);
  check(
    inView(during),
    `the reply stays in view while it streams (worst ${during}px under the fold)`,
  );
  await idle();
  await Bun.sleep(300);
  check(inView((await position()).below), "the finished reply is in view");

  console.log("scrolling up stops following; the button resumes it");
  await send("scroll-up");
  await Bun.sleep(1000);
  await wheel(-120);
  const left = (await position()).top;
  await Bun.sleep(1000);
  const stayed = await position();
  check(Math.abs(stayed.top - left) <= 2, "the view stays where the reader scrolled to");
  check(stayed.below > 100, "the stream goes on under the fold");
  check(await toEnd.isVisible(), "the scroll-to-end button shows");
  await smoke.shot("scrolled-up");
  await toEnd.click();
  await Bun.sleep(800);
  check(inView(await worstBelow(1000)), "after the button the stream is followed again");
  await idle();
  await Bun.sleep(300);
  check(inView((await position()).below), "the finished reply is in view");

  console.log("a message sent while scrolled up");
  await wheel(-200);
  await Bun.sleep(300);
  check(!inView((await position()).below), "scrolled up before sending");
  await send("send-while-up");
  await idle();
  await Bun.sleep(300);
  check(inView((await position()).below), "sending jumps to the end and the reply is in view");

  console.log("a reload");
  await page.reload();
  await box.waitFor();
  await Bun.sleep(1000);
  check(inView((await position()).below), "the page opens at the end");

  check(pageErrors.length === 0, `no page errors (${pageErrors.join("; ")})`);
  await smoke.pass();
} catch (e) {
  await smoke.fail(e);
}
