/**
 * Phase 2A — Retrieval Module (placeholder)
 *
 * Defines the interface for SOP retrieval. In Phase 2A this returns
 * an empty array. Phase 2B will implement real Pinecone RAG via
 * searchSimilarTickets().
 */

export interface SOPContextBlock {
  title: string;
  source_type: "sop_article" | "similar_ticket" | "fallback";
  content: string;
  citation_id: string;
  score: number;
}

/**
 * Retrieve SOP context for triage.
 * Phase 2A: returns empty array (placeholder).
 * Phase 2B: will call searchSimilarTickets() from Pinecone.
 */
export async function retrieveSOP(
  _category: string,
  _description: string,
  _propertyId?: string
): Promise<SOPContextBlock[]> {
  return [];
}

/**
 * Format retrieved SOP blocks into a string for LLM context.
 */
export function formatSOPContext(blocks: SOPContextBlock[]): string {
  if (blocks.length === 0) return "";
  return blocks
    .map((b, i) => `[${i + 1}] ${b.title} (score: ${b.score.toFixed(2)})\n${b.content}`)
    .join("\n\n");
}
