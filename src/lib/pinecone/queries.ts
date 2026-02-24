import type { RecordMetadata } from "@pinecone-database/pinecone";
import { getIndex } from "./client";
import { embedText } from "./embeddings";

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

  await index.upsert({
    records: [
      {
        id: ticketId,
        values: embedding,
        metadata,
      },
    ],
  });
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

  const results = await index.query({
    vector: embedding,
    topK,
    includeMetadata: true,
    filter,
  });

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
  await index.deleteOne({ id: ticketId });
}
