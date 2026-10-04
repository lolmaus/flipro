# Flipro

A small TypeScript proxy that makes Flibusta's OPDS catalog available through your VPS. It uses Node.js, Hono, and an XML parser. Catalog navigation, search, covers, download redirects, and Flibusta HTTP Basic authentication stay on the proxy's address. Book files stream without modification or storage.

## Development

Use the Node.js version pinned in `.nvmrc`. With nvm:

```sh
nvm install
nvm use
```

Install pnpm 11 or newer using [pnpm's installation instructions](https://pnpm.io/installation). The exact project version lives in `devEngines.packageManager` in `package.json`; pnpm downloads and selects that version automatically when necessary. `pnpm-lock.yaml` records both the package-manager resolution and dependencies. There is no separate `packageManager` pin or npm lockfile.

```sh
pnpm install --frozen-lockfile
pnpm run check
```

Create `.env` from `.env.example` and set the address reachable by your reader. For this VPS's WireGuard interface:

```dotenv
PUBLIC_ORIGIN=http://10.77.0.3:3000
HOST=10.77.0.3
PORT=3000
```

```sh
pnpm run dev
```

Open **http://10.77.0.3:3000/opds** from a computer or reader connected to the WireGuard network. `HOST` controls the listening interface; `PUBLIC_ORIGIN` controls all generated URLs. Setting one does not set the other. The health endpoint is http://10.77.0.3:3000/_flipro/health.

The development server watches source files and restarts after changes. It does not start automatically after a VPS reboot; use the production service for that. Request logs are written to standard output.

With the server running, `pnpm run smoke` checks the live catalog, OpenSearch, Cyrillic search, pagination, cover headers, redirected download headers, and the upstream authentication challenge. It uses `PUBLIC_ORIGIN` from your environment or `.env`, requires upstream network access, and does not download books or use account credentials.

## KOReader

In KOReader's OPDS catalog list, add a catalog with:

- Name: `Flibusta via VPS`
- URL: `http://10.77.0.3:3000/opds` for development, or `https://books.example.com/opds` in production.
- Username/password: leave blank for anonymous use, or enter your **Flibusta** credentials to use account features such as “Моя полка”. There are no proxy credentials.

For acceptance on your device, navigate through authors/genres and several pages, search for a Cyrillic title, view a cover, download an EPUB or another supported format, and open it. With Flibusta credentials configured, also open “Моя полка”. The project tests authentication forwarding using fixture credentials; a real account is verified on your reader.

## Production on the VPS

Use a dedicated HTTPS hostname and a system-wide installation of the Node.js version specified by `.nvmrc`. Place the project at `/opt/flipro`, then run the following there as the deployment user:

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm prune --prod
```

Create a dedicated service user if one does not exist:

```sh
sudo useradd --system --home-dir /opt/flipro --shell /usr/sbin/nologin flipro
```

Ensure that user can read `/opt/flipro`, its compiled `dist` directory, and `node_modules`. The service does not need write access. Create `/etc/flipro.env`:

```dotenv
PUBLIC_ORIGIN=https://books.example.com
HOST=127.0.0.1
PORT=3000
```

Install and enable the example service:

```sh
sudo install -m 0644 deploy/flipro.service /etc/systemd/system/flipro.service
sudo systemctl daemon-reload
sudo systemctl enable --now flipro
sudo systemctl status flipro
```

The service uses `/usr/bin/env node`; ensure Node is available in systemd's PATH, or replace `ExecStart` with the absolute path to your system-wide Node executable. Its production configuration comes from `/etc/flipro.env`, not the development `.env`.

Point your hostname's DNS at the VPS and add the block from `deploy/Caddyfile.example` to your existing Caddy configuration, substituting your hostname. Validate and reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy terminates HTTPS and forwards to the loopback listener. Keep `PUBLIC_ORIGIN` equal to the hostname readers actually use. Add `https://books.example.com/opds` to KOReader and verify `https://books.example.com/_flipro/health`.

To update, reinstall dependencies, run the checks/build, prune development dependencies, and restart `flipro`. Inspect application logs with `journalctl -u flipro`. If the development server still owns port 3000 on WireGuard, stop it before activating production on that port to avoid having two differently configured instances.

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

| Command               | Purpose                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `pnpm run dev`        | Run TypeScript directly with Node's watch mode and optional `.env` |
| `pnpm run lint`       | Check JavaScript/TypeScript with Oxlint; warnings fail the check   |
| `pnpm run lint:fix`   | Apply Oxlint's automatic fixes                                     |
| `pnpm run format`     | Check formatting with Oxfmt without writing files                  |
| `pnpm run format:fix` | Format supported project files with Oxfmt                          |
| `pnpm run typecheck`  | Check application and test types                                   |
| `pnpm test`           | Run unit tests and local HTTP integration fixtures                 |
| `pnpm run build`      | Compile production JavaScript into `dist`                          |
| `pnpm run check`      | Lint, check formatting, type check, test, and build                |
| `pnpm run smoke`      | Check the running proxy against live Flibusta                      |
| `pnpm start`          | Run compiled JavaScript with optional `.env`                       |

| Variable        | Default     | Purpose                                        |
| --------------- | ----------- | ---------------------------------------------- |
| `PUBLIC_ORIGIN` | Required    | HTTP(S) origin, with no path/query/credentials |
| `HOST`          | `127.0.0.1` | Listening interface                            |
| `PORT`          | `3000`      | Listening port                                 |

Integration tests bind ephemeral loopback ports and require permission to open local network sockets. They do not contact Flibusta or need a real account.

## CI

Trusted dependency projects are exempt from pnpm’s release-age delay through `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`, including their native platform packages. This allows their latest stable releases to install immediately in both development and CI. Update dependencies with pnpm and commit the manifest and lockfile together.

GitHub Actions runs `pnpm run check` in one job for pull requests and pushes to `main`/`master`, with a manual trigger available. Live smoke checks remain manual because they depend on Flibusta availability.

The workflow reads Node from `.nvmrc` and pnpm from `devEngines.packageManager`; it does not duplicate either version. [pnpm/setup](https://github.com/pnpm/setup) restores the pnpm store before installing Node and dependencies, caches lockfile-verification results, and enforces a frozen lockfile. It performs the dependency installation once; there is no extra setup-node, Corepack, or install step. The store cache reuses downloads rather than caching `node_modules`.

Actions are pinned to immutable commit SHAs, with weekly grouped Dependabot updates for actions. CI uses read-only repository permissions, does not persist checkout credentials, cancels superseded runs, and has a ten-minute timeout. Runtime and package-manager upgrades are made in `.nvmrc` and `devEngines.packageManager` respectively; run `pnpm install` after changing the package-manager pin and commit the resulting lockfile.
