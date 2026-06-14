# Example: a live poll canvas

A complete single-file canvas that stores votes with KV and shows a running total.
Deploy it, then enable **Backend → Key–value** in the canvas's Capabilities tab.

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
        const tacos = (await canvasdrop.kv.get("tacos")) ?? 0;
        const ramen = (await canvasdrop.kv.get("ramen")) ?? 0;
        out.textContent = `Tacos: ${tacos}\nRamen: ${ramen}`;
      }

      for (const btn of document.querySelectorAll("button")) {
        btn.addEventListener("click", async () => {
          try {
            await canvasdrop.kv.increment(btn.dataset.opt);
            await refresh();
          } catch (err) {
            if (err.code === "CAPABILITY_DISABLED") {
              out.textContent = "Enable Backend → Key–value in the Capabilities tab.";
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
- `increment` is atomic — concurrent votes are safe.
- No keys in the page; identity and storage ride the signed-in session.
