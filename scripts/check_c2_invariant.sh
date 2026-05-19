#!/usr/bin/env bash
#
# check_c2_invariant.sh — V16 Phase 1b.fix8 (C2 — stateless finalize).
#
# Enforces the structural invariant introduced in fix-attempt 8:
# inside the workQueue.sync closure in finalize(), there must be ZERO
# `self.*` references.  All state the closure needs is plumbed through
# the `FinalizePayload` value struct (see top of
# IncrementalStitcher.swift).
#
# Why a script and not a Swift compiler check?  Swift's compiler does
# not have a "forbid self capture in this specific closure" pragma.
# An explicit capture list `[payload, completion]` is good but a
# careless future edit can still write `self.someIvar` and the
# compiler will obligingly add it to the implicit capture list,
# re-introducing the `objc_retain`-on-torn-pointer race class that
# fix-attempts 1-7 chased.
#
# This script grep-enforces the structural invariant against drift.
# Run as part of CI; also runnable locally:
#
#     bash retailens-capture-sdk/scripts/check_c2_invariant.sh
#
# Exit 0 = invariant holds.  Exit 1 = `self.*` reintroduced; fail CI.

set -euo pipefail

# Resolve the Swift file path relative to this script — works from
# any CWD.
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SWIFT_FILE="$SCRIPT_DIR/../ios/Sources/RNImageStitcher/IncrementalStitcher.swift"

if [[ ! -f "$SWIFT_FILE" ]]; then
    echo "FATAL: source file not found: $SWIFT_FILE" >&2
    exit 2
fi

# Extract the lines strictly between the C2-INVARIANT-START and
# C2-INVARIANT-END markers, strip trailing `// ...` comments, then
# look for `self.` as a token (preceded by start-of-line or any
# non-identifier character so we don't false-positive on substrings
# like `myself.something`).
VIOLATIONS=$(awk '
    /MARK: C2-INVARIANT-START/ { inside = 1; next }
    /MARK: C2-INVARIANT-END/   { inside = 0; next }
    inside {
        # Strip "// comment" from end of line so we only inspect code.
        # Note: this is a textual heuristic.  A self.* token inside a
        # string literal would still match — none exist today and
        # adding one would be just as bad as a code-level reference.
        code = $0
        sub(/\/\/.*$/, "", code)
        if (match(code, /(^|[^a-zA-Z0-9_])self\./)) {
            printf "%s:%d: %s\n", FILENAME, NR, $0
        }
    }
' "$SWIFT_FILE")

if [[ -n "$VIOLATIONS" ]]; then
    cat >&2 <<EOF
❌ C2 invariant violated — \`self.\` reference(s) inside finalize closure:

$VIOLATIONS

All state used in the workQueue.sync closure must be plumbed through
FinalizePayload (see top of IncrementalStitcher.swift).
Re-introducing self.* in this closure has caused EXC_BAD_ACCESS
\`objc_retain\` crashes in 7 prior fix attempts; this invariant is
the architectural escalation per design-doc
docs/site-content/design/2026-05-12-finalize-crash-investigation.md.

EOF
    exit 1
fi

# Bracket markers present?  If they were accidentally removed, the
# invariant is silently bypassed.  Fail fast.
if ! grep -q "MARK: C2-INVARIANT-START" "$SWIFT_FILE"; then
    echo "FATAL: 'MARK: C2-INVARIANT-START' marker missing from $SWIFT_FILE" >&2
    echo "Did someone delete the invariant brackets?" >&2
    exit 1
fi
if ! grep -q "MARK: C2-INVARIANT-END" "$SWIFT_FILE"; then
    echo "FATAL: 'MARK: C2-INVARIANT-END' marker missing from $SWIFT_FILE" >&2
    echo "Did someone delete the invariant brackets?" >&2
    exit 1
fi

echo "✓ C2 invariant holds — 0 \`self.\` references inside finalize closure"
