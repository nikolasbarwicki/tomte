import type { ExternalEventKind } from "@tomte/contract/events";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  HandIcon,
  InfoIcon,
  MessageCircleQuestionIcon,
  OctagonXIcon,
  type LucideIcon,
} from "lucide-react";

/** The icon of an external event, by kind: on its transcript row and in the Needs you bar. */
export const EXTERNAL_ICONS = {
  question: MessageCircleQuestionIcon,
  blocked: HandIcon,
  failed: CircleAlertIcon,
  done: CircleCheckIcon,
  stopped: OctagonXIcon,
  notice: InfoIcon,
} satisfies Record<Exclude<ExternalEventKind, "progress">, LucideIcon>;
