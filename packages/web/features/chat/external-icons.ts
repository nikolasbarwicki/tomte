import type { ServerEvent } from "@claudebot/contract/events";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  HandIcon,
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
} satisfies Record<Extract<ServerEvent, { type: "external" }>["kind"], LucideIcon>;
