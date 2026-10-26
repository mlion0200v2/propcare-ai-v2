/**
 * Counts what the assistant itself spends on OpenAI during a live eval,
 * without touching its code: wraps fetch (the OpenAI client captures it
 * when it is created, so import this module first) and reads the usage in
 * each response. The eval's own calls (tenant, judge, baseline) send
 * EVAL_HEADER and are counted by their own Budget instead.
 */
import { priceOf } from "./llm";

export const EVAL_HEADER = "x-propcare-eval";

export const assistantUsage = { usd: 0, calls: 0, input: 0, output: 0 };

const original = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await original(input, init);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (url.includes("api.openai.com") && !headers.has(EVAL_HEADER)) {
    // Read a copy; the client reads the original.
    res
      .clone()
      .json()
      .then((body: { model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }) => {
        if (!body?.usage) return;
        const p = priceOf(body.model?.startsWith("gpt-4o-mini") ? "gpt-4o-mini" : body.model?.startsWith("gpt-4o") ? "gpt-4o" : "gpt-4o-mini");
        const input = body.usage.prompt_tokens ?? 0;
        const output = body.usage.completion_tokens ?? 0;
        // Embeddings cost about $0.02 per 1M tokens; count them at that rate.
        const usd = body.model?.startsWith("text-embedding") ? input * 0.02e-6 : (input * p.input + output * p.output) / 1_000_000;
        assistantUsage.usd += usd;
        assistantUsage.calls++;
        assistantUsage.input += input;
        assistantUsage.output += output;
      })
      .catch(() => {});
  }
  return res;
};
