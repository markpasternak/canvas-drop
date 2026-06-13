import { createAnthropic } from "@ai-sdk/anthropic";
import type { Config } from "@canvas-drop/shared";
import { type ModelMessage, streamText } from "ai";

/**
 * AI provider factory (plan 009 / M9, D-AI-1). The Vercel AI SDK is the chosen
 * provider shape (§6.6.3 — provider-swappability), but it is **quarantined to
 * this file**: the AI route and every test depend only on `ModelProvider`, never
 * on `ai`/`@ai-sdk/anthropic`. That keeps the test suite offline + decoupled from
 * the AI SDK's version-volatile mock surface, and contains v5/v6 drift to one
 * module. A second provider later is `createOpenAI(...)` behind the same seam — no
 * canvas-code change.
 *
 * The provider key lives only in `config.ai.apiKey` (server-side, §8.1) and never
 * leaves this layer — it is never serialized into any response or the SDK bundle.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamChatInput {
  /** A model id already validated against the admin allowlist by the caller. */
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Abort the upstream call when the client disconnects (no runaway cost). */
  signal?: AbortSignal;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatStream {
  /** Incremental assistant text. */
  textStream: AsyncIterable<string>;
  /** Resolves once the stream finishes (or aborts) with final token counts. */
  usage: Promise<ChatUsage>;
}

export interface ModelProvider {
  streamChat(input: StreamChatInput): ChatStream;
}

/**
 * Default Anthropic-backed provider. Retries 429/5xx with backoff before the
 * first byte streams (§6.6.9, D-AI-5) and forwards the client abort signal.
 */
export function anthropicProvider(config: Config): ModelProvider {
  const anthropic = createAnthropic({
    apiKey: config.ai.apiKey,
    baseURL: config.ai.baseUrl,
  });
  return {
    streamChat({ model, system, messages, maxTokens, signal }) {
      const result = streamText({
        model: anthropic(model),
        system,
        messages: messages as ModelMessage[],
        maxOutputTokens: maxTokens,
        maxRetries: 2,
        abortSignal: signal,
      });
      return {
        textStream: result.textStream,
        // totalUsage is a PromiseLike; wrap so ChatStream.usage is a real Promise.
        usage: Promise.resolve(result.totalUsage).then(
          (u): ChatUsage => ({
            inputTokens: u.inputTokens ?? 0,
            outputTokens: u.outputTokens ?? 0,
          }),
        ),
      };
    },
  };
}
