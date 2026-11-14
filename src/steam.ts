import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

export const APP_ID = "431960";

function steamRoots(): string[] {
  return [
    join(homedir(), ".steam/steam"),
    join(homedir(), ".steam/root"),
    join(homedir(), ".local/share/Steam"),
    "/usr/local/share/steam",
    "/usr/share/steam",
  ].map((path) => resolve(path)).filter((path, index, paths) => paths.indexOf(path) === index);
}

function libraryPaths(): string[] {
  const libraries: string[] = [];
  for (const root of steamRoots()) {
    if (existsSync(join(root, "steamapps"))) libraries.push(root);
    try {
      const vdf = readFileSync(join(root, "steamapps/libraryfolders.vdf"), "utf8");
      for (const match of vdf.matchAll(/"path"\s*"([^"]+)"/g)) {
        libraries.push(resolve(match[1].replace(/\\\\/g, "/")));
      }
    } catch { /* This Steam root may not have a library list. */ }
  }
  return libraries.filter((path, index, paths) => paths.indexOf(path) === index);
}

export function findWorkshopPath(): string | undefined {
  return libraryPaths().map((library) => join(library, "steamapps/workshop/content", APP_ID))
    .find((path) => existsSync(path));
}

export function findWallpaperEngineAssets(): string | undefined {
  return libraryPaths().map((library) => join(library, "steamapps/common/wallpaper_engine/assets"))
    .find((path) => existsSync(path));
}

export function findWallpaperEngineLibrary(): string | undefined {
  return libraryPaths().find((library) => existsSync(join(library, "steamapps/common/wallpaper_engine")));
}
