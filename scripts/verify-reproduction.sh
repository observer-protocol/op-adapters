#!/bin/bash
# Does the tree that CLAIMS version V actually reproduce the published V?
#
# WHY THIS IS HEAD-BASED AND NOT gitHead-BASED. The obvious formulation — "check out the commit
# each published version names and confirm it rebuilds" — PASSES on the case that went wrong.
# Measured 2026-08-08: x402-op-authorize@0.4.0 rebuilds BYTE-IDENTICALLY from its gitHead in the
# archived repo. Meanwhile this monorepo's tree declared 0.4.0 while carrying four changed files,
# including a widened exported union. The gitHead-based check would have reported everything fine.
#
# The question that catches it is about the WORKING TREE: if package.json's version is already
# published, this tree must reproduce that published artifact exactly. If it is not published,
# there is nothing to compare against and we skip — which after the publish guard's registry check
# is the normal state of a tree between releases.
#
# Together the two are total: a tree either declares an unpublished version (publishable, skipped
# here) or a published one (must reproduce it). There is no third state.
set -uo pipefail
PKG_DIR="${1:?usage: verify-reproduction.sh <package-dir>}"
cd "$PKG_DIR" || exit 1
NAME="$(node -p 'require("./package.json").name')"
VER="$(node -p 'require("./package.json").version')"

# Is this version published? Key on EXIT CODE plus response shape, never on output being non-empty:
# npm prints its E404 body to STDOUT and exits 1, so an emptiness test scores MISSING as PRESENT.
OUT="$(npm view "${NAME}@${VER}" version --json 2>/dev/null)"; RC=$?
if [ $RC -ne 0 ] && printf '%s' "$OUT" | grep -q '"code": *"E404"'; then
  echo "SKIP  ${NAME}@${VER} — not published, nothing to reproduce"
  exit 0
fi
if [ $RC -ne 0 ] || ! printf '%s' "$OUT" | grep -q "\"${VER}\""; then
  echo "FAIL  ${NAME}@${VER} — could not establish whether this version is published (fail-closed)" >&2
  exit 1
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
( cd "$WORK" && npm pack "${NAME}@${VER}" >/dev/null 2>&1 ) || {
  echo "FAIL  ${NAME}@${VER} — could not fetch the published tarball (fail-closed)" >&2; exit 1; }
PUBLISHED="$(ls "$WORK"/*.tgz | head -1)"

npm ci --silent >/dev/null 2>&1 || { echo "FAIL  ${NAME}@${VER} — npm ci failed" >&2; exit 1; }
npm run build --silent >/dev/null 2>&1 || { echo "FAIL  ${NAME}@${VER} — build failed" >&2; exit 1; }
REBUILT="$(npm pack --silent 2>/dev/null | tail -1)"
[ -f "$REBUILT" ] || { echo "FAIL  ${NAME}@${VER} — npm pack produced nothing" >&2; exit 1; }

# WHAT IS COMPARED, AND WHY IT IS NOT THE WHOLE TARBALL.
#
# The first version of this check compared the tarballs byte-for-byte. Running it against all seven
# packages showed why that is the wrong subject: FIVE failed, and four of those differed only in
# README.md and package.json — because the provenance boundary notes were added to the READMEs after
# those versions were published, and package.json's repository field changed when the packages were
# rehomed into this monorepo. Under whole-tarball comparison, fixing a typo in a README would break
# CI until the next release. That is not a defect worth a red build.
#
# THE SUBJECT IS THE SHIPPED CODE. dist/ is what consumers execute, and it is what diverged in the
# case this check exists for: x402-op-authorize declared 0.4.0 while its dist/ differed in four
# files, including a widened exported union. A dist/ difference means the code we ship is not the
# code this tree builds. Everything else is reported and does not fail the build.
mkdir -p "$WORK/a" "$WORK/b"
tar xzf "$PUBLISHED" -C "$WORK/a" 2>/dev/null
tar xzf "$REBUILT"   -C "$WORK/b" 2>/dev/null
rm -f "$REBUILT"

if ! diff -rq "$WORK/a/package/dist" "$WORK/b/package/dist" >/dev/null 2>&1; then
  echo "FAIL  ${NAME}@${VER} — SHIPPED CODE DIFFERS FROM WHAT THIS TREE BUILDS" >&2
  echo "      dist/ is what consumers execute. This tree claims ${VER} and does not produce its" >&2
  echo "      published dist/. Either bump the version (npm version prerelease --preid rc) or" >&2
  echo "      restore the tree." >&2
  diff -rq "$WORK/a/package/dist" "$WORK/b/package/dist" 2>&1 \
    | sed "s|$WORK/a/package/dist|published:|g; s|$WORK/b/package/dist|rebuilt:|g" | sed 's/^/      /' >&2
  exit 1
fi

# Non-dist differences are reported, never fatal. Read them: a changed dependency range in
# package.json is a real signal even though it does not fail this check, whereas an edited README is
# expected between releases.
OTHER="$(diff -rq "$WORK/a/package" "$WORK/b/package" 2>/dev/null | grep -v "/dist" || true)"
if [ -n "$OTHER" ]; then
  echo "OK    ${NAME}@${VER} — shipped dist/ reproduces exactly; non-code files differ (expected between releases):"
  printf '%s\n' "$OTHER" | sed "s|$WORK/a/package/||g; s|$WORK/b/package/||g" | sed 's/^/        /'
else
  echo "OK    ${NAME}@${VER} — reproduces the published tarball byte-for-byte"
fi
exit 0
