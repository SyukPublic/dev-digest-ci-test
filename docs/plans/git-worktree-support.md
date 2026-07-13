# Git Worktree Support for DevDigest — Analysis & Implementation Plan

> **Status:** proposal (no changes applied yet).
> **Scope:** machine-local dual-platform dev setup (Windows + WSL2). Assumptions
> below match `CLAUDE.local.md` on the author's machine — a different machine
> (different WSL distro, MCP launch variant, or repo drive) must re-verify §0.
> **Audience:** Part 1 = humans; Part 2 = a follow-up Claude Code session that
> will implement this. Part 2 is written to be executed verbatim.

---

## Part 1 — Human-readable analysis

### 1.1 Why worktrees are non-trivial in this repo

DevDigest is **deliberately NOT a monorepo**: each package (`server/`, `client/`,
`reviewer-core/`, `mcp/`, `e2e/`, `evals/`) owns its own `package.json`,
`pnpm-lock.yaml`, `node_modules`, and per-package `pnpm-workspace.yaml`. There is
**no root `package.json`** and the root `node_modules` is empty. Cross-package
wiring is done via **relative** tsconfig path aliases (e.g. server →
`../reviewer-core/src`), which resolve correctly inside any full checkout.

`git worktree add` gives you a second working tree that shares the same object
store but has its **own working directory and its own index**. Two consequences
drive every trap below:

1. A worktree checkout contains only **tracked** files. Every machine-local,
   git-ignored file that the build/runtime depends on is **absent** in a fresh
   worktree and must be reproduced.
2. `node_modules` is git-ignored, so it is **never** copied into a worktree — and
   in this repo that interacts with a Windows/WSL **platform split** (see T4),
   which is the single most important thing to get right.

### 1.2 The traps (with evidence)

#### T1 — git-ignored per-package `pnpm-workspace.yaml` (build approval) — **BLOCKER**

