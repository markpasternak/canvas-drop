import { createAnthropic } from "@ai-sdk/anthropic";
import { type LanguageModelUsage, type ModelMessage, streamText } from "ai";

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
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
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

const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

function isCacheableText(content: string): boolean {
  return content.trim().length > 0;
}

function withAnthropicCacheControl(message: ModelMessage): ModelMessage {
  return {
    ...message,
    providerOptions: ANTHROPIC_EPHEMERAL_CACHE_CONTROL,
  };
}

export function buildAnthropicPromptWithCacheControl(input: {
  system?: string;
  messages: ChatMessage[];
}): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (input.system && isCacheableText(input.system)) {
    messages.push(
      withAnthropicCacheControl({
        role: "system",
        content: input.system,
      }),
    );
  }

  const conversationOffset = messages.length;
  messages.push(...(input.messages as ModelMessage[]));

  const newestUserIndex = input.messages.findLastIndex((message) => message.role === "user");
  if (newestUserIndex <= 0) return messages;

  for (let i = newestUserIndex - 1; i >= 0; i--) {
    if (isCacheableText(input.messages[i]?.content ?? "")) {
      const providerMessageIndex = conversationOffset + i;
      messages[providerMessageIndex] = withAnthropicCacheControl(
        messages[providerMessageIndex] as ModelMessage,
      );
      break;
    }
  }

  return messages;
}

export function chatUsageFromLanguageModelUsage(u: LanguageModelUsage): ChatUsage {
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheCreationInputTokens: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    cacheReadInputTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/**
 * Default Anthropic-backed provider. Retries 429/5xx with backoff before the
 * first byte streams (§6.6.9, D-AI-5) and forwards the client abort signal.
 *
 * The key is passed in (not read from Config) because it is now resolved per
 * request — the admin can set/rotate it in the DB at runtime (DB overrides env),
 * so the route builds the provider with the *effective* key for each call. The
 * key stays server-side and is never serialized into any response or the SDK
 * bundle (§12.0 no-secrets-in-browser).
 */
export function anthropicProvider(opts: { apiKey?: string; baseUrl?: string }): ModelProvider {
  const anthropic = createAnthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  });
  return {
    streamChat({ model, system, messages, maxTokens, signal }) {
      const result = streamText({
        model: anthropic(model),
        messages: buildAnthropicPromptWithCacheControl({ system, messages }),
        allowSystemInMessages: true,
        maxOutputTokens: maxTokens,
        maxRetries: 2,
        abortSignal: signal,
      });
      return {
        textStream: result.textStream,
        // totalUsage is a PromiseLike; wrap so ChatStream.usage is a real Promise.
        usage: Promise.resolve(result.totalUsage).then(chatUsageFromLanguageModelUsage),
      };
    },
  };
}
