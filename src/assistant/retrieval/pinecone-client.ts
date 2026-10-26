import { Pinecone } from "@pinecone-database/pinecone";

let pineconeInstance: Pinecone | null = null;

export function getPinecone() {
  if (!pineconeInstance) {
    pineconeInstance = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY!,
    });
  }
  return pineconeInstance;
}

export function getIndex() {
  return getPinecone().index(process.env.PINECONE_INDEX!);
}
