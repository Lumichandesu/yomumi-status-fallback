# Yomumi Status

Independent, static service observations. The status UI has no application navigation, player,
third-party scripts, account features, cookies, or dependency on the main application to render.

Primary: https://status.yomumi.moe/

DNS-independent fallback: https://lumichandesu.github.io/yomumi-status-fallback/

The primary repository is `Lumichandesu/yomumi-status`; it contains only this newly authored
status service and sanitized public observations. The application repository remains private.
The fallback repository has no custom domain: its github.io address must never redirect to the
main website or status custom domain. Both sites use GitHub Pages and public standard Actions.

## Observations

The separate scheduled snapshot Worker reads the public homepage, public API health proxy, and
the API's schema 2 dependency report every 15 minutes. The GitHub scheduled workflow remains
a secondary observer; delayed GitHub jobs do not stop the separate Cron. Both perform no account writes, payments,
email deliveries or content generation. The dependency report measures SELECT 1 and Redis PING.
Older reports without actual probe evidence are unknown. Blocked/rate-limited checks are unknown.
Each request/body is bounded, failures receive one retry, and logs omit target URLs and bodies.

`STATUS_API_BASE_URL` is configured privately as a Worker secret and as a GitHub Actions secret
in the primary repository. There are no provider credentials in this public static service.
The target is the existing public API origin;
do not publish its address in snapshots or this generic repository. If origin ingress changes,
replace this check with a dedicated least-privilege monitor access mechanism.

The browser reads two fixed, read-only public snapshots, never the application API or an endpoint
that starts probes. Both hosts read `https://yomumi-status-monitor.yomumi.workers.dev/status.json`;
the primary also reads its hosted JSON and the fallback reads the exact public raw-GitHub snapshot.
It displays the first validated observation as soon as it arrives, then updates only if another
source has a newer observation. It rejects future timestamps and refuses to move backward.
A hung source cannot delay an already available snapshot; all pending requests stop after six seconds.
Every service becomes unknown after 45 minutes without a fresh observation. Gray historical days are
unobserved. Percentages are ratios of recorded pass/fail checks, not continuous uptime.
History starts at the first real check; there is no invented 90-day history. Keep 48 hours of raw
observations and 90 daily aggregates. Automated incidents record observed failure and subsequent
recovery only; unknown does not resolve an incident. These checks do not prove every application
feature or user session works.

## Commands

Node 22 or newer and Bun 1.4.2 or newer. CI pins Bun 1.4.2 and installs the locked Elysia
dependency without package lifecycle scripts for server verification. Monitoring remains a
dependency-free Node command; it does not require the server to be running.

```text
bun --no-env-file install --frozen-lockfile --ignore-scripts
bun --no-env-file run test
node scripts/monitor.mjs
bun --no-env-file run build
bun --no-env-file run serve
```

The monitor requires the target secret in its environment. Bun bundles and minifies the public
HTML, CSS and browser JavaScript into the fixed `dist` directory. The model shares one JavaScript
bundle with the client, avoiding a separate module request; CSS and JavaScript have content hashes.
The browser build disables environment-variable inlining and never bundles Elysia or monitoring code.
Invalid configuration or a failed bundle leaves the previous output intact.

Measured against the previously published source on October 1, 2026: uncompressed browser JS/CSS
decreased from 31,734 to 21,684 bytes (31.7%), and its asset requests decreased from three to two.
These are build payload measurements, not a promise of the same load-time improvement on every network.

The optional Elysia server preloads the same `dist` files into memory and serves only their exact
public routes. It supports conditional GET/HEAD with ETags, immutable hashed assets and revalidated
HTML; status JSON is always fetched without a cache. It does not start or proxy monitoring requests.
`serve` listens on `127.0.0.1:4331` by default after a successful build. To explicitly self-host,
put an independent reverse proxy in front of the loopback server; `STATUS_PORT` (or `PORT`)
changes its port. Restart after a new build or snapshot to reload preloaded bytes.
Do not expose an old in-memory snapshot as fresh: the client still marks observations UNKNOWN
after 45 minutes. Elysia is useful for local preview or independent Bun hosting; GitHub Pages
continues serving the optimized static output and cannot run a Bun server process.

For the separate fallback build, set
`STATUS_DATA_URL=https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json`
and install `fallback-workflow.yml` as `.github/workflows/deploy.yml`, leaving Pages cname unset.
Artifacts retain for one day; no action caches or paid runners. Source changes deploy on push;
schedule/manual runs commit only the validated snapshot and then deploy.

Independent hosting survives application/CDN/API failures, but GitHub Pages/Actions/Raw share a
provider. The separate snapshot producer shares Cloudflare; its failure leaves the GitHub source
available, or UNKNOWN when all observations are stale. The custom domain uses Cloudflare authoritative DNS; bookmark the github.io
fallback for a DNS problem. No service can promise availability through every provider outage.
