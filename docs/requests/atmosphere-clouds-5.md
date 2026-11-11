Status: open
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
