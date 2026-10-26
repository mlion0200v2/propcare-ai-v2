/**
 * Drive the assistant like a channel does: one `turn()` per message, the
 * state carried between calls. Every eval and chat test goes through this,
 * so what they measure is the assistant's real boundary.
 */
import { turn, type AssistantState, type TurnRequest, type TurnResponse } from "../../src/assistant";
import type { ModelUnderstander } from "../../src/assistant/understanding";
import { emptyFrame, withUnknowns, type IssueFrame } from "../../src/assistant/understanding/frame";
import { EMPTY_PROPERTY, type PropertyContext } from "../../src/assistant/property";

export interface Chat {
  state: AssistantState | null;
  property: PropertyContext;
  media: number;
  understander: ModelUnderstander | null;
}

export function newChat(options: { rooms?: string[]; property?: Partial<PropertyContext>; understander?: ModelUnderstander | null } = {}): Chat {
  return {
    state: null,
    property: { ...EMPTY_PROPERTY, ...options.property, rooms: options.rooms ?? options.property?.rooms ?? [] },
    media: 0,
    understander: options.understander ?? null,
  };
}

/** One tenant message (or button). Updates the chat's state. */
export async function say(chat: Chat, message: string, action?: TurnRequest["action"]): Promise<TurnResponse> {
  const response = await turn(
    { conversation: "eval", message, action, state: chat.state, property: chat.property, media: { count: chat.media }, channel: "web" },
    { understander: chat.understander }
  );
  chat.state = response.state;
  return response;
}

/** A stand-in for the model: always "understands" these fields, confidently. */
export function stubUnderstander(fields: Partial<Record<"equipment" | "symptom" | "substance" | "room", string>>): ModelUnderstander {
  return async () => {
    const f: IssueFrame = { ...emptyFrame(), ...(fields as Partial<IssueFrame>) };
    for (const k of Object.keys(fields) as (keyof typeof fields)[]) f.confidence[k] = 0.9;
    return withUnknowns(f);
  };
}
