/**
 * Test 7: OpenAI Embeddings (text-embedding-3-small, 1536d)
 * Run:  npx tsx tests/integration/test-openai.ts
 */
import OpenAI from "openai";
import { createRunner, printSection, isExternalEnabled, runStandalone, type TestResult } from "./helpers";

export async function testOpenAI(): Promise<TestResult> {
  printSection("OpenAI Embeddings");
  const { pass, fail, skip, result } = createRunner();

  if (!isExternalEnabled()) {
    skip("OpenAI tests", "RUN_EXTERNAL !== 1");
    return result;
  }

  if (!process.env.OPENAI_API_KEY) {
    skip("OpenAI tests", "missing OPENAI_API_KEY");
    return result;
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "Kitchen faucet leaking — Phase 1 validation test",
      dimensions: 1536,
    });

    const embedding = response.data[0].embedding;

    if (embedding.length === 1536) {
      pass(`Embedding generated: ${embedding.length} dimensions`);
    } else {
      fail(`Dimension mismatch: got ${embedding.length}, expected 1536`);
    }

    pass(`Model: text-embedding-3-small`);
    pass(`Tokens used: ${response.usage.total_tokens}`);

    // Check L2 norm
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (Math.abs(norm - 1.0) < 0.01) {
      pass(`L2 norm: ${norm.toFixed(4)} (unit-normalized)`);
    } else {
      pass(`L2 norm: ${norm.toFixed(4)} (valid)`);
    }
  } catch (e) {
    fail("Embedding generation failed", e);
  }

  return result;
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-openai");
if (isMain) runStandalone(testOpenAI);
