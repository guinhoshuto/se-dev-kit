import {readFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import fg from "fast-glob";
import {z} from "zod";
import type {CaptureVariant, MarketplacePreset, RecipeDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assertSafeId} from "../shared/ids.js";
import {jsonObjectSchema} from "./schemas.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const presetSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    marketplace: z.string().min(1),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sources: z.array(z.object({url: z.string().url(), scope: z.string().min(1)}).strict()).min(1),
    constraints: jsonObjectSchema,
    recipeDefaults: jsonObjectSchema.optional(),
    validation: z
      .object({
        images: z
          .object({
            maximumCount: z.number().int().min(1).optional(),
            formats: z.array(z.string().min(1)).optional(),
            minimumWidth: z.number().int().min(1).optional(),
            minimumHeight: z.number().int().min(1).optional(),
            requireOpaque: z.boolean().optional()
          })
          .strict()
          .optional(),
        video: z
          .object({
            maximumCount: z.number().int().min(1).optional(),
            formats: z.array(z.string().min(1)).optional(),
            minimumDurationMs: z.number().int().min(1).optional(),
            maximumDurationMs: z.number().int().min(1).optional(),
            minimumWidth: z.number().int().min(1).optional(),
            minimumHeight: z.number().int().min(1).optional(),
            aspectRatios: z.array(z.string().regex(/^\d+:\d+$/)).optional(),
            audio: z.literal("none").optional(),
            maximumBytes: z.number().int().min(1).optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict();

export async function loadMarketplacePresets(): Promise<MarketplacePreset[]> {
  const files = await fg("presets/marketplaces/*.json", {cwd: packageRoot, absolute: true, onlyFiles: true});
  const presets: MarketplacePreset[] = [];
  const ids = new Set<string>();
  for (const file of files.sort()) {
    const parsedJson = JSON.parse(await readFile(file, "utf8")) as unknown;
    const parsed = presetSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new StudioError(
        "INVALID_MARKETPLACE_PRESET",
        `Invalid marketplace preset ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
      );
    }
    assertSafeId(parsed.data.id, "marketplace preset id");
    if (ids.has(parsed.data.id)) throw new StudioError("DUPLICATE_ID", `Duplicate marketplace preset id: ${parsed.data.id}`);
    ids.add(parsed.data.id);
    presets.push(parsed.data as MarketplacePreset);
  }
  return presets;
}

export async function loadMarketplacePreset(id: string): Promise<MarketplacePreset> {
  assertSafeId(id, "marketplace preset id");
  const preset = (await loadMarketplacePresets()).find((item) => item.id === id);
  if (!preset) throw new StudioError("MARKETPLACE_PRESET_NOT_FOUND", `Marketplace preset not found: ${id}`);
  return preset;
}

function isOpaqueBackground(variant: CaptureVariant): boolean {
  const color = variant.background.color?.trim().toLowerCase();
  if (!color || color === "transparent") return false;
  if (/^#[\da-f]{8}$/i.test(color)) return color.slice(-2) === "ff";
  if (/^#[\da-f]{4}$/i.test(color)) return color.at(-1) === "f";
  const functionalAlpha = color.match(/(?:\/|,)\s*([\d.]+%?)\s*\)$/)?.[1];
  if (functionalAlpha === undefined) return true;
  return functionalAlpha.endsWith("%")
    ? Number(functionalAlpha.slice(0, -1)) >= 100
    : Number(functionalAlpha) >= 1;
}

function ratioMatches(width: number, height: number, ratios: string[]): boolean {
  return ratios.some((ratio) => {
    const [left, right] = ratio.split(":").map(Number);
    return Boolean(left && right && Math.abs(width / height - left / right) < 0.001);
  });
}

export function marketplaceRecipeIssues(
  recipe: RecipeDefinition,
  preset: MarketplacePreset,
  variants: CaptureVariant[]
): string[] {
  const issues: string[] = [];
  const imageRules = preset.validation?.images;
  const videoRules = preset.validation?.video;
  const createsImages = recipe.outputs?.screenshots !== false;
  const video = recipe.outputs?.video?.enabled ? recipe.outputs.video : undefined;

  if (createsImages && imageRules) {
    if (imageRules.maximumCount && variants.length > imageRules.maximumCount) {
      issues.push(`image count ${variants.length} exceeds ${imageRules.maximumCount}`);
    }
    for (const variant of variants) {
      const width = variant.scene.crop?.width ?? variant.output.width;
      const height = variant.scene.crop?.height ?? variant.output.height;
      const format = (variant.output.format ?? "png") === "jpeg" ? "jpg" : "png";
      if (imageRules.formats && !imageRules.formats.includes(format)) issues.push(`${variant.id} uses unsupported image format ${format}`);
      if (imageRules.minimumWidth && width < imageRules.minimumWidth) issues.push(`${variant.id} width ${width} is below ${imageRules.minimumWidth}`);
      if (imageRules.minimumHeight && height < imageRules.minimumHeight) issues.push(`${variant.id} height ${height} is below ${imageRules.minimumHeight}`);
      if (imageRules.requireOpaque && !isOpaqueBackground(variant)) issues.push(`${variant.id} does not have an opaque background color`);
    }
  }

  if (video && videoRules) {
    if (videoRules.maximumCount && variants.length > videoRules.maximumCount) {
      issues.push(`video count ${variants.length} exceeds ${videoRules.maximumCount}`);
    }
    const format = video.format ?? "mp4";
    if (videoRules.formats && !videoRules.formats.includes(format)) issues.push(`video format ${format} is not allowed`);
    if (videoRules.minimumDurationMs && video.durationMs < videoRules.minimumDurationMs) {
      issues.push(`video duration ${video.durationMs}ms is below ${videoRules.minimumDurationMs}ms`);
    }
    if (videoRules.maximumDurationMs && video.durationMs > videoRules.maximumDurationMs) {
      issues.push(`video duration ${video.durationMs}ms exceeds ${videoRules.maximumDurationMs}ms`);
    }
    for (const variant of variants) {
      const width = variant.scene.crop?.width ?? variant.output.width;
      const height = variant.scene.crop?.height ?? variant.output.height;
      if (videoRules.minimumWidth && width < videoRules.minimumWidth) issues.push(`${variant.id} width ${width} is below ${videoRules.minimumWidth}`);
      if (videoRules.minimumHeight && height < videoRules.minimumHeight) issues.push(`${variant.id} height ${height} is below ${videoRules.minimumHeight}`);
      if (videoRules.aspectRatios && !ratioMatches(width, height, videoRules.aspectRatios)) {
        issues.push(`${variant.id} aspect ratio ${width}:${height} is not one of ${videoRules.aspectRatios.join(", ")}`);
      }
    }
    if (videoRules.audio === "none" && (video.audio ?? "none") !== "none") issues.push("video audio must be none");
  }
  return [...new Set(issues)];
}
