# Quickstart

Deploy your first canvas in a few minutes.

## 1. Create a canvas

From the dashboard, click **New**. You can:

- **Drag a folder or ZIP** containing an `index.html`.
- **Paste HTML** for a quick single-page canvas.
- **Start from the editor** and write files in the browser.

Each canvas gets a slug and a URL. In path mode that's `{base}/c/{slug}/`; in
subdomain mode it's `{slug}.{base}`.

## 2. Add some content

A canvas is static files. The simplest possible canvas is one `index.html`:

```html
<!doctype html>
<html>
  <body>
    <h1>Hello from my canvas</h1>
  </body>
</html>
```

No build step runs on the server — what you deploy is what's served.

## 3. Give it a backend (optional)

Add the SDK and you get storage, identity, and more with no keys in the page:

```html
<script src="/sdk/v1.js"></script>
<script>
  const me = await canvasdrop.me();
  await canvasdrop.kv.increment("views");
</script>
```

The owner enables **Backend** (and the specific feature) in the canvas's
**Capabilities** tab first. See the [SDK overview](/docs/sdk/overview).

## 4. Publish & share

Publish a version and share the canvas URL. Who can open it follows your
organization's sign-in — canvases are private to your org by default.

## Deploying as an agent

Agents deploy over HTTP with a per-canvas API key — no dashboard session needed.
See the [Deploy API](/docs/api/deploy-api) and [`/llms.txt`](/llms.txt).
