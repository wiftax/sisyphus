// What the model calls in one patrol cost, at list price. Token counts come
// from each response's usage. Prices are USD per million tokens and can be
// overridden with SISYPHUS_PRICES (JSON: {"<model>": {"input": 4, "output": 20, ...}}).

export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number; // 5-minute cache writes
}

// List prices, USD per million tokens. Cache writes are 1.25x input.
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
};

function priceFor(model: string): Price | null {
  try {
    const custom = process.env.SISYPHUS_PRICES ? (JSON.parse(process.env.SISYPHUS_PRICES) as Record<string, Price>) : {};
    if (custom[model]) return custom[model];
  } catch {
    /* ignore a malformed override */
  }
  return PRICES[model] ?? null;
}

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number; // list price, rounded to cents
  unpriced_models: string[]; // served by a model with no known price; not in cost_usd
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export class UsageMeter {
  private t = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0 };
  private unpriced = new Set<string>();

  // `model` is the model that served the response, which a fallback can change.
  add(model: string, u: MessageUsage): void {
    const read = u.cache_read_input_tokens ?? 0;
    const write = u.cache_creation_input_tokens ?? 0;
    this.t.calls++;
    this.t.input_tokens += u.input_tokens;
    this.t.output_tokens += u.output_tokens;
    this.t.cache_read_tokens += read;
    this.t.cache_write_tokens += write;
    const p = priceFor(model);
    if (!p) {
      this.unpriced.add(model);
      return;
    }
    this.t.cost += (u.input_tokens * p.input + u.output_tokens * p.output + read * p.cache_read + write * p.cache_write) / 1_000_000;
  }

  totals(): UsageTotals {
    const { cost, ...rest } = this.t;
    return { ...rest, cost_usd: Math.round(cost * 100) / 100, unpriced_models: [...this.unpriced] };
  }
}

export const meter = new UsageMeter();
