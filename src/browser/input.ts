import { z } from "zod";

const coord = z.number().finite().min(0).max(20_000);
const modifiers = z.number().int().min(0).max(15).optional();

const Mouse = z.object({
  kind: z.literal("mouse"),
  eventType: z.enum(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"]),
  x: coord,
  y: coord,
  button: z.enum(["none", "left", "middle", "right"]).optional(),
  clickCount: z.number().int().min(0).max(3).optional(),
  deltaX: z.number().finite().min(-20_000).max(20_000).optional(),
  deltaY: z.number().finite().min(-20_000).max(20_000).optional(),
  modifiers,
});

const Keyboard = z.object({
  kind: z.literal("keyboard"),
  eventType: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
  key: z.string().max(32).optional(),
  code: z.string().max(32).optional(),
  text: z.string().max(32).optional(),
  windowsVirtualKeyCode: z.number().int().min(0).max(255).optional(),
  modifiers,
});

const Touch = z.object({
  kind: z.literal("touch"),
  eventType: z.enum(["touchStart", "touchMove", "touchEnd", "touchCancel"]),
  touchPoints: z.array(z.object({ x: coord, y: coord })).max(10),
  modifiers,
});

const Input = z.discriminatedUnion("kind", [Mouse, Keyboard, Touch]);

/** The engine's stream message for one user input event, or undefined if the event is malformed. Only the fields the engine reads get through. */
export function toEngineInput(body: Record<string, unknown>): string | undefined {
  const parsed = Input.safeParse(body);
  if (!parsed.success) return undefined;
  const { kind, ...fields } = parsed.data;
  return JSON.stringify({ type: `input_${kind}`, ...fields });
}
