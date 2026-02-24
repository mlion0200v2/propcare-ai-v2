/**
 * Test 1: Environment Variables
 * Run:  npx tsx tests/integration/test-env.ts
 */
import { createRunner, printSection, runStandalone, type TestResult } from "./helpers";

export function testEnv(): TestResult & { envPresent: Record<string, boolean> } {
  printSection("Environment Variables");
  const { pass, fail, result } = createRunner();

  const REQUIRED = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PINECONE_API_KEY",
    "PINECONE_INDEX",
    "OPENAI_API_KEY",
  ] as const;

  const envPresent: Record<string, boolean> = {};

  for (const name of REQUIRED) {
    const value = process.env[name];
    if (value && value.length > 0) {
      const masked = value.slice(0, 8) + "..." + value.slice(-4);
      pass(`${name} = ${masked}`);
      envPresent[name] = true;
    } else {
      fail(`${name} is missing or empty`);
      envPresent[name] = false;
    }
  }

  return { ...result, envPresent };
}

// Standalone
const isMain = process.argv[1]?.replace(/\.ts$/, "").endsWith("test-env");
if (isMain) runStandalone(testEnv);
