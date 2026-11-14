import { Grid, ActionPanel, Action, showToast, Toast, closeMainWindow, environment } from "@vicinae/api";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { useMemo, useState } from "react";
import { findWorkshopPath } from "./steam";

const SCRIPT = join(environment.assetsPath, "wpengine-pick.sh");
const PERFORMANCE_STATE = join(homedir(), ".cache", "wpengine-performance");

type Wallpaper = { id: string; dir: string; title: string; preview: string };

function loadWallpapers(): Wallpaper[] {
  const out: Wallpaper[] = [];
  const workshop = findWorkshopPath();
  if (!workshop) return out;
  let ids: string[] = [];
  try { ids = readdirSync(workshop); } catch { return out; }

  for (const id of ids) {
    const dir = join(workshop, id);
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

type PerformanceMode = "low" | "medium" | "high";

function loadPerformance(): PerformanceMode {
  try {
    const saved = readFileSync(PERFORMANCE_STATE, "utf8").trim();
    if (saved === "low" || saved === "high") return saved;
  } catch {}
  return "medium";
}

function performanceLabel(mode: PerformanceMode) {
  return mode === "low" ? "Low · 15 FPS" : mode === "high" ? "High · 60 FPS" : "Medium · 30 FPS";
}

async function apply(w: Wallpaper, mode: "duplicate" | "extend", performance: PerformanceMode) {
  spawn(SCRIPT, ["--apply", w.dir, mode, performance], { detached: true, stdio: "ignore" }).unref();
  await showToast({ style: Toast.Style.Success, title: `Applying ${w.title}`, message: `${mode === "extend" ? "Spanning" : "Duplicating"} monitors · ${performanceLabel(performance)}` });
  await closeMainWindow();
}

export default function Command() {
  const items = useMemo(loadWallpapers, []);
  const [performance, setPerformance] = useState<PerformanceMode>(loadPerformance);

  function updatePerformance(value: string) {
    const mode: PerformanceMode = value === "low" || value === "high" ? value : "medium";
    mkdirSync(join(homedir(), ".cache"), { recursive: true });
    writeFileSync(PERFORMANCE_STATE, `${mode}\n`);
    setPerformance(mode);
    showToast({ style: Toast.Style.Success, title: `Performance set to ${performanceLabel(mode)}` });
  }

  return (
    <Grid columns={4} aspectRatio="16/9" fit={"fill" as Grid.Props["fit"]} searchBarPlaceholder="Search wallpapers..."
      searchBarAccessory={
        <Grid.Dropdown tooltip="Wallpaper performance" value={performance} onChange={updatePerformance}>
          <Grid.Dropdown.Item title="Low · 15 FPS" value="low" />
          <Grid.Dropdown.Item title="Medium · 30 FPS" value="medium" />
          <Grid.Dropdown.Item title="High · 60 FPS" value="high" />
        </Grid.Dropdown>
      }>
      {items.map((w) => (
        <Grid.Item
          key={w.id}
          title={w.title}
          keywords={[w.id]}
          content={{ source: w.preview }}
          actions={
            <ActionPanel>
              <Action title="Set Wallpaper on All Monitors" onAction={() => apply(w, "duplicate", performance)} />
              <Action title="Extend Across All Monitors" onAction={() => apply(w, "extend", performance)} />
            </ActionPanel>
          }
        />
      ))}
    </Grid>
  );
}
