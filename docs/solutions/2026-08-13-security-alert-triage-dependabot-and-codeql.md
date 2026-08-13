---
title: Clearing the Security tab — reproducing Dependabot + CodeQL alerts locally, and what to do with false positives
type: workflow
area: ops
date: 2026-08-13
---

Round that took the repo from 24 open Dependabot alerts + 7 CodeQL code-scanning
alerts to 0 Dependabot and 2 (both dismissible false positives). The mechanics are
worth keeping, because the obvious approach — read the alerts from the API — does
not work from an agent session.

## You usually cannot read the alerts from the API

`GET /repos/{o}/{r}/dependabot/alerts` and `.../code-scanning/alerts` both return
`403 Resource not accessible by integration` for a GitHub App installation token
that only carries `metadata=read`. They need `security_events: read`
(`vulnerability_alerts: read` for Dependabot). GraphQL `vulnerabilityAlerts` is
blocked separately in agent sessions. So: **do not plan on reading the Security
tab; reproduce it.** Both scanners are deterministic and runnable locally.

### Dependabot ≡ `pnpm audit`

Dependabot's npm alerts are the GitHub Advisory Database applied to the lockfile —
exactly what `pnpm audit --json` reports, one advisory per alert. It works
**without `node_modules`** (lockfile only), so it is fast:

```
pnpm audit --json > audit.json   # exit 1 when anything is found
```

### Code scanning ≡ the CodeQL CLI with the same suites

Check which analyses actually run before guessing — the check-runs on `main` name
them (`Analyze (javascript-typescript)`, `Analyze (actions)` here, which means
CodeQL **default setup** is on, with no workflow file to read):

```
curl -H "Authorization: Bearer $GH_TOKEN" \
  .../repos/{o}/{r}/commits/main/check-runs
```

Then run the same thing locally. Two traps:

- The bundle ships as `.tar.zst` **and** `.tar.gz`. This container has no `zstd`,
  so take the `.tar.gz`.
- `--format` takes a suite **path**, not the bare name printed in docs.
  `javascript-typescript-code-scanning.qls` is not resolvable; the real path is
  `qlpacks/codeql/javascript-queries/<ver>/codeql-suites/javascript-code-scanning.qls`.

```
curl -sSL -o codeql.tar.gz \
  https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.24.2/codeql-bundle-linux64.tar.gz
tar -xzf codeql.tar.gz
./codeql/codeql database create db --language=javascript-typescript --source-root=.
./codeql/codeql database analyze db \
  ./codeql/qlpacks/codeql/javascript-queries/2.3.2/codeql-suites/javascript-code-scanning.qls \
  --format=sarif-latest --output=out.sarif
```

Database build dominates the runtime (several minutes on this repo). When you only
want to re-check one finding, analyze a **single `.ql` file** instead of the suite.

## CodeQL ignores in-source suppression comments

Tested both `// lgtm[js/rule-id]` and `// codeql[js/rule-id]`, on the line above
and on the same line: the result still appears in the SARIF. There is no
in-repo way to silence a specific alert under default setup. The options are:

1. Change the code so the query no longer matches (right answer when the finding
   is real, or when the pattern is a genuine latent trap — see `pick()` below).
2. **Dismiss the alert in the Security tab** with a reason. This is the correct
   move for a true false positive, and it needs a human click or a token with
   `security_events: write`.
3. Switch default setup → advanced setup and filter the query out. Rejected here:
   it disables the rule repo-wide, so a future *real* SHA-256-on-a-password would
   go unreported.

Leaving a `// codeql[...]` marker that does nothing is worse than no marker — it
reads as handled. Write the rationale in the doc comment instead and dismiss.

## Calibrating the findings (per the auth-invariant checklist)

Weigh each finding against the trust model rather than the CWE title. Of the 7:

