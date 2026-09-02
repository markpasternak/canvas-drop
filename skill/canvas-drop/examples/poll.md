# Example: a poll canvas

Ship one static HTML file that counts votes in the canvas's shared KV store, lets each
signed-in viewer vote once, and shows running totals. No keys in the page, no build step.
An optional five-line addition at the end pushes new totals to every open tab over realtime.

## Ship it

1. **Enable KV.** Backend is off by default. Over MCP, one `set_capabilities` call turns on
   the master switch and the feature (omitted fields are unchanged; owner or editor):

   ```json
   { "id": "<canvas id>", "backendEnabled": true, "kv": true }
   ```

   In the dashboard this is the canvas's **Backend** tab: turn on **Backend**, then **KV**.
   Until both are on, every `canvasdrop.kv.*` call throws with `.code` `CAPABILITY_DISABLED`
   (HTTP 403); the page below shows a message instead of totals.

2. **Deploy the file** as `index.html` at the root of a ZIP, with the canvas's deploy key:

   ```bash
   zip poll.zip index.html
   curl -X PUT "{base}/v1/canvases/{id}/deploy" \
     -H "Authorization: Bearer $CANVAS_KEY" \
     --data-binary @poll.zip
   ```

   The deploy is live immediately. `create_canvas` over MCP returns the canvas `id`, the key,
   and the exact endpoint; `deploy_canvas` works when you cannot run shell commands
   (see `SKILL.md`).

3. **Share it at a signed-in rung** (Specific people, Team, or Whole org). At the Public
   link rung the runtime API is closed to everyone but the owner and editors: each KV call
   fails with `403 STATIC_ONLY`, so a public-link poll cannot record votes.

## `index.html`

`<script src="/sdk/v1.js">` is root-relative on purpose: the server serves the bundle on the
canvas host in both path mode and subdomain mode, and the SDK reads the slug and API origin
from `location`. The only global it defines is `canvasdrop`; there is no `cd` alias. Every
request rides the signed-in session cookie.

```html
<!doctype html>
<html>
  <body>
    <h1>Lunch poll</h1>
    <button data-opt="tacos">Tacos</button>
    <button data-opt="ramen">Ramen</button>
    <pre id="out"></pre>

    <script src="/sdk/v1.js"></script>
    <script>
      const PREFIX = "vote:";
      const out = document.getElementById("out");
      const buttons = [...document.querySelectorAll("button[data-opt]")];
      const lock = () => buttons.forEach((b) => (b.disabled = true));

      async function refresh() {
        // list(opts?) -> { entries: [{ key, value }], nextCursor }. One request reads
        // every counter; the page holds 100 entries by default (limit up to 1000).
        const { entries } = await canvasdrop.kv.list({ prefix: PREFIX });
        const totals = Object.fromEntries(
          entries.map((e) => [e.key.slice(PREFIX.length), e.value]),
        );
        out.textContent = buttons
          .map((b) => `${b.textContent}: ${totals[b.dataset.opt] ?? 0}`)
          .join("\n");
      }

      async function vote(opt) {
        lock();
        // increment(key, by = 1) is a single atomic upsert server-side and resolves
        // to the new total, so concurrent clicks from different viewers never lose votes.
        await canvasdrop.kv.increment(PREFIX + opt);
        // kv.user.* is the same API scoped to the signed-in viewer (server-resolved).
        await canvasdrop.kv.user.set("vote", opt);
        await refresh();
      }

      async function init() {
        // get(key) resolves to null when the key is absent: this viewer has not voted.
        if (await canvasdrop.kv.user.get("vote")) lock();
        await refresh();
      }

      function fail(err) {
        // err.code is a stable string and err.status the HTTP status. The typed error
        // classes are not browser globals, so branch on err.code, not instanceof.
        if (err.code === "CAPABILITY_DISABLED") {
          // err.message is the server's hint (or names the capability that is off).
          out.textContent = `Backend is off for this canvas. ${err.message}`;
        } else {
          out.textContent = `${err.code}: ${err.message}`;
        }
      }

      for (const b of buttons) b.addEventListener("click", () => vote(b.dataset.opt).catch(fail));
      init().catch(fail);
    </script>
  </body>
</html>
```

## SDK calls used

| Call | Signature | Role in this page |
|---|---|---|
| `canvasdrop.kv.increment(key, by?)` | `(key: string, by = 1) => Promise<number>` | Count a vote; atomic; resolves to the new total. A missing key starts at 0. |
| `canvasdrop.kv.list(opts?)` | `({ prefix?, cursor?, limit? }) => Promise<{ entries: Array<{ key, value }>, nextCursor: string \| null }>` | Read every `vote:*` counter in one request. |
| `canvasdrop.kv.user.get(key)` | `(key: string) => Promise<T \| null>` | Has this viewer voted? `null` means no. |
| `canvasdrop.kv.user.set(key, value)` | `(key: string, value: unknown) => Promise<void>` | Remember the viewer's choice. |

`canvasdrop.kv` (shared, every viewer sees the same keys) and `canvasdrop.kv.user` (one
namespace per signed-in viewer) expose the same five methods: `get`, `set`, `delete`,
`list`, `increment`. Both go to `{base}/v1/c/{slug}/kv/...` and `.../kv/user/...` with
`credentials: "include"`; the user scope is derived from the session on the server, never
sent by the page.

## Errors this page can hit

| `err.code` | status | when |
|---|---|---|
| `CAPABILITY_DISABLED` | 403 | Backend or KV is off. `err.name` is `CapabilityDisabledError`. |
| `STATIC_ONLY` | 403 | The canvas is at the Public link rung and the viewer is not an owner or editor. |
| `NOT_NUMERIC` | 409 | A `vote:*` key holds a non-number (something called `set` on it). `delete` the key. |
| `RATE_LIMITED` | 429 | More than 120 runtime-API requests per minute from one viewer on one canvas (instance default). |

## Limits that matter here

- One vote per viewer is enforced in the page, not by the server: any signed-in viewer can
  call `kv.increment` directly. Fine for a lunch poll inside a trusted org; not a ballot box.
- Do not poll `refresh()` on a timer. The runtime API allows 120 requests per minute per
  viewer per canvas by default. For live totals, use realtime (below).
- Keys are at most 512 bytes and values at most 64 KiB; the shared scope holds up to
  10,000 keys per canvas and each user scope up to 1,000.

## Make the totals live (optional)

Enable `realtime` too (`set_capabilities` with `"realtime": true`; the instance must run with
`CANVAS_DROP_REALTIME=on`). Then add a channel and re-read totals whenever anyone votes:

```js
const ch = canvasdrop.realtime.channel("poll");
// subscribe(handler) receives { event, data, from: { id, name } } for every publish
// on the channel, the sender's own included. Returns void; call ch.unsubscribe() to stop.
ch.subscribe(() => refresh().catch(fail));

// In vote(), after the increment. publish(event, data) is fire-and-forget (returns void);
// the server attaches the sender identity, the page never sends `from`.
ch.publish("vote", { opt });
```

The SDK opens one WebSocket per page on the first `subscribe` or `publish` and reconnects
with backoff. If realtime is off for the canvas, the server closes the socket with code
4403 and a later `ch.publish` throws with `.code` `CAPABILITY_DISABLED`, which the same
`fail` handler reports. KV still records the vote either way.
