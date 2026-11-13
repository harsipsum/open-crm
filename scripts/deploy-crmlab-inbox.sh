#!/usr/bin/env bash
# Deploy branch grok/inbox to crmlab (staging) on the Ralveto EveryApp gateway, then set the Inbox token.
# Needs one Cloudflare device approval the first time (everyapp login prints a link + code).
set -euo pipefail
cd "$(dirname "$0")/.."
grep -q 'id: "crmlab"' everyapp.config.ts || { echo "refusing: this checkout is not the crmlab id"; exit 1; }
pnpm exec everyapp status >/dev/null 2>&1 || pnpm exec everyapp login
pnpm exec everyapp deploy --gateway https://apps.ralveto.com
INBOX_API_TOKEN="$(cat /workspace/wa-cloud/.inbox_token)" pnpm exec everyapp secret set INBOX_API_TOKEN --from-env INBOX_API_TOKEN --app crmlab
