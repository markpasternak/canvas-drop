# Authoring audience: a fourth audience switch, with a different default

**Context.** The SeenThis roadmap canvas wanted only its owners and editors to publish
shares from the page. Authoring was on/off for every admitted member; AI and Connections
had audiences, authoring did not.

**What we did.** Added `authoringAudience` beside the other two audiences, checked in the
authoring routes after `requireCapability("authoring")` and reflected in
`me().permissions.canCreateCanvas`, so canvas code can hide a control it would be refused.

**The one non-obvious choice.** The default is `viewers`, not `editors` like its siblings.
`aiAudience`/`connectionsAudience` shipped with an upgrade guide because they changed what
viewers could do; authoring has been open to every member since it shipped, and a column
default of `editors` would have silently broken publishing for those canvases on upgrade.
Restricting is the opt-in.

**Gotchas.** Every full `Canvas` fixture in the canvas tests is a complete literal, so a new
NOT NULL column has to be added to each (`authoringAudience: "viewers"`), or `typecheck`
fails before any test runs. The dashboard select falls back per key: `editors` for the two
older audiences, `viewers` for authoring, so a legacy payload without the field renders
the historical behaviour rather than a false "owners and editors".