`.gitignore` ignores `pnpm-workspace.yaml` ("auto-generated and
pnpm-version-dependent"). But there is one per package, and each holds the
pnpm 11 `allowBuilds` map (pnpm 11 replaced `onlyBuiltDependencies` with
`allowBuilds: {name: true}` — see `server/INSIGHTS.md`). A fresh worktree gets
none of them, so pnpm silently skips native build scripts. `esbuild` tolerates
this (it runs via a platform optional-dep), but the others do not — and the
client's lint deps-status pre-check hard-fails with `ERR_PNPM_IGNORED_BUILDS`
(see `client/INSIGHTS.md`).

Current, verified maps:

| Package         | `allowBuilds` entries                         |
| --------------- | --------------------------------------------- |
| `server`        | `cpu-features`, `esbuild`, `protobufjs`, `ssh2` |
| `client`        | `esbuild`, `sharp`, `unrs-resolver`            |
| `reviewer-core` | `esbuild`                                      |
| `mcp`           | `esbuild`                                      |
| `e2e`           | `esbuild`                                      |
| `evals`         | `esbuild`                                      |

#### T2 — git-ignored `.env` files — **BLOCKER for runtime**

`.gitignore` ignores `.env`. Two exist and carry non-optional config:

- `server/.env` — keys: `DATABASE_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `OPENROUTER_API_KEY`, `GITHUB_TOKEN`, `EMBEDDINGS_ENABLED`,
  `REPO_INTEL_ENABLED`, `API_PORT`, `WEB_PORT`, `NODE_ENV`, `LOG_LEVEL`,
  `DEVDIGEST_CLONE_DIR`.
- `client/.env` — keys: `NEXT_PUBLIC_API_BASE`, `WEB_PORT`.

Verified: **no absolute or worktree-specific paths** inside either file, so a
whole-file copy is safe. `*.env.example` files are tracked and are NOT a
substitute (no real values). Note the port/`DATABASE_URL` collision caveat under
T6 if two stacks run at once.

#### T3 — git-ignored `.mcp.json` and `CLAUDE.local.md`

Both are git-ignored (machine-local).

- `.mcp.json` (this machine) launches the MCP server via
  `wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -c 'cd <ABS>/mcp && exec ./node_modules/.bin/tsx src/index.ts'`.
  The `cd` path is **hardcoded to the main worktree**. Copying it into a worktree
  is **optional** — most worktree use reuses the main MCP server — and if copied,
  the `cd` path **must be rewritten** to the worktree's `mcp/`. `.mcp.json.example`
  (tracked) is the portable Windows-`npx` variant.
- `CLAUDE.local.md` — the machine-local Claude instructions (git-on-Windows,
  test-mirror rules). Helpful to copy so a Claude session inside the worktree
  inherits the same rules. Contains no worktree-specific paths.

#### T4 — `node_modules` is not shared, and installs are **platform-split** — **most important**

`node_modules` is per-package and git-ignored, so a worktree starts with zero. It
must be reinstalled per package — **and the install platform must match where that
package actually runs**, because several packages ship **platform-specific native
binaries** and, on this machine, the repo drive `E:\` is the **same filesystem**
as WSL's `/mnt/e` (one `node_modules` visible from both sides — the "shared
node_modules platform trap": native binaries match only the **last** installer's
platform).

Verified runtime platform per package (this machine):

| Package         | Runs on (this machine)                         | `pnpm install` from |
| --------------- | ---------------------------------------------- | ------------------- |
| `server`        | WSL (`test-mirror.sh`, `dev.sh`)               | **WSL**             |
| `client`        | WSL (`test-mirror.sh`)                         | **WSL**             |
| `reviewer-core` | WSL (not mirrored)                             | **WSL**             |
| `e2e`           | WSL (agent-browser / Chrome via apt)           | **WSL**             |
| `mcp`           | WSL (local `.mcp.json` → `wsl.exe … tsx`)      | **WSL**             |
| `evals`         | **Windows** (Claude Code subscription CLI)     | **Windows**         |

Why the split is real and not cosmetic:
- `evals` runs from the **Windows** shell (the Claude Agent SDK spawns the Windows
  `claude` login — `CLAUDE.local.md` → "Harness evals"). Its `tsx`/`vitest` need
  `@esbuild/win32-x64`. Installing `evals` from WSL yields `@esbuild/linux-x64`
  and Windows `vitest` cannot find its esbuild binary.
- `client`/`server` native deps (`sharp`, `unrs-resolver`, `ssh2`, `cpu-features`)
  must be the **linux** builds, because tests/dev run in WSL.

Because each package has its **own separate** `node_modules`, holding different
platforms side-by-side is fine — the trap only bites if the **same** package is
installed from the wrong side (or alternately from both, overwriting).

Consequence: the bootstrap is **two-platform** — not "everything in WSL".

#### T5 — `test-mirror.sh` uses a fixed mirror path → cross-worktree collision

`scripts/test-mirror.sh:49`:
`MIRROR_ROOT="${DEVDIGEST_MIRROR:-$HOME/.devdigest-test-mirror}"`. Two worktrees
running suites would `rsync --delete` over the same mirror, clobbering each
other. The `DEVDIGEST_MIRROR` override already exists; the fix is to make the
**default** unique per worktree. (`test-mirror.sh` is WSL-only.)

#### T6 — shared runtime: single Postgres + fixed ports

`docker-compose.yml` defines a single container `devdigest-postgres`, port
`5432`, volume `devdigest_pgdata`. `scripts/dev.sh` starts API on `:3001` and web
on `:3000`. Running **two** worktree stacks **simultaneously** collides on ports
and shares one database. Sequential use is fine. Secrets in
`~/.devdigest/secrets.json` live outside the repo and are correctly shared.

For concurrent runtime a worktree needs: different `API_PORT`/`WEB_PORT`
(`server/.env`), matching `NEXT_PUBLIC_API_BASE`/`WEB_PORT` (`client/.env`), and
an isolated DB (separate container/port or a separate database name in
`DATABASE_URL`). This is **out of scope** for the default bootstrap (single-active
worktree); documented here so a concurrent setup is a known, deliberate step.

#### T7 — `skip-worktree` (informational)

`TESTING.md:83` documents a practice of marking `server/package.json` as
`skip-worktree`. It is **currently inactive** (`git ls-files -v server/package.json`
→ `H`, tree clean). If ever applied: the bit lives in the **index**, and each
worktree has its own index, so a new worktree gets the committed version with no
local divergence. Not a blocker today; noted so it is not a surprise later.

#### T8 — `e2e` has no committed lockfile

Verified: `server`, `client`, `reviewer-core`, `mcp`, `evals` each have
`pnpm-lock.yaml`; **`e2e` does not**. The bootstrap must install `e2e` with a
plain `pnpm install` (no `--frozen-lockfile`).

#### T9 — harness-created worktrees (Agent `isolation: "worktree"` / EnterWorktree)

The Claude Code harness can auto-create worktrees for isolated subagents. Those
inherit **exactly the same gaps** (T1–T4, T8): no git-ignored config, no
`node_modules`. A subagent that must build/test/run in such a worktree needs the
same bootstrap first — otherwise `pnpm install`/tests fail. Prefer isolated
worktrees only for agents that touch tracked source and do **not** need a live
toolchain, or run the bootstrap inside them.

### 1.3 Where to put the worktree

`E:\…` and `/mnt/e/…` are the **same** filesystem. Options:

- **On `E:\` (recommended):** git/`gh` from Windows work exactly as today
  (`CLAUDE.local.md` git-on-Windows rule honored); heavy suites still go through
  `test-mirror.sh` into WSL-native ext4. This is the assumed layout below.
- Inside WSL ext4 (`~/…`): fast tests, but Windows git/`gh` cannot reach it
  conveniently, breaking the established git workflow. Not recommended.

Each worktree also needs its **own branch** (git forbids checking out the same
branch in two worktrees).

### 1.4 Solution overview

1. Add `scripts/worktree-init.sh` — a **WSL-side** bootstrap that copies the
   git-ignored machine-local files (T1, T2, and `CLAUDE.local.md`) from a source
   (main) worktree and installs the **WSL** packages (`server`, `client`,
   `reviewer-core`, `mcp`, `e2e`). It **prints** (does not run) the Windows-side
   `evals` install, because that must run on Windows (T4). It never calls `git`.
2. One-line change to `scripts/test-mirror.sh` so the default mirror path is
   per-worktree (T5).
3. Document the two-phase flow in `CLAUDE.local.md` (machine-local per the
   personal-vs-project filing rule).

`git worktree add` stays a manual **Windows** step (git-on-Windows rule). `evals`
install stays a manual **Windows** step (T4).

---

## Part 2 — Execution plan for a follow-up Claude session

> Implement exactly what follows. Do **not** invent scope. Every command notes
> its platform. Nothing here runs `git` inside WSL.

### §0 — Preconditions to re-verify before editing

Run these and confirm they still hold (facts as of this doc's authoring):

```bash
# Windows (Bash tool):
git worktree list                      # confirm current worktree(s)
git --version                          # git runs on Windows
# WSL:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc 'pnpm --version; node --version; which rsync'
```

Confirm: repo on `E:\ == /mnt/e`; WSL distro `Ubuntu-24.04-dev-digest-test`;
`server/.env` + `client/.env` exist; each package's `pnpm-workspace.yaml` still
matches the T1 table; `evals` runs on Windows and `mcp` via `wsl.exe` in
`.mcp.json`. If any differs, STOP and re-plan — the platform assignments in T4
are machine-specific.

### §1 — NEW FILE: `scripts/worktree-init.sh`

Create with this exact content (mode `+x`):

```bash
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
# It copies from the SOURCE worktree: the 6 per-package pnpm-workspace.yaml
# (allowBuilds), server/.env, client/.env, CLAUDE.local.md — then installs the
# packages that run in WSL (linux binaries). It DOES NOT install `evals`: that
# runs on Windows (win32 binaries) and must be installed from the Windows shell
# (the command is printed at the end). It never invokes git.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the new worktree
SRC="${1:?usage: worktree-init.sh <path-to-source-worktree> (e.g. /mnt/e/.../dev-digest)}"

[ -d "$SRC" ]      || { echo "source worktree not found: $SRC" >&2; exit 2; }
[ "$SRC" != "$ROOT" ] || { echo "source and worktree are the same dir" >&2; exit 2; }

# --- 1. reproduce git-ignored machine-local files ---
FILES=(
  server/pnpm-workspace.yaml
  client/pnpm-workspace.yaml
  reviewer-core/pnpm-workspace.yaml
  mcp/pnpm-workspace.yaml
  e2e/pnpm-workspace.yaml
  evals/pnpm-workspace.yaml
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
for p in server client reviewer-core mcp e2e; do
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
```

### §2 — EDIT: `scripts/test-mirror.sh` (per-worktree default mirror, T5)

Change line 49 only:

```diff
-MIRROR_ROOT="${DEVDIGEST_MIRROR:-$HOME/.devdigest-test-mirror}"
+MIRROR_ROOT="${DEVDIGEST_MIRROR:-$HOME/.devdigest-test-mirror-$(basename "$ROOT")}"
```

Effect: main worktree mirror becomes `~/.devdigest-test-mirror-dev-digest`;
each worktree gets `~/.devdigest-test-mirror-<worktree-dirname>`. One-time
re-sync for the main worktree (idempotent, cheap). `DEVDIGEST_MIRROR` still
overrides. Update the `CLAUDE.local.md` line that references
`~/.devdigest-test-mirror/` to match (see §3).

### §3 — EDIT: `CLAUDE.local.md` (document the flow; machine-local)

Read the file first, then **append** a new section (do not rewrite). Suggested:

```markdown
## Git worktrees (this machine)
- Full analysis + rationale: docs/plans/git-worktree-support.md.
- Create + bootstrap a worktree (two platforms):
  1. WINDOWS (git-on-Windows): `git worktree add ../dev-digest-<name> -b <branch>`
  2. WSL: `wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
       '/mnt/e/.../dev-digest-<name>/scripts/worktree-init.sh /mnt/e/.../dev-digest'`
  3. WINDOWS: `cd <worktree>/evals && pnpm install --frozen-lockfile`
- Git-ignored files a worktree needs (reproduced by worktree-init.sh): the 6
  per-package pnpm-workspace.yaml (allowBuilds), server/.env, client/.env,
  CLAUDE.local.md. `.mcp.json` only if the worktree needs its own MCP server
  (rewrite its hardcoded `cd .../mcp` path).
- Per-worktree test mirror is automatic: test-mirror.sh now defaults
  DEVDIGEST_MIRROR to ~/.devdigest-test-mirror-<worktree-dirname>.
- Concurrent stacks (two worktrees running dev at once) need distinct
  API_PORT/WEB_PORT and an isolated Postgres/DB — not handled by the bootstrap.
```

Also update the existing "rsyncs to `~/.devdigest-test-mirror/`" mention to note
the new per-worktree suffix.

### §4 — End-to-end usage (what the flow looks like once implemented)

```bash
# 1. WINDOWS (Bash tool / PowerShell) — git only:
git worktree add ../dev-digest-featureX -b labs/featureX

# 2. WSL — config copy + linux installs:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  '/mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest-featureX/scripts/worktree-init.sh \
   /mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest'

# 3. WINDOWS — evals (win32):
cd /e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest-featureX/evals && pnpm install --frozen-lockfile

# 4. Work; run suites via the (now per-worktree) mirror, e.g.:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-featureX && bash scripts/test-mirror.sh server exec vitest run --exclude "**/*.it.test.ts"'
```

### §5 — Verification (must all pass)

```bash
# WSL — installs resolved with correct (linux) binaries:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-featureX && for p in server client reviewer-core mcp e2e; do \
     test -d "$p/node_modules" && echo "$p ok" || echo "$p MISSING"; done'
# WSL — client lint no longer dies on ERR_PNPM_IGNORED_BUILDS (proves T1 fixed):
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-featureX && bash scripts/test-mirror.sh client typecheck'
# WSL — a server unit lane runs green through the per-worktree mirror (proves T5):
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-featureX && bash scripts/test-mirror.sh server exec vitest run --exclude "**/*.it.test.ts"'
# Windows — evals harness runs (proves T4 win32 install):
cd /e/.../dev-digest-featureX/evals && pnpm eval:quality
```

Also confirm `.env` presence and that the main worktree still works unchanged.

### §6 — Evals gate & commit note

- `scripts/worktree-init.sh` and the `scripts/test-mirror.sh` edit are plain
  scripts — **no** harness eval gate applies (they are not `.claude/skills/*`,
  `.claude/agents/*`, `CLAUDE.md`, or `AGENTS.md`).
- `CLAUDE.local.md` is git-ignored/local and doc-only — no gate; it is not
  committed.
- **If** you additionally decide to document worktrees in the tracked `AGENTS.md`,
  that edit **does** trigger the gate: run `pnpm eval:workflow` GREEN before
  committing (AGENTS.md → "Evals gate").
- Commit only when the user asks; keep "commit and push" to exactly stage/commit/
  push (CLAUDE.local git discipline).

### §7 — Rollback

- `rm scripts/worktree-init.sh`; revert the one line in `scripts/test-mirror.sh`;
  remove the appended `CLAUDE.local.md` section.
- Remove a worktree (WINDOWS): `git worktree remove ../dev-digest-featureX`
  then `git worktree prune`. Delete its mirror:
  `wsl.exe … -- bash -lc 'rm -rf ~/.devdigest-test-mirror-dev-digest-featureX'`.

---

## Appendix — Evidence index

| Claim | Source |
| ----- | ------ |
| Not a monorepo; per-package lockfiles; relative aliases | `AGENTS.md`, `scripts/sync-shared.mjs` header |
| `pnpm-workspace.yaml` git-ignored | `.gitignore` ("auto-generated…") |
| `allowBuilds` maps | each `<pkg>/pnpm-workspace.yaml` (verified) |
| pnpm 11 `allowBuilds` replaces `onlyBuiltDependencies` | `server/INSIGHTS.md` |
| client lint hard-fails on ignored builds | `client/INSIGHTS.md` |
| esbuild via platform optional-dep | `evals/INSIGHTS.md` |
| `.env` git-ignored; keys; no abs paths | `.gitignore`, `server/.env`, `client/.env` (verified) |
| `.mcp.json` launches mcp via `wsl.exe … tsx`; `.example` = Windows npx | `.mcp.json`, `.mcp.json.example` |
| evals run on Windows | `CLAUDE.local.md` → "Harness evals" |
| test-mirror fixed default; `DEVDIGEST_MIRROR` override; WSL-only | `scripts/test-mirror.sh:49`, `CLAUDE.local.md` |
| single Postgres, port 5432, volume | `docker-compose.yml` |
| dev ports 3001/3000 | `scripts/dev.sh:104,109` |
| skip-worktree practice, currently inactive | `TESTING.md:83`, `git ls-files -v` (verified `H`) |
| e2e has no lockfile | package listing (verified) |
| E:\ == /mnt/e single FS; platform trap | `CLAUDE.local.md`, auto-memory `mcp-shared-node-modules-platform` |
| WSL git exists but convention forbids its use | `CLAUDE.local.md` git-on-Windows; `wsl … git --version` = 2.43.0 |
