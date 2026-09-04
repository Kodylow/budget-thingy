#!/bin/bash
set -e
pnpm install --no-frozen-lockfile
node scripts/baseline-drizzle.mjs
pnpm --filter @workspace/db run migrate
