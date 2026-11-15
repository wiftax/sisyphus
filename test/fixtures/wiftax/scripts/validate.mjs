// Minimal stand-in for wiftax's validator: same output format.
import { readFileSync, readdirSync } from "node:fs";
const dir = new URL("../data/products/", import.meta.url).pathname;
let failed = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))) {
  const t = readFileSync(dir + f, "utf8");
  const errs = [];
  if (t.includes(";")) errs.push("summary: has a semicolon. Split it into sentences");
  if (!/^id: /m.test(t)) errs.push("/ must have required property 'id'");
  if (errs.length) { failed++; console.log(`✗ ${f}\n   ${errs.join("\n   ")}`); } else console.log(`✓ ${f}  ok`);
}
process.exit(failed ? 1 : 0);
