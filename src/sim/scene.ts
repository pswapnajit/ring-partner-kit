import { encodePng, type RgbaImage } from '../image.ts';

// Procedural "doorbell camera" frames for the simulator's snapshot endpoint:
// a porch seen through a wide-angle lens, day or night (IR), with optional
// package, visitor and car. Ground truth goes in a tEXt chunk so tests (and an
// explicitly labeled offline vision oracle) can check what was drawn.

export type SceneObject = 'package' | 'person' | 'car';

export interface SceneSpec {
  width?: number;
  height?: number;
  objects: SceneObject[];
  /** Local hour of day (0-23.99) for lighting. */
  hour: number;
  /** Top-right overlay text, like the mandatory watermark on real Ring media. */
  caption?: string;
  /** Deterministic variation (clouds, clothing color). */
  seed?: number;
}

type RGB = [number, number, number];

class Canvas {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;

  constructor(w: number, h: number, data?: Uint8Array) {
    this.w = w;
    this.h = h;
    this.data = data ?? new Uint8Array(w * h * 4).fill(255);
  }

  blend(x: number, y: number, c: RGB, alpha = 1): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (Math.floor(y) * this.w + Math.floor(x)) * 4;
    const d = this.data;
    d[i] = d[i] + (c[0] - d[i]) * alpha;
    d[i + 1] = d[i + 1] + (c[1] - d[i + 1]) * alpha;
    d[i + 2] = d[i + 2] + (c[2] - d[i + 2]) * alpha;
  }

  rect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(this.h, y + h); yy++) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(this.w, x + w); xx++) this.blend(xx, yy, c, alpha);
    }
  }

  gradient(y0: number, y1: number, top: RGB, bottom: RGB): void {
    for (let y = Math.max(0, y0); y < Math.min(this.h, y1); y++) {
      const t = (y - y0) / Math.max(1, y1 - y0);
      const c: RGB = [lerp(top[0], bottom[0], t), lerp(top[1], bottom[1], t), lerp(top[2], bottom[2], t)];
      for (let x = 0; x < this.w; x++) this.blend(x, y, c);
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB, alpha = 1): void {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d <= 1) this.blend(x, y, c, alpha * Math.min(1, (1 - d) * Math.max(rx, ry) * 0.5 + 0.2));
      }
    }
  }

  /** Even-odd scanline fill. */
  poly(points: Array<[number, number]>, c: RGB, alpha = 1): void {
    const ys = points.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(this.h - 1, Math.max(...ys)); y++) {
      const xs: number[] = [];
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y + 0.5 !== yj > y + 0.5) xs.push(xi + ((y + 0.5 - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(this.w - 1, xs[k + 1]); x++) this.blend(x, y, c, alpha);
      }
    }
  }

  text(x: number, y: number, str: string, scale: number, c: RGB): void {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT['?'];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === '#') this.rect(cx + col * scale, y + row * scale, scale, scale, c);
        }
      }
      cx += 6 * scale;
    }
  }
}

export function textWidth(str: string, scale: number): number {
  return str.length * 6 * scale - scale;
}

