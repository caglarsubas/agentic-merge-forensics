#!/bin/sh
# Container startup: make git and gh usable before handing over to the app.
set -e

# The mirror clones under /data are written by this user, but a volume reused
# across a uid change would otherwise trip git's ownership check mid-run.
git config --global --add safe.directory '*'

# gh reads GH_TOKEN or GITHUB_TOKEN for its own API calls, but `git clone` of a
# private repo needs a credential helper too. Wiring gh in as that helper keeps
# the token out of any file on disk.
if [ -n "${GH_TOKEN:-}" ] || [ -n "${GITHUB_TOKEN:-}" ]; then
  gh auth setup-git 2>/dev/null || echo "warn: gh auth setup-git failed; private repos may not clone" >&2
else
  echo "note: no GH_TOKEN/GITHUB_TOKEN set — public repos only, and PR titles/authors/reviews will be missing" >&2
fi

exec "$@"
