/**
 * Plumbing subcategory edge-case tests.
 *
 * Tests realistic tenant phrasings beyond the happy-path keywords
 * to find gaps in classifyPlumbing().
 */
import { createRunner, printSection, type TestResult } from "./helpers";
import { classifyPlumbing } from "../../src/lib/triage/classify-issue";

interface Case {
  input: string;
  expected: string | null;
}

export function testPlumbingEdgeCases(): TestResult {
  printSection("Plumbing Edge Cases");
  const { pass, fail, result } = createRunner();

  const cases: Case[] = [
    // ── broken_fixture ──
    { input: "faucet handle broke off", expected: "broken_fixture" },
    { input: "shower knob fell off", expected: "broken_fixture" },
    { input: "toilet seat is cracked", expected: "broken_fixture" },
    { input: "toilet lever snapped", expected: "broken_fixture" },
    { input: "bathtub faucet is stuck", expected: "broken_fixture" },
    { input: "kitchen faucet handle is loose", expected: "broken_fixture" },
    { input: "faucet won't turn off", expected: "broken_fixture" },
    { input: "toilet won't flush properly", expected: "broken_fixture" },
    { input: "broken pipe under the sink", expected: "broken_fixture" },
    { input: "the tap is jammed", expected: "broken_fixture" },

    // ── running_toilet ──
    { input: "toilet keeps running", expected: "running_toilet" },
    { input: "my toilet runs all night", expected: "running_toilet" },
    { input: "toilet runs constantly", expected: "running_toilet" },
    { input: "the toilet is running nonstop", expected: "running_toilet" },
    { input: "ghost flushing toilet", expected: "running_toilet" },
    { input: "toilet keeps flushing by itself", expected: "running_toilet" },
    { input: "toilet won't stop filling", expected: "running_toilet" },

    // ── clog ──
    { input: "kitchen sink won't drain", expected: "clog" },
    { input: "toilet is overflowing", expected: "clog" },
    { input: "bathtub won't drain", expected: "clog" },
    { input: "drain is really slow", expected: "clog" },
    { input: "toilet keeps backing up", expected: "clog" },
    { input: "shower drain is slow", expected: "clog" },
    { input: "the toilet is plugged", expected: "clog" },
    { input: "garbage disposal is clogged", expected: "clog" },
    { input: "water standing in the sink", expected: "clog" },

    // ── leak ──
    { input: "water dripping from ceiling", expected: "leak" },
    { input: "faucet drips all day", expected: "leak" },
    { input: "pipe burst in the wall", expected: "leak" },
    { input: "water coming from under the sink", expected: "leak" },
    { input: "there's a puddle under the toilet", expected: "leak" },
    { input: "bathroom is flooded", expected: "leak" },
    { input: "kitchen faucet has a slow drip", expected: "leak" },

    // ── no_hot_water ──
    { input: "hot water isn't working", expected: "no_hot_water" },
    { input: "only getting cold water from the shower", expected: "no_hot_water" },
    { input: "water heater is making weird noise", expected: "no_hot_water" },
    { input: "the hot water runs out after 2 minutes", expected: "no_hot_water" },
    { input: "water is only lukewarm", expected: "no_hot_water" },

    // ── water_pressure ──
    { input: "water barely comes out of the faucet", expected: "water_pressure" },
    { input: "shower has no pressure at all", expected: "water_pressure" },
    { input: "the water pressure is really low", expected: "water_pressure" },
    { input: "faucet has very weak water flow", expected: "water_pressure" },
    { input: "no water coming out of the kitchen sink", expected: "water_pressure" },

    // ── null (generic plumbing, no specific problem type) ──
    { input: "I need a plumber", expected: null },
    { input: "something wrong with the plumbing", expected: null },
    { input: "bathroom needs repair", expected: null },
  ];

  for (const { input, expected } of cases) {
    const actual = classifyPlumbing(input);
    const label = `classifyPlumbing: "${input}" → ${expected === null ? "null" : `'${expected}'`}`;
    if (actual === expected) {
      pass(label);
    } else {
      fail(label, { expected, actual });
    }
  }

  return result;
}

// Standalone execution
if (require.main === module) {
  const { runStandalone } = require("./helpers");
  runStandalone(testPlumbingEdgeCases);
}
