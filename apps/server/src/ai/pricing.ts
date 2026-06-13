/**
 * AI model pricing (plan 009 / M9, D-AI-2). USD per 1,000,000 tokens, input /
 * output. Source: the Anthropic models+pricing reference (cached 2026-06-04).
 * The admin allowlist (CANVAS_DROP_AI_MODELS) is what bounds which models can be
 * called; this table is what turns a call's token counts into the USD cost that
 * the quota windows sum. A model that's allowlisted but absent here costs $0 and
 * is flagged via {@link isPricedModel} so the route can warn (tokens are still
 * recorded — we never crash on an unpriced model).
 */
export interface ModelRate {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
}

export const PRICING: Readonly<Record<string, ModelRate>> = {
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
};

/** Whether we have a price for this model (false → costUsd returns 0). */
export function isPricedModel(model: string): boolean {
  return model in PRICING;
}

/**
 * Compute the USD cost of a call. Unknown model → 0 (caller should warn via
 * {@link isPricedModel}); the per-MTok division keeps fractional cents intact.
 */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = PRICING[model];
  if (!rate) return 0;
  return (
    (inputTokens / 1_000_000) * rate.inputPerMTok + (outputTokens / 1_000_000) * rate.outputPerMTok
  );
}
