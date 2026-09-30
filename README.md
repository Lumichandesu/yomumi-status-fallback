# Yomumi Status fallback

Status-only static UI at https://lumichandesu.github.io/yomumi-status-fallback/.
This repository contains only newly authored generic status assets. It contains no private
application code, monitoring credentials, provider responses or application navigation.

Leave the GitHub Pages custom domain unset. The github.io address is the backup when the
main website or its Cloudflare DNS is unavailable. Public snapshots are read only from
https://raw.githubusercontent.com/Lumichandesu/yomumi-status/main/public/status.json.
Snapshots older than45minutes become unknown; history is actual recorded checks only.

The primary status repository runs the15-minute monitoring workflow. This fallback does
not run probes or hold an API target secret. Both UI hosting and the snapshot still share
GitHub as a provider; this is not a guarantee against a GitHub outage.

Node22or newer; no external dependencies. The deploy workflow sets STATUS_DATA_URL to the
exact public snapshot before `node scripts/build.mjs`. Source pushes and manual dispatches
publish a tiny Pages artifact retained for one day. Never add a CNAME/custom domain here.