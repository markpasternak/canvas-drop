import { loadConfig } from "@canvas-drop/shared";
import { describe, expect, it } from "vitest";
import { anthropicProvider } from "./provider.js";
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
    expect(await res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
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
});
