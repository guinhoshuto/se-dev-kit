import {z} from "zod";

const jsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(jsonValueSchema)])
);
export const jsonObjectSchema = z.record(jsonValueSchema);

export const viewportSchema = z
  .object({
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    deviceScaleFactor: z.number().min(0.25).max(4).optional()
  })
  .strict();

export const readySchema = z
  .object({
    selector: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(100).max(120_000).optional()
  })
  .strict();

export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    widget: z
      .object({
        root: z.string().min(1).optional(),
        files: z
          .object({
            html: z.string().min(1).optional(),
            css: z.string().min(1).optional(),
            js: z.string().min(1).optional(),
            fields: z.string().min(1).optional()
          })
          .strict()
          .optional(),
        assets: z.array(z.string().min(1)).optional(),
        viewport: viewportSchema.optional(),
        ready: readySchema.optional(),
        adapter: z.string().min(1).optional()
      })
      .strict(),
    channel: jsonObjectSchema.optional(),
    themes: z.object({glob: z.string().min(1)}).strict().optional(),
    fixtures: z.object({glob: z.string().min(1)}).strict().optional(),
    scenarios: z.object({glob: z.string().min(1)}).strict().optional(),
    scenes: z.object({glob: z.string().min(1)}).strict().optional(),
    recipes: z.object({glob: z.string().min(1)}).strict().optional(),
    output: z.object({root: z.string().min(1)}).strict().optional()
  })
  .strict();

export const timelineEventSchema = z
  .object({
    atMs: z.number().int().min(0),
    listener: z.string().min(1),
    event: jsonValueSchema
  })
  .strict();

const backgroundSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    color: z.string().optional(),
    image: z.string().optional(),
    checkerboard: z.boolean().optional()
  })
  .strict();

const cameraSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().optional(),
    scale: z.number().min(0.05).max(20),
    x: z.number().min(-100_000).max(100_000),
    y: z.number().min(-100_000).max(100_000),
    origin: z.string().optional()
  })
  .strict();

const outputSchema = z
  .object({
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional()
  })
  .strict();

const cropSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384)
  })
  .strict();

export const themeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    fieldData: jsonObjectSchema
  })
  .strict();

export const fixtureSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    channel: jsonObjectSchema.optional(),
    recents: jsonObjectSchema.optional(),
    fieldData: jsonObjectSchema.optional(),
    events: z.array(timelineEventSchema).default([])
  })
  .strict();

const scenarioStepSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("dispatch"), listener: z.string().min(1), event: jsonValueSchema}).strict(),
  z.object({action: z.literal("updateFields"), fieldData: jsonObjectSchema}).strict(),
  z.object({action: z.literal("wait"), ms: z.number().int().min(0).max(120_000)}).strict(),
  z
    .object({
      action: z.literal("assert"),
      selector: z.string().min(1),
      exists: z.boolean().optional(),
      visible: z.boolean().optional(),
      count: z.number().int().min(0).optional(),
      text: z.string().optional(),
      attribute: z.object({name: z.string().min(1), value: z.string().optional()}).strict().optional()
    })
    .strict()
]);

export const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    theme: z.string().optional(),
    fixture: z.string().optional(),
    scene: z.string().optional(),
    steps: z.array(scenarioStepSchema)
  })
  .strict();

export const sceneSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    theme: z.string().optional(),
    fixture: z.string().optional(),
    fieldData: jsonObjectSchema.optional(),
    background: backgroundSchema.optional(),
    viewport: viewportSchema.optional(),
    output: outputSchema.optional(),
    camera: cameraSchema.optional(),
    crop: cropSchema.optional(),
    captureAtMs: z.number().int().min(0).max(600_000).optional()
  })
  .strict();

const thumbnailSchema = z
  .object({
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    fit: z.enum(["contain", "cover"]).optional(),
    format: z.enum(["png", "jpeg"]).optional()
  })
  .strict();

const videoSchema = z
  .object({
    enabled: z.boolean(),
    durationMs: z.number().int().min(100).max(600_000),
    fps: z.number().int().min(1).max(120),
    format: z.enum(["mp4", "webm"]).optional(),
    codec: z.enum(["h264", "vp9"]).optional(),
    pixelFormat: z.enum(["yuv420p", "yuva420p"]).optional(),
    audio: z.literal("none").optional()
  })
  .strict();

export const recipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    marketplacePreset: z.string().optional(),
    scenes: z.array(z.string().min(1)).min(1),
    matrix: z
      .object({
        themes: z.array(z.string().min(1)).optional(),
        backgrounds: z.array(backgroundSchema).optional(),
        viewports: z.array(viewportSchema.extend({id: z.string().min(1), label: z.string().optional()})).optional(),
        cameras: z.array(cameraSchema).optional()
      })
      .strict()
      .optional(),
    outputs: z
      .object({
        screenshots: z.boolean().optional(),
        thumbnails: thumbnailSchema.optional(),
        contactSheet: z.boolean().optional(),
        video: videoSchema.optional()
      })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(1000).optional()
  })
  .strict()
  .superRefine((recipe, context) => {
    const outputs = recipe.outputs;
    if (outputs?.screenshots === false && (outputs.thumbnails || outputs.contactSheet)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "screenshots"],
        message: "screenshots cannot be false when thumbnails or a contact sheet are requested"
      });
    }
    const video = outputs?.video;
    if (!video?.enabled) return;
    const format = video.format ?? "mp4";
    const codec = video.codec ?? (format === "mp4" ? "h264" : "vp9");
    const pixelFormat = video.pixelFormat ?? "yuv420p";
    if ((format === "mp4" && codec !== "h264") || (format === "webm" && codec !== "vp9")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "video", "codec"],
        message: "MP4 requires h264 and WebM requires vp9"
      });
    }
    if (pixelFormat === "yuva420p" && codec !== "vp9") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "video", "pixelFormat"],
        message: "yuva420p is supported only with VP9 WebM"
      });
    }
  });
