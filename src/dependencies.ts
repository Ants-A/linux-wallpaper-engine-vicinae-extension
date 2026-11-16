import { accessSync, constants } from "fs";
import { join } from "path";
import { showToast, Toast } from "@vicinae/api";

export async function checkDependencies(): Promise<boolean> {
  const required = ["linux-wallpaperengine", "awww", "identify", "jq", "matugen"];
  const missing = required.filter((name) => !(process.env.PATH ?? "").split(":").some((dir) => {
    try { accessSync(join(dir || ".", name), constants.X_OK); return true; } catch { return false; }
  }));
  if (missing.length) {
    await showToast({ style: Toast.Style.Failure, title: "Missing required programs", message: `Install or add to PATH: ${missing.join(", ")}` });
    return false;
  }
  return true;
}
