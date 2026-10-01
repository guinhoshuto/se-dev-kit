/**
 * The hosted (Vercel) deployment keeps the limits that protect its personal quotas: the daily
 * budgets, a ten-minute job, 15-second videos at 30 fps, four video variants, and 900 frames per
 * video job. A local Studio runs on the owner's machine instead, where a job takes the machine-wide
 * render slot and the render disk guard, and has LOCAL_JOB_MS to finish.
 */
export function hostedLimits(): boolean {
  return Boolean(process.env.VERCEL) || process.env.STUDIO_EXECUTION === 'vercel';
}
export const HOSTED_JOB_MS = 10 * 60_000;
/** Up to 30 minutes waiting for the render slot, then the render and its font passes. */
export const LOCAL_JOB_MS = 120 * 60_000;
export function jobBudgetMs(): number {
  return hostedLimits() ? HOSTED_JOB_MS : LOCAL_JOB_MS;
}
/** The preview response cap: a Vercel Function answers at most about 4.5 MB; a local Studio has no such cap, and 10 MB bounds memory. */
export function previewResponseBytes(): number {
  return hostedLimits() ? 4_000_000 : 10_000_000;
}
/** Artifact size limits: the hosted ones fit Blob and the Sandbox; the local ones bound memory, since publishing reads each file whole. */
export function artifactLimits(): {file: number; job: number} {
  return hostedLimits() ? {file: 100 * 1024 * 1024, job: 250 * 1024 * 1024} : {file: 512 * 1024 * 1024, job: 1024 * 1024 * 1024};
}
