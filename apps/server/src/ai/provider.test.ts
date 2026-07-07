import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import {
  anthropicProvider,
  buildAnthropicPromptWithCacheControl,
  chatUsageFromLanguageModelUsage,
} from "./provider.js";
import { fakeProvider } from "./testing.js";

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("ai provider seam", () => {
  it("fakeProvider streams deltas and resolves usage", async () => {
    const provider = fakeProvider({
      deltas: ["Hel", "lo"],
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const res = provider.streamChat({ model: "claude-haiku-4-5", messages: [], maxTokens: 100 });
    expect(await collect(res.textStream)).toEqual(["Hel", "lo"]);
    expect(await res.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it("fakeProvider stops emitting once the signal is aborted (abandoned stream)", async () => {
    const ac = new AbortController();
    const provider = fakeProvider({ deltas: ["a", "b", "c"] });
    const res = provider.streamChat({
      model: "claude-haiku-4-5",
      messages: [],
      maxTokens: 100,
      signal: ac.signal,
    });
    const out: string[] = [];
    for await (const chunk of res.textStream) {
      out.push(chunk);
      ac.abort(); // abort after the first chunk
    }
    expect(out).toEqual(["a"]);
  });

  it("anthropicProvider constructs lazily — no network, no throw without a call", () => {
    // No CANVAS_DROP_AI_API_KEY set: capability guard would block at the route,
    // but the factory itself must not throw at construction (no eager request).
    const config = loadConfig({ CANVAS_DROP_AUTH_MODE: "dev" });
    const provider = anthropicProvider({ apiKey: config.ai.apiKey, baseUrl: config.ai.baseUrl });
    expect(typeof provider.streamChat).toBe("function");
  });

  it("marks the system prompt but not the newest user message for caching", () => {
    const messages = buildAnthropicPromptWithCacheControl({
      system: "stable instructions",
      messages: [{ role: "user", content: "rewrite this" }],
    });

    expect(messages).toEqual([
      {
        role: "system",
        content: "stable instructions",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
      { role: "user", content: "rewrite this" },
    ]);
  });

  it("marks the last stable-prefix message before the latest user turn", () => {
    const messages = buildAnthropicPromptWithCacheControl({
      system: "stable instructions",
      messages: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "follow up" },
      ],
    });

    expect(messages[2]).toEqual({
      role: "assistant",
      content: "first answer",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(messages[3]).toEqual({ role: "user", content: "follow up" });
  });

  it("does not mark a trailing assistant response as the newest-turn breakpoint", () => {
    const messages = buildAnthropicPromptWithCacheControl({
      messages: [
        { role: "user", content: "first request" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "follow up" },
        { role: "assistant", content: "draft answer" },
      ],
    });

    expect(messages[1]).toEqual({
      role: "assistant",
      content: "first answer",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(messages[3]).toEqual({ role: "assistant", content: "draft answer" });
  });

  it("sends no cache breakpoints when no system or stable prefix exists", () => {
    const messages = buildAnthropicPromptWithCacheControl({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("extracts cache write/read tokens from AI SDK usage details with zero defaults", () => {
    expect(
      chatUsageFromLanguageModelUsage({
        inputTokens: 17,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheWriteTokens: 7,
          cacheReadTokens: 5,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 20,
        raw: {},
      }),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 3,
      cacheCreationInputTokens: 7,
      cacheReadInputTokens: 5,
    });

    expect(
      chatUsageFromLanguageModelUsage({
        inputTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheWriteTokens: undefined,
          cacheReadTokens: undefined,
        },
        outputTokens: undefined,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: undefined,
        raw: {},
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });
});