export function renderScene(spec: SceneSpec): RgbaImage {
  const W = spec.width ?? 1280;
  const H = spec.height ?? 720;
  const c = new Canvas(W, H);
  const sx = (v: number) => (v * W) / 1280;
  const sy = (v: number) => (v * H) / 720;
  const rand = mulberry32(spec.seed ?? 7);
  const night = spec.hour < 6.5 || spec.hour >= 19.5;
  const dusk = !night && (spec.hour < 8 || spec.hour >= 18);

  // Sky and far side of the street.
  c.gradient(0, sy(330), night ? [10, 16, 30] : dusk ? [236, 170, 120] : [150, 196, 232], night ? [30, 42, 58] : dusk ? [250, 214, 170] : [222, 236, 246]);
  if (!night) for (let i = 0; i < 4; i++) c.ellipse(sx(150 + rand() * 1000), sy(60 + rand() * 120), sx(70 + rand() * 60), sy(18 + rand() * 10), [250, 252, 255], 0.55);
  const houseColors: RGB[] = [[186, 164, 140], [150, 160, 172], [196, 180, 150], [168, 140, 130]];
  for (let i = 0; i < 5; i++) {
    const x = sx(40 + i * 250 + rand() * 40);
    const w = sx(170 + rand() * 40);
    const top = sy(240 + rand() * 20);
    c.rect(x, top, w, sy(330) - top, houseColors[i % 4]);
    c.poly([[x - sx(12), top], [x + w / 2, top - sy(55)], [x + w + sx(12), top]], [96, 84, 80]);
    for (let k = 0; k < 2; k++) c.rect(x + sx(25 + k * 80), top + sy(25), sx(40), sy(32), night ? [255, 214, 140] : [120, 150, 175], night && rand() < 0.5 ? 0.9 : 1);
  }
  c.rect(0, sy(300), W, sy(36), [70, 110, 70]);
  // Street, sidewalk, lawn.
  c.rect(0, sy(330), W, sy(55), [92, 94, 98]);
  for (let x = 0; x < W; x += sx(120)) c.rect(x, sy(355), sx(60), sy(4), [220, 210, 150]);
  c.rect(0, sy(385), W, sy(22), [196, 192, 184]);
  c.rect(0, sy(407), W, H, [86, 140, 74]);
  for (let i = 0; i < 400; i++) c.rect(rand() * W, sy(407) + rand() * (H - sy(407)), sx(3), sy(6), [70, 120, 60], 0.6);
  // Walkway.
  c.poly([[sx(585), sy(407)], [sx(695), sy(407)], [sx(900), H], [sx(380), H]], [184, 176, 166]);
  for (let k = 1; k < 6; k++) {
    const y = sy(407) + (k * (H - sy(407))) / 6;
    c.rect(sx(380), y, sx(520), sy(2), [150, 144, 136], 0.6);
  }
  if (spec.objects.includes('car')) drawCar(c, sx, sy, rand);
  // Shrubs and a planter.
  c.ellipse(sx(250), sy(470), sx(130), sy(70), [52, 102, 52]);
  c.ellipse(sx(1060), sy(480), sx(140), sy(75), [48, 96, 50]);
  c.ellipse(sx(980), sy(455), sx(60), sy(40), [196, 92, 110], 0.85);
  // Porch floor (planks) in the foreground.
  c.poly([[0, sy(575)], [W, sy(575)], [W, H], [0, H]], [150, 108, 72]);
  for (let k = 0; k < 8; k++) c.rect(0, sy(585 + k * 18), W, sy(2), [118, 82, 52], 0.7);
  // Porch posts and soffit.
  c.poly([[sx(40), 0], [sx(95), 0], [sx(110), sy(600)], [sx(30), sy(600)]], [236, 232, 224]);
  c.poly([[sx(1185), 0], [sx(1240), 0], [sx(1250), sy(600)], [sx(1170), sy(600)]], [236, 232, 224]);
  c.rect(0, 0, W, sy(46), [64, 54, 48]);
  // Door mat.
  c.poly([[sx(500), sy(612)], [sx(780), sy(612)], [sx(820), sy(700)], [sx(460), sy(700)]], [70, 58, 50]);
  c.poly([[sx(515), sy(620)], [sx(765), sy(620)], [sx(800), sy(692)], [sx(478), sy(692)]], [104, 86, 70]);
  if (spec.objects.includes('person')) drawPerson(c, sx, sy, rand);
  if (spec.objects.includes('package')) drawPackage(c, sx, sy);

  let image: RgbaImage = { width: W, height: H, data: c.data };
  if (night) image = infrared(image, sx(640), sy(40));
  image = fisheye(image, 0.16);
  stamp(image, spec.caption);
  return image;
}

export function renderScenePng(spec: SceneSpec): Uint8Array {
  return encodePng(renderScene(spec), { text: { 'sim:objects': [...spec.objects].sort().join(',') || 'none', 'sim:hour': spec.hour.toFixed(2) } });
}

function drawPackage(c: Canvas, sx: (v: number) => number, sy: (v: number) => number): void {
  const x = sx(690);
  const y = sy(598);
  const w = sx(150);
  const h = sy(92);
  const depth = sy(30);
  c.poly([[x - sx(6), y + h + sy(4)], [x + w + sx(26), y + h + sy(4)], [x + w + sx(10), y + h + sy(14)], [x - sx(20), y + h + sy(14)]], [40, 30, 24], 0.45);
  c.poly([[x, y], [x + w, y], [x + w + sx(20), y - depth], [x + sx(20), y - depth]], [214, 168, 112]);
  c.rect(x, y, w, h, [176, 126, 74]);
  c.poly([[x + w, y], [x + w + sx(20), y - depth], [x + w + sx(20), y + h - depth], [x + w, y + h]], [146, 102, 58]);
  c.rect(x + w / 2 - sx(9), y, sx(18), h, [222, 204, 160]);
  c.poly([[x + w / 2 - sx(9), y], [x + w / 2 + sx(9), y], [x + w / 2 + sx(29), y - depth], [x + w / 2 + sx(11), y - depth]], [230, 214, 172]);
  c.rect(x + sx(14), y + sy(16), sx(46), sy(30), [246, 246, 240]);
  for (let k = 0; k < 4; k++) c.rect(x + sx(18), y + sy(21 + k * 6), sx(36 - k * 6), sy(2), [90, 90, 90]);
}

