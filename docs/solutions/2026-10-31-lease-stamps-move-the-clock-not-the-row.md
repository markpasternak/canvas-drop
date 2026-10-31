---
title: Lease-fence tests — move the clock, don't backdate the row
type: bug
area: data
date: 2026-10-31
---

# Lease-fence tests — move the clock, don't backdate the row

Builds on [[2026-09-12-publication-token-and-release-identity]].

## What happened

`upload/service.test.ts` › "fenced unconsume" failed about one run in four, and only
when the whole file ran. Attempt A was meant to lose its activation and leave the
handle alone, but its `unconsume` reopened the handle that the newer attempt B had
just consumed.

## Root cause

The finalize lease is a `finalizing_at` millisecond stamp, and `unconsume` is fenced
on `finalizing_at = <the stamp this attempt claimed>`. To fake "A outlived its lease",
the test rewrote the row's `finalizing_at` 61 s into the past, then had B re-claim at
once. B's stamp was `Date.now()`. When B ran in the same millisecond as A's claim,
both stamps were equal, so A's fence matched B's lease.

Production is not affected. A re-claim only succeeds once the stored stamp is at or
before `now - FINALIZE_LEASE_MS`, so each new stamp is at least a lease newer than
the last. Clock skew between instances changes when a re-claim happens, not whether
the stamps differ. The test broke that ordering by changing the stored value instead
of letting time pass.

## Fix

- `claimForFinalize(handleHash, staleBefore, stamp)` now takes the stamp from its
  caller. The service passes one `now()` reading for both arguments, so the lease
  cutoff and the stamp come from the same injectable clock.
- The coordination tests inject `now`. The fence test advances that clock by
  `FINALIZE_LEASE_MS + 1000` instead of rewriting the row. The repository test uses
  explicit `t0` / `t0 + 61_000` stamps instead of a 5 ms sleep.
- Check: with the fence condition removed from `unconsume`, both tests fail.

## Rule

When a test simulates elapsed time for a time-stamped fence, advance the clock the
code reads. Don't edit the stored timestamp. Editing the row skips the ordering
guarantee that makes the fence sound, so the test can fail even though the real code
is correct.
