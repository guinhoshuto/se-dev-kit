import {readFile, realpath} from "node:fs/promises";
import {extname, posix, relative, resolve, sep} from "node:path";
import fg from "fast-glob";
import type {ResolvedProject} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {isInside} from "../shared/paths.js";

export interface AssetEntry {
  key: string;
  filePath: string;
  contentType: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".wasm": "application/wasm"
};

function portablePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

function localReferenceCandidates(source: string): string[] {
  const candidates = new Set<string>();
  const attributePattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const cssPattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  const quotedAssetPattern = /["']([^"']+\.(?:css|js|mjs|json|png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp3|ogg|wav|m4a|mp4|webm|mov|wasm)(?:\?[^"']*)?)["']/gi;
  for (const pattern of [attributePattern, cssPattern, quotedAssetPattern]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const raw = match[1]?.trim();
      if (!raw || /^(?:[a-z]+:|\/\/|#|data:|blob:)/i.test(raw)) continue;
      candidates.add(raw.split(/[?#]/, 1)[0] ?? raw);
    }
  }
  return [...candidates];
}

async function addFile(
  map: Map<string, AssetEntry>,
  project: ResolvedProject,
  filePath: string
): Promise<AssetEntry | undefined> {
  const realFile = await realpath(filePath).catch(() => undefined);
  if (!realFile || !isInside(project.widgetRoot, realFile)) return undefined;
  if (isInside(project.outputRoot, realFile)) return undefined;
  const key = portablePath(project.widgetRoot, realFile);
  if (!key || key.split("/").some((part) => part.startsWith("."))) return undefined;
  if (key === "se-widget-studio.config.mjs") return undefined;
  const extension = extname(realFile).toLowerCase();
  const contentType = MIME_TYPES[extension];
  if (!contentType) return undefined;
  const entry = {key, filePath: realFile, contentType};
  map.set(key, entry);
  return entry;
}

export async function buildAssetMap(project: ResolvedProject): Promise<Map<string, AssetEntry>> {
  const assets = new Map<string, AssetEntry>();
  const scanQueue: AssetEntry[] = [];
  for (const filePath of Object.values(project.files)) {
    const entry = await addFile(assets, project, filePath);
    if (entry) scanQueue.push(entry);
  }
  if (project.adapterPath) {
    const entry = await addFile(assets, project, project.adapterPath);
    if (entry) scanQueue.push(entry);
  }

  const configuredPatterns = project.config.widget.assets ?? ["assets/**/*", "fonts/**/*", "media/**/*"];
  if (configuredPatterns.length > 0) {
    const matches = await fg(configuredPatterns, {
      cwd: project.widgetRoot,
      absolute: true,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      unique: true
    });
    for (const match of matches) await addFile(assets, project, match);
  }

  const scanned = new Set<string>();
  while (scanQueue.length > 0) {
    const entry = scanQueue.shift();
    if (!entry || scanned.has(entry.filePath)) continue;
    scanned.add(entry.filePath);
    if (!/^text\/(?:html|css|javascript)|application\/json/.test(entry.contentType)) continue;
    const source = await readFile(entry.filePath, "utf8");
    const sourceDirectory = posix.dirname(entry.key);
    for (const reference of localReferenceCandidates(source)) {
      const normalized = posix.normalize(posix.join(sourceDirectory, reference.replaceAll("\\", "/")));
      if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) continue;
      const candidate = await addFile(assets, project, resolve(project.widgetRoot, normalized));
      if (candidate && !scanned.has(candidate.filePath)) scanQueue.push(candidate);
    }
  }

  return assets;
}

export function assetUrlPath(key: string): string {
  return `/__sws/widget/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function lookupAsset(map: Map<string, AssetEntry>, encodedKey: string): AssetEntry {
  let key: string;
  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    throw new StudioError("ASSET_NOT_FOUND", "Asset was not found.");
  }
  if (key.includes("\0") || key.includes("\\") || key.split("/").some((part) => part === ".." || part.startsWith("."))) {
    throw new StudioError("ASSET_NOT_FOUND", "Asset was not found.");
  }
  const asset = map.get(key);
  if (!asset) throw new StudioError("ASSET_NOT_FOUND", "Asset was not found.");
  return asset;
}
