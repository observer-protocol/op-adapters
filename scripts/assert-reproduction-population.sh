#!/bin/bash
# HOW MANY PACKAGES WERE ACTUALLY MEASURED? Asserted here, because the matrix cannot answer it.
#
# The reproduction matrix reports whether each job PASSED. It has never reported how many packages
# were CHECKED, and those are different facts: a skip passes. Measured 2026-08-09, five of seven
# jobs were green and two of those were skips, so "7 jobs, 0 failures" described a run that had
# compared five packages against the registry and two against nothing.
#
# This asserts three things, each able to fail on its own:
#
#   1. EVERY package directory produced a result. A job that was omitted from the matrix, or that
#      died before it could record anything, is counted as "no result" rather than passed. The
#      expected population is read from packages/ rather than from the matrix, so a package added
#      to the repo and forgotten in the workflow fails here instead of being silently uncovered.
#   2. The measured count is at or above the floor declared in scripts/reproduction-floor.txt.
#   3. The floor file itself is present and parseable. Fail closed: an unreadable floor is not
#      permission to skip the check, and a missing file must not read as a floor of zero.
#
# Usage: assert-reproduction-population.sh <results-dir>
#   <results-dir> holds one file per package, each containing "<state> <name>@<version>",
#   where <state> is measured | skipped | inconclusive.
set -uo pipefail

DIR="${1:?usage: assert-reproduction-population.sh <results-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FLOOR_FILE="${ROOT}/scripts/reproduction-floor.txt"

# ─── 3. THE FLOOR MUST BE READABLE ───────────────────────────────────────────────────────────────
if [ ! -f "${FLOOR_FILE}" ]; then
  echo "REFUSING: ${FLOOR_FILE} is missing. A floor that cannot be read is not a floor of zero." >&2
  exit 1
fi
FLOOR="$(grep -vE '^\s*#|^\s*$' "${FLOOR_FILE}" | head -1 | tr -d '[:space:]')"
if ! printf '%s' "${FLOOR}" | grep -qE '^[0-9]+$'; then
  echo "REFUSING: ${FLOOR_FILE} does not contain a bare integer (read: '${FLOOR}')." >&2
  exit 1
fi

# ─── 1. EVERY PACKAGE MUST HAVE REPORTED ─────────────────────────────────────────────────────────
EXPECTED=()
for d in "${ROOT}"/packages/*/; do
  [ -f "${d}package.json" ] || continue
  EXPECTED+=("$(basename "${d%/}")")
done
if [ "${#EXPECTED[@]}" -eq 0 ]; then
  echo "REFUSING: no package directories found under ${ROOT}/packages. An empty population passes" >&2
  echo "          every check trivially, which is the failure this line exists to prevent." >&2
  exit 1
fi

MEASURED=0; SKIPPED=0; INCONCLUSIVE=0; MISSING=0
echo "REPRODUCTION POPULATION"
echo
for pkg in "${EXPECTED[@]}"; do
  # The result file may arrive at <dir>/<pkg>/result.txt or <dir>/repro-result-<pkg>/result.txt
  # depending on how artifacts were laid down. Find it rather than assuming one shape.
  f="$(find "${DIR}" -type f -path "*${pkg}*" -name '*.txt' 2>/dev/null | head -1)"
  if [ -z "${f}" ] || [ ! -s "${f}" ]; then
    printf '  %-26s NO RESULT\n' "${pkg}"
    MISSING=$((MISSING + 1)); continue
  fi
  line="$(head -1 "${f}")"
  state="${line%% *}"
  case "${state}" in
    measured)     MEASURED=$((MEASURED + 1)) ;;
    skipped)      SKIPPED=$((SKIPPED + 1)) ;;
    inconclusive) INCONCLUSIVE=$((INCONCLUSIVE + 1)) ;;
    *)            printf '  %-26s UNRECOGNISED STATE: %s\n' "${pkg}" "${line}"; MISSING=$((MISSING + 1)); continue ;;
  esac
  printf '  %-26s %s\n' "${pkg}" "${line}"
done

echo
echo "  packages in repo : ${#EXPECTED[@]}"
echo "  measured         : ${MEASURED}   (floor ${FLOOR})"
echo "  skipped          : ${SKIPPED}"
echo "  inconclusive     : ${INCONCLUSIVE}"
echo "  no result        : ${MISSING}"
echo

FAILED=0

if [ "${MISSING}" -gt 0 ]; then
  cat >&2 <<MISSING_EOF
  FAIL: ${MISSING} package(s) in packages/ produced no reproduction result.

  Either the matrix in .github/workflows/reproduction.yml does not list them, or their job died
  before recording an outcome. Both mean this run does not know their state, and not knowing is
  not a pass.

MISSING_EOF
  FAILED=1
fi

if [ "${MEASURED}" -lt "${FLOOR}" ]; then
  cat >&2 <<FLOOR_EOF
  FAIL: only ${MEASURED} package(s) were actually measured against the registry; the floor is ${FLOOR}.

  A skip is green. That is why this check exists: coverage can fall without any job going red, and
  it did — a version bump moved a package to an unpublished number and took the reproduction check
  with it, silently.

  If the drop is intended, lower the number in scripts/reproduction-floor.txt and record there which
  package left and why. Accepting less coverage is a decision someone makes, not a side effect.

FLOOR_EOF
  FAILED=1
fi

if [ "${FAILED}" -ne 0 ]; then exit 1; fi

echo "  OK: ${MEASURED} package(s) measured, at or above the declared floor of ${FLOOR}."
exit 0
