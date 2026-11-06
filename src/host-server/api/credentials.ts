import { z } from "zod";
import { CredentialFields, type Credentials } from "../../credentials/index.ts";
import { InvalidInput, NotFound } from "../../platform/errors.ts";

const Id = z.object({ id: z.string() });

/** The `/api/credentials/*` routes as a pure function of path and JSON body; `undefined` means no such route. */
export async function credentialApi(creds: Credentials, path: string, b: Record<string, unknown>): Promise<{ status: number; body: unknown } | undefined> {
  try {
    switch (path) {
      case "/api/credentials/list":
        return { status: 200, body: creds.list() };
      case "/api/credentials/add":
        return { status: 200, body: await creds.add(CredentialFields.extend({ password: z.string() }).parse(b)) };
      case "/api/credentials/update": {
        const { id, ...f } = Id.extend(CredentialFields.shape).extend({ password: z.string().optional() }).parse(b);
        return { status: 200, body: await creds.update(id, f) };
      }
      case "/api/credentials/remove":
        await creds.remove(Id.parse(b).id);
        return { status: 200, body: { ok: true } };
      case "/api/credentials/revoke": {
        const a = Id.extend({ botId: z.string() }).parse(b);
        creds.revoke(a.botId, a.id);
        return { status: 200, body: { ok: true } };
      }
    }
    return undefined;
  } catch (e) {
    if (e instanceof z.ZodError) return { status: 400, body: { error: e.issues.map((i) => i.message).join("; ") } };
    if (e instanceof InvalidInput) return { status: 400, body: { error: e.message } };
    if (e instanceof NotFound) return { status: 404, body: { error: e.message } };
    throw e;
  }
}
