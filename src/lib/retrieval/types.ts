/**
 * Phase 2B — Retrieval pipeline types.
 *
 * Defines the contract for Pinecone SOP retrieval, including
 * query parameters, result shapes, and the full audit log
 * persisted in tickets.classification.retrieval.
 */

export interface RetrievalQuery {
  query_text: string;
  category: string;
  top_k: number;
  min_score: number;
  max_chars: number;
  namespace: string;
}

export interface RetrievalSnippet {
  id: string;
  score: number;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface RetrievalResult {
  snippets: RetrievalSnippet[];
  log: import("../triage/types").RetrievalLog;
}
