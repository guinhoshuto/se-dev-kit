import type {CameraDefinition, CaptureVariant, ResolvedProject, VideoDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
import {assertSafeId} from "../shared/ids.js";
import {resolveSceneState} from "../scenarios/state.js";
import {compileTutorial, EMULATE_MENU, type TutorialTimeline} from "./timeline.js";

export {EMULATE_MENU};

/** Compiles a variant's tutorial script and checks that it fits inside the recorded duration. */
export function compileVariantTutorial(
  project: ResolvedProject,
  variant: CaptureVariant,
  video: VideoDefinition
): TutorialTimeline {
  if (!video.tutorial) {
    throw new StudioError("TUTORIAL_MISSING", `Video mode "tutorial" requires a tutorial script.`);
  }
  const resolved = resolveSceneState(project, variant.scene);
  const channel = typeof resolved.runtimeState.channel.username === "string" ? resolved.runtimeState.channel.username : "streamer";
  const uiScale = video.tutorial.uiScale ?? Math.min(4, Math.max(0.5, resolved.output.width / 1440));
  const timeline = compileTutorial({
    tutorial: {...video.tutorial, uiScale},
    fields: project.fields,
    fieldData: resolved.runtimeState.fieldData,
    channel,
    ...(variant.fixture ? {fixture: variant.fixture} : {})
  });
  if (timeline.endMs > video.durationMs) {
    throw new StudioError(
      "TUTORIAL_TOO_LONG",
      `Tutorial for variant "${variant.id}" needs ${timeline.endMs}ms but the video lasts ${video.durationMs}ms.`,
      `Set outputs.video.durationMs to at least ${Math.ceil(timeline.endMs / 500) * 500}.`
    );
  }
  return timeline;
}

/** Places the widget inside the overlay canvas; the capture host centers #widget-wrap before the camera offset. */
export function tutorialCamera(timeline: TutorialTimeline): CameraDefinition {
  const {overlay, widget} = timeline.chrome;
  return {
    id: "tutorial-overlay",
    scale: widget.scale,
    x: widget.x - overlay.width / 2,
    y: widget.y - overlay.height / 2,
    origin: "center center"
  };
}

/**
 * The names of a tutorial video's `still` steps, in step order, checked to be safe file-name ids and
 * unique. Each becomes `<variant>-still-<name>.png` next to the video.
 */
export function tutorialStillNames(video: VideoDefinition | undefined): string[] {
  if (!video?.enabled || video.mode !== "tutorial" || !video.tutorial) return [];
  const names: string[] = [];
  for (const step of video.tutorial.steps) {
    if (step.action !== "still") continue;
    assertSafeId(step.name, "tutorial still name");
    if (names.includes(step.name)) {
      throw new StudioError("TUTORIAL_STILL_DUPLICATE", `Two tutorial still steps are named "${step.name}".`, "Give every still step its own name.");
    }
    names.push(step.name);
  }
  return names;
}

/** The first video frame at or after `atMs`, or the last frame when the video ends first. */
export function stillFrameIndex(atMs: number, fps: number, frameCount: number): number {
  let index = Math.max(0, Math.ceil((atMs * fps) / 1000) - 1);
  while (Math.round((index * 1000) / fps) < atMs) index += 1;
  return Math.min(index, frameCount - 1);
}
