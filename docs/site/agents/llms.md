# llms.txt

canvas-drop serves a single agent-optimized reference at
[`{base}/llms.txt`](/llms.txt) — plain text, no markup chrome, designed to be
dropped into an LLM's context.

It is **public** (readable without a session) so an agent can learn the API before
it has credentials, and it carries the essentials:

- What a canvas is and how to deploy one.
- The deploy API (Bearer-key, agent-usable from day one).
- The browser SDK surface (`canvasdrop.kv`, `files`, `me`, `ai`, `realtime`).
- The capability model and the stable error codes.

## For agents

1. Read [`/llms.txt`](/llms.txt) for the contract.
2. Obtain a per-canvas API key (from the canvas owner / dashboard).
3. Deploy with `PUT {base}/v1/canvases/{id}/deploy` — see the
   [Deploy API](/docs/api/deploy-api).
4. Use the [SDK](/docs/sdk/overview) inside the canvas for backend capability.

For a packaged, installable version of this guidance, see the
[Agent skill](/docs/agents/skill).
