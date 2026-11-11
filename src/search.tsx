import { Action, ActionPanel, Grid, Toast, closeMainWindow, environment, showToast } from "@vicinae/api";
import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { useEffect, useState } from "react";

const APP_ID = "431960";
const GRID_COLUMNS = 4;
const STEAM_LIBRARY = "/mnt/slow-storage/SteamLibrary";
const WORKSHOP = join(STEAM_LIBRARY, "steamapps/workshop/content", APP_ID);
const STEAMCMD_HOME = join(homedir(), ".steam/steamcmd");
const APPLY_SCRIPT = join(environment.assetsPath, "wpengine-pick.sh");
const PERFORMANCE_STATE = join(homedir(), ".cache", "wpengine-performance");

type Item = { id: string; title: string; preview: string };
type WorkshopPage = { items: Item[]; page: number; totalPages: number };
type PerformanceMode = "low" | "medium" | "high";

function loadPerformance(): PerformanceMode {
  try {
    const saved = readFileSync(PERFORMANCE_STATE, "utf8").trim();
    if (saved === "low" || saved === "high") return saved;
  } catch {}
  return "medium";
}

function decode(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseWorkshop(html: string): WorkshopPage {
  const items: Item[] = [];
  let page = 1;
  let totalPages = 1;
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
        if (Array.isArray(record.results) && typeof record.total_pages === "number") {
          page = typeof record.current_page === "number" ? record.current_page : page;
          totalPages = record.total_pages;
          for (const entry of record.results) {
            if (!entry || typeof entry !== "object") continue;
            const item = entry as Record<string, unknown>;
            if (typeof item.publishedfileid === "string" && typeof item.title === "string" && typeof item.preview_url === "string") {
              items.push({ id: item.publishedfileid, title: item.title, preview: item.preview_url });
            }
          }
          return;
        }
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
      if (items.length || totalPages !== 1) return { items, page, totalPages };
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
  return { items, page, totalPages };
}

async function searchWorkshop(query: string, hideAnime: boolean, allowMature: boolean, page: number): Promise<WorkshopPage> {
  const params = new URLSearchParams({ appid: APP_ID, searchtext: query, childpublishedfileid: "0", browsesort: "textsearch", section: "readytouseitems", p: String(page), num_per_page: "30" });
  if (hideAnime) params.append("excludedtags[]", "Anime");
  if (allowMature) params.set("include_adult", "1");
  const response = await fetch(`https://steamcommunity.com/workshop/browse/?${params}`, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Steam Workshop returned ${response.status}`);
  const html = await response.text();
  const result = parseWorkshop(html);
  if (!result.items.length && result.totalPages === 1 && !/no (?:items|results)|0 results/i.test(html)) {
    throw new Error("Steam returned a page, but no Workshop results could be read. Check Steam access or search directly on Steam Workshop.");
  }
  return result;
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

  const steamcmd = findExecutable("steamcmd");
  if (!steamcmd) {
    await showToast({ style: Toast.Style.Failure, title: "SteamCMD is required for direct downloads", message: "Install it with `sudo pacman -S steamcmd`, then press Enter again." });
    return;
  }
  const username = findSteamAccountName();
  if (!username) {
    await showToast({ style: Toast.Style.Failure, title: "Could not find your Steam account", message: "Sign in to Steam once, then try again." });
    return;
  }
  mkdirSync(STEAMCMD_HOME, { recursive: true });

  const toast = await showToast({ style: Toast.Style.Animated, title: `Downloading ${item.title}`, message: "Starting authenticated Steam Workshop download…" });
  const proc = spawn(steamcmd, ["+force_install_dir", STEAM_LIBRARY, "+login", username, "+workshop_download_item", APP_ID, item.id, "+quit"], { cwd: STEAMCMD_HOME, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let loginExpired = false;
  let loginConfirmed = false;
  let authTimeout: ReturnType<typeof setTimeout>;
  const update = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
    const pct = output.match(/(\d{1,3})%/g)?.at(-1);
    if (pct) toast.message = `Downloading ${item.title} · ${pct}`;
    if (/Logging in user .* to Steam Public.*OK|Logging in using cached credentials/i.test(output)) {
      loginConfirmed = true;
      clearTimeout(authTimeout);
    }
    if (/password:|steam guard|authenticator code|enter the code/i.test(output)) {
      loginExpired = true;
      proc.kill();
    }
  };
  proc.stdout.on("data", update);
  proc.stderr.on("data", update);
  authTimeout = setTimeout(() => {
    if (!loginConfirmed) { loginExpired = true; proc.kill(); }
  }, 45000);
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", (code) => { clearTimeout(authTimeout); resolve(code ?? 1); });
  }).catch((error: Error) => {
    output = error.message;
    return -1;
  });
  if (loginExpired) {
    startSteamCmdLogin(steamcmd, username);
    toast.style = Toast.Style.Failure;
    toast.title = "SteamCMD sign-in expired";
    toast.message = "Complete the Steam Guard sign-in in Kitty, then press Enter again.";
    return;
  }
  if (exitCode !== 0 || !folderHasPreview(item.id)) {
    toast.style = Toast.Style.Failure;
    toast.title = "Wallpaper download failed";
    toast.message = output.split("\n").filter(Boolean).slice(-1)[0] ?? "Check SteamCMD and your Steam account.";
    return;
  }
  toast.title = "Download complete";
  toast.message = `Applying ${item.title}`;
  toast.style = Toast.Style.Success;
  spawn(APPLY_SCRIPT, ["--apply", join(WORKSHOP, item.id)], { detached: true, stdio: "ignore" }).unref();
  await closeMainWindow();
}

function findExecutable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
}

function findSteamAccountName(): string | undefined {
  const paths = [
    join(homedir(), ".local/share/Steam/config/loginusers.vdf"),
    join(homedir(), ".steam/steam/config/loginusers.vdf"),
    join(homedir(), ".steam/root/config/loginusers.vdf"),
  ];
  for (const path of paths) {
    try {
      const content = readFileSync(path, "utf8");
      const entries = [...content.matchAll(/"\d+"\s*\{([^{}]*)\}/g)].map((match) => match[1]);
      const entry = entries.find((block) => /"MostRecent"\s*"1"/.test(block)) ?? entries[0];
      const username = entry?.match(/"AccountName"\s*"([^"]+)"/)?.[1];
      if (username) return username;
    } catch { /* Try the next Steam library location. */ }
  }
}

function startSteamCmdLogin(steamcmd: string, username: string) {
  const kitty = findExecutable("kitty");
  if (!kitty) return;
  const terminal = spawn(kitty, ["--directory", STEAMCMD_HOME, "--hold", "-e", steamcmd, "+login", username], { detached: true, stdio: "ignore" });
  terminal.unref();
}

function openWorkshopPage(id: string) {
  const steam = spawn("steam", [`steam://url/CommunityFilePage/${id}`], { detached: true, stdio: "ignore" });
  steam.on("error", (error) => showToast({ style: Toast.Style.Failure, title: "Could not open Steam", message: error.message }));
  steam.unref();
  void floatSteamWorkshopWindow();
}

async function floatSteamWorkshopWindow() {
  const hyprctl = findExecutable("hyprctl");
  if (!hyprctl || !/hyprland/i.test(process.env.XDG_CURRENT_DESKTOP ?? "")) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const clients = JSON.parse(execFileSync(hyprctl, ["clients", "-j"], { encoding: "utf8" })) as Array<{ address: string; class: string; floating: boolean; focusHistoryID?: number }>;
      const steamClient = clients.filter((client) => /steam/i.test(client.class)).sort((a, b) => (a.focusHistoryID ?? 9999) - (b.focusHistoryID ?? 9999))[0];
      if (steamClient) {
        const monitors = JSON.parse(execFileSync(hyprctl, ["monitors", "-j"], { encoding: "utf8" })) as Array<{ focused: boolean; width: number; height: number; scale: number }>;
        const monitor = monitors.find((entry) => entry.focused) ?? monitors[0];
        if (!monitor) return;
        const scale = monitor.scale || 1;
        const width = Math.round(monitor.width * 0.75 / scale);
        const height = Math.round(monitor.height * 0.75 / scale);
        execFileSync(hyprctl, ["dispatch", "focuswindow", `address:${steamClient.address}`], { stdio: "ignore" });
        if (!steamClient.floating) execFileSync(hyprctl, ["dispatch", "togglefloating", `address:${steamClient.address}`], { stdio: "ignore" });
        execFileSync(hyprctl, ["dispatch", "resizeactive", "exact", String(width), String(height)], { stdio: "ignore" });
        execFileSync(hyprctl, ["dispatch", "centerwindow"], { stdio: "ignore" });
        return;
      }
    } catch { /* The Steam window may not exist yet; retry briefly. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function directoryBytes(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return total + directoryBytes(path);
      if (entry.isFile()) return total + statSync(path).size;
      return total;
    }, 0);
  } catch { return 0; }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Command() {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [hideAnime, setHideAnime] = useState(false);
  const [performance, setPerformance] = useState<PerformanceMode>(loadPerformance);
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
        const result = await searchWorkshop(term, hideAnime, false, page);
        if (active) {
          setItems((current) => page === 1 ? result.items : [...current, ...result.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
          setTotalPages(result.totalPages);
        }
      } catch (e) {
        if (active) { setItems([]); setError(e instanceof Error ? e.message : "Search failed"); }
      } finally { if (active) setLoading(false); }
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [query, hideAnime, page]);

  const updateQuery = (value: string) => { setQuery(value); setPage(1); setItems([]); setTotalPages(0); };
  const updateAnime = (value: string) => { setHideAnime(value === "hide"); setPage(1); setItems([]); setTotalPages(0); };
  const updatePerformance = (value: string) => {
    const mode: PerformanceMode = value === "low" || value === "high" ? value : "medium";
    mkdirSync(join(homedir(), ".cache"), { recursive: true });
    writeFileSync(PERFORMANCE_STATE, `${mode}\n`);
    setPerformance(mode);
  };
  const loadMore = () => { if (!loading && page < totalPages) setPage((current) => current + 1); };
  const handleSelectionChange = (id: string) => {
    const selectedIndex = items.findIndex((item) => item.id === id);
    if (items.length >= GRID_COLUMNS && selectedIndex >= items.length - GRID_COLUMNS) loadMore();
  };

  return (
    <Grid columns={GRID_COLUMNS} aspectRatio="16/9" fit={"fill" as Grid.Props["fit"]} isLoading={loading} searchText={query} onSearchTextChange={updateQuery} onSelectionChange={handleSelectionChange} searchBarPlaceholder="Search Steam Workshop wallpapers..."
      searchBarAccessory={<>
        <Grid.Dropdown tooltip="Anime results" value={hideAnime ? "hide" : "show"} onChange={updateAnime}>
          <Grid.Dropdown.Item title="Show anime" value="show" />
          <Grid.Dropdown.Item title="Hide anime" value="hide" />
        </Grid.Dropdown>
        <Grid.Dropdown tooltip="Wallpaper performance" value={performance} onChange={updatePerformance}>
          <Grid.Dropdown.Item title="Low · 15 FPS" value="low" />
          <Grid.Dropdown.Item title="Medium · 30 FPS" value="medium" />
          <Grid.Dropdown.Item title="High · 60 FPS" value="high" />
        </Grid.Dropdown>
      </>}>
      {error ? <Grid.EmptyView title="Steam Workshop search failed" description={error} /> : !query.trim() ? <Grid.EmptyView title="Search Steam Workshop" description="Type a wallpaper name or tag to browse community wallpapers." /> : items.length === 0 && !loading ? <Grid.EmptyView title="No wallpapers found" /> : null}
      {items.map((item) => <Grid.Item key={item.id} id={item.id} title={item.title} subtitle={item.id} content={{ source: item.preview }} actions={<ActionPanel>
        <Action title="Download and Set Wallpaper" onAction={() => download(item)} />
        <Action title="Open Workshop in Steam" onAction={() => openWorkshopPage(item.id)} />
      </ActionPanel>} />)}
    </Grid>
  );
}
