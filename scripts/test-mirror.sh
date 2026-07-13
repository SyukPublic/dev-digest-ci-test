#!/usr/bin/env bash
#
# DevDigest test mirror — run a package's test suite from the WSL-native
# filesystem instead of the slow /mnt/* 9p bridge.
#
#   scripts/test-mirror.sh                    # mirror client/, run `pnpm test`
#   scripts/test-mirror.sh client typecheck   # run `pnpm typecheck` in the mirror
#   scripts/test-mirror.sh server test        # full server suite (unit + integration)
#   scripts/test-mirror.sh server exec vitest run --exclude '**/*.it.test.ts'  # unit lane
#   scripts/test-mirror.sh server exec vitest run .it.test                     # integration lane
#
# Why: when the repo lives on a Windows drive, every module read inside WSL2
# goes through the 9p bridge — loading jsdom's module graph alone costs ~82s
# via /mnt/e vs ~0.5s on ext4 (~175x, TD-010). Mirroring the package to $HOME
# and running vitest there removes that multiplier entirely.
#
# Package specifics are declared in the case block below: extra excludes
# (server: runtime `clones/`, build `dist/`) and companion directories that
# must sit next to the package for cross-package aliases to resolve
# (server's vitest/tsconfig alias `@devdigest/reviewer-core` -> ../reviewer-core/src).
#
# Idempotent: rsync copies only changes; node_modules lives in the mirror and
# is reused across runs. Exit code is the underlying pnpm command's exit code.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PKG="${1:-client}"
if [ "$#" -ge 2 ]; then
  shift
  CMD=("$@")
else
  CMD=(test)
fi

SHARED_SRC=0
SERVER_SRC_EXTRA=()   # extra server/src files to mirror (source only) for a standalone run
case "$PKG" in
  server)
    EXTRA_EXCLUDES=(--exclude clones --exclude dist)
    COMPANIONS=(reviewer-core)
    ;;
  agent-runner)
    # Aliases BOTH @devdigest/reviewer-core (companion → own install) AND
    # @devdigest/shared (source subtree). reviewer-core itself resolves
    # @devdigest/shared -> ../server/src/vendor/shared, so SHARED_SRC=1 covers both.
    EXTRA_EXCLUDES=(--exclude dist)
    COMPANIONS=(reviewer-core)
    SHARED_SRC=1
    ;;
  reviewer-core)
    # Aliases `@devdigest/shared` -> ../server/src/vendor/shared (source, no install).
    # PLUS its tests reach directly into server source: test/{extract-conventions,run}.test.ts
    # import ../../server/src/adapters/mocks.js, which imports ../lib/diff-parser.js. Mirror
    # that exact closure (2 files) so the suite is self-sufficient in ANY run order — previously
    # it only passed if a prior `server` run had left a full server/ mirror in the same root
    # (broke on a fresh per-worktree mirror). Both files' remaining imports are zod (reviewer-core
    # dep) and @devdigest/shared (the SHARED_SRC alias), so no further server source is needed.
    EXTRA_EXCLUDES=()
    COMPANIONS=()
    SHARED_SRC=1
    SERVER_SRC_EXTRA=(server/src/adapters/mocks.ts server/src/lib/diff-parser.ts)
    ;;
  mcp)
    # Aliases `@devdigest/shared` -> ../server/src/vendor/shared (source, no install needed).
    # Mirror just that subtree so the alias resolves when mcp is the standalone primary.
    EXTRA_EXCLUDES=()
    COMPANIONS=()
    SHARED_SRC=1
    ;;
  *)
    EXTRA_EXCLUDES=()
    COMPANIONS=()
    ;;
esac

SRC="$ROOT/$PKG"
MIRROR_ROOT="${DEVDIGEST_MIRROR:-$HOME/.devdigest-test-mirror-$(basename "$ROOT")}"
DST="$MIRROR_ROOT/$PKG"

[ -d "$SRC" ] || { echo "package dir not found: $SRC" >&2; exit 2; }
[ -f "$SRC/pnpm-lock.yaml" ] || { echo "$PKG has no pnpm-lock.yaml — mirror needs a per-package lockfile" >&2; exit 2; }

sync_dir() { # sync_dir <name> [extra rsync args...]
  local name="$1"; shift
  mkdir -p "$MIRROR_ROOT/$name"
  echo "[mirror] rsync $ROOT/$name/ -> $MIRROR_ROOT/$name/"
  rsync -a --delete \
    --exclude node_modules \
    --exclude .next \
    --exclude coverage \
    --exclude '*.tsbuildinfo' \
    "$@" \
    "$ROOT/$name/" "$MIRROR_ROOT/$name/"
}

sync_dir "$PKG" ${EXTRA_EXCLUDES[@]+"${EXTRA_EXCLUDES[@]}"}
for comp in ${COMPANIONS[@]+"${COMPANIONS[@]}"}; do
  sync_dir "$comp"
  if [ -f "$MIRROR_ROOT/$comp/pnpm-lock.yaml" ]; then
    echo "[mirror] pnpm install --frozen-lockfile ($comp)"
    (cd "$MIRROR_ROOT/$comp" && pnpm install --frozen-lockfile)
  fi
done

# Alias-source companion: place server/src/vendor/shared next to the package (source only, no
# install) so `@devdigest/shared` resolves for a standalone reviewer-core / mcp mirror run.
if [ "$SHARED_SRC" = "1" ]; then
  echo "[mirror] rsync server/src/vendor/shared -> $MIRROR_ROOT/server/src/vendor/shared (alias source)"
  mkdir -p "$MIRROR_ROOT/server/src/vendor"
  rsync -a --delete "$ROOT/server/src/vendor/shared/" "$MIRROR_ROOT/server/src/vendor/shared/"
fi

# Extra individual server/src source files a package's tests import directly (source only, no
# install). Placed at the same relative path so intra-server relative imports resolve.
for rel in ${SERVER_SRC_EXTRA[@]+"${SERVER_SRC_EXTRA[@]}"}; do
  [ -f "$ROOT/$rel" ] || { echo "SERVER_SRC_EXTRA source missing: $ROOT/$rel" >&2; exit 2; }
  echo "[mirror] cp $rel -> $MIRROR_ROOT/$rel (server source file)"
  mkdir -p "$MIRROR_ROOT/$(dirname "$rel")"
  rsync -a "$ROOT/$rel" "$MIRROR_ROOT/$rel"
done

cd "$DST"

echo "[mirror] pnpm install --frozen-lockfile ($PKG)"
pnpm install --frozen-lockfile

if [ "${CMD[0]}" = "exec" ]; then
  echo "[mirror] pnpm ${CMD[*]}"
  exec pnpm "${CMD[@]}"
fi
echo "[mirror] pnpm run ${CMD[*]}"
exec pnpm run "${CMD[@]}"
