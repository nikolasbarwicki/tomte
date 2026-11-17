import type { ServerResponse } from "node:http";

import type { RoutinePreview } from "@tomte/contract/api";
import { z } from "zod";

import { getBot } from "../../bots/index.ts";
import { NotFound } from "../../platform/errors.ts";
import { Conflict, RoutineInput, RoutinePatch } from "../../routines/index.ts";
import { json } from "../http.ts";
import type { ApiContext } from "./context.ts";

const Id = z.object({ id: z.string() });
const RoutineCreate = RoutineInput.extend({ botId: z.string() });
const RoutineEdit = RoutinePatch.extend({ id: z.string() });
const RunsQuery = Id.extend({ before: z.number().optional(), limit: z.number().int().optional() });
const Preview = z.object({ schedule: RoutineInput.shape.schedule });

/** Routine routes address bots and routines by id, so they work whichever bot is open. */
export async function routineApi(
  { dataRoot, routines }: ApiContext,
  res: ServerResponse,
  path: string,
  b: Record<string, unknown>,
) {
  try {
    switch (path) {
      case "/api/routines/list": {
        const { botId } = z.object({ botId: z.string() }).parse(b);
        if (!getBot(dataRoot, botId)) throw new NotFound("no such bot");
        return json(res, routines.list(botId));
      }
      case "/api/routines/create": {
        const { botId, ...input } = RoutineCreate.parse(b);
        return json(res, routines.create(botId, input));
      }
      case "/api/routines/update": {
        const { id, ...patch } = RoutineEdit.parse(b);
        return json(res, routines.update(id, patch));
      }
      case "/api/routines/delete":
        await routines.remove(Id.parse(b).id);
        return json(res, { ok: true });
      case "/api/routines/run":
        return json(res, routines.testRun(Id.parse(b).id));
      case "/api/routines/runs": {
        const q = RunsQuery.parse(b);
        return json(res, routines.runs(q.id, q.before, q.limit));
      }
      case "/api/routines/preview":
        return json(res, {
          next: routines.preview(Preview.parse(b).schedule),
        } satisfies RoutinePreview);
    }
    res.writeHead(404).end();
  } catch (e) {
    if (e instanceof Conflict) return json(res, { error: e.message }, 409);
    if (e instanceof NotFound) return json(res, { error: e.message }, 404);
    throw e;
  }
}
