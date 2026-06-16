# Example canvases

Two minimal canvases that show what a canvas *is* and what the SDK does. Each is
a plain folder of static files — no build step.

| Example | What it shows |
|---------|---------------|
| [`hello-static/`](./hello-static/) | The simplest possible canvas: a single `index.html`. Drop the folder in, get a URL out. |
| [`kv-counter/`](./kv-counter/) | A backend in one `<script>` tag — an atomic shared counter via the KV primitive (`canvasdrop.kv.*`), no secrets in the browser. |
| [`showcase/`](./showcase/) | The full primitives showcase (identity · KV · files · AI · realtime). |

## Deploy one

Any of the deploy paths work — pick whichever fits:

- **Drag the folder** onto the create flow in the dashboard.
- **Paste HTML** (for `hello-static`, the single file is enough).
- **Deploy API** — zip the folder and `PUT` it with the canvas's key:

  ```bash
  cd examples/kv-counter && zip -r ../kv-counter.zip . && cd ..
  curl -X PUT "$BASE_URL/v1/canvases/$CANVAS_ID/deploy" \
    -H "Authorization: Bearer $CANVAS_KEY" \
    --data-binary @kv-counter.zip
  ```

For `kv-counter`, enable the **KV** capability on the canvas (Settings → backend)
so `canvasdrop.kv.*` is live. `hello-static` needs no backend.
