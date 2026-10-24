import { Grid, ActionPanel, Action, showToast, Toast, closeMainWindow } from "@vicinae/api";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { useMemo } from "react";

const WORKSHOP = "/mnt/slow-storage/SteamLibrary/steamapps/workshop/content/431960";
const SCRIPT = join(homedir(), ".local/bin/wpengine-pick.sh");

type Wallpaper = { id: string; dir: string; title: string; preview: string };

function loadWallpapers(): Wallpaper[] {
  const out: Wallpaper[] = [];
  let ids: string[] = [];
  try { ids = readdirSync(WORKSHOP); } catch { return out; }

  for (const id of ids) {
    const dir = join(WORKSHOP, id);
    try {
      const raw = readFileSync(join(dir, "project.json"), "utf8").replace(/^\uFEFF/, "");
      const pj = JSON.parse(raw);
      let preview = pj.preview ? join(dir, pj.preview) : "";
      if (!preview || !existsSync(preview)) {
        const f = readdirSync(dir).find((n) => n.startsWith("preview."));
        if (!f) continue;
        preview = join(dir, f);
      }
      out.push({ id, dir, title: pj.title || id, preview });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

async function apply(w: Wallpaper) {
  spawn(SCRIPT, ["--apply", w.dir], { detached: true, stdio: "ignore" }).unref();
  await showToast({ style: Toast.Style.Success, title: `Applying ${w.title}` });
  await closeMainWindow();
}

export default function Command() {
  const items = useMemo(loadWallpapers, []);

  return (
    <Grid columns={4} aspectRatio="16/9" fit={Grid.Fit.Fill} searchBarPlaceholder="Search wallpapers...">
      {items.map((w) => (
        <Grid.Item
          key={w.id}
          title={w.title}
          keywords={[w.id]}
          content={{ source: w.preview }}
          actions={
            <ActionPanel>
              <Action title="Set Wallpaper" onAction={() => apply(w)} />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}
