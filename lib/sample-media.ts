import {resolve} from 'node:path';
import {loadSampleMediaCatalog, requireSampleMedia, type SampleMediaCatalog} from '../src/config/sample-media';

/**
 * Built-in sample media ship with the deployment, like presets: next.config.mjs traces this
 * directory into every function bundle and lib/jobs.ts uploads it to the offline Sandbox.
 * Nothing is downloaded at runtime and samples never become revision assets.
 */
export const SAMPLE_MEDIA_DIRECTORY = 'sample-media';
export type SampleMediaSource = () => Promise<SampleMediaCatalog>;
export const deployedSampleMedia: SampleMediaSource = () => loadSampleMediaCatalog(resolve(process.cwd(), SAMPLE_MEDIA_DIRECTORY));

/** Fails when a revision pinned different bytes than this deployment serves. */
export function assertPinned(reference: string, sha256: string, pins: Record<string, string> | undefined): void {
  const pinned = pins?.[reference];
  if (pinned !== undefined && pinned !== sha256) throw new Error(`Sample media changed since this revision was saved: ${reference}. Samples are append-only; save a new revision with a current reference.`);
}

/** Verified sample bytes as an embeddable data URL for the opaque preview iframe or the editor stage. */
export async function sampleMediaDataUrl(reference: string, source: SampleMediaSource, pins?: Record<string, string>): Promise<{dataUrl: string; bytes: number}> {
  const catalog = await source();
  const entry = requireSampleMedia(catalog, reference);
  assertPinned(reference, entry.sha256, pins);
  const body = catalog.body(reference);
  return {dataUrl: `data:${entry.contentType};base64,${body.toString('base64')}`, bytes: body.byteLength};
}
