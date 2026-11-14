#!/usr/bin/env bash
set -u
PICK="$HOME/Projects/Wallpaper-Engine-Linux/assets/wpengine-pick.sh"
was_fullscreen=0
while sleep 1; do
  instances=$(hyprctl instances -j 2>/dev/null) || continue
  signature=$(jq -r '.[0].instance // empty' <<<"$instances" 2>/dev/null)
  display=$(jq -r '.[0].wl_socket // empty' <<<"$instances" 2>/dev/null)
  [[ -n "$signature" && -n "$display" ]] || continue
  export HYPRLAND_INSTANCE_SIGNATURE="$signature" WAYLAND_DISPLAY="$display"
  clients=$(hyprctl -j clients 2>/dev/null) || continue
  jq -e 'type == "array"' <<<"$clients" >/dev/null 2>&1 || continue
  # Hyprland reports 1 for maximized, 2 for fullscreen, and 3 for both.
  if jq -e 'any(.[]; .fullscreen == 2 or .fullscreen == 3)' <<<"$clients" >/dev/null 2>&1; then
    pkill -x linux-wallpaper 2>/dev/null || true
    was_fullscreen=1
  elif (( was_fullscreen == 1 )); then
    "$PICK" --restore
    was_fullscreen=0
  fi
done
