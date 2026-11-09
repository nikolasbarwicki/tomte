/** Zero-width, bidirectional-control, tag and other control characters that hide or reorder text. */
const INVISIBLE =
  // oxlint-disable-next-line no-control-regex -- matching control characters is this pattern's purpose
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/gu;

/** Text from outside the host (a web page, an external process) without the characters that hide or reorder it. */
export const stripInvisible = (s: string) => s.replace(INVISIBLE, "");
