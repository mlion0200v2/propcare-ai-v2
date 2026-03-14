/**
 * Phase 2B — Pinecone SOP retrieval pipeline.
 *
 * Builds a query from gathered issue info, embeds it, queries Pinecone,
 * applies score filtering + character cap, and returns snippets with
 * a full audit log for persistence in tickets.classification.retrieval.
 */

import { getIndex } from "../pinecone/client";
import { embedForRetrieval } from "./embedding";
import type { GatheredInfo, RetrievalLog } from "../triage/types";
import type { RetrievalQuery, RetrievalResult, RetrievalSnippet } from "./types";

// ── Defaults (overridable via env) ──

const DEFAULT_TOP_K = 5;
const DEFAULT_MIN_SCORE = 0.40;
const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_NAMESPACE = "sop";

function getConfig() {
  return {
    topK: parseInt(process.env.RETRIEVAL_TOP_K ?? String(DEFAULT_TOP_K), 10),
    minScore: parseFloat(process.env.RETRIEVAL_MIN_SCORE ?? String(DEFAULT_MIN_SCORE)),
    maxChars: parseInt(process.env.RETRIEVAL_MAX_CHARS ?? String(DEFAULT_MAX_CHARS), 10),
    namespace: process.env.PINECONE_NAMESPACE ?? DEFAULT_NAMESPACE,
    indexName: process.env.PINECONE_INDEX ?? "maintenance-kb",
  };
}

/**
 * Build the query text from gathered issue info.
 */
export function buildQueryText(gathered: GatheredInfo, description: string): string {
  const categoryPart = gathered.subcategory
    ? `${gathered.category ?? "general"} ${gathered.subcategory} issue`
    : `${gathered.category ?? "general"} issue`;
  const parts = [
    categoryPart,
    gathered.location_in_unit ? `in ${gathered.location_in_unit}` : null,
    description ? `: ${description}` : null,
    gathered.current_status ? `. Status: ${gathered.current_status}` : null,
    gathered.brand_model && gathered.brand_model !== "unknown"
      ? `. Equipment: ${gathered.brand_model}`
      : null,
  ].filter(Boolean);
  return parts.join("");
}

/**
 * Run the full retrieval pipeline:
 * 1. Build query text
 * 2. Embed the query
 * 3. Query Pinecone with category filter
 * 4. Filter by min score
 * 5. Cap total snippet characters
 * 6. Build audit log
 */
export async function querySnippets(
  gathered: GatheredInfo,
  description: string,
  traceId: string
): Promise<RetrievalResult> {
  const config = getConfig();
  const queryText = buildQueryText(gathered, description);

  console.log("[retrieval] config:", {
    indexName: config.indexName,
    namespace: config.namespace,
    topK: config.topK,
    minScore: config.minScore,
    maxChars: config.maxChars,
    hasPineconeKey: !!process.env.PINECONE_API_KEY,
    hasOpenAIKey: !!process.env.OPENAI_API_KEY,
  });
  console.log("[retrieval] queryText:", queryText);
  console.log("[retrieval] filter:", { category: gathered.category ?? "general" });

  const query: RetrievalQuery = {
    query_text: queryText,
    category: gathered.category ?? "general",
    top_k: config.topK,
    min_score: config.minScore,
    max_chars: config.maxChars,
    namespace: config.namespace,
  };

  // Embed
  const { vector, model } = await embedForRetrieval(queryText);
  console.log("[retrieval] embedding done, model:", model, "dims:", vector.length);

  // Query Pinecone
  const index = getIndex();
  const ns = index.namespace(config.namespace);
  const results = await ns.query({
    vector,
    topK: config.topK,
    includeMetadata: true,
    filter: { category: gathered.category ?? "general" },
  });

  const rawMatches = results.matches ?? [];
  console.log("[retrieval] raw matches from Pinecone:", rawMatches.length);
  for (const m of rawMatches) {
    console.log("[retrieval]   match:", m.id, "score:", m.score, "title:", m.metadata?.title);
  }

  // Filter by min score
  const filteredMatches = rawMatches.filter(
    (m) => (m.score ?? 0) >= config.minScore
  );
  console.log("[retrieval] after min_score filter:", filteredMatches.length);

  // Cap total snippet characters
  const snippets: RetrievalSnippet[] = [];
  let totalChars = 0;
  for (const match of filteredMatches) {
    const content = String(match.metadata?.content ?? match.metadata?.text ?? "");
    const title = String(match.metadata?.title ?? match.id);

    if (totalChars + content.length > config.maxChars && snippets.length > 0) {
      break;
    }

    snippets.push({
      id: match.id,
      score: match.score ?? 0,
      title,
      content,
      metadata: (match.metadata ?? {}) as Record<string, unknown>,
    });
    totalChars += content.length;
  }

  // Confidence metadata
  const scores = snippets.map((s) => s.score);
  const highestScore = scores.length > 0 ? Math.max(...scores) : 0;
  const averageScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  // Low confidence = no snippets passed, or the best match is still below min_score
  const lowConfidence = snippets.length === 0 || highestScore < config.minScore;

  console.log("[retrieval] final snippets:", snippets.length,
    "highestScore:", highestScore.toFixed(3),
    "avgScore:", averageScore.toFixed(3),
    "lowConfidence:", lowConfidence);

  const log: RetrievalLog = {
    query_text: queryText,
    embedding_model: model,
    pinecone_index: config.indexName,
    pinecone_namespace: config.namespace,
    filters: { category: gathered.category ?? "general" },
    top_k: config.topK,
    min_score: config.minScore,
    matches: snippets.map((s) => ({
      id: s.id,
      score: s.score,
      metadata: s.metadata,
    })),
    highest_score: highestScore,
    average_score: averageScore,
    low_confidence: lowConfidence,
    timestamp: new Date().toISOString(),
    trace_id: traceId,
  };

  return { snippets, log };
}
