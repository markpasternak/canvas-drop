# Example: a live poll canvas

A complete single-file canvas that records votes in the shared KV store and shows a
running total. Deploy it, then enable the `kv` capability for the canvas. The browser
SDK is served at `/sdk/v1.js` and auto-detects the canvas slug — no keys, no config.

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
              out.textContent = "Enable the kv capability for this canvas.";
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
  For per-viewer state, use `canvasdrop.kv.user.*` (same five methods, scoped to the caller).
- No keys in the page; identity and storage ride the signed-in session cookie
  (requests go to `/v1/c/<slug>/kv/...` with `credentials: "include"`).
