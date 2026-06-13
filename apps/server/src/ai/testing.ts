import type { ChatStream, ChatUsage, ModelProvider, StreamChatInput } from "./provider.js";

export interface FakeProviderOptions {
  /** Text chunks to emit, in order. */
  deltas: string[];
  /** Final usage (defaults to small non-zero counts). */
  usage?: ChatUsage;
  /** Throw mid-stream after emitting this many deltas (simulates upstream error). */
  throwAfter?: number;
  /** Observe each call's input (assert allowlist/abort wiring, capture last call). */
  onCall?: (input: StreamChatInput) => void;
}

/**
 * In-memory {@link ModelProvider} for tests — no network, no `ai` dependency.
 * Honors the abort signal (stops emitting once aborted) so the AI route's
 * abandoned-stream handling is testable.
 */
export function fakeProvider(opts: FakeProviderOptions): ModelProvider {
  const usage: ChatUsage = opts.usage ?? { inputTokens: 10, outputTokens: 5 };
  return {
    streamChat(input: StreamChatInput): ChatStream {
      opts.onCall?.(input);
      async function* gen(): AsyncIterable<string> {
        let i = 0;
        for (const d of opts.deltas) {
          if (input.signal?.aborted) return;
          if (opts.throwAfter !== undefined && i >= opts.throwAfter) {
            throw new Error("upstream boom");
          }
          yield d;
          i++;
        }
      }
      return { textStream: gen(), usage: Promise.resolve(usage) };
    },
  };
}
