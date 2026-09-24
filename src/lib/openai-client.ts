import OpenAI from "openai";

/**
 * Shared OpenAI client for the whole app.
 *
 * Constructed once at module load and reused by every call site
 * (embeddings, grounding, step interpretation, step help).
 * Keeps API key handling and client config in a single place.
 */
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
