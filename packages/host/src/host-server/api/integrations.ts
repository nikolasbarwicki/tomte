import type { ServerResponse } from "node:http";

import { z } from "zod";

import { NameTaken, type Integrations } from "../../integrations/index.ts";
import { InvalidInput, NotFound } from "../../platform/errors.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

const Id = z.object({ id: z.string() });
const CustomIntegration = z.discriminatedUnion("transport", [
  z.object({
    name: z.string().trim(),
    url: z.string().trim(),
    transport: z.enum(["http", "sse"]),
    token: z.string().exactOptional(),
    oauth: z.boolean().exactOptional(),
    skillsDir: z.string().exactOptional(),
  }),
  z.object({
    name: z.string().trim(),
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).exactOptional(),
    env: z.record(z.string(), z.string()).exactOptional(),
    skillsDir: z.string().exactOptional(),
  }),
]);

export async function integrationApi(
  { integrations }: ApiContext,
  res: ServerResponse,
  path: string,
  b: Record<string, unknown>,
) {
  try {
    switch (path) {
      case "/api/integrations/list":
        return json(res, integrations.list());
      case "/api/integrations/add-custom":
        return json(res, await integrations.addCustom(CustomIntegration.parse(b)));
      case "/api/integrations/set-bearer": {
        const { id, token } = z.object({ id: z.string(), token: z.string() }).parse(b);
        return json(res, await integrations.setBearer(id, token));
      }
      case "/api/integrations/connect-oauth": {
        const a = Id.extend({
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
        }).parse(b);
        const own =
          a.clientId === undefined && a.clientSecret === undefined
            ? undefined
            : { clientId: a.clientId ?? "", clientSecret: a.clientSecret ?? "" };
        return json(res, await integrations.connectOAuth(a.id, own));
      }
      case "/api/integrations/disconnect":
        await integrations.disconnect(Id.parse(b).id);
        return json(res, { ok: true });
      case "/api/integrations/probe":
        return json(res, await integrations.probe(Id.parse(b).id));
      case "/api/integrations/remove":
        await integrations.remove(Id.parse(b).id);
        return json(res, { ok: true });
      case "/api/integrations/set-enabled": {
        const a = Id.extend({ enabled: z.boolean() }).parse(b);
        integrations.setEnabled(a.id, a.enabled);
        return json(res, { ok: true });
      }
      case "/api/integrations/set-policy": {
        const a = Id.extend({ tool: z.string(), policy: z.enum(["off", "ask", "auto"]) }).parse(b);
        integrations.setPolicy(a.id, a.tool, a.policy);
        return json(res, { ok: true });
      }
      case "/api/integrations/set-skill-enabled": {
        const a = Id.extend({ skill: z.string(), enabled: z.boolean() }).parse(b);
        integrations.setSkillEnabled(a.id, a.skill, a.enabled);
        return json(res, { ok: true });
      }
      case "/api/integrations/reset-policies":
        integrations.resetPolicies(Id.parse(b).id);
        return json(res, { ok: true });
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e instanceof InvalidInput) return json(res, { error: e.message }, 400);
    if (e instanceof NameTaken) return json(res, { error: e.message }, 409);
    if (e instanceof NotFound) return json(res, { error: e.message }, 404);
    throw e;
  }
}

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, status: number, message: string) {
  res
    .writeHead(status, { "content-type": "text/html; charset=utf-8" })
    .end(
      `<!doctype html><meta charset="utf-8"><title>Claudebot</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><p>${htmlEscape(message)}</p>`,
    );
}

/** The provider sends the browser back here after sign-in. */
export async function oauthCallback(
  integrations: Integrations,
  res: ServerResponse,
  q: URLSearchParams,
) {
  try {
    const code = q.get("code");
    const error = q.get("error");
    const i = await integrations.finishOAuth(q.get("state") ?? "", {
      ...(code !== null && { code }),
      ...(error !== null && { error }),
    });
    if (i.state !== "connected") return page(res, 400, `Could not connect ${i.label}: ${i.error}`);
    page(res, 200, "Connected. You can close this tab.");
  } catch (e) {
    if (e instanceof InvalidInput || e instanceof NotFound) return page(res, 400, e.message);
    page(res, 500, (e as Error).message);
  }
}
