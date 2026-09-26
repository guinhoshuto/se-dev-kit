/**
 * Pure color math for the tutorial color picker. The StreamElements editor uses
 * md-color-picker 0.2.6, whose spectrum is an exact HSV plane (x = saturation,
 * y = 1 - value) next to a linear hue strip, so every picker position is derived
 * from HSV parameters here rather than from sampled pixels. No clock, no randomness.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Rgba extends Rgb {
  a: number;
}

export interface Hsv {
  /** Hue in degrees, [0, 360). */
  h: number;
  /** Saturation, [0, 1]. */
  s: number;
  /** Value (brightness), [0, 1]. */
  v: number;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i;

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(r, g, b), and rgba(r, g, b, a). */
export function parseColor(value: string): Rgba | undefined {
  const hex = HEX.exec(value);
  if (hex) {
    const digits = hex[1]!;
    const full = digits.length <= 4 ? [...digits].map((digit) => digit + digit).join("") : digits;
    const channel = (index: number) => Number.parseInt(full.slice(index * 2, index * 2 + 2), 16);
    return {r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? channel(3) / 255 : 1};
  }
  const rgb = RGB.exec(value);
  if (!rgb) return undefined;
  const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
  const isRgba = /^rgba/i.test(value);
  if (isRgba !== (rgb[4] !== undefined)) return undefined;
  const a = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if (r > 255 || g > 255 || b > 255 || !(a >= 0 && a <= 1)) return undefined;
  return {r, g, b, a};
}

export function rgbToHsv({r, g, b}: Rgb): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {h, s: max === 0 ? 0 : delta / max, v: max / 255};
}

/** Converts HSV to rounded 8-bit RGB; `h` may be 360 (the top of the hue strip). */
export function hsvToRgb({h, s, v}: Hsv): Rgb {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - chroma;
  const sector = Math.floor(hue / 60);
  const [r1, g1, b1] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x]
  ][sector]!;
  return {r: Math.round((r1! + m) * 255), g: Math.round((g1! + m) * 255), b: Math.round((b1! + m) * 255)};
}

/** Perceived brightness as tinycolor computes it (0-255). */
export function brightness({r, g, b}: Rgb): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * md-color-picker gives the header its `dark` class (dark text) when the color is
 * light (tinycolor `isDark()` is false) or mostly transparent.
 */
export function needsDarkText(color: Rgba): boolean {
  return brightness(color) >= 128 || color.a < 0.45;
}

function roundAlpha(alpha: number): number {
  return Math.round(alpha * 100) / 100;
}

/**
 * Formats a color in the notation of `like`: hex (keeping its letter case, with an
 * alpha pair when `like` or the color has alpha) or tinycolor's rgb()/rgba() string.
 */
export function formatColor(color: Rgba, like: string): string {
  if (like.startsWith("#")) {
    const digits = like.length - 1;
    const withAlpha = digits === 4 || digits === 8 || color.a < 1;
    const pairs = [color.r, color.g, color.b, ...(withAlpha ? [Math.round(color.a * 255)] : [])];
    const hex = `#${pairs.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
    const upper = /[A-F]/.test(like) && !/[a-f]/.test(like);
    return upper ? hex.toUpperCase() : hex;
  }
  const alpha = roundAlpha(color.a);
  return alpha < 1 || /^rgba/i.test(like)
    ? `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
    : `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/** CSS color for drawing, alpha included. */
export function cssColor(color: Rgba): string {
  return color.a < 1 ? `rgba(${color.r}, ${color.g}, ${color.b}, ${roundAlpha(color.a)})` : `rgb(${color.r}, ${color.g}, ${color.b})`;
}
