# Live smoke verification

`pnpm run smoke` checks a running Flipro's health/version, catalog, OpenSearch,
navigation, pagination, cover headers, Cyrillic search, anonymous authentication
challenge, and a bounded acquisition prefix. It requires Node >=24 and the normal
frozen development installation. Offline `pnpm test` uses controlled HTTP fixtures
and the real Hono proxy/Node adapter; it never contacts Flibusta.

```sh
pnpm install --frozen-lockfile
PUBLIC_ORIGIN=https://flipro.bubba.lolma.us pnpm run smoke
```

Set `EXPECTED_REVISION` and/or `EXPECTED_NODE_VERSION` to require the deployed
identity. Neither variable configures the application. Health/version remain
local process checks, independent of Flibusta.

## Sampling and reproduction

The old test selected the first advertised EPUB and used HEAD, requiring a filename
and positive Content-Length. An advertised conversion can instead return HTML,
require authentication, disappear, or time out. Missing metadata does not prove a
broken download: [HTTP HEAD semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2)
permit omitting headers generated while producing the body, and streamed GET
responses can omit Content-Length too. HTTP 200 alone does not prove a book exists.

By default the smoke selects at most **four distinct acquisition links** from the
new-books feed. It first takes one per advertised media type, then fills remaining
slots with other links. It does not assume that EPUB is available or require a
particular book. Unavailable samples are retained in the report; a later verified
sample can satisfy the download stage. A demonstrated or unconfirmed difference
cannot be erased by a later successful sample.

To inspect only the observed sample, including when catalog checks fail:

```sh
PUBLIC_ORIGIN=https://flipro.bubba.lolma.us \
EXPECTED_REVISION=fc864b1ef4b7ab2637c364c62afcba7a5f3c47b9 \
SMOKE_SAMPLE=/b/891685/epub pnpm run smoke
```

`SMOKE_SAMPLE` accepts a `/b/<numeric-id>/<format>` or `/b/<id>/download[/<format>]`
path (epub, fb2, mobi, pdf, djvu), or that URL on PUBLIC_ORIGIN. Query parameters
are permitted for reproduction but omitted from reports. Credentials, fragments,
foreign origins and arbitrary non-acquisition paths are rejected. An override
never falls back to another sample and does not bypass the other smoke stages.
The historical FB2Reader download proves that a reader downloaded some book; its
unknown format and authentication context do not establish anonymous EPUB support
for this sample.

## Probe and comparison

Each sample is requested with anonymous **GET**, `Range: bytes=0-4095`,
`Accept-Encoding: identity`, the same explicit Accept/Accept-Language/User-Agent,
and manual redirects on both legs. One leg uses Flipro; the other maps the same
path to the application's existing `flibusta.is`/`static.flibusta.is` origins.
Static proxy paths and allowed download redirects use the application's existing
URL mapping. Proxy redirects must remain on PUBLIC_ORIGIN; direct redirects must
remain on the two HTTPS upstream origins. Foreign destinations, credentials and
redirect exhaustion stop the probe without following the destination. No
Authorization, Cookie, Proxy-Authorization or response cookies are reused.

The smoke checks a recognizable EPUB/ZIP, FB2 XML (or ZIP), MOBI, PDF or DjVu prefix
and rejects HTML, recognizable error pages, authentication requirements, empty
bodies and unsupported/unrecognized formats. FB2's legitimate `<body>` element is
not mistaken for an HTML document. Signature recognition is deliberately shallow:
a ZIP prefix does not prove an EPUB archive is valid. Filename metadata is optional;
if supplied it must have a usable nonempty filename without path/control characters.
Content-Disposition without a filename is allowed. Length metadata is optional;
if present it must be a positive safe integer consistent with observed bytes and,
when EOF was seen, the complete response body. A 206 must have a consistent
Content-Range starting at zero within the requested range. Unexpected content
encoding makes the comparison unverified.

For successful probes, the comparison checks normalized redirect destinations,
status, content type, disposition, length, range, ETag and exact prefix bytes.
This detects header loss even though those headers are optional in isolation.
Matching unavailable resources, upstream timeouts and exhausted transient failures
are classified separately from differences. If the direct request cannot provide
a valid reference, the result is `comparison-unavailable`, not proof of a proxy defect.

**Prefer running smoke on the host and network environment where the service's
upstream connections originate.** Confirm the same egress, DNS/firewall, namespace
and request context before setting:

