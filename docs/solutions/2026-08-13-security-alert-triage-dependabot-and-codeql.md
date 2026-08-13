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
| `js/biased-cryptographic-random` in `pick()` | **False today, latent trap.** `byte % len` is unbiased only when `len` divides 256, and both wordlists happen to be 32. Nothing enforced that. Rejection sampling + a distribution test makes it stop being luck. |
| `js/insufficient-password-hash` ×2 | **False positive.** Name-based heuristic firing on `passwordVersion` (an HMAC over non-secret inputs, keyed by `sessionSecret`) and on `hashToken` (SHA-256 of 256-bit `randomBytes` API keys — argon2 there would put a KDF on every authenticated request). Dismiss. |

The pattern: a scanner finding is rarely simply "wrong". Four of the five
non-dismissed ones were unexploitable where they sat, and were still worth fixing
because each one rested on an unstated precondition (an escape downstream, a
wordlist length) that nothing in the code enforced.

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
