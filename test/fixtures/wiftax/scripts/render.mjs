import { readdirSync, writeFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
writeFileSync(root + "SCOREBOARD.md", readdirSync(root + "data/products").sort().join("\n") + "\n");
