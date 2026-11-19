import { ToolInputError } from "./tool.ts";

/** A plain-text message as a bot composes it. Gmail adds From and Date itself. */
export interface MailDraft {
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  body: string;
  /** Message-ID headers of the message this one answers; anything that is not an angle-bracketed id is dropped. */
  inReplyTo?: string | undefined;
  references?: string | undefined;
}

const NON_ASCII = /[^\x20-\x7e]/;
const ADDRESS = /^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/;
const MESSAGE_ID = /<[^<>\s]+>/g;
const CRLF = "\r\n";

/** A header value must stay on one line: a line break in it would let its author add headers of their own. */
function oneLineOnly(value: string, what: string): string {
  if (/[\r\n\0]/.test(value)) throw new ToolInputError(`${what} must not contain a line break`);
  return value;
}

/** `text` as RFC 2047 encoded words of at most 75 characters each, folded onto continuation lines. */
function encodedWords(text: string): string {
  const words: string[] = [];
  let chunk = "";
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(`${CRLF} `);
}

/** A header value that may carry any text, such as a subject or a display name. */
const textHeader = (value: string) => (NON_ASCII.test(value) ? encodedWords(value) : value);

/** `Anna <anna@example.com>` or `anna@example.com`, checked and with a non-ASCII display name encoded; anything else is refused. */
function address(raw: string): string {
  const s = oneLineOnly(raw, "an address").trim();
  const named = /^(.*)<([^<>]+)>$/.exec(s);
  const addr = (named?.[2] ?? s).trim();
  if (!ADDRESS.test(addr)) throw new ToolInputError(`"${s}" is not an email address`);
  const name = named?.[1]?.trim().replace(/^"(.*)"$/, "$1") ?? "";
  if (!name) return addr;
  return `${NON_ASCII.test(name) ? encodedWords(name) : `"${name.replace(/["\\]/g, "\\$&")}"`} <${addr}>`;
}

const addressList = (list: string[]) => list.map(address).join(`,${CRLF} `);

const ids = (s: string | undefined) => s?.match(MESSAGE_ID)?.join(" ");

/**
 * The message as RFC 2822 text: UTF-8, base64 body, CRLF line ends, every header on one line or folded. It is what Gmail's
 * `raw` field takes, for a draft today and for a send later.
 */
function rfc2822(m: MailDraft): string {
  const inReplyTo = ids(m.inReplyTo);
  const references = ids(m.references);
  const headers = [
    "MIME-Version: 1.0",
    `To: ${addressList(m.to)}`,
    ...(m.cc?.length ? [`Cc: ${addressList(m.cc)}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${addressList(m.bcc)}`] : []),
    `Subject: ${textHeader(oneLineOnly(m.subject, "the subject"))}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(m.body.replace(/\r?\n/g, CRLF)).toString("base64");
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body.match(/.{1,76}/g)?.join(CRLF) ?? ""}${CRLF}`;
}

/** Gmail's `raw` field: the message as base64url. */
export const rawOf = (m: MailDraft): string => Buffer.from(rfc2822(m)).toString("base64url");
