import { describe, expect, test } from "bun:test";

import { detectBotWall, detectLoginWall } from "./page-walls.ts";

const ARTICLE = Array.from(
  { length: 30 },
  (_, i) =>
    `- paragraph: Paragraph ${i} of an essay about how the web is delivered, with enough words to make the page long.`,
).join("\n");

describe("detectBotWall", () => {
  test.each([
    [
      "cloudflare: the managed challenge, by title",
      "Just a moment...",
      '- heading "example.com" [level=1]\n- paragraph: Performing security verification',
      "cloudflare",
    ],
    [
      "cloudflare: the challenge, by its text alone",
      undefined,
      '- heading "Verify you are human by completing the action below." [level=2]\n- checkbox "Verify you are human" [ref=e1]',
      "cloudflare",
    ],
    [
      "cloudflare: the block page",
      "Attention Required! | Cloudflare",
      '- heading "Sorry, you have been blocked" [level=1]\n- text: Cloudflare Ray ID: 8a1b2c3d4e5f',
      "cloudflare",
    ],
    [
      "perimeterx: press and hold",
      undefined,
      '- text: Press & Hold to confirm you are a human (and not a bot).\n- button "Press & Hold" [ref=e1]',
      "perimeterx",
    ],
    [
      "perimeterx: the denied page",
      undefined,
      '- heading "Access to this page has been denied" [level=1]\n- text: Reference ID #0a1b2c3d',
      "perimeterx",
    ],
    [
      "imperva: the incident page",
      undefined,
      "- text: Request unsuccessful. Incapsula incident ID: 123000100-456000200",
      "imperva",
    ],
    [
      "datadome: the captcha page",
      "example.com",
      '- iframe "geo.captcha-delivery.com"\n- text: Please enable JS and disable any ad blocker',
      "datadome",
    ],
  ])("%s", (_label, title, snapshot, vendor) => {
    expect(detectBotWall(snapshot, title)).toBe(vendor as never);
  });

  test("a long article that quotes a wall's phrase is not a wall", () => {
    const quoting = `${ARTICLE}\n- paragraph: The page said "Just a moment..." and "Verify you are human by completing the action below" and showed a Cloudflare Ray ID.`;
    expect(detectBotWall(quoting, "How CDNs challenge visitors")).toBeUndefined();
    expect(
      detectBotWall(
        `- heading "Why do I see 'Just a moment...' on Cloudflare?" [level=1]\n${ARTICLE}`,
      ),
    ).toBeUndefined();
  });

  test("a heading that opens with the phrase marks a page of any length", () => {
    expect(detectBotWall(`- heading "Just a moment..." [level=1]\n${ARTICLE}`)).toBe("cloudflare");
  });

  test.each([
    [
      "an ordinary small page",
      '- heading "Example Domain" [level=1]\n- link "More information" [ref=e1]',
    ],
    ["an empty page", "(empty page)"],
    [
      "a small page that mentions a vendor in passing",
      '- link "Cloudflare" [ref=e1]\n- text: Home',
    ],
  ])("%s is clear", (_label, snapshot) => {
    expect(detectBotWall(snapshot, "Example Domain")).toBeUndefined();
  });
});

describe("detectLoginWall", () => {
  const SIGN_IN =
    '- heading "Sign in" [level=1]\n- textbox "Username" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]';

  test("a sign-in form is a login wall", () => {
    expect(detectLoginWall(SIGN_IN, "Sign in")).toBe(true);
    expect(detectLoginWall(SIGN_IN)).toBe(true);
  });

  test("a code or username step is not", () => {
    expect(
      detectLoginWall('- textbox "Verification code" [ref=e1]\n- button "Verify" [ref=e2]'),
    ).toBe(false);
    expect(detectLoginWall('- textbox "Email" [ref=e1]\n- button "Next" [ref=e2]')).toBe(false);
  });

  test("a long content page with a password box in its sidebar is not, one headed Sign in is", () => {
    expect(detectLoginWall(`${ARTICLE}\n- textbox "Password" [ref=e9]`, "An essay")).toBe(false);
    expect(detectLoginWall(`${ARTICLE}\n- textbox "Password" [ref=e9]`, "Log in to Example")).toBe(
      true,
    );
  });
});
