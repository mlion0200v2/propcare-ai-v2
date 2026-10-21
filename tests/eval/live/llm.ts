/**
 * Model access for the live eval: one structured-output call shape, a
 * budget that stops the run at a dollar cap, and a stub for dry runs (CI).
 */
import type { z } from "zod";

/** USD per 1M tokens. Override with LIVE_EVAL_PRICE_IN / LIVE_EVAL_PRICE_OUT if prices change. */
export const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

export function priceOf(model: string): { input: number; output: number } {
  const p = PRICES[model] ?? PRICES["gpt-4o-mini"];
  return {
    input: Number(process.env.LIVE_EVAL_PRICE_IN ?? p.input),
    output: Number(process.env.LIVE_EVAL_PRICE_OUT ?? p.output),
  };
}

export class BudgetExceeded extends Error {}

/** Spend so far, by purpose (understanding, tenant, judge). Throws once the cap is passed. */
export class Budget {
  spent = 0;
  calls = 0;
  byPurpose: Record<string, { usd: number; calls: number; input: number; output: number }> = {};
  constructor(readonly maxUsd: number) {}

  add(purpose: string, model: string, input: number, output: number): void {
    const p = priceOf(model);
    const usd = (input * p.input + output * p.output) / 1_000_000;
    this.spent += usd;
    this.calls++;
    const b = (this.byPurpose[purpose] ??= { usd: 0, calls: 0, input: 0, output: 0 });
    b.usd += usd;
    b.calls++;
    b.input += input;
    b.output += output;
  }

  check(): void {
    if (this.spent > this.maxUsd) throw new BudgetExceeded(`cost cap reached: $${this.spent.toFixed(3)} > $${this.maxUsd}`);
  }
}

/** A structured call: system + user text in, a schema-checked object out. */
export type StructuredCall = <T extends z.ZodTypeAny>(args: {
  purpose: string;
  system: string;
  user: string;
  schema: T;
  name: string;
}) => Promise<z.infer<T>>;

export function openAICall(budget: Budget, model = process.env.LIVE_EVAL_MODEL ?? "gpt-4o-mini"): StructuredCall {
  return async ({ purpose, system, user, schema, name }) => {
    budget.check();
    const { default: OpenAI } = await import("openai");
    const { zodResponseFormat } = await import("openai/helpers/zod");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, timeout: 30_000, maxRetries: 2 });
    const res = await client.chat.completions.parse({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: zodResponseFormat(schema, name),
    });
    if (res.usage) budget.add(purpose, model, res.usage.prompt_tokens, res.usage.completion_tokens);
    const parsed = res.choices[0]?.message.parsed;
    if (!parsed) throw new Error(`${purpose}: no parsed output`);
    return parsed;
  };
}

/** Rough token count (4 chars ≈ 1 token) for the dry run's cost estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
