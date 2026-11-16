import { RoutinePreview } from "@claudebot/contract/api";
import type { Routine } from "@claudebot/contract/events";
import { useActionState, useEffect, useEffectEvent, useReducer, useState } from "react";

import { errorOf, readJson } from "@/host/api.ts";

import { createRoutine, previewSchedule, updateRoutine } from "./api.ts";
import { formFromRoutine, presetFromForm, toSchedule, type FormFields } from "./schedule.ts";

type Preview = { next?: number[]; error?: string };

const patchFields = (fields: FormFields, patch: Partial<FormFields>): FormFields => ({
  ...fields,
  ...patch,
});

/** State and submit for the routine dialog: the fields, a debounced preview of the next runs, and create or update. */
export function useRoutineForm({
  botId,
  routine,
  onDone,
}: {
  botId: string;
  routine?: Routine | undefined;
  onDone: () => void;
}) {
  const [fields, set] = useReducer(patchFields, routine, formFromRoutine);
  const [preview, setPreview] = useState<Preview>({});

  const schedule = toSchedule(presetFromForm(fields), fields.tz.trim());
  const scheduleKey = JSON.stringify(schedule);

  const refreshPreview = useEffectEvent(async () => {
    const res = await previewSchedule(schedule);
    setPreview(res.ok ? await readJson(res, RoutinePreview) : { error: await errorOf(res) });
  });
  useEffect(() => {
    const t = setTimeout(() => void refreshPreview(), 300);
    return () => clearTimeout(t);
  }, [scheduleKey]);

  const [error, submit, busy] = useActionState(async () => {
    const payload = {
      name: fields.name,
      instruction: fields.instruction,
      schedule,
      catchUp: fields.catchUp,
      notifyResult: fields.notifyResult,
    };
    const res = await (routine
      ? updateRoutine(routine.id, payload)
      : createRoutine(botId, payload));
    if (!res.ok) return errorOf(res);
    onDone();
    return "";
  }, "");

  return { fields, set, preview, error, busy, submit };
}
