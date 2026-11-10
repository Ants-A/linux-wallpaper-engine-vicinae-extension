#!/usr/bin/env bash
# wpengine-pick.sh — pick a wallpaper (vicinae), apply it, run matugen
# Usage: wpengine-pick.sh            (picker)
#        wpengine-pick.sh --restore  (relaunch last wallpaper, for autostart)

SCALING="fill"
LINKS="$HOME/.cache/wpengine-previews"
STATE="$HOME/.cache/wpengine-last"
FRAME="$HOME/.cache/wpengine-frame.png"

WORKSHOP="/mnt/slow-storage/SteamLibrary/steamapps/workshop/content/431960"
ASSETS="/mnt/slow-storage/SteamLibrary/steamapps/common/wallpaper_engine/assets"

detect_monitors() {
  if command -v hyprctl >/dev/null && hyprctl monitors -j >/dev/null 2>&1; then
    hyprctl monitors -j | jq -r '.[].name'
  elif command -v niri >/dev/null && niri msg --json outputs >/dev/null 2>&1; then
    niri msg --json outputs | jq -r 'keys[]'
  elif command -v wlr-randr >/dev/null; then
    wlr-randr | awk '/^[^ ]/ {print $1}'
  fi
}

launch() {   # $1 = wallpaper folder
  pkill -x linux-wallpaper 2>/dev/null
  mapfile -t MONITORS < <(detect_monitors)
  [ ${#MONITORS[@]} -eq 0 ] && { echo "No monitors detected" >&2; return 1; }
  args=(--assets-dir "$ASSETS" --silent)
  for m in "${MONITORS[@]}"; do
    args+=(--scaling "$SCALING" --screen-root "$m" --bg "$1")
  done
  setsid linux-wallpaperengine "${args[@]}" >"$HOME/.cache/wpengine.log" 2>&1 &
}

preview_of() {
  local dir="$1" p=""
  if [ -f "$dir/project.json" ]; then
    p=$(jq -r '.preview // empty' "$dir/project.json" 2>/dev/null)
    [ -n "$p" ] && [ -f "$dir/$p" ] && { echo "$dir/$p"; return; }
  fi
  ls "$dir"/preview.* 2>/dev/null | head -n1
}

apply() {   # $1 = wallpaper folder
  local dir="$1" real
  real=$(preview_of "$dir")
  echo "$dir" > "$STATE"
  if [ -n "$real" ]; then
    magick "${real}[0]" "$FRAME" || cp "$real" "$FRAME"
    matugen image "$FRAME" --source-color-index 0
  fi
  launch "$dir"
}

# --- Restore mode (autostart) ---
if [ "$1" = "--restore" ]; then
  for _ in $(seq 60); do
    [ -d "$ASSETS" ] && [ -d "$WORKSHOP" ] && break
    sleep 1
  done
  dir=$(cat "$STATE" 2>/dev/null)
  [ -d "$dir" ] && launch "$dir"
  exit 0
fi

# --- Apply mode (used by the vicinae extension) ---
if [ "$1" = "--apply" ]; then
  [ -d "$2" ] || exit 1
  apply "$2"
  exit 0
fi

# --- Picker mode (dmenu fallback) ---
[ -d "$WORKSHOP" ] || { echo "Workshop dir not found" >&2; exit 1; }
[ -d "$ASSETS" ]   || { echo "Assets dir not found" >&2; exit 1; }
mkdir -p "$HOME/.config/quickshell/assets"

list_previews() {
  rm -rf "$LINKS"; mkdir -p "$LINKS"
  for dir in "$WORKSHOP"/*/; do
    dir="${dir%/}"
    id=$(basename "$dir")
    prev=$(preview_of "$dir"); [ -z "$prev" ] && continue
    title=$(jq -r '.title // empty' "$dir/project.json" 2>/dev/null)
    [ -z "$title" ] && title="$id"
    safe=$(printf '%s' "$title" | tr '/\n' '--')
    ext="${prev##*.}"
    link="$LINKS/$safe.$ext"
    [ -e "$link" ] || [ -L "$link" ] && link="$LINKS/$safe ($id).$ext"
    ln -s "$prev" "$link"
    echo "$link"
  done | sort
}

choice=$(list_previews | vicinae dmenu -p "Pick a wallpaper...")
[ -z "$choice" ] && exit 0
[ -e "$choice" ] || exit 0
apply "$(dirname "$(readlink -f "$choice")")"
