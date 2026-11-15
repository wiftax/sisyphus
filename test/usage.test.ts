import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageMeter } from "../src/usage.js";

test("cost is summed at list price per served model, cache included", () => {
  const m = new UsageMeter();
  m.add("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 });
  m.add("claude-opus-5", { input_tokens: 0, output_tokens: 1_000_000 });
  m.add("some-new-model", { input_tokens: 5, output_tokens: 5 });
  const t = m.totals();
  assert.equal(t.calls, 3);
  // Opus 5.5: 4 + 2 + 0.2. Opus 5: 25.
  assert.equal(t.cost_usd, 31.2);
  assert.deepEqual(t.unpriced_models, ["some-new-model"]);
});
