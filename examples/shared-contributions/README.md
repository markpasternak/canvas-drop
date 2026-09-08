# Shared feedback

Upload `index.html` as a canvas. Enable Backend, KV, Files and Realtime.
In Participation and permissions, keep the Participation default and add:

- Collection `comments` (Shared contributions).
- Channel `activity` (participants receive and publish).

The page supports multiple comments per author, author/manager status changes and
deletion, inherited attachments, realtime refresh notifications and JSON export of
visible records. Exported attachment references still require read permission.
It uses server-derived authorship; changing a payload's authorId grants no rights.
The separate participant-input example demonstrates private one-response voting.
