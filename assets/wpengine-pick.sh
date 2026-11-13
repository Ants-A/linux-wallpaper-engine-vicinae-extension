#!/usr/bin/env bash
# wpengine-pick.sh — pick a wallpaper (vicinae), apply it, run matugen
# Usage: wpengine-pick.sh            (picker)
#        wpengine-pick.sh --restore  (relaunch last wallpaper, for autostart)

SCALING="fill"
LINKS="$HOME/.cache/wpengine-previews"
STATE="$HOME/.cache/wpengine-last"
MODE_STATE="$HOME/.cache/wpengine-mode"
PERF_STATE="$HOME/.cache/wpengine-performance"
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
  local mode="${2:-$(cat "$MODE_STATE" 2>/dev/null)}"
  local performance="${3:-$(cat "$PERF_STATE" 2>/dev/null)}"
  pkill -x linux-wallpaper 2>/dev/null
  mapfile -t MONITORS < <(detect_monitors)
  [ ${#MONITORS[@]} -eq 0 ] && { echo "No monitors detected" >&2; return 1; }
  args=(--assets-dir "$ASSETS" --silent)
  case "$performance" in
    low) args+=(--fps 15) ;;
    high) args+=(--fps 60) ;;
    *) args+=(--fps 30) ;;
  esac
  if [ "$mode" = "extend" ] && [ ${#MONITORS[@]} -gt 1 ]; then
    local joined
    joined=$(IFS=,; echo "${MONITORS[*]}")
    args+=(--scaling "$SCALING" --screen-span "$joined" --bg "$1")
  else
    for m in "${MONITORS[@]}"; do
      args+=(--scaling "$SCALING" --screen-root "$m" --bg "$1")
    done
  fi
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

render_wallpaper_frame() {   # $1 = wallpaper folder; render natively at output resolution
  local dir="$1" monitor render pid
  mapfile -t MONITORS < <(detect_monitors)
  [ ${#MONITORS[@]} -gt 0 ] || return 1
  monitor="${MONITORS[0]}"
  render="$FRAME.render.png"
  rm -f "$render"
  pkill -x linux-wallpaper 2>/dev/null || true
  linux-wallpaperengine --assets-dir "$ASSETS" --silent --fps 30 \
    --screenshot "$render" --screenshot-delay 30 \
    --screen-root "$monitor" --scaling "$SCALING" --bg "$dir" \
    >"$HOME/.cache/wpengine-render.log" 2>&1 &
  pid=$!
  for _ in $(seq 1 120); do
    if [ -s "$render" ] && identify "$render" >/dev/null 2>&1; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      mv "$render" "$FRAME"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$render"
  return 1
}

apply() {   # $1 = wallpaper folder
  local dir="$1" mode="${2:-duplicate}" performance="${3:-medium}" real
  real=$(preview_of "$dir")
  echo "$dir" > "$STATE"
  printf '%s\n' "$mode" > "$MODE_STATE"
  printf '%s\n' "$performance" > "$PERF_STATE"
  if [ -n "$real" ]; then
    if render_wallpaper_frame "$dir"; then
      command -v awww >/dev/null && awww img "$FRAME" --transition-type none
      matugen image "$FRAME" --source-color-index 0
    else
      echo "Could not render a native-resolution frame; keeping the current awww image" >&2
    fi
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
  [ -d "$dir" ] && launch "$dir" "$(cat "$MODE_STATE" 2>/dev/null)" "$(cat "$PERF_STATE" 2>/dev/null)"
  exit 0
fi

# --- Apply mode (used by the vicinae extension) ---
if [ "$1" = "--apply" ]; then
  [ -d "$2" ] || exit 1
  mode="${3:-duplicate}"
  [ "$mode" = "extend" ] || mode="duplicate"
  performance="${4:-$(cat "$PERF_STATE" 2>/dev/null)}"
  case "$performance" in low|high) ;; *) performance="medium" ;; esac
  apply "$2" "$mode" "$performance"
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
