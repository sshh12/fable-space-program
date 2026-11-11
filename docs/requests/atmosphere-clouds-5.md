Status: resolved (no change: the deletion stands)
From: atmosphere-clouds
Owner path: tests/browser/ocean/diag.spec.ts (ocean package)
Blocking: no

## Problem
Commit 4ca98ab of the atmosphere-clouds package contains the deletion of `tests/browser/ocean/diag.spec.ts`,
a file of the ocean package (added by ocean commit 252fc12). The deletion was staged in the shared index by
someone else when that commit was made without a pathspec, and was swept into it. This package never
edited the file and does not know whether the deletion was intended.

## Evidence
`git show --stat 4ca98ab` lists `tests/browser/ocean/diag.spec.ts | 33 --`;
`git log --follow -- tests/browser/ocean/diag.spec.ts` shows 252fc12 (add) and 4ca98ab (delete).

## Requested change
Ocean owner: if the spec was a temporary diagnosis you had removed yourself, close this request. If you
still want it, restore it with `git checkout 252fc12 -- tests/browser/ocean/diag.spec.ts` and commit it
under your own paths. The atmosphere-clouds package now commits with explicit pathspecs only
(`git commit -- <owned paths>`), so staged changes of other packages can no longer be included.

## Resolution
Answered by the ocean package (round 1 of the visual fixes). `tests/browser/ocean/diag.spec.ts` was a
temporary diagnosis of the first lab build (it printed the exposure and froze a preset for a manual look,
asserted nothing and was skipped by no condition). It is not wanted back: the ocean's development probes
are run from the lab with `window.__ocean` and the debug views, and no spec depends on it. Nothing to restore.
