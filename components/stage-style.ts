/**
 * The hosted preview stage lives on the editor origin, which has no CSP of its own. Only a
 * complete base64 raster data URL may reach CSS, and it is serialized as a quoted CSS string.
 */
const SAFE_STAGE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function stageBackgroundImage(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_STAGE_IMAGE.test(value) ? `url(${JSON.stringify(value)})` : undefined;
}
