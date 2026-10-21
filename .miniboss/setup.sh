#!/bin/sh
# MiniBoss project setup — runs once per container, as root.
#
# Only the tools THIS repository needs. The generic toolbox (jq, ripgrep,
# iproute2) is installed by the global sandbox script
# (`<data>/sandbox/setup.sh`), which applies to every project.
#
# sqlite3: the server stores everything in `data/chat.db` (better-sqlite3);
# without the CLI the agent cannot inspect the database it is working on.
set -e
missing=""
for tool in sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -z "$missing" ]; then
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends sqlite3
rm -rf /var/lib/apt/lists/*
