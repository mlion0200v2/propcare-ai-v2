/**
 * Knowledge-base similarity for finding cards: embeds what the tenant said
 * and asks Pinecone which SOPs read most like it. The scores add to the
 * card ranking (./index.ts findCards); they never pick a card on their own.
 *
 * Optional and time-boxed: no keys, an error or a slow answer returns null
 * and cards are found from the understanding and keywords alone.
 */
import { embedForRetrieval } from "@/assistant/retrieval/embedding";
import { getIndex } from "@/assistant/retrieval/pinecone-client";

/** Similarity (0–1) per issue_key, or null when unavailable. */
export type CardSearch = (text: string) => Promise<Record<string, number> | null>;

/** Below this, a match says nothing useful. */
const MIN_SIMILARITY = 0.3;

export function pineconeCardSearch(options: { topK?: number; timeoutMs?: number } = {}): CardSearch | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey || openaiKey.startsWith("placeholder") || !process.env.PINECONE_API_KEY || process.env.PINECONE_API_KEY === "x") return null;
  const topK = options.topK ?? 5;
  const timeoutMs = options.timeoutMs ?? 4000;
  const namespace = process.env.PINECONE_NAMESPACE ?? "sop";

  return async (text) => {
    const search = (async () => {
      const { vector } = await embedForRetrieval(text.slice(0, 2000));
      const results = await getIndex().namespace(namespace).query({ vector, topK, includeMetadata: true });
      const scores: Record<string, number> = {};
      for (const m of results.matches ?? []) {
        const key = m.metadata?.issue_key;
        if (typeof key === "string" && (m.score ?? 0) >= MIN_SIMILARITY) scores[key] = Math.max(scores[key] ?? 0, m.score ?? 0);
      }
      return scores;
    })().catch(() => null);
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.());
    return Promise.race([search, timeout]);
  };
}
