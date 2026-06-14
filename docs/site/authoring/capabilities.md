# Capabilities

A canvas is static by default. To give it backend behaviour, the owner turns on
capabilities in the canvas's **Capabilities** tab. Capabilities are off until
explicitly enabled, and a method whose capability is off throws a
`CapabilityDisabledError`.

## The switch hierarchy

A feature is only **effective** when three things are all true:

1. **Backend** is on for the canvas (the master switch).
2. The **specific feature** (KV, files, identity, AI, realtime) is on.
3. The **operator** has not globally disabled that feature for the instance.

Identity is effective whenever Backend is on.

## The five primitives

| Capability | What it gives the canvas | SDK |
|-----------|--------------------------|-----|
| Key–value | Shared and per-viewer JSON storage, atomic increment | [kv](/docs/sdk/kv) |
| Files | Upload, list, serve files | [files](/docs/sdk/files) |
| Identity | The signed-in viewer's id, email, name | [identity](/docs/sdk/identity) |
| AI | Server-side model calls, no provider key in the page | [ai](/docs/sdk/ai) |
| Realtime | Ephemeral pub/sub + presence | [realtime](/docs/sdk/realtime) |

## Why off by default

No secrets ever live in canvas files. Capabilities are server-enforced per
request from the signed-in session — the canvas can ask, but the server decides.
Turning a capability on is a deliberate choice the owner makes per canvas.
