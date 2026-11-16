import { describe, expect, test } from "bun:test";

import { callsOf, editParams, fitText, inboundOf, parseRef, refOf, sendParams } from "./mapping.ts";

const user = { id: 42, first_name: "Ada", last_name: "L" };
const chat = { id: 42, type: "private" };

describe("a Telegram update as an Inbound", () => {
  test("a private text message names its sender and what it replies to", () => {
    const served = inboundOf({
      update_id: 1,
      message: {
        message_id: 7,
        from: user,
        chat,
        text: "hi",
        reply_to_message: { message_id: 3, chat },
      },
    });
    expect(served).toEqual({
      chatId: 42,
      inbound: { from: { id: "42", label: "Ada L" }, text: "hi", replyTo: refOf(42, 3) },
    });
  });

  test("a button press carries its data and the message it is on, and the id to acknowledge", () => {
    expect(
      inboundOf({
        update_id: 2,
        callback_query: { id: "cb1", from: user, data: "a:1", message: { message_id: 9, chat } },
      }),
    ).toEqual({
      chatId: 42,
      callbackId: "cb1",
      inbound: { from: { id: "42", label: "Ada L" }, button: { data: "a:1", on: "42:9" } },
    });
  });

  test("a sender with no name is labelled by username, then id", () => {
    const label = (from: object) =>
      inboundOf({ update_id: 1, message: { message_id: 1, from, chat, text: "x" } })!.inbound.from
        .label;
    expect(label({ id: 42, username: "ada" })).toBe("@ada");
    expect(label({ id: 42 })).toBe("42");
  });

  test.each([
    ["a group", { message_id: 1, from: user, chat: { id: -5, type: "group" }, text: "x" }],
    ["a channel", { message_id: 1, from: user, chat: { id: -5, type: "channel" }, text: "x" }],
    ["no sender", { message_id: 1, chat, text: "x" }],
    ["a bot", { message_id: 1, from: { ...user, is_bot: true }, chat, text: "x" }],
  ])("a message in %s is not served", (_name, message) => {
    expect(inboundOf({ update_id: 1, message })).toBeUndefined();
  });

  test("an edited message, another update kind, a button with no message or data, and junk are not served", () => {
    const edited = { message_id: 1, from: user, chat, text: "x" };
    expect(inboundOf({ update_id: 1, edited_message: edited })).toBeUndefined();
    expect(inboundOf({ update_id: 1, my_chat_member: {} })).toBeUndefined();
    expect(
      inboundOf({ update_id: 1, callback_query: { id: "c", from: user, data: "d" } }),
    ).toBeUndefined();
    expect(
      inboundOf({
        update_id: 1,
        callback_query: { id: "c", from: user, message: { message_id: 1, chat } },
      }),
    ).toBeUndefined();
    expect(inboundOf("nonsense")).toBeUndefined();
    expect(inboundOf({ update_id: "one" })).toBeUndefined();
  });

  test("a message without text is still served, as an update with no text", () => {
    expect(
      inboundOf({ update_id: 1, message: { message_id: 1, from: user, chat } })!.inbound,
    ).toEqual({ from: { id: "42", label: "Ada L" } });
  });
});

describe("message references", () => {
  test("round trip through the chat and message id, and a foreign one is refused", () => {
    expect(parseRef(refOf(-100, 55))).toEqual({ chatId: -100, messageId: 55 });
    expect(parseRef("m1")).toBeUndefined();
  });
});

describe("a ChannelMessage as Bot API parameters", () => {
  test("is plain text with no parse mode and link previews off", () => {
    const p = sendParams(42, { text: "<b>*not formatted*</b>" });
    expect(p).toEqual({
      chat_id: 42,
      text: "<b>*not formatted*</b>",
      link_preview_options: { is_disabled: true },
    });
  });

  test("buttons become callback buttons and the link a URL button in its own row", () => {
    const p = sendParams(42, {
      text: "Allow?",
      buttons: [
        [
          { label: "Yes", data: "y" },
          { label: "No", data: "n" },
        ],
      ],
      link: { label: "Open", url: "https://example.test/x" },
    });
    expect(p.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "y" },
          { text: "No", callback_data: "n" },
        ],
        [{ text: "Open", url: "https://example.test/x" }],
      ],
    });
  });

  test("an edit always states its keyboard, so a card can lose its buttons", () => {
    expect(editParams({ chatId: 42, messageId: 9 }, { text: "Handled" })).toEqual({
      chat_id: 42,
      message_id: 9,
      text: "Handled",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
  });

  test("text is cut below Telegram's limit on a whole character; an empty text gets a placeholder", () => {
    expect(fitText("short")).toBe("short");
    const long = fitText("x".repeat(9000));
    expect(long.length).toBeLessThan(4096);
    expect(long.endsWith("…")).toBe(true);
    // A pair of UTF-16 units that straddles the cut is dropped whole.
    const emoji = fitText(`${"x".repeat(3998)}😀😀😀`);
    expect(emoji).not.toMatch(/[\ud800-\udbff]…$/);
    expect(fitText("  ")).toBe("(empty message)");
  });
});

describe("a Reply as Bot API calls", () => {
  const msg = (n: number) => ({ text: `m${n}` });

  test("is acknowledgement, then edits, then sends, in order", () => {
    const calls = callsOf(
      { toast: "Done", edit: [{ ref: "42:9", message: msg(1) }], send: [msg(2), msg(3)] },
      { chatId: 42, callbackId: "cb1" },
    );
    expect(calls.map((c) => c.method)).toEqual([
      "answerCallbackQuery",
      "editMessageText",
      "sendMessage",
      "sendMessage",
    ]);
    expect(calls[0]!.params).toEqual({ callback_query_id: "cb1", text: "Done" });
    expect(calls[1]!.params).toMatchObject({ chat_id: 42, message_id: 9 });
    expect(calls[2]!.params.chat_id).toBe(42);
  });

  test("a button press answered with sends only is still acknowledged, with no text", () => {
    expect(callsOf({ send: [msg(1)] }, { chatId: 42, callbackId: "cb1" })[0]).toEqual({
      method: "answerCallbackQuery",
      params: { callback_query_id: "cb1" },
    });
  });

  test("an empty reply makes no call at all, a button press included", () => {
    expect(callsOf({}, { chatId: 42, callbackId: "cb1" })).toEqual([]);
    expect(callsOf({}, { chatId: 42 })).toEqual([]);
  });

  test("a toast on a plain message is not an acknowledgement, and a toast is cut to Telegram's limit", () => {
    expect(callsOf({ toast: "x" }, { chatId: 42 })).toEqual([]);
    const [call] = callsOf({ toast: "y".repeat(500) }, { chatId: 42, callbackId: "c" });
    expect(String(call!.params.text)).toHaveLength(200);
  });

  test("an edit of a message that is not Telegram's is skipped", () => {
    expect(callsOf({ edit: [{ ref: "m1", message: msg(1) }] }, { chatId: 42 })).toEqual([]);
  });
});
