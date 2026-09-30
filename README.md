# Yomumi Status fallback

Status-only static UI at https://lumichandesu.github.io/yomumi-status-fallback/.
This repository contains only newly authored generic status assets. It contains no private
application code, monitoring credentials, provider responses or application navigation.

Leave the GitHub Pages custom domain unset. The github.io address is the backup when the
main website or its Cloudflare DNS is unavailable. The browser reads two fixed, read-only snapshots:
https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json and
https://yomumi-status-monitor.yomumi.workers.dev/status.json. Neither public read starts probes.
It selects the newest validated observation, rejects future timestamps and refuses to move backward.
One unavailable or hung source does not hide the other beyond the six-second request deadline.
Snapshots older than 45 minutes become unknown; history is actual recorded checks only.

The separate snapshot Worker runs a 15-minute Cron; GitHub Actions remains a secondary observer.
This fallback holds no API target or credentials and runs no probes. GitHub hosts both static sites
and the raw snapshot; the separate producer shares Cloudflare infrastructure. During a producer
outage the GitHub source remains available, or UNKNOWN when all observations are stale.
These paths do not guarantee availability through every provider outage.

Node 22 or newer; no external dependencies. The deploy workflow sets STATUS_DATA_URL to the
exact raw-GitHub snapshot before node scripts/build.mjs. Source pushes and manual dispatches
publish a tiny Pages artifact retained for one day. Never add a CNAME/custom domain here.
