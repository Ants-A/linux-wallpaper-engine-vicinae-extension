#!/usr/bin/env bash
# Wait for Steam to register and finish installing the selected Workshop item.
set -u
library=$1 id=$2 picker=$3
[[ $id =~ ^[0-9]+$ ]] || exit 1
manifest="$library/steamapps/workshop/appworkshop_431960.acf"
dir="$library/steamapps/workshop/content/431960/$id"
pending="${XDG_CACHE_HOME:-$HOME/.cache}/wpengine-pending-subscription"
mkdir -p "${pending%/*}"
token="$$-$id"
printf '%s' "$token" > "$pending"
initial=$(stat -c '%Y:%s' "$manifest" 2>/dev/null || true)
for ((i=0; i<1800; i++)); do
  [[ $(cat "$pending" 2>/dev/null) == "$token" ]] || exit 0
  current=$(stat -c '%Y:%s' "$manifest" 2>/dev/null || true)
  if [[ -n $current && $current != "$initial" && -f "$dir/project.json" ]] &&
    awk -v id="$id" '
      /"WorkshopItemsInstalled"/ { installed=1; next }
      installed && $1 == "\"" id "\"" { found=1; exit }
      installed && /"WorkshopItemDetails"/ { exit }
      END { exit !found }
    ' "$manifest"; then
    "$picker" --apply "$dir"
    exit $?
  fi
  sleep 1
done
