#!/bin/bash
#
# Align — offline server for macOS.
#
# Double-click this file in the Finder (or run `bash mac-offline.command` in a
# terminal) and Align opens at http://localhost:8177/ served from the files in
# this folder — no internet needed at all. localhost is a secure context, so
# the microphone works with the measurement, fully offline.
#
# If macOS refuses to run it the first time ("cannot be opened because it is
# from an unidentified developer"), right-click the file → Open, once, or run:
#   xattr -d com.apple.quarantine mac-offline.command
#
# The server needs Python 3. macOS offers it through the Command Line Tools:
#   xcode-select --install
#
set -e

# The Finder launches scripts from the home folder; find the app files by the
# script's own location, wherever the folder was unzipped.
cd "$(dirname "${BASH_SOURCE[0]}")"

PY=""
for candidate in python3 python; do
  if command -v "$candidate" > /dev/null 2>&1; then
    PY="$candidate"
    break
  fi
done
if [ -z "$PY" ]; then
  echo "No Python found. Install the Command Line Tools (they include it):"
  echo "  xcode-select --install"
  read -p "Press Return to close…"
  exit 1
fi

# A port already serving something is skipped, so re-running while one copy is
# up opens a second instance instead of a confusing half-state.
PORT=""
for candidate in 8177 8178 8179 8180; do
  if ! curl --output /dev/null --silent "http://127.0.0.1:$candidate/" 2> /dev/null; then
    PORT="$candidate"
    break
  fi
done
if [ -z "$PORT" ]; then
  echo "No free port found — 8177 to 8180 are all serving something already."
  read -p "Press Return to close…"
  exit 1
fi

if [ "${1:-}" = "--selftest" ]; then
  # Verification mode: start the server, read one page back, stop. The page it
  # finds is whatever sits next to the script, so only the server is judged.
  "$PY" -m http.server "$PORT" > /dev/null 2>&1 &
  SERVER=$!
  trap 'kill $SERVER 2> /dev/null' EXIT
  sleep 1
  code=$("$PY" - <<PYEOF
import urllib.request, urllib.error
try:
    with urllib.request.urlopen("http://127.0.0.1:$PORT/", timeout=5) as r:
        print("HTTP", r.status)
except urllib.error.HTTPError as e:
    print("HTTP", e.code)  # a server answered — that is what is being verified
except Exception as e:
    print("ERR", e)
PYEOF
)
  case "$code" in
    HTTP\ *)
      echo "selftest OK: server answered ($code) on port $PORT"
      exit 0
      ;;
    *)
      echo "selftest FAILED: no answer on port $PORT ($code)"
      exit 1
      ;;
  esac
fi

echo "Starting the Align offline server…"
"$PY" -m http.server "$PORT" > /dev/null 2>&1 &
SERVER=$!
trap 'echo "Align offline server stopped."; kill $SERVER 2> /dev/null' EXIT
sleep 1

echo "Align is serving at http://localhost:$PORT/"
echo "Leave this window open while you work. Close the window (or press Ctrl-C) to stop."
open "http://localhost:$PORT/" || true

read -p "Press Return to stop the server…"
