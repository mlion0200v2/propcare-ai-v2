/**
 * Phase 2B — Retrieval embedding wrapper.
 *
 * Wraps the existing embedText() from pinecone/embeddings.ts and
 * tracks the model ID for audit logging in the RetrievalLog.
 */

import { embedText } from "../pinecone/embeddings";

export const EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Embed text for retrieval and return both the vector and model ID.
 */
export async function embedForRetrieval(
  text: string
): Promise<{ vector: number[]; model: string }> {
  const vector = await embedText(text);
  return { vector, model: EMBEDDING_MODEL };
}
