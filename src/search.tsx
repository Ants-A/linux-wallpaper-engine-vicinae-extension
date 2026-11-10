import { Action, ActionPanel, Grid, Toast, closeMainWindow, environment, showToast } from "@vicinae/api";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { useEffect, useState } from "react";

const APP_ID = "431960";
const STEAM_LIBRARY = "/mnt/slow-storage/SteamLibrary";
const WORKSHOP = join(STEAM_LIBRARY, "steamapps/workshop/content", APP_ID);
const APPLY_SCRIPT = join(environment.assetsPath, "wpengine-pick.sh");

type Item = { id: string; title: string; preview: string };

function decode(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseWorkshop(html: string): Item[] {
  const items: Item[] = [];
  const ssr = html.match(/<script[^>]+id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (ssr) {
    try {
      const payload: unknown = JSON.parse(ssr);
      const visit = (value: unknown) => {
        // Steam serializes its SSR loaderData entries as JSON strings inside the outer JSON.
        if (typeof value === "string" && /^[\s]*[\[{]/.test(value)) {
          try { visit(JSON.parse(value)); } catch { /* Not a serialized JSON entry. */ }
          return;
        }
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        const id = record.publishedfileid;
        const title = record.title;
        const preview = record.preview_url;
        if (typeof id === "string" && typeof title === "string" && typeof preview === "string") {
          items.push({ id, title, preview });
          return;
        }
        Object.values(record).forEach(visit);
      };
      visit(payload);
      if (items.length) return items;
    } catch {
      // Fall back to the legacy HTML cards below if Steam changes its SSR payload.
    }
  }

  const ids = [...html.matchAll(/id="sharedfile_(\d+)"|data-publishedfileid="(\d+)"|sharedfiles\/filedetails\/\?id=(\d+)/gi)];
  const titles = [...html.matchAll(/class="[^"]*workshopItemTitle[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi)];
  const previews = [...html.matchAll(/<(?:img|source)\b[^>]*(?:src|data-src|srcset)="([^"]+)"[^>]*>/gi)];
  const nearest = <T extends { index?: number }>(matches: T[], position: number) => matches
    .filter((match) => match.index !== undefined && Math.abs(match.index - position) < 5000)
    .sort((a, b) => Math.abs((a.index ?? 0) - position) - Math.abs((b.index ?? 0) - position))[0];

  for (const match of ids) {
    const id = match[1] ?? match[2] ?? match[3];
    const position = match.index ?? 0;
    if (items.some((item) => item.id === id)) continue;
    const titleMatch = nearest(titles, position);
    const previewMatch = nearest(previews, position);
    const title = titleMatch?.[1];
    const preview = previewMatch?.[1]?.split(/\s+/)[0];
    if (title && preview) items.push({ id, title: decode(title.replace(/<[^>]+>/g, "").trim()), preview: decode(preview) });
  }
  return items;
}

async function searchWorkshop(query: string, hideAnime: boolean, allowMature: boolean): Promise<Item[]> {
  const params = new URLSearchParams({ appid: APP_ID, searchtext: query, browsesort: "textsearch", actualsort: "textsearch", section: "readytouseitems", p: "1", num_per_page: "30" });
  if (hideAnime) params.append("excludedtags[]", "Anime");
  if (allowMature) params.set("include_adult", "1");
  const response = await fetch(`https://steamcommunity.com/workshop/browse/?${params}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Steam Workshop returned ${response.status}`);
  const html = await response.text();
  const items = parseWorkshop(html);
  if (!items.length && !/no (?:items|results)|0 results/i.test(html)) {
    throw new Error("Steam returned a page, but no Workshop results could be read. Check Steam access or search directly on Steam Workshop.");
  }
  return items;
}

function folderHasPreview(id: string): boolean {
  const dir = join(WORKSHOP, id);
  if (!existsSync(dir)) return false;
  try {
    const project = JSON.parse(readFileSync(join(dir, "project.json"), "utf8").replace(/^\uFEFF/, ""));
    if (project.preview && existsSync(join(dir, project.preview))) return true;
    return readdirSync(dir).some((file) => file.startsWith("preview."));
  } catch { return false; }
}

async function download(item: Item) {
  if (folderHasPreview(item.id)) {
    await showToast({ style: Toast.Style.Animated, title: "Applying wallpaper", message: item.title });
    spawn(APPLY_SCRIPT, ["--apply", join(WORKSHOP, item.id)], { detached: true, stdio: "ignore" }).unref();
    await closeMainWindow();
    return;
  }

  const toast = await showToast({ style: Toast.Style.Animated, title: "Starting Steam Workshop download", message: item.title });
  const proc = spawn("steamcmd", ["+force_install_dir", STEAM_LIBRARY, "+login", "anonymous", "+workshop_download_item", APP_ID, item.id, "+quit"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const update = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-6000);
    const pct = output.match(/(\d{1,3})%/g)?.at(-1);
    if (pct) toast.message = `Downloading ${item.title} · ${pct}`;
  };
  proc.stdout.on("data", update);
  proc.stderr.on("data", update);
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => resolve(code ?? 1));
  }).catch(async (error: Error) => {
    await toast.hide();
    await showToast({ style: Toast.Style.Failure, title: "Could not start SteamCMD", message: error.message });
    return -1;
  });
  if (exitCode !== 0 || !folderHasPreview(item.id)) {
    await toast.hide();
    await showToast({ style: Toast.Style.Failure, title: "Wallpaper download failed", message: output.split("\n").filter(Boolean).slice(-1)[0] ?? "Check that SteamCMD is installed and Steam Workshop access is available." });
    return;
  }
  toast.title = "Download complete";
  toast.message = `Applying ${item.title}`;
  toast.style = Toast.Style.Success;
  spawn(APPLY_SCRIPT, ["--apply", join(WORKSHOP, item.id)], { detached: true, stdio: "ignore" }).unref();
  await closeMainWindow();
}

export default function Command() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [hideAnime, setHideAnime] = useState(false);
  const [allowMature, setAllowMature] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const term = query.trim();
    if (!term) { setItems([]); setLoading(false); setError(""); return; }
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const result = await searchWorkshop(term, hideAnime, allowMature);
        if (active) setItems(result);
      } catch (e) {
        if (active) { setItems([]); setError(e instanceof Error ? e.message : "Search failed"); }
      } finally { if (active) setLoading(false); }
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [query, hideAnime, allowMature]);

  return (
    <Grid columns={4} aspectRatio="16/9" fit={"fill" as Grid.Props["fit"]} isLoading={loading} searchText={query} onSearchTextChange={setQuery} searchBarPlaceholder="Search Steam Workshop wallpapers..."
      searchBarAccessory={<>
        <Grid.Dropdown tooltip="Anime results" value={hideAnime ? "hide" : "show"} onChange={(v) => setHideAnime(v === "hide")}>
          <Grid.Dropdown.Item title="Show anime" value="show" />
          <Grid.Dropdown.Item title="Hide anime" value="hide" />
        </Grid.Dropdown>
        <Grid.Dropdown tooltip="Mature content" value={allowMature ? "on" : "off"} onChange={(v) => setAllowMature(v === "on")}>
          <Grid.Dropdown.Item title="G · All ages" value="off" />
          <Grid.Dropdown.Item title="Allow R rated" value="on" />
        </Grid.Dropdown>
      </>}>
      {error ? <Grid.EmptyView title="Steam Workshop search failed" description={error} /> : !query.trim() ? <Grid.EmptyView title="Search Steam Workshop" description="Type a wallpaper name or tag to browse community wallpapers." /> : items.length === 0 && !loading ? <Grid.EmptyView title="No wallpapers found" /> : null}
      {items.map((item) => <Grid.Item key={item.id} id={item.id} title={item.title} subtitle={item.id} content={{ source: item.preview }} actions={<ActionPanel><Action title="Download and Set Wallpaper" onAction={() => download(item)} /></ActionPanel>} />)}
    </Grid>
  );
}
