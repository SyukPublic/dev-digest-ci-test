#!/usr/bin/env bash
#
# DevDigest worktree bootstrap — reproduce git-ignored machine-local files and
# install per-package node_modules for a freshly-created git worktree.
#
# RUN THIS INSIDE WSL. It assumes you already ran `git worktree add` on Windows
# (git-on-Windows rule) and that the worktree lives on E:\ == /mnt/e.
#
#   wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
#     '<worktree>/scripts/worktree-init.sh <path-to-source-(main)-worktree>'
#
# It copies from the SOURCE worktree: the per-package pnpm-workspace.yaml
# (allowBuilds), server/.env, client/.env, CLAUDE.local.md — then installs the
# packages that run in WSL (linux binaries). It DOES NOT install `evals`: that
# runs on Windows (win32 binaries) and must be installed from the Windows shell
# (the command is printed at the end). It never invokes git.
#
# Rationale + trap analysis: docs/plans/git-worktree-support.md.
# User manual:              docs/manuals/git-worktree-usage.md.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the new worktree
SRC="${1:?usage: worktree-init.sh <path-to-source-worktree> (e.g. /mnt/e/.../dev-digest)}"

[ -d "$SRC" ]         || { echo "source worktree not found: $SRC" >&2; exit 2; }
[ "$SRC" != "$ROOT" ] || { echo "source and worktree are the same dir" >&2; exit 2; }

# --- 1. reproduce git-ignored machine-local files ---
# One pnpm-workspace.yaml per package (allowBuilds map, pnpm 11), plus the two
# .env files and the machine-local Claude instructions. Keep this list in sync
# with the package set (see docs/plans/git-worktree-support.md T1/T4).
FILES=(
  server/pnpm-workspace.yaml
  client/pnpm-workspace.yaml
  reviewer-core/pnpm-workspace.yaml
  mcp/pnpm-workspace.yaml
  e2e/pnpm-workspace.yaml
  evals/pnpm-workspace.yaml
  agent-runner/pnpm-workspace.yaml
  server/.env
  client/.env
  CLAUDE.local.md
)
for f in "${FILES[@]}"; do
  if [ -f "$SRC/$f" ]; then
    mkdir -p "$ROOT/$(dirname "$f")"
    cp "$SRC/$f" "$ROOT/$f"
    echo "[copy] $f"
  else
    echo "[skip] $SRC/$f absent"
  fi
done
# NOTE: .mcp.json is intentionally NOT copied — most worktrees reuse the main
# MCP server. If this worktree needs its own, copy it and REWRITE the hardcoded
# `cd <path>/mcp` to this worktree's mcp/.

# --- 2. WSL-side installs (linux binaries) ---
# Every package here runs in WSL on this machine. `evals` is deliberately absent
# (win32 — installed from Windows). `e2e` has no committed lockfile, so it falls
# back to a plain install.
for p in server client reviewer-core mcp e2e agent-runner; do
  echo "[wsl-install] $p"
  if [ -f "$ROOT/$p/pnpm-lock.yaml" ]; then
    ( cd "$ROOT/$p" && pnpm install --frozen-lockfile )
  else
    ( cd "$ROOT/$p" && pnpm install )   # e2e has no committed lockfile
  fi
done

echo
echo "=== WSL side complete. Remaining MANUAL steps: ==="
echo "1) On WINDOWS, install evals (win32 binaries):"
echo "     cd '$ROOT/evals'   # (Windows path form)"
echo "     pnpm install --frozen-lockfile"
echo "2) Tests use a per-worktree mirror automatically (see test-mirror.sh)."
echo "3) For CONCURRENT runtime only: edit API_PORT/WEB_PORT in server/.env,"
echo "   NEXT_PUBLIC_API_BASE/WEB_PORT in client/.env, and isolate the DB."
