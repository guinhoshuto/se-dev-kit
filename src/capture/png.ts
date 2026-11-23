import {crc32, deflateSync} from "node:zlib";

const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * An 8-bit RGB (3 channels) or RGBA (4 channels) PNG of `pixels`, row by row with no filter. It writes no time or
 * text chunk, so the same pixels always give the same bytes.
 */
export function encodePng(width: number, height: number, channels: 3 | 4, pixels: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`A PNG needs a positive integer size, not ${width}x${height}.`);
  }
  const stride = width * channels;
  if (pixels.length !== stride * height) throw new RangeError(`Expected ${stride * height} bytes of pixels, got ${pixels.length}.`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(rows, {level: 9})), chunk("IEND", Buffer.alloc(0))]);
}
