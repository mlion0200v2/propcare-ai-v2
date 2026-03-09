import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })

import { Pinecone } from "@pinecone-database/pinecone"
import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! })

const index = pinecone.index(process.env.PINECONE_INDEX!)
const namespace = process.env.PINECONE_NAMESPACE ?? "sop"

async function embed(text: string) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  })
  return res.data[0].embedding
}

async function main() {
  const q = process.argv.slice(2).join(" ") || "kitchen faucet leak comes and goes"
  const vector = await embed(q)

  const result = await index.namespace(namespace).query({
    vector,
    topK: 5,
    includeMetadata: true,
    filter: { category: "plumbing" },
  })

  console.log("Query:", q)
  console.log(
    (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score,
      title: (m.metadata as any)?.title,
      category: (m.metadata as any)?.category,
    }))
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})