# Shared feedback

Upload `index.html` as a canvas. Enable Backend, KV, Files and Realtime.
In Participation and permissions, keep the Participation default and add:

- Collection `comments` (Shared contributions).
- Channel `activity` (participants receive and publish).

`comments` is a named group of records inside the KV primitive. Its Shared
contributions preset controls access to those records; another collection could
use the same preset and hold different data, or choose different permissions.
`activity` is a channel inside Realtime and carries ephemeral refresh signals.
Attachments use Files but inherit the parent comment's permissions, so this
example does not need a standalone file group. The names in settings match those
used in `index.html`; configuration does not generate the commenting interface.
See [Data storage](../../docs/site/sdk/kv.md) for the model and collection API.

The page supports multiple comments per author, author/manager status changes and
deletion, inherited attachments, realtime refresh notifications and JSON export of
visible records. Exported attachment references still require read permission.
It uses server-derived authorship; changing a payload's authorId grants no rights.
The separate participant-input example demonstrates private one-response voting.