```sh
SMOKE_COMPARISON_CONTEXT=same-egress PUBLIC_ORIGIN=https://books.example.com pnpm run smoke
```

The default is `different-or-unknown`. Differences from that context are always
`unconfirmed-difference`. Even with `same-egress`, attributing a difference to the
proxy requires the same final upstream URL and matching strong ETags. Sequential
requests can observe different upstream resources, generated filenames, conversions,
load balancers, caches or availability; same egress alone does not establish the
same representation. Missing/weak validators leave differences unconfirmed.
Controlled regression fixtures can establish a stable reference without live
validators; that context is available only through the test seam, not the CLI.
Matching responses provide evidence for this sample and context, not a guarantee
about all deployments. For catalog failures, a bounded direct request supplies
availability diagnostics; rewritten XML is not compared byte-for-byte.

## Bounds and diagnostics

Limits are fixed in `scripts/smoke-probe.ts`; test seams can reduce them, never
increase them:

| Bound                                     | Value                |
| ----------------------------------------- | -------------------- |
| Acquisition candidates                    | 4                    |
| Attempts per request leg                  | 3                    |
| Redirects per attempt                     | 5                    |
| Retained download/error prefix            | 4096 bytes           |
| Catalog/JSON document body                | less than 8 MiB      |
| Request headers and body deadline per hop | 35 seconds           |
| Shared network/runtime deadline           | 180 seconds          |
| Exponential backoff                       | 500 ms, then 1000 ms |

Connection errors, interrupted streams, timeouts and HTTP 500/502/503/504 are retried.
HTTP 200 HTML, authentication/access restrictions, 404, unsuitable 5xx, invalid
metadata, unsafe redirects, assertions and unsupported formats are not repaired by
retries. The total deadline includes both legs, all stages and backoff. Once it
expires, later stages cannot start new network requests. Bounded local parsing and
report formatting may add a small amount of time after the deadline.

The reader retains at most 4096 prefix bytes and cancels/aborts promptly at the cap,
on redirects, and on failure, even when Range is ignored. Fetch/socket buffering
can deliver an oversized chunk or already have additional bytes in flight; this is
**not an exact on-wire 4096-byte transfer quota**. `observedBytes` records all bytes
in delivered chunks, whereas `bytes` records the retained prefix. The test verifies
that both the direct stream and the real proxy's upstream stream close promptly.
The finite candidates, attempts, redirects and deadlines bound the probe's work.

Stdout is JSON Lines: `smoke-attempt` events followed by one `smoke-result` report.
Each event identifies the stage, side, sanitized pathname, attempt/hop, method,
status, content type, disposition, length, range, ETag, retained/observed bytes,
EOF, prefix SHA-256, classification and reason. Query values, credentials, cookies,
response body text and raw exception messages are omitted; metadata/control
characters and path length are sanitized. The final report includes **all attempt
evidence**, including failures before eventual success, stage results and sample
classifications. Capture stdout to preserve an investigation:

```sh
PUBLIC_ORIGIN=https://books.example.com pnpm run smoke > smoke.jsonl
```

## Outcomes and deployment tooling

| Outcome      | Exit | Meaning                                                                                                                                                      |
| ------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `passed`     | 0    | All stages passed and at least one direct/proxy book prefix was verified, with no unresolved differences.                                                    |
| `failed`     | 1    | Invalid configuration, a local health/version or rewriting contract assertion, a demonstrated proxy difference, or an unexpected tooling failure.            |
| `incomplete` | 2    | Upstream unavailable/timed out, no usable sample, unsupported response, runtime exhausted, or an unconfirmed difference. Full acceptance remains unverified. |

A later recovery may yield exit 0 while retaining transient failures or unavailable
samples. Persistent failures cannot produce a fabricated success. Exit 2 is neither
complete acceptance nor an automatic proxy-defect diagnosis. IaC should consume
these documented outcomes, preserve the report, and keep process health/identity
separate from live upstream acceptance; it must not silently convert exit 2 into
success. The minimal production artifact and `smoke:production` startup/identity/
shutdown contract are unchanged. Live smoke is run from a checkout with tooling,
not added to the deployed artifact.

A partial prefix **does not validate an entire book**, archive integrity, later
stream bytes, reader compatibility, or account-only downloads. Reader acceptance
still requires downloading and opening the complete chosen book, with the intended
authentication context.
