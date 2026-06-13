import type { Config } from "@canvas-drop/shared";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { costUsd, isPricedModel } from "../ai/pricing.js";
import type { ModelProvider } from "../ai/provider.js";
import { checkQuota, dayStartUtc, monthStartUtc } from "../ai/quota.js";
import { requireCapability } from "../canvas/capability-guard.js";
import type { AiUsageRepository } from "../db/repositories/ai-usage.js";
import { requireCanvas } from "../http/canvas-api-isolation.js";
import type { AppEnv } from "../http/types.js";

/** AI output limits (§6.6). Default modest; hard cap so one call can't run away. */
export const AI_DEFAULT_MAX_TOKENS = 1024;
export const AI_MAX_TOKENS = 8192;
/** Max wait for the provider's usage promise before recording with 0 tokens. */
export const USAGE_SETTLE_TIMEOUT_MS = 5_000;

export interface CanvasAiDeps {
  config: Config;
  aiUsage: AiUsageRepository;
  /** The model provider seam (default Anthropic; tests inject a fake). */
  provider: ModelProvider;
}

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .min(1),
  system: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
});

/**
 * AI primitive route (§6.6, plan 009 / M9), mounted at `/v1/c/:slug/ai`. Behind
 * `requireCapability("ai")` (→ 403 CAPABILITY_DISABLED when backend off, per-canvas
 * `cap_ai` off, or no provider key configured). The provider API key is server-side
 * only and never appears in any response (§12.0 no-secrets-in-browser).
 *
 * `POST /chat` streams SSE: `{type:"delta",text}` … then `{type:"done",usage,cost}`,
 * or `{type:"error",code,message}` on upstream failure. Pre-stream failures
 * (invalid body / model-not-allowed / quota) are plain JSON `{code}` HTTP errors so
 * the SDK maps status→typed error before reading the stream.
 */
export function canvasAiRoutes(deps: CanvasAiDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireCapability("ai", deps.config));

  app.post("/chat", async (c) => {
    const parsed = chatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "INVALID_BODY" }, 400);
    const { model, messages, system } = parsed.data;
    const maxTokens = Math.min(parsed.data.maxTokens ?? AI_DEFAULT_MAX_TOKENS, AI_MAX_TOKENS);

    // Admin allowlist (§6.6.4) — server config is authoritative; out-of-list rejected.
    if (!deps.config.ai.models.includes(model)) {
      return c.json({ code: "MODEL_NOT_ALLOWED" }, 400);
    }
    // Fail closed on an allowlisted-but-unpriced model: cost would be recorded as
    // $0, so the USD quota windows would never grow and spend would be unbounded
    // (adversarial review). Reject until the operator adds a pricing entry.
    if (!isPricedModel(model)) {
      c.get("log")?.error(
        { model },
        "ai: model is allowlisted but has no pricing entry; rejecting to protect the spend quota",
      );
      return c.json({ code: "MODEL_NOT_ALLOWED" }, 400);
    }

    const canvas = requireCanvas(c);
    const user = c.get("user");

    // Pre-call quota check (D-AI-4, best-effort): per-user daily + per-canvas monthly.
    const now = Date.now();
    const [userSpend, canvasSpend] = await Promise.all([
      deps.aiUsage.userSpendSince(user.id, dayStartUtc(now)),
      deps.aiUsage.canvasSpendSince(canvas.id, monthStartUtc(now)),
    ]);
    const quota = checkQuota(userSpend, canvasSpend, {
      userDailyUsd: deps.config.ai.userDailyUsd,
      canvasMonthlyUsd: deps.config.ai.canvasMonthlyUsd,
    });
    if (!quota.ok) return c.json({ code: "QUOTA_EXCEEDED", scope: quota.scope }, 429);

    const chat = deps.provider.streamChat({
      model,
      system,
      messages,
      maxTokens,
      signal: c.req.raw.signal,
    });

    return streamSSE(c, async (stream) => {
      let recorded = false;
      // Record consumed usage exactly once — on success, upstream error, OR client
      // abort — so an abandoned stream still counts against the quota (D-AI-5 /
      // adversarial F5: otherwise abandon-and-retry silently bypasses the cap).
      const persist = async () => {
        if (recorded) return { inputTokens: 0, outputTokens: 0, cost: 0 };
        recorded = true;
        // Race the provider's usage promise against a timeout: on a client abort the
        // upstream usage promise may never settle, which would hang the recording and
        // re-open the abandon-and-retry quota bypass. Record whatever we have within
        // the window (0 tokens worst case — the call is still counted).
        const u = await Promise.race([
          chat.usage.catch(() => ({ inputTokens: 0, outputTokens: 0 })),
          new Promise<{ inputTokens: number; outputTokens: number }>((resolve) =>
            setTimeout(() => resolve({ inputTokens: 0, outputTokens: 0 }), USAGE_SETTLE_TIMEOUT_MS),
          ),
        ]);
        const cost = costUsd(model, u.inputTokens, u.outputTokens);
        await deps.aiUsage
          .record({
            canvasId: canvas.id,
            userId: user.id,
            provider: deps.config.ai.provider,
            model,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            costUsd: cost,
          })
          .catch((err) => c.get("log")?.error({ err }, "ai: failed to record usage"));
        return { ...u, cost };
      };
      stream.onAbort(() => {
        void persist();
      });

      try {
        for await (const delta of chat.textStream) {
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: delta }) });
        }
        const r = await persist();
        if (!stream.aborted) {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "done",
              usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens },
              cost: r.cost,
            }),
          });
        }
      } catch (err) {
        await persist();
        c.get("log")?.error({ err }, "ai: upstream stream error");
        if (!stream.aborted) {
          await stream
            .writeSSE({
              data: JSON.stringify({
                type: "error",
                code: "AI_UPSTREAM_ERROR",
                message: "the AI provider returned an error",
              }),
            })
            .catch(() => {});
        }
      }
    });
  });

  return app;
}
