/**
 * Understanding layer: model first, rules as fast path and safety net.
 *
 *   rules frame (always, instant, deterministic emergency rules)
 *   + model frame (when configured; cached; time-boxed)
 *   → merged: model fills/overrides where confident, urgency only goes up.
 */
import { mergeFrames, updateFrame, type IssueFrame } from "./frame";
import { rulesFrame } from "./rules";
import type { ModelUnderstander } from "./model";

export interface Understanding {
  frame: IssueFrame;
  rules: IssueFrame;
  model: IssueFrame | null;
  source: "rules" | "model+rules";
}

export async function understand(message: string, model?: ModelUnderstander | null, context?: string): Promise<Understanding> {
  const rules = rulesFrame(message);
  const modelFrame = model ? await model(message, context).catch(() => null) : null;
  return {
    frame: mergeFrames(rules, modelFrame),
    rules,
    model: modelFrame,
    source: modelFrame ? "model+rules" : "rules",
  };
}

/** A reply adds information: understand it and fold it into what we know. */
export async function understandReply(
  current: IssueFrame,
  reply: string,
  model?: ModelUnderstander | null
): Promise<IssueFrame> {
  const context = `equipment=${current.equipment}, symptom=${current.symptom}, substance=${current.substance}, room=${current.room}`;
  const { frame } = await understand(reply, model, context);
  return updateFrame(current, frame);
}

export { rulesFrame } from "./rules";
export { openAIUnderstander, type ModelUnderstander } from "./model";
export * from "./frame";
export * from "./taxonomy";
