# Example: a live poll canvas

Goal: ship a single static HTML file that records votes in the shared KV store and shows
a running total, with no keys and no build step.

Two steps to live:

1. Deploy the file below as a canvas (folder/ZIP/paste/deploy API — see the deploy docs).
2. Enable backend access for the canvas. Backend is off by default; turning it on enables
   the `kv` capability (and the other primitives), so this poll can read and write the store.

The browser SDK is served at `/sdk/v1.js` and auto-detects the canvas slug from the URL.
The single global it exposes is `canvasdrop` (no `cd` alias). No keys, no config: requests
carry the signed-in session cookie. If a primitive is off, the call throws a typed error
you can catch (see the `CAPABILITY_DISABLED` handler below).

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
      const out = document.getElementById("out");

      async function refresh() {
        // kv.get<T>(key) resolves to the stored value, or null if unset.
        const tacos = (await canvasdrop.kv.get("tacos")) ?? 0;
        const ramen = (await canvasdrop.kv.get("ramen")) ?? 0;
        out.textContent = `Tacos: ${tacos}\nRamen: ${ramen}`;
      }

      for (const btn of document.querySelectorAll("button")) {
        btn.addEventListener("click", async () => {
          try {
            // kv.increment(key, by = 1) is atomic and resolves to the new total.
            await canvasdrop.kv.increment(btn.dataset.opt);
            await refresh();
          } catch (err) {
            // CapabilityDisabledError.code === "CAPABILITY_DISABLED" (HTTP 403)
            if (err.code === "CAPABILITY_DISABLED") {
              out.textContent = "Enable backend access (kv) for this canvas.";
            } else {
              throw err;
            }
          }
        });
      }

      refresh();
    </script>
  </body>
</html>
```

Notes:
- `kv.increment(key, by?)` is atomic and returns the new number — concurrent votes are safe.
- Votes here use the shared scope (`canvasdrop.kv`), so every viewer sees the same totals.
  For per-viewer state, use `canvasdrop.kv.user.*` (same five methods — `get`, `set`,
  `delete`, `list`, `increment` — scoped to the caller server-side).
- No keys in the page; identity and storage ride the signed-in session cookie
  (requests go to `/v1/c/{slug}/kv/...` with `credentials: "include"`).
