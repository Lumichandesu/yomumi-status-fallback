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

The scheduled workflow reads the public homepage, public API health proxy, and the API's
schema 2 dependency report every 15 minutes. It performs no account writes, payments,
email deliveries or content generation. The dependency report measures SELECT 1 and Redis PING.
Older reports without actual probe evidence are unknown. Blocked/rate-limited checks are unknown.
Each request/body is bounded, failures receive one retry, and logs omit target URLs and bodies.

`STATUS_API_BASE_URL` is configured only as a GitHub Actions secret in the primary repository.
There are no provider credentials in this service. The target is the existing public API origin;
do not publish its address in snapshots or this generic repository. If origin ingress changes,
replace this check with a dedicated least-privilege monitor access mechanism.

The browser reads the hosted public JSON, never the application API. The fallback reads the
exact public raw-GitHub snapshot. Every service becomes unknown after 45 minutes without a fresh
observation, including when Actions is delayed or monitoring stops. Gray historical days are
unobserved. Percentages are ratios of recorded pass/fail checks, not continuous uptime.
History starts at the first real check; there is no invented 90-day history. Keep 48 hours of raw
observations and 90 daily aggregates. Automated incidents record observed failure and subsequent
recovery only; unknown does not resolve an incident. These checks do not prove every application
feature or user session works.

## Commands

Node 22 or newer; no runtime packages or dependency install.

```text
node --test tests/*.test.mjs
node scripts/monitor.mjs
node scripts/build.mjs
```

The monitor requires the target secret in its environment. The builder reads only validated
public files and writes the fixed `dist` directory. For the separate fallback build, set
`STATUS_DATA_URL=https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json`
and install `fallback-workflow.yml` as `.github/workflows/deploy.yml`, leaving Pages cname unset.
Artifacts retain for one day; no action caches or paid runners. Source changes deploy on push;
schedule/manual runs commit only the validated snapshot and then deploy.

Independent hosting survives application/CDN/API failures, but GitHub Pages/Actions/Raw share a
provider. The custom domain still uses Cloudflare authoritative DNS; bookmark the github.io
fallback for a DNS problem. No service can promise availability through every provider outage.
