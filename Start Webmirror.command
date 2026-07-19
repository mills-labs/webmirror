#!/bin/zsh
# Double-clickable launcher for the Webmirror control panel.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found on this Mac. Please install it, then try again."
  read -k 1 "?Press any key to close this window."
  exit 1
fi

if [[ ! -f dist/cli.js ]]; then
  echo "First-time setup (this happens only once)…"
  npm install && npm run build || {
    echo "Setup failed. Please report the messages above."
    read -k 1 "?Press any key to close this window."
    exit 1
  }
fi

echo "Starting the Webmirror control panel…"
echo "A page will open in your web browser. Keep THIS window open while you"
echo "use Webmirror; when you are finished, simply close this window."
echo
node bin/webmirror.js ui
