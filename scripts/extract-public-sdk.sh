#!/usr/bin/env bash
# SPDX-License-Identifier: UNLICENSED
#
# extract-public-sdk.sh — extract retailens-capture-sdk/ into a
# separate public repo `react-native-image-stitcher` via git subtree
# split.  See:
#   docs/site-content/design/2026-05-15-react-native-image-stitcher-publication.md
#
# Prerequisites
# ─────────────
#
#   1. The target repo MUST exist on GitHub (otherwise the push fails).
#      Create it manually first (or via gh repo create):
#        gh repo create bhargav-kanda/react-native-image-stitcher \
#            --public \
#            --description "Cross-platform RN camera + panorama stitcher"
#
#   2. Working directory must be the RetaiLens monorepo ROOT, on a
#      clean branch (preferably main).  Uncommitted changes will be
#      rejected — commit or stash first.
#
#   3. `git subtree` ships with git.  No extra install needed.
#
# What this script does
# ─────────────────────
#
#   1. Verifies clean working tree.
#   2. Creates a local branch `rn-image-stitcher-extract` containing
#      ONLY the retailens-capture-sdk/ history, rewritten so the
#      top-level of that branch == retailens-capture-sdk/'s
#      current contents.
#   3. Pushes that branch to the public repo as `main`.
#   4. Leaves your monorepo untouched (the extract branch can be
#      deleted afterwards — the public repo now owns the history).
#
# After running
# ─────────────
#
#   - Rename retailens-capture-sdk/ → retailens-private-sdk/ in the
#     monorepo.
#   - Prune retailens-private-sdk/ to ONLY the private bits
#     (measurements, ML detection, audit-specific glue).
#   - Update retailens-mobile/package.json:
#       "react-native-image-stitcher": "0.1.0",     # from npm once published
#       "retailens-private-sdk": "file:../retailens-private-sdk",
#     (Remove the old @retailens/capture-sdk entry.)
#   - Sweep imports — RetaiLens* prefixes get stripped from the
#     public lib's exports.  See the design doc's "Implementation
#     Plan" §3 for the find/replace mappings.

set -euo pipefail

TARGET_REPO_URL="${TARGET_REPO_URL:-git@github.com:bhargav-kanda/react-native-image-stitcher.git}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
EXTRACT_BRANCH="rn-image-stitcher-extract"
SDK_DIR="retailens-capture-sdk"

# ── Pre-flight ──────────────────────────────────────────────────────

if [[ ! -d "$SDK_DIR" ]]; then
    echo "ERROR: $SDK_DIR/ not found.  Run this from the monorepo root."
    exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: working tree is dirty.  Commit or stash changes before extracting."
    git status --short
    exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Extracting $SDK_DIR/ from current branch '$CURRENT_BRANCH'"
echo "Target repo:    $TARGET_REPO_URL"
echo "Target branch:  $TARGET_BRANCH"
echo "Extract branch: $EXTRACT_BRANCH (local, temporary)"
echo ""
read -p "Continue? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

# ── Subtree split ───────────────────────────────────────────────────

# Delete the extract branch if it exists from a prior failed run, so
# the split below recreates it cleanly.
git branch -D "$EXTRACT_BRANCH" 2>/dev/null || true

# Create the extract branch.  `git subtree split` rewrites the history
# of the given prefix so the top-level of the resulting branch is
# what was inside that prefix.  All other paths are dropped.
echo "Running git subtree split (this may take 30-90 s on the RetaiLens repo)..."
git subtree split --prefix="$SDK_DIR" --branch="$EXTRACT_BRANCH"
echo "Subtree split complete.  Branch '$EXTRACT_BRANCH' contains $SDK_DIR/ history."

# ── Add target remote (idempotent) ──────────────────────────────────

if ! git remote get-url public-sdk 2>/dev/null; then
    git remote add public-sdk "$TARGET_REPO_URL"
    echo "Added remote 'public-sdk' → $TARGET_REPO_URL"
else
    git remote set-url public-sdk "$TARGET_REPO_URL"
    echo "Updated remote 'public-sdk' → $TARGET_REPO_URL"
fi

# ── Push ────────────────────────────────────────────────────────────

echo "Pushing $EXTRACT_BRANCH → public-sdk/$TARGET_BRANCH ..."
git push public-sdk "$EXTRACT_BRANCH:$TARGET_BRANCH"

echo ""
echo "✓ Extraction complete."
echo ""
echo "Next steps (manual):"
echo "  1. Clone the public repo:"
echo "       git clone $TARGET_REPO_URL"
echo "  2. In the public repo, rename:"
echo "       package.json:  @retailens/capture-sdk → react-native-image-stitcher"
echo "       license:       UNLICENSED → MIT (+ add LICENSE file)"
echo "       README.md:     write a public-facing README"
echo "       ios/...:       rename modules from RetaiLens* → public-facing names"
echo "       android/...:   rename package com.retailens.capturesdk → io.imagestitcher.rn"
echo "  3. Tag v0.1.0 to trigger the OpenCV-build + npm-publish CI workflow."
echo "  4. Back in the monorepo, rename $SDK_DIR/ → retailens-private-sdk/ and"
echo "     prune to private bits per the publication design doc §Implementation Plan §8."
