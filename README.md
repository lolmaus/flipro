# Flipro

A small TypeScript proxy that makes Flibusta's OPDS catalog available through your VPS. It uses Node.js, Hono, and an XML parser. Catalog navigation, search, covers, download redirects, and Flibusta HTTP Basic authentication stay on the proxy's address. Book files stream without modification or storage.

## Development

The supported runtime range is **Node.js >=24** (`engines.node`). The preferred tested version is **26.10.0**, sourced from `.nvmrc`; this is a development/CI preference, not the minimum supported runtime. CI exercises Node 24 and the preferred pin. Use a maintained release within the supported range. With nvm:

```sh
nvm install
nvm use
```

Install pnpm 11 or newer using [pnpm's installation instructions](https://pnpm.io/installation). The exact project version lives in `devEngines.packageManager` in `package.json`; pnpm downloads and selects that version automatically when necessary. `pnpm-lock.yaml` records both the package-manager resolution and dependencies. There is no separate `packageManager` pin or npm lockfile.

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Create `.env` from `.env.example` and set the address reachable by your reader. For a local development listener:

```dotenv
PUBLIC_ORIGIN=http://localhost:3000
HOST=127.0.0.1
PORT=3000
```

```sh
pnpm run dev
```

Open **http://localhost:3000/opds** on the development computer. To reach it from a reader, set a reachable development hostname and interface. `HOST` controls the listening interface; `PUBLIC_ORIGIN` controls all generated URLs. Setting one does not set the other. The health endpoint is http://localhost:3000/_flipro/health.

The development server watches source files and restarts after changes. It does not start automatically after a VPS reboot; use the production service for that. Request logs are written to standard output.

With the server running, `pnpm run smoke` checks health, build identity, the live catalog, OpenSearch, Cyrillic search, pagination, cover headers, a bounded download prefix, and the upstream authentication challenge. It uses `PUBLIC_ORIGIN` from your environment or `.env`, requires upstream network access, and uses anonymous partial GET probes. [Live smoke verification](docs/live-smoke.md) documents sample overrides, equivalent upstream comparisons, retry/runtime/byte bounds, diagnostic JSON and exit codes (0 passed, 1 failed, 2 incomplete). A partial probe does not verify an entire book.

## KOReader

In KOReader's OPDS catalog list, add a catalog with:

- Name: `Flibusta via VPS`
- URL: your reachable development origin followed by `/opds`, or `https://books.example.com/opds` in production.
- Username/password: leave blank for anonymous use, or enter your **Flibusta** credentials to use account features such as “Моя полка”. There are no proxy credentials.

For acceptance on your device, navigate through authors/genres and several pages, search for a Cyrillic title, view a cover, download an EPUB or another supported format, and open it. With Flibusta credentials configured, also open “Моя полка”. The project tests authentication forwarding using fixture credentials; a real account is verified on your reader.

## Production application contract

A separate Ansible project owns installation, explicit runtime/application upgrades, uninstall, and infrastructure verification. The examples in `deploy/` describe the application contract for that tooling; they are not an installation workflow.

Run compiled JavaScript as a dedicated unprivileged systemd account behind Caddy. Ansible supplies a root-owned, versioned Node runtime outside account homes and renders an **absolute Node executable path** in `ExecStart`, for example `/opt/node/versions/26.10.0/bin/node /opt/flipro/dist/server.js`. Resolve the preferred version from `.nvmrc` when choosing that runtime. Do not depend on a login shell, fnm, an account's PATH, or `/usr/bin/env node`. Provisioning must leave the developer's PATH, shell configuration, fnm settings, and active Node version untouched.

Prepare an artifact in a build directory using the intended supported Node runtime and the **project-pinned pnpm** (currently `12.9.1` in `devEngines.packageManager`). pnpm 11+ automatically downloads/selects the project version when necessary (`onFail: download`); invoking an arbitrary global pnpm does not establish which version did the build. Deployment tooling must deliberately honor that selection, verify `pnpm --version` in the project directory, and allow/bootstrap its package-manager store during preparation. Do not disable automatic selection or substitute a newer pnpm. The running service needs neither pnpm nor its writable store.

```sh
pnpm --version # must match devEngines.packageManager.version
pnpm install --frozen-lockfile
pnpm run check
pnpm prune --prod
EXPECTED_REVISION="$(git rev-parse HEAD)" pnpm run smoke:production
```

This checkout example assumes clean committed source. The smoke command launches `dist/server.js` on an ephemeral loopback port with external environment configuration, verifies health, identity and startup logging, checks a configured-origin redirect, and sends SIGTERM, requiring exit code 0. It deliberately supplies conflicting revision/version environment values and removes the child's executable PATH. It requires no upstream network or development dependencies after pruning. Do preparation in a disposable build directory; pruning removes development tools needed for subsequent checks.

The installation needs only `dist/`, the pruned production `node_modules/`, and `package.json` (including `type: module`). It needs no TypeScript, source, Git, repository metadata, network access to report identity, or write access to the installation directory. Make the artifact readable and directories traversable by the service account, with ownership/write permission retained by deployment tooling. Configuration comes externally from `/etc/flipro.env` through systemd, for example:

```dotenv
PUBLIC_ORIGIN=https://books.example.com
HOST=127.0.0.1
PORT=3000
```

`deploy/flipro.service` illustrates a read-only installation and graceful shutdown with a 15-second systemd stop timeout (the app closes connections with a 10-second deadline). Caddy terminates HTTPS and proxies to the loopback listener, as in `deploy/Caddyfile.example`. Keep `PUBLIC_ORIGIN` equal to the reader's hostname. Anonymous access is unrestricted; readers can optionally supply their Flibusta credentials, which are forwarded upstream. The service remains stateless.

Application updates require building, checking, pruning, replacing the artifact, and restarting the service. Runtime updates are explicit and require updating the absolute executable path. Brief maintenance interruptions are acceptable; no zero-downtime release mechanism is required. Inspect stdout/stderr through `journalctl -u flipro`.

## Build identity and deployment verification

`GET /_flipro/version` returns HTTP 200, JSON, and `Cache-Control: no-store`:

```json
{
  "name": "flipro",
  "version": "0.1.0",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "node": "v26.10.0"
}
```

`name` and `version` come from `package.json` during `pnpm run build`; `revision` is embedded alongside them in `dist/build-identity.js`. `node` is the actual running `process.version`, not the build runtime or the preferred pin. The startup JSON log contains these same fields with `event: startup`. Runtime environment variables, including `FLIPRO_BUILD_REVISION`, cannot override embedded identity.

Build revision rules:

- In a Git checkout, the build uses the full committed HEAD hash. Any staged, unstaged, or non-ignored untracked change (including submodule changes) adds `-dirty`; a modified build never reports the clean hash.
- `FLIPRO_BUILD_REVISION` is an optional **build-time** input. It must be exactly 40 or 64 hexadecimal characters (a full SHA-1 or SHA-256 Git revision), normalized to lowercase. Short hashes, branch/tag names, empty values, and whitespace fail the build. In a checkout it must match HEAD and cannot suppress `-dirty`.
- For a source archive without checkout metadata, supply the known source revision explicitly. Deployment tooling is responsible for the archive's provenance; a hash alone cannot prove its contents match that commit. Without a supplied revision, or when Git identity cannot be read, the build reports `unknown`. A supplied revision cannot bypass broken checkout metadata. An archive inside another repository does not inherit that repository's HEAD.
- Direct TypeScript development uses the checked-in fallback `version: unbuilt`, `revision: unknown`. Tests, type checking, and development work before compilation, with no manually generated files. Each production build replaces the fallback in compiled output and removes stale output.

For a source archive:

```sh
FLIPRO_BUILD_REVISION=0123456789abcdef0123456789abcdef01234567 pnpm run check
pnpm prune --prod
EXPECTED_REVISION=0123456789abcdef0123456789abcdef01234567 pnpm run smoke:production
```

Deployment tooling should query `https://books.example.com/_flipro/health` for exact `{ "status": "ok" }`, then query `https://books.example.com/_flipro/version` and require `name`/`version` to match the expected artifact and `revision` to equal its full expected source hash. Equality rejects `unknown` and `-dirty` artifacts. Compare `node` separately with the version provisioned for that service: matching the source revision does not prove the runtime is correct. Both endpoints are local process checks independent of upstream availability.

For optional live upstream acceptance with the server running:

```sh
PUBLIC_ORIGIN=https://books.example.com \
EXPECTED_REVISION=0123456789abcdef0123456789abcdef01234567 \
EXPECTED_NODE_VERSION=v26.10.0 pnpm run smoke
```

These expectation variables belong to smoke tooling, not application configuration. Live smoke checks also exercise anonymous catalog navigation and authentication challenges; fixture tests verify credential forwarding without a real account. Deployment tooling must distinguish upstream-dependent incomplete verification (exit 2) from complete success (exit 0) and demonstrated failures (exit 1), and retain the [smoke report](docs/live-smoke.md#outcomes-and-deployment-tooling).

## Behavior and limits

- Only GET and HEAD are supported. `/` redirects to `/opds`.
- Ordinary paths map to `https://flibusta.is`. `/_flipro/static/*` maps to `https://static.flibusta.is/*`, including the download conversion redirects used by Flibusta. Destinations cannot be supplied by clients.
- Atom and OpenSearch XML under `/opds`, `/opds/*`, and `/opds-opensearch.xml` are rewritten. Relative links, nested XML bases, search templates, and UTF-8 text are supported. Bibliographic IDs, relation identifiers, and unrelated external URLs are preserved.
- Other content is streamed as received. Ordinary website pages can be served, but full website navigation, HTML asset rewriting, and browser login are outside the supported workflow.
- Authorization and reader cookies go only to the main Flibusta host. Upstream authentication challenges are preserved. Cookie domains are made local to the proxy; no credentials or session state are stored. Requests containing credentials/cookies and upstream challenges are marked `private, no-store`.
- Downloads preserve ranges, content types, filenames, and validators. Catalog conditional/range requests are omitted, and transformed XML's upstream lengths/validators are removed.
- Upstream headers and catalog body retrieval each have a 30-second timeout. Catalog bodies are limited to 8 MiB; invalid XML and DTDs are rejected. Errors use HTTP 502/504 with a short explanation. Download streams have no short total deadline and are canceled when the reader disconnects.
- Health checks report process availability, not upstream availability. Logs contain request method, pathname, response status, and handling time; query values and credentials are omitted. Download duration is not included in handling time.
- There is no server-side cache, database, proxy authentication, rate limiter, or offline mirror.

## Commands and configuration

| Command                     | Purpose                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `pnpm run dev`              | Run TypeScript directly with Node's watch mode and optional `.env` |
| `pnpm run lint`             | Check JavaScript/TypeScript with Oxlint; warnings fail the check   |
| `pnpm run lint:fix`         | Apply Oxlint's automatic fixes                                     |
| `pnpm run format`           | Check formatting with Oxfmt without writing files                  |
| `pnpm run format:fix`       | Format supported project files with Oxfmt                          |
| `pnpm run typecheck`        | Check application and test types                                   |
| `pnpm test`                 | Run unit tests and local HTTP integration fixtures                 |
| `pnpm run build`            | Compile JavaScript and embed package/source identity into `dist`   |
| `pnpm run check`            | Lint, check formatting, type check, test, and build                |
| `pnpm run smoke:production` | Launch compiled app; check health, identity, redirects, shutdown   |
| `pnpm run smoke`            | Check identity and the running proxy against live Flibusta         |
| `pnpm start`                | Run compiled JavaScript with optional `.env`                       |

| Variable        | Default     | Purpose                                        |
| --------------- | ----------- | ---------------------------------------------- |
| `PUBLIC_ORIGIN` | Required    | HTTP(S) origin, with no path/query/credentials |
| `HOST`          | `127.0.0.1` | Listening interface                            |
| `PORT`          | `3000`      | Listening port                                 |

Integration tests bind ephemeral loopback ports and require permission to open local network sockets. They do not contact Flibusta or need a real account.

## CI

Trusted dependency projects are exempt from pnpm’s release-age delay through `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, including their native platform packages. This allows their latest stable releases to install immediately in both development and CI. Update dependencies with pnpm and commit the manifest and lockfile together.

GitHub Actions runs `pnpm run check`, prunes development dependencies, and exercises the compiled application with `pnpm run smoke:production` in a matrix for Node 24 and the preferred version from `.nvmrc`. This runs for pull requests and pushes to `main`/`master`, with a manual trigger available. Live upstream smoke checks remain manual because they depend on Flibusta availability.

The preferred CI runtime reads `.nvmrc`; the compatibility job selects `node@24`. pnpm comes from `devEngines.packageManager`; neither preferred tool pin is duplicated in CI. [pnpm/setup](https://github.com/pnpm/setup) restores the pnpm store before installing Node and dependencies, caches lockfile-verification results, and enforces a frozen lockfile. It performs the dependency installation once; there is no extra setup-node, Corepack, or install step. The store cache reuses downloads rather than caching `node_modules`.

Actions are pinned to immutable commit SHAs, with weekly grouped Dependabot updates for actions. CI uses read-only repository permissions, does not persist checkout credentials, cancels superseded runs, and has a ten-minute timeout. Runtime and package-manager upgrades are made in `.nvmrc` and `devEngines.packageManager` respectively; run `pnpm install` after changing the package-manager pin and commit the resulting lockfile.
