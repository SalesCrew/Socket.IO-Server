#!/usr/bin/env sh
set -e

# Install dependencies (prefer CI for lockfile if available)
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# Start the Node app via package.json script
npm start


