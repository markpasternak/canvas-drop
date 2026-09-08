# Example: a poll with private responses

Enable Backend and Key-value storage (`set_capabilities` with `backendEnabled`
and `kv` true), then deploy this static file as `index.html`. Share with named
signed-in people/teams or Whole org. Public-link viewers are static-only.

Each viewer owns one current response and can update or withdraw it. Owners and
editors can review responses and explicitly publish validated totals. Other
viewers read only those published totals. Use a new collection name for each
round. This is not a secret ballot: canvas owners and editors can read responses.

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lunch poll</title>
<h1>Lunch poll</h1>
<p>Your answer is visible to you and the owner and editors.</p>
<button type="button" data-choice="ramen" disabled>Ramen</button>
<button type="button" data-choice="tacos" disabled>Tacos</button>
<button type="button" id="withdraw" disabled>Withdraw vote</button>
<button type="button" id="publish" hidden>Publish totals</button>
<button type="button" id="refresh" disabled>Refresh results</button>
<p id="status" role="status"></p><pre id="results"></pre>
<script src="/sdk/v1.js"></script>
<script type="module">
  const collection = "lunch-round-1";
  const resultKey = `${collection}-results`;
  const cd = canvasdrop;
  const status = document.getElementById("status");
  const result = document.getElementById("results");
  async function run(action) {
    try { await action(); }
    catch (err) { status.textContent = err.message; }
  }
  async function refresh() {
    const totals = await cd.kv.get(resultKey);
    result.textContent = totals ? JSON.stringify(totals, null, 2) : "No published totals yet.";
  }
  for (const button of document.querySelectorAll("[data-choice]")) {
    button.onclick = () => run(async () => {
      await cd.submissions.set(collection, { choice: button.dataset.choice });
      status.textContent = "Your vote is saved. Editors publish results separately.";
    });
  }
  document.getElementById("withdraw").onclick = () => run(async () => {
    await cd.submissions.delete(collection);
    status.textContent = "Vote withdrawn.";
  });
  document.getElementById("refresh").onclick = () => run(refresh);
  document.getElementById("publish").onclick = () => run(async () => {
    const totals = { ramen: 0, tacos: 0 };
    let cursor;
    do {
      const page = await cd.submissions.list(collection, { cursor });
      for (const { value } of page.entries) {
        if (value?.choice === "ramen" || value?.choice === "tacos") totals[value.choice]++;
      }
      cursor = page.nextCursor || undefined;
    } while (cursor);
    await cd.kv.set(resultKey, totals);
    await refresh();
  });
  await run(async () => {
    const me = await cd.me();
    if (!me.permissions.canSubmit) throw new Error("Enable Key-value storage first.");
    const mine = await cd.submissions.get(collection);
    status.textContent = mine ? `Your saved choice: ${mine.value.choice}` : "Choose your lunch.";
    await refresh();
    for (const button of document.querySelectorAll("button")) button.disabled = false;
    document.getElementById("publish").hidden = !me.permissions.canManageSubmissions;
  });
</script>
</html>
```

Responses may change while an editor pages through them. Published totals are an
explicit snapshot, not a transaction or a live tally. If desired, editors may
broadcast a `results` channel event after publishing; viewers subscribe and reread
shared totals. Do not broadcast individual responses on `participants:` channels.
For form text use `submissions.set("feedback-round-1", { text })`; private
attachments use `files.upload(file, { scope: "submission" })`. See
`{base}/docs/sdk/submissions` for review, removal, quotas and error handling.
