import { useActionState, useEffect, useReducer, useState } from "react";
import type { Routine } from "@claudebot/contract/events";
import { errorOf } from "@/host/api.ts";
import { createRoutine, previewSchedule, updateRoutine } from "./api.ts";
import { formFromRoutine, presetFromForm, toSchedule, type FormFields } from "./schedule.ts";

type Preview = { next?: number[]; error?: string };

const patchFields = (fields: FormFields, patch: Partial<FormFields>): FormFields => ({ ...fields, ...patch });

/** State and submit for the routine dialog: the fields, a debounced preview of the next runs, and create or update. */
export function useRoutineForm({ botId, routine, onDone }: { botId: string; routine?: Routine; onDone: () => void }) {
  const [fields, set] = useReducer(patchFields, routine, formFromRoutine);
  const [preview, setPreview] = useState<Preview>({});

  const schedule = toSchedule(presetFromForm(fields), fields.tz.trim());
  const scheduleKey = JSON.stringify(schedule);

  useEffect(() => {
    const t = setTimeout(async () => {
      const res = await previewSchedule(schedule);
      setPreview(await res.json());
    }, 300);
    return () => clearTimeout(t);
  }, [scheduleKey]);

  const [error, submit, busy] = useActionState(async () => {
    const payload = { name: fields.name, instruction: fields.instruction, schedule, catchUp: fields.catchUp };
    const res = await (routine ? updateRoutine(routine.id, payload) : createRoutine(botId, payload));
    if (!res.ok) return errorOf(res);
    onDone();
    return "";
  }, "");

  return { fields, set, preview, error, busy, submit };
}
