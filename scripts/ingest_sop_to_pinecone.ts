import dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
import fs from "node:fs"
import readline from "node:readline"

import { Pinecone } from "@pinecone-database/pinecone"
import OpenAI from "openai"

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY!,
})

const indexName = process.env.PINECONE_INDEX!
const namespace = process.env.PINECONE_NAMESPACE ?? "sop"

const index = pinecone.index(indexName)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
})

async function embed(text: string) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  })
  return res.data[0].embedding
}

async function main() {
  const file = process.argv[2]

  if (!file) {
    console.error("Usage: ingest <file.jsonl>")
    process.exit(1)
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  })

  let batch: any[] = []
  let count = 0

  for await (const line of rl) {
    if (!line.trim()) continue

    const doc = JSON.parse(line)

    const vector = await embed(doc.text)

    batch.push({
      id: doc.id,
      values: vector,
      metadata: {
        ...doc.metadata,
        title: doc.title,
        text: doc.text,
      },
    })

    if (batch.length >= 50) {
      await index.namespace(namespace).upsert({ records: batch })
      count += batch.length
      batch = []
      console.log(`Upserted ${count}`)
    }
  }
  console.log("Final batch size:", batch.length)
  console.log("First vector id:", batch[0]?.id)
  if (batch.length > 0) {
    await index.namespace(namespace).upsert({ records: batch })
    count += batch.length
  }

  console.log(`Finished. Total inserted: ${count}`)
}

main()