# Running DevDigest from a Git Worktree

> **Scope:** this manual is for the human operator on the dual-platform
> Windows + WSL2 dev machine (assumptions match `CLAUDE.local.md`). It covers how
> to create a second working tree with `git worktree`, bootstrap the git-ignored
> machine-local files and `node_modules` it needs, and run the app + test suites
> inside it. The full trap analysis and rationale live in
> [../plans/git-worktree-support.md](../plans/git-worktree-support.md) — you do
> not need to read it to use this manual.
>
> **Short version (fast path):**
> ```
> # 1. WINDOWS (git-on-Windows)
> git worktree add ../dev-digest-<name> -b <branch>
> # 2. WSL (config copy + linux installs)
> wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
>   '/mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest-<name>/scripts/worktree-init.sh \
>    /mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest'
> # 3. WINDOWS (evals only — win32 binaries)
> cd ../dev-digest-<name>/evals && pnpm install --frozen-lockfile
> ```

---

## Table of contents

1. [Why a worktree needs a bootstrap here](#1-why-a-worktree-needs-a-bootstrap-here)
2. [Prerequisites](#2-prerequisites)
3. [Where to put the worktree](#3-where-to-put-the-worktree)
4. [Fast path — `worktree-init.sh`](#4-fast-path--worktree-initsh)
5. [Manual path — what the script does, by hand](#5-manual-path--what-the-script-does-by-hand)
6. [Running the app and the test suites](#6-running-the-app-and-the-test-suites)
7. [Running two worktrees at once (concurrent stacks)](#7-running-two-worktrees-at-once-concurrent-stacks)
8. [MCP server inside a worktree](#8-mcp-server-inside-a-worktree)
9. [Verification checklist](#9-verification-checklist)
10. [Removing a worktree (cleanup)](#10-removing-a-worktree-cleanup)

---

## 1. Why a worktree needs a bootstrap here

`git worktree add` gives you a second working directory that shares the same
object store but has its **own index and its own checkout**. A fresh worktree
contains only **tracked** files — so two whole classes of things are missing and
must be reproduced before anything builds or runs:

- **Git-ignored machine-local files.** In this repo that includes each package's
  `pnpm-workspace.yaml` (the pnpm 11 `allowBuilds` map — without it native build
  scripts are silently skipped and the client lint pre-check hard-fails with
  `ERR_PNPM_IGNORED_BUILDS`), plus `server/.env`, `client/.env`, and
  `CLAUDE.local.md`.
- **`node_modules`** (git-ignored, never copied) — and this is the subtle part:
  installs are **platform-split**. On this machine `E:\` and `/mnt/e` are the
  **same filesystem**, and packages ship platform-specific native binaries. The
  packages that run in WSL (`server`, `client`, `reviewer-core`, `mcp`, `e2e`,
  `agent-runner`) must be installed **from WSL** (linux binaries); `evals` runs
  from the **Windows** shell (the Claude Code subscription CLI) and must be
  installed **from Windows** (win32 binaries). Installing the wrong side yields
  the wrong esbuild/sharp/etc. binary.

That is why the bootstrap is **two-platform**, not "everything in WSL".

## 2. Prerequisites

- **Git and `gh` on Windows.** All `git` runs on the Windows side (Git Bash /
  the Bash tool), never inside `wsl.exe` — the git-on-Windows rule from
  `CLAUDE.local.md`.
- **WSL distro `Ubuntu-24.04-dev-digest-test`** with `pnpm`, `node`, and `rsync`
  available (`wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc 'pnpm -v; node -v; which rsync'`).
- **A source (main) worktree that is fully set up** — its git-ignored files
  (`.env`, `pnpm-workspace.yaml`, `CLAUDE.local.md`) are what the bootstrap
  copies from. By default that is the main checkout at
  `/mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest`.
- **A free branch.** Git forbids checking out the same branch in two worktrees,
  so each worktree needs its own.

## 3. Where to put the worktree

Put it on `E:\` (i.e. `/mnt/e/...`), as a sibling of the main checkout —
**recommended**. Windows `git`/`gh` then work exactly as today, and heavy suites
still go through `test-mirror.sh` into WSL-native ext4.

Putting the worktree inside WSL ext4 (`~/...`) gives faster raw file access but
Windows `git`/`gh` cannot reach it conveniently, breaking the established git
workflow. **Not recommended.**

## 4. Fast path — `worktree-init.sh`

Three steps, on the platform noted for each. Replace `<name>` and `<branch>`.

**Step 1 — WINDOWS (git only):**
```bash
git worktree add ../dev-digest-<name> -b <branch>
```

**Step 2 — WSL (copy git-ignored config + install the WSL packages):**
```bash
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  '/mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest-<name>/scripts/worktree-init.sh \
   /mnt/e/Sources/NeoVersity/Projects/AIAgenticEngineering/dev-digest'
```
The single argument is the **source** worktree to copy the machine-local files
from (normally the main checkout). The script:
- copies the 7 per-package `pnpm-workspace.yaml`, `server/.env`, `client/.env`,
  and `CLAUDE.local.md` from the source;
- runs `pnpm install --frozen-lockfile` for `server`, `client`, `reviewer-core`,
  `mcp`, `agent-runner`, and a plain `pnpm install` for `e2e` (no committed
  lockfile) — all with **linux** binaries;
- **prints** (does not run) the Windows-side `evals` install;
- never invokes `git`.

**Step 3 — WINDOWS (`evals` only — win32 binaries):**
```bash
cd ../dev-digest-<name>/evals && pnpm install --frozen-lockfile
```

That is the whole setup. Skip Step 3 if you will not run harness evals in this
worktree.

## 5. Manual path — what the script does, by hand

Use this if you prefer not to run the script, or are on a machine whose layout
differs from §2. It is exactly what `worktree-init.sh` automates.

**5.1 — Copy the git-ignored machine-local files** from the source worktree into
the new one (same relative paths). These are absent in any fresh checkout:

| File(s) | Why it is needed |
| ------- | ---------------- |
| `server/pnpm-workspace.yaml`, `client/pnpm-workspace.yaml`, `reviewer-core/pnpm-workspace.yaml`, `mcp/pnpm-workspace.yaml`, `e2e/pnpm-workspace.yaml`, `evals/pnpm-workspace.yaml`, `agent-runner/pnpm-workspace.yaml` | pnpm 11 `allowBuilds` map — without it native builds are skipped / lint hard-fails |
| `server/.env`, `client/.env` | runtime config (DB URL, API keys, ports); no absolute paths inside, so whole-file copy is safe |
| `CLAUDE.local.md` | machine-local Claude rules (git-on-Windows, test-mirror) — helpful, not required to build |

`*.env.example` and `.mcp.json.example` are tracked but are **not** substitutes
(no real values). `.mcp.json` is intentionally **not** copied — see §8.

**5.2 — Install `node_modules` per package, on the correct platform:**

```bash
# WSL — linux binaries:
for p in server client reviewer-core mcp agent-runner; do
  ( cd /mnt/e/.../dev-digest-<name>/$p && pnpm install --frozen-lockfile )
done
( cd /mnt/e/.../dev-digest-<name>/e2e && pnpm install )   # no lockfile

# WINDOWS — win32 binaries:
cd ../dev-digest-<name>/evals && pnpm install --frozen-lockfile
```

Because each package has its **own separate** `node_modules`, holding linux and
win32 installs side-by-side is fine — the platform trap only bites if the **same**
package is installed from the wrong side.

## 6. Running the app and the test suites

**Test suites** run through the WSL-native mirror, exactly as in the main
worktree — and the mirror is now **per-worktree automatically**:
`test-mirror.sh` defaults `DEVDIGEST_MIRROR` to
`~/.devdigest-test-mirror-<worktree-dirname>`, so two worktrees never
`rsync --delete` over each other's mirror. Run from inside the worktree:

```bash
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-<name> && bash scripts/test-mirror.sh server exec vitest run --exclude "**/*.it.test.ts"'
```
(The same commands as `CLAUDE.local.md` "Test-suite execution", just from the
worktree's path. You can still override with an explicit `DEVDIGEST_MIRROR=...`.)

> Note: after this change the **main** worktree's default mirror also moves from
> `~/.devdigest-test-mirror/` to `~/.devdigest-test-mirror-dev-digest/`. The
> first run re-syncs into the new directory once (idempotent, cheap). The old
> directory can be deleted.

**Harness evals** run from the **Windows** shell inside the worktree:
```bash
cd ../dev-digest-<name>/evals && pnpm eval:quality
```

**Full dev stack** (`scripts/dev.sh` — Postgres + migrate + seed + API:3001 +
web:3000) works from the worktree too, but it shares one Postgres and fixed
ports with the main stack — see §7 before running two at once.

## 7. Running two worktrees at once (concurrent stacks)

The default bootstrap assumes a **single active** worktree at a time. Sequential
use is fine and needs nothing extra. Running **two** dev stacks simultaneously
collides, because `docker-compose.yml` defines a single `devdigest-postgres`
(port `5432`) and `dev.sh` fixes API `:3001` / web `:3000`.

For genuinely concurrent runtime, the second worktree needs, as a deliberate
manual step:
- distinct `API_PORT` / `WEB_PORT` in `server/.env`,
- matching `NEXT_PUBLIC_API_BASE` / `WEB_PORT` in `client/.env`,
- an isolated database — a separate Postgres container/port, or a different
  database name in `DATABASE_URL`.

Secrets in `~/.devdigest/secrets.json` live outside the repo and are correctly
shared across worktrees — no action needed.

## 8. MCP server inside a worktree

Most worktree work reuses the **main** worktree's MCP server, so `.mcp.json` is
intentionally **not** copied by the bootstrap. If this worktree needs its **own**
MCP server, copy `.mcp.json` into it and **rewrite the hardcoded**
`cd <path>/mcp` in the launch command to point at *this* worktree's `mcp/`
directory (the machine-local `.mcp.json` launches the server via
`wsl.exe ... tsx` with an absolute path). See
[devdigest-mcp-connection.md](./devdigest-mcp-connection.md) for the connection
details.

## 9. Verification checklist

After the bootstrap, all of these should pass:

```bash
# WSL — every WSL package has node_modules:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-<name> && for p in server client reviewer-core mcp e2e agent-runner; do \
     test -d "$p/node_modules" && echo "$p ok" || echo "$p MISSING"; done'

# WSL — client typecheck no longer dies on ERR_PNPM_IGNORED_BUILDS (allowBuilds present):
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-<name> && bash scripts/test-mirror.sh client typecheck'

# WSL — a server unit lane runs green through the per-worktree mirror:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'cd /mnt/e/.../dev-digest-<name> && bash scripts/test-mirror.sh server exec vitest run --exclude "**/*.it.test.ts"'

# Windows — evals harness runs (proves the win32 install):
cd ../dev-digest-<name>/evals && pnpm eval:quality
```
Also confirm `server/.env` and `client/.env` are present, and that the **main**
worktree still works unchanged.

## 10. Removing a worktree (cleanup)

```bash
# WINDOWS (git):
git worktree remove ../dev-digest-<name>
git worktree prune

# WSL — delete its dedicated test mirror:
wsl.exe -d Ubuntu-24.04-dev-digest-test -- bash -lc \
  'rm -rf ~/.devdigest-test-mirror-dev-digest-<name>'
```
`git worktree remove` refuses if the worktree has uncommitted changes — commit,
stash, or `git worktree remove --force` deliberately.
