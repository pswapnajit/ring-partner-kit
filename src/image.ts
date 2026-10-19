import { crc32, deflateSync, inflateSync } from 'node:zlib';
import type { Zone } from './types.ts';

// Minimal, dependency-free PNG support so privacy zones can be blacked out
// before a snapshot is analyzed or stored. Ring's UX guide: "Don't display,
// analyze, or store video content from areas marked as privacy zones."
// Request snapshots with image_options.format = "png" to use this.

export interface RgbaImage {
  width: number;
  height: number;
  /** width * height * 4 bytes, row-major RGBA. */
  data: Uint8Array;
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function encodePng(image: RgbaImage, opts: { alpha?: boolean; text?: Record<string, string> } = {}): Uint8Array {
  const { width, height, data } = image;
  const channels = opts.alpha ? 4 : 3;
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1; // filter: Sub, cheap and compresses illustrations well
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = rowStart + 1 + x * channels;
      for (let c = 0; c < channels; c++) {
        const left = x > 0 ? data[src - 4 + c] : 0;
        raw[dst + c] = (data[src + c] - left) & 0xff;
      }
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opts.alpha ? 6 : 2;
  const chunks = [chunk('IHDR', ihdr)];
  for (const [k, v] of Object.entries(opts.text ?? {})) {
    chunks.push(chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  }
  chunks.push(chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0)));
  return Buffer.concat([PNG_SIGNATURE, ...chunks]);
}

export function decodePng(bytes: Uint8Array): RgbaImage & { text: Record<string, string> } {
  if (!isPng(bytes)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  const text: Record<string, string> = {};
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
      width = h.getUint32(0);
      height = h.getUint32(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'tEXt') {
      const zero = body.indexOf(0);
      if (zero > 0) text[Buffer.from(body.subarray(0, zero)).toString('latin1')] = Buffer.from(body.subarray(zero + 1)).toString('latin1');
    } else if (type === 'IEND') break;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[out + x - channels] : 0;
      const b = y > 0 ? pixels[out - stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[out - stride + x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      pixels[out + x] = v & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) data.set(pixels.subarray(s, s + 4), d);
    else if (colorType === 2) {
      data[d] = pixels[s];
      data[d + 1] = pixels[s + 1];
      data[d + 2] = pixels[s + 2];
      data[d + 3] = 255;
    } else if (colorType === 0 || colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = pixels[s];
      data[d + 3] = colorType === 4 ? pixels[s + 1] : 255;
    } else {
      const idx = pixels[s];
      data[d] = palette?.[idx * 3] ?? 0;
      data[d + 1] = palette?.[idx * 3 + 1] ?? 0;
      data[d + 2] = palette?.[idx * 3 + 2] ?? 0;
      data[d + 3] = transparency?.[idx] ?? 255;
    }
  }
  return { width, height, data, text };
}

/** Ray-casting point-in-polygon on normalized (0..1) coordinates, origin top-left. */
export function pointInPolygon(x: number, y: number, vertices: Zone['vertices']): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = Number(vertices[i].x);
    const yi = Number(vertices[i].y);
    const xj = Number(vertices[j].x);
    const yj = Number(vertices[j].y);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Paints every pixel inside any zone with a solid color. Returns how many pixels were masked. */
export function maskZones(image: RgbaImage, zones: Zone[] | undefined, color: [number, number, number] = [0, 0, 0]): number {
  let masked = 0;
  for (const zone of zones ?? []) {
    if (!zone.vertices?.length) continue;
    const xs = zone.vertices.map((v) => Number(v.x));
    const ys = zone.vertices.map((v) => Number(v.y));
    const x0 = Math.max(0, Math.floor(Math.min(...xs) * image.width));
    const x1 = Math.min(image.width - 1, Math.ceil(Math.max(...xs) * image.width));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) * image.height));
    const y1 = Math.min(image.height - 1, Math.ceil(Math.max(...ys) * image.height));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!pointInPolygon((x + 0.5) / image.width, (y + 0.5) / image.height, zone.vertices)) continue;
        const i = (y * image.width + x) * 4;
        image.data[i] = color[0];
        image.data[i + 1] = color[1];
        image.data[i + 2] = color[2];
        image.data[i + 3] = 255;
        masked++;
      }
    }
  }
  return masked;
}

/** Box-filter downscale so the longest side is at most maxSide pixels. */
export function downscale(image: RgbaImage, maxSide: number): RgbaImage {
  const factor = Math.ceil(Math.max(image.width, image.height) / maxSide);
  if (factor <= 1) return image;
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  const n = factor * factor;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * image.width + (x * factor + dx)) * 4;
          for (let c = 0; c < 4; c++) sum[c] += image.data[i + c];
        }
      }
      const o = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.round(sum[c] / n);
    }
  }
  return { width, height, data };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(Buffer.from(type, 'latin1'), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)) >>> 0);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
