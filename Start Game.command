#!/bin/zsh
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print 'Install Node.js 22.12 or newer, then run this file again.'
  read '?Press Enter to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci || exit 1
fi
print 'APEX opens at http://127.0.0.1:5173. Keep this terminal open while playing.'
# work/leaderboard-db is unreadable (see README); use the working local database.
export DATA_DIR="${DATA_DIR:-work/party-preview-db}"
npm run dev
