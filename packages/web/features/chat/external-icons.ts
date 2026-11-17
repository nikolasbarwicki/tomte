import {
  WarningCircleIcon,
  CheckCircleIcon,
  HandIcon,
  InfoIcon,
  QuestionIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { ExternalEventKind } from "@tomte/contract/events";

/** The icon of an external event, by kind: on its transcript row and in the Needs you bar. */
export const EXTERNAL_ICONS = {
  question: QuestionIcon,
  blocked: HandIcon,
  failed: WarningCircleIcon,
  done: CheckCircleIcon,
  stopped: XCircleIcon,
  notice: InfoIcon,
} satisfies Record<Exclude<ExternalEventKind, "progress">, Icon>;
