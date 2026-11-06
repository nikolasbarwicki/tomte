import { expect, test } from "bun:test";

import { parseHandoffTags, parseMentions } from "./format.ts";

// Transcripts are rebuilt from session files, so a tag missing an attribute must still read back, never throw.
test("a handoff tag missing attributes still reads back, with empty strings for what is absent", () => {
  expect(parseHandoffTags('<handoff id="h1">\nbrief\n</handoff>')).toEqual([
    { id: "h1", from: "", status: "submitted", text: "brief", resumed: false },
  ]);
  expect(parseHandoffTags('<handoff-update from="Grace">\ndone\n</handoff-update>')).toEqual([
    { id: "", from: "Grace", status: "", text: "done", resumed: false },
  ]);
});

test("a mention tag missing attributes still reads back, with empty strings for what is absent", () => {
  expect(parseMentions('hi <mention name="Grace"/>')).toEqual({
    text: "hi",
    mentions: [{ id: "", name: "Grace" }],
  });
});