| Finding | Verdict |
| --- | --- |
| `js/double-escaping` in `build-docs` `stripTags` | **Real.** Unescaping `&amp;` *before* `&lt;` turns the literal text `&amp;lt;b&amp;gt;` into a real `<b>`. Unescape `&amp;` **last**. |
| `js/polynomial-redos` in `normalizeSlug` | **Real enough.** `^-+|-+$` backtracks quadratically and it runs on live keystrokes. The preceding collapse means at most one hyphen can sit at each end, so `^-|-$` is equivalent and linear. |
| `js/incomplete-multi-character-sanitization` ×2 | **Real as written, not exploitable in place.** One pass of `<[^>]+>` on `<<b>script>` strips the inner tag and the leftovers re-form `<script>`. Both call sites escape downstream, so nothing leaked — but a sanitizer that can be walked backwards is not worth keeping. Loop to a fixpoint. |
| `js/biased-cryptographic-random` in `pick()` | **False today, latent trap.** `byte % len` is unbiased only when `len` divides 256, and both wordlists happen to be 32. Nothing enforced that. Use `crypto.randomInt(len)` — it rejection-samples internally and is uniform for any bound. |
| `js/insufficient-password-hash` ×2 | **False positive.** Name-based heuristic firing on `passwordVersion` (an HMAC over non-secret inputs, keyed by `sessionSecret`) and on `hashToken` (SHA-256 of 256-bit `randomBytes` API keys — argon2 there would put a KDF on every authenticated request). Dismiss. |

The pattern: a scanner finding is rarely simply "wrong". Four of the five
non-dismissed ones were unexploitable where they sat, and were still worth fixing
because each one rested on an unstated precondition (an escape downstream, a
wordlist length) that nothing in the code enforced.

**But verify the mechanism before you write the comment.** Two of these were
first "fixed" against a story that turned out to be false — a code review caught
both:

- `<[^>]*>` under a global replace **is** idempotent (a `<` survives a pass only
  when no `>` follows it, and deleting earlier text cannot put one there;
  confirmed over 300k random inputs). The re-forming-`<script>` failure the first
  draft described in a doc comment cannot happen with this regex — that belongs
  to the `.replace("<script>", "")` class. The fixpoint loop stays because it
  makes the function robust to the regex being edited and because it clears the
  scanner, but the comment now says so instead of inventing a bug.
- The `^-+|-+$` ReDoS was likewise unreachable, because the preceding
  `[^a-z0-9]+ → "-"` collapse means the trim never sees a hyphen run longer than
  one.

Both "regression" tests written for them passed verbatim against the pre-fix code
— the tell that the story was wrong. **If a regression test passes on the old
code, the diagnosis is wrong, not the test.** Run new tests against the parent
commit before believing them.

And hand-rolled crypto helpers deserve the same suspicion as the code they
replace: the first `pick()` rewrite introduced a **worse** bug than the one it
fixed — `Math.floor(256/len)*len` is `0` for any list longer than 256, making
`while (byte >= limit)` an infinite loop on every canvas creation. `randomInt`
was the right answer all along.

## A lockfile bump does not reach a committed bundle

**The one that nearly shipped.** `docs/site/assets/mermaid.js` is a 3.3 MB esbuild
bundle, committed to the repo and served at `/docs/mermaid.js` with
`immutable, max-age=1y`. Bumping mermaid and overriding dompurify made `pnpm audit`
clean and would have closed GHSA-55q2-fjhq-7xh7 — while the bundle kept inlining
DOMPurify **3.4.11**, squarely inside the vulnerable range, to every docs visitor.
Nothing regenerated or drift-checked it.

The general trap: **Dependabot reads manifests, not build outputs.** Any committed
artifact — a bundled JS file, a vendored library, a lockfile-derived SBOM — can
carry a vulnerable copy of a dependency the advisory now considers fixed. Closing
the alert is then actively misleading: the tab goes green and the vulnerable code
keeps being served.

When fixing a dependency advisory, grep the tree for committed build output of
that dependency before believing the audit:

```
grep -ro 'version="3\.[0-9.]*"' docs/site/assets/mermaid.js
```

CI now rebuilds the bundle and fails on drift, mirroring the existing
`generated-content.ts` check. Same esbuild + same lockfile is byte-reproducible
(verified across three runs), so drift means a dep moved without a rebuild.

## Fixing transitive advisories

Direct dependencies get their floor raised in `package.json`. Everything else
lands in `pnpm-workspace.yaml` `overrides` keyed by the vulnerable **range**, so
the pin lapses on its own once the upstream tree catches up:

```yaml
overrides:
  "postcss@<8.5.23": "^8.5.23"
  "undici@<7.29.0": "^7.29.0"
```

Raising a floor in `package.json` is what forces re-resolution — `pnpm install`
will happily keep a locked version that still satisfies an unchanged range. That
also bit the `mermaid` bump: 11.16.1 asks for `dompurify@^3.3.3` and pnpm kept the
locked-but-vulnerable 3.4.12, which needed its own override.
