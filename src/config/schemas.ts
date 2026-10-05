import {z} from "zod";
import {SAFE_ID} from "../shared/ids.js";

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

export const fieldUpdateSchema = z.enum(["reload", "event"]);

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
        fieldUpdate: fieldUpdateSchema.optional(),
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

const tutorialTargetSchema = z.union([
  z.enum(["layer", "save", "preview", "emulate", "open-editor", "chat-input"]),
  z.string().regex(/^(?:group|field):.+$/, "targets must be a known control, group:<name>, or field:<id>"),
  z.object({x: z.number().finite(), y: z.number().finite()}).strict()
]);

const tutorialMoveDurationSchema = z.number().int().min(0).max(10_000).optional();

const tutorialStepSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("wait"), ms: z.number().int().min(0).max(120_000)}).strict(),
  z.object({action: z.literal("caption"), text: z.string().max(240).nullable()}).strict(),
  z
    .object({
      action: z.literal("still"),
      name: z.string().max(64).regex(SAFE_ID, "still names use lowercase letters, numbers, and single hyphens"),
      camera: z.enum(["video", "full"]).optional()
    })
    .strict(),
  z.object({action: z.literal("move"), target: tutorialTargetSchema, durationMs: tutorialMoveDurationSchema}).strict(),
  z.object({action: z.literal("click"), target: tutorialTargetSchema, durationMs: tutorialMoveDurationSchema}).strict(),
  z.object({action: z.literal("selectLayer")}).strict(),
  z.object({action: z.literal("openGroup"), group: z.string().min(1)}).strict(),
  z.object({action: z.literal("setField"), field: z.string().min(1), value: jsonPrimitiveSchema}).strict(),
  z
    .object({
      action: z.literal("emulate"),
      event: z.enum(["follower", "subscriber", "tip", "cheer", "raid", "redemption", "merch"]),
      option: z.string().min(1).optional(),
      name: z.string().min(1).max(64).optional(),
      amount: z.number().finite().min(0).optional(),
      message: z.string().max(500).optional(),
      listener: z.string().min(1).optional(),
      payload: jsonValueSchema.optional()
    })
    .strict(),
  z
    .object({
      action: z.literal("chat"),
      user: z.string().min(1).max(64),
      text: z.string().min(1).max(500),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      badges: z.array(z.enum(["broadcaster", "moderator", "vip", "subscriber"])).max(4).optional(),
      typed: z.boolean().optional(),
      data: jsonObjectSchema.optional()
    })
    .strict(),
  z.object({action: z.literal("save")}).strict()
]);

export const tutorialSchema = z
  .object({
    overlayName: z.string().max(120).optional(),
    layerName: z.string().max(120).optional(),
    overlay: z
      .object({width: z.number().int().min(16).max(7680), height: z.number().int().min(16).max(4320)})
      .strict()
      .optional(),
    widget: z
      .object({
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        scale: z.number().min(0.05).max(20).optional()
      })
      .strict()
      .optional(),
    uiScale: z.number().min(0.5).max(4).optional(),
    chat: z
      .object({
        enabled: z.boolean().optional(),
        title: z.string().max(60).optional(),
        channel: z.string().max(60).optional()
      })
      .strict()
      .optional(),
    liveEmulation: z.boolean().optional(),
    typingMsPerChar: z.number().int().min(10).max(1_000).optional(),
    autoZoom: z.union([z.boolean(), z.object({zoom: z.number().min(1.2).max(2.5).optional()}).strict()]).optional(),
    steps: z.array(tutorialStepSchema).min(1).max(500)
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
    audio: z.literal("none").optional(),
    mode: z.enum(["stage", "tutorial"]).optional(),
    tutorial: tutorialSchema.optional(),
    keepFrames: z.boolean().optional()
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
    if (video.mode === "tutorial" && !video.tutorial) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "video", "tutorial"],
        message: "tutorial mode requires a tutorial script"
      });
    }
    if (video.tutorial && video.mode !== "tutorial") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputs", "video", "mode"],
        message: "a tutorial script requires mode \"tutorial\""
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