function drawPerson(c: Canvas, sx: (v: number) => number, sy: (v: number) => number, rand: () => number): void {
  const coats: RGB[] = [[40, 64, 120], [150, 40, 40], [60, 100, 70], [90, 80, 120]];
  const coat = coats[Math.floor(rand() * coats.length)];
  const cx = sx(560);
  c.ellipse(cx, sy(590), sx(70), sy(14), [30, 30, 30], 0.35);
  c.poly([[cx - sx(34), sy(470)], [cx - sx(8), sy(470)], [cx - sx(12), sy(585)], [cx - sx(36), sy(585)]], [44, 48, 60]);
  c.poly([[cx + sx(8), sy(470)], [cx + sx(34), sy(470)], [cx + sx(36), sy(585)], [cx + sx(12), sy(585)]], [44, 48, 60]);
  c.poly([[cx - sx(58), sy(318)], [cx + sx(58), sy(318)], [cx + sx(52), sy(480)], [cx - sx(52), sy(480)]], coat);
  c.poly([[cx - sx(58), sy(322)], [cx - sx(82), sy(450)], [cx - sx(62), sy(456)], [cx - sx(44), sy(340)]], coat);
  c.poly([[cx + sx(58), sy(322)], [cx + sx(82), sy(450)], [cx + sx(62), sy(456)], [cx + sx(44), sy(340)]], coat);
  c.ellipse(cx, sy(282), sx(34), sy(40), [200, 160, 130]);
  c.ellipse(cx, sy(256), sx(36), sy(20), [60, 44, 36]);
}

function drawCar(c: Canvas, sx: (v: number) => number, sy: (v: number) => number, rand: () => number): void {
  const x = sx(820 + rand() * 120);
  const y = sy(318);
  c.rect(x, y + sy(18), sx(240), sy(36), [176, 40, 40]);
  c.poly([[x + sx(50), y + sy(18)], [x + sx(80), y - sy(10)], [x + sx(170), y - sy(10)], [x + sx(200), y + sy(18)]], [160, 34, 34]);
  c.poly([[x + sx(64), y + sy(16)], [x + sx(86), y - sy(4)], [x + sx(164), y - sy(4)], [x + sx(186), y + sy(16)]], [150, 190, 215]);
  c.ellipse(x + sx(55), y + sy(56), sx(20), sy(14), [28, 28, 28]);
  c.ellipse(x + sx(190), y + sy(56), sx(20), sy(14), [28, 28, 28]);
}

/** Night view: monochrome IR look with a porch-light glow. */
function infrared(img: RgbaImage, lx: number, ly: number): RgbaImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  const maxD = Math.hypot(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
      const glow = Math.max(0, 1 - Math.hypot(x - lx, y - ly) / (maxD * 0.55));
      const v = Math.min(255, lum * (0.35 + 0.9 * glow) + 12);
      out[i] = v * 0.92;
      out[i + 1] = v;
      out[i + 2] = v * 0.94;
      out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Barrel distortion plus vignette, the signature wide-angle doorbell look. */
function fisheye(img: RgbaImage, k: number): RgbaImage {
  const { width, height, data } = img;
  const out = new Uint8Array(data.length);
  const cx = width / 2;
  const cy = height / 2;
  const norm = Math.hypot(cx, cy);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x - cx) / norm;
      const v = (y - cy) / norm;
      const r2 = u * u + v * v;
      const f = (1 + k * r2) / (1 + k * 0.6);
      const srcX = Math.round(cx + u * f * norm);
      const srcY = Math.round(cy + v * f * norm);
      const o = (y * width + x) * 4;
      const vignette = Math.max(0, 1 - 0.55 * r2);
      if (srcX < 0 || srcY < 0 || srcX >= width || srcY >= height) {
        out[o + 3] = 255;
        continue;
      }
      const s = (srcY * width + srcX) * 4;
      out[o] = data[s] * vignette;
      out[o + 1] = data[s + 1] * vignette;
      out[o + 2] = data[s + 2] * vignette;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function stamp(img: RgbaImage, caption: string | undefined): void {
  const c = new Canvas(img.width, img.height, img.data);
  const scale = Math.max(2, Math.round(img.width / 480));
  c.rect(scale * 6, scale * 6, textWidth('SIMULATED', scale) + scale * 8, scale * 11, [20, 20, 20], 0.55);
  c.text(scale * 10, scale * 8, 'SIMULATED', scale, [255, 255, 255]);
  if (caption) {
    const w = textWidth(caption, scale);
    c.rect(img.width - w - scale * 14, scale * 6, w + scale * 8, scale * 11, [20, 20, 20], 0.55);
    c.text(img.width - w - scale * 10, scale * 8, caption, scale, [255, 255, 255]);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 5x7 pixel font for overlays.
const FONT: Record<string, string[]> = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  '|': ['..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
};
