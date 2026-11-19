import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ClaudeLoginStart, ClaudeUsage, ModelProviders } from "@tomte/contract/api";

import { defined } from "../testing/defined.ts";
import { startHandoffHost, type HandoffHost } from "../testing/test-host.ts";

const FAKE_URL = "https://claude.example.test/oauth?state=fake";
const TOKEN = "sk-gateway-synthetic-token";

let host: HandoffHost;
beforeEach(async () => {
  host = await startHandoffHost();
});
afterEach(async () => {
  await host.stop();
});

const providersBody = async () => (await host.ui("/api/providers", {})).text();
const claude = async () =>
  defined(ModelProviders.parse(JSON.parse(await providersBody())).providers[0], "claude");

/** Opens a new bot and sends it one message, so the CLI is launched; resolves with that launch. */
async function launch(name: string) {
  const bot = host.createBot(name);
  const before = host.launches().length;
  expect((await host.ui("/api/open", { botId: bot })).status).toBe(200);
  expect((await host.ui("/api/send", { text: "hello" })).status).toBe(200);
  await host.until(() => host.messagesOf(bot).length === 1);
  return defined(host.launches()[before], "launch");
}

describe("signing in from the web UI", () => {
  const start = async () =>
    ClaudeLoginStart.parse(await (await host.ui("/api/providers/claude/login", {})).json());

  test("a good code signs the CLI in and ends the sign-in", async () => {
    host.setSignedIn(false);
    expect(await start()).toEqual({ url: FAKE_URL });
    expect((await claude()).login).toEqual({ url: FAKE_URL });

    const res = await host.ui("/api/providers/claude/login/code", { code: "good-code" });
    expect(await res.json()).toEqual({ ok: true, status: "connected" });
    const after = await claude();
    expect(after.status).toBe("connected");
    expect(after.login).toBeNull();
    expect(after.account?.email).toBe("owner@example.test");
  });

  test("a bad code answers 400 with the CLI's message", async () => {
    host.setSignedIn(false);
    await start();
    const res = await host.ui("/api/providers/claude/login/code", { code: "bad-code" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Couldn't log in: Invalid code" });
    expect((await claude()).status).toBe("disconnected");
  });

  test("a code without a sign-in in progress is refused", async () => {
    const res = await host.ui("/api/providers/claude/login/code", { code: "good-code" });
    expect(res.status).toBe(409);
  });

  test("cancel ends the sign-in", async () => {
    host.setSignedIn(false);
    await start();
    expect(await (await host.ui("/api/providers/claude/login/cancel", {})).json()).toEqual({
      ok: true,
    });
    expect((await claude()).login).toBeNull();
  });

  test("the CLI's own callback completes the sign-in without a code", async () => {
    host.setSignedIn(false);
    await start();
    host.completeLoginCallback();
    let provider = await claude();
    for (let i = 0; i < 160 && provider.status !== "connected"; i++) {
      await Bun.sleep(25);
      provider = await claude();
    }
    expect(provider.status).toBe("connected");
    expect(provider.login).toBeNull();
  });

  test("a sign-in that exits at once answers 502", async () => {
    host.setLoginExit(1);
    const res = await host.ui("/api/providers/claude/login", {});
    expect(res.status).toBe(502);
  });
});

describe("a custom provider", () => {
  const setGateway = (auth: "bearer" | "api_key") =>
    host.ui("/api/providers/claude/gateway", {
      baseUrl: " https://gateway.example.test ",
      auth,
      token: TOKEN,
    });

  test("is used instead of the sign-in, never shows its token, survives a restart and can be removed", async () => {
    expect((await setGateway("bearer")).status).toBe(200);
    expect(host.secretNames()).toContain("claude-gateway");

    const body = await providersBody();
    expect(body).not.toContain(TOKEN);
    const provider = await claude();
    expect(provider.gateway).toEqual({ baseUrl: "https://gateway.example.test", auth: "bearer" });
    expect(provider.access).toBe("api_key");
    expect(provider.account?.method).toBe("oauth_token");

    const first = await launch("Ada");
    expect(first.env.ANTHROPIC_BASE_URL).toBe("https://gateway.example.test");
    expect(first.env.CLAUDE_CODE_USE_GATEWAY).toBe("1");
    expect(first.credential).toEqual({
      variable: "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
      token: TOKEN,
    });
    expect(Object.values(first.env)).not.toContain(TOKEN);

    await host.restart();
    expect((await claude()).gateway).toEqual({
      baseUrl: "https://gateway.example.test",
      auth: "bearer",
    });

    expect((await host.ui("/api/providers/claude/gateway/remove", {})).status).toBe(200);
    expect(host.secretNames()).not.toContain("claude-gateway");
    expect((await claude()).gateway).toBeNull();
    const after = await launch("Bea");
    expect(after.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(after.env.CLAUDE_CODE_USE_GATEWAY).toBeUndefined();
    expect(after.credential).toBeUndefined();
  });

  test("with an API key hands the token over as the API key, on a descriptor", async () => {
    await setGateway("api_key");
    expect((await claude()).account?.method).toBe("api_key");
    const { env, credential } = await launch("Ada");
    expect(credential).toEqual({ variable: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", token: TOKEN });
    expect(env.CLAUDE_CODE_USE_GATEWAY).toBeUndefined();
    expect(Object.values(env)).not.toContain(TOKEN);
  });

  test("refuses a base URL that is not http(s)", async () => {
    const res = await host.ui("/api/providers/claude/gateway", {
      baseUrl: "ftp://gateway.example.test",
      auth: "bearer",
      token: TOKEN,
    });
    expect(res.status).toBe(400);
    expect(host.secretNames()).not.toContain("claude-gateway");
  });
});

test("bots never load the owner's own Claude Code settings or claude.ai connectors", async () => {
  const { argv, env } = await launch("Ada");
  const sources = argv.filter((a: string) => a.startsWith("--setting-sources"));
  expect(sources).toEqual(["--setting-sources="]);
  expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
});

describe("plan usage", () => {
  const usage = async () => {
    const res = await host.ui("/api/providers/claude/usage", {});
    return { status: res.status, body: await res.json() };
  };

  test("reports the session and weekly windows the CLI reports, in that order", async () => {
    host.setPlanUsage({
      rate_limits_available: true,
      rate_limits: {
        seven_day: { utilization: 41.5, resets_at: "2026-11-20T09:00:00Z" },
        five_hour: { utilization: 73, resets_at: "2026-11-17T15:00:00Z" },
        seven_day_opus: null,
        seven_day_sonnet: { utilization: null, resets_at: null },
        model_scoped: [{ display_name: "Fable", utilization: 120, resets_at: "nonsense" }],
      },
    });
    const { status, body } = await usage();
    expect(status).toBe(200);
    const parsed = ClaudeUsage.parse(body);
    expect(parsed.available).toBe(true);
    expect(parsed.windows).toEqual([
      {
        window: "five_hour",
        name: null,
        percent: 73,
        resetsAt: Date.parse("2026-11-17T15:00:00Z"),
      },
      {
        window: "seven_day",
        name: null,
        percent: 41.5,
        resetsAt: Date.parse("2026-11-20T09:00:00Z"),
      },
      { window: "seven_day_sonnet", name: null, percent: null, resetsAt: null },
      { window: "model", name: "Fable", percent: 100, resetsAt: null },
    ]);
  });

  test("is unavailable when plan limits do not apply, while signed out and with a custom provider", async () => {
    expect((await usage()).body).toMatchObject({ available: false, windows: [] });

    host.setPlanUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 5 } },
    });
    host.setSignedIn(false);
    expect((await usage()).body).toMatchObject({ available: false, windows: [] });

    host.setSignedIn(true);
    await host.ui("/api/providers/claude/gateway", {
      baseUrl: "https://gateway.example.test",
      auth: "bearer",
      token: TOKEN,
    });
    expect((await usage()).body).toMatchObject({ available: false, windows: [] });
  });

  test("answers 502 with the reason when the CLI cannot report it", async () => {
    host.setPlanUsage({ error: "usage endpoint unavailable" });
    const { status, body } = await usage();
    expect(status).toBe(502);
    expect(body).toEqual({ error: expect.stringContaining("usage endpoint unavailable") });
  });
});
