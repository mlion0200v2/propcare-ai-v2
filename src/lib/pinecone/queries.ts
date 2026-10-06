import type { RecordMetadata } from "@pinecone-database/pinecone";
import { getIndex } from "./client";
import { embedText } from "./embeddings";
import { withTimeoutRetry} from "../retry";

interface TicketMetadata extends RecordMetadata {
  ticket_id: string;
  title: string;
  category: string;
  resolution: string;
  property_id: string;
}

/**
 * Upsert a resolved ticket into the vector index for future similarity search.
 */
export async function upsertTicket(
  ticketId: string,
  text: string,
  metadata: TicketMetadata
) {
  const embedding = await embedText(text);
  const index = getIndex();

  await withTimeoutRetry(
    () => index.upsert({
      records: [
        {
          id: ticketId,
          values: embedding,
          metadata,
        },
      ],
    }),
    { timeoutMs: 15000, retries: 2, label: "pinecone-upsert-ticket" }
  );
}

/**
 * Search for similar tickets based on a description.
 * Returns top-K matches with their metadata and similarity scores.
 */
export async function searchSimilarTickets(
  description: string,
  topK: number = 5,
  filter?: Record<string, string>
) {
  const embedding = await embedText(description);
  const index = getIndex();

  const results = await withTimeoutRetry(
    () => index.query({
      vector: embedding,
      topK,
      includeMetadata: true,
      filter,
    }),
    { timeoutMs: 15000, retries: 2, label: "pinecone-search-tickets"}
  );

  return (results.matches ?? []).map((match) => ({
    ticket_id: match.id,
    score: match.score ?? 0,
    metadata: match.metadata as unknown as TicketMetadata,
  }));
}

/**
 * Delete a ticket's vector from the index (e.g., if ticket is deleted).
 */
export async function deleteTicketVector(ticketId: string) {
  const index = getIndex();
  await withTimeoutRetry(
    () => index.deleteOne({ id: ticketId }),
    { timeoutMs: 15000, retries: 2, label: "pinecone-delete-ticket" }
  );
}
