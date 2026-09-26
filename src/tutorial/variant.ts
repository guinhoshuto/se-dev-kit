import type {CameraDefinition, CaptureVariant, ResolvedProject, VideoDefinition} from "../types.js";
import {StudioError} from "../shared/errors.js";
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
