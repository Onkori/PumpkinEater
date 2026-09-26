// Draws the pumpkin toolbar icon at each size Chrome needs and writes PNGs.
// Pure Node (zlib only) so it runs without installing anything.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling per axis for anti-aliasing

const ORANGE = [249, 115, 22];
const RIDGE = [194, 65, 12];
const STEM = [77, 124, 15];

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// Colour at a point in the unit square (0..1), or null for transparent.
function shade(x, y) {
  if (x > 0.45 && x < 0.57 && y > 0.06 && y < 0.3 && x - 0.45 < (0.3 - y) * 0.5 + 0.04) return STEM;
  const lobes = [[0.5, 0.58, 0.2, 0.36], [0.3, 0.6, 0.23, 0.33], [0.7, 0.6, 0.23, 0.33]];
  if (!lobes.some(([cx, cy, rx, ry]) => inEllipse(x, y, cx, cy, rx, ry))) return null;
  // Dark ridges where the side lobes meet the middle one.
  const onRidge = [0.37, 0.63].some((rx) => Math.abs(x - rx - (y - 0.6) * (rx < 0.5 ? 0.12 : -0.12)) < 0.018);
  return onRidge && y > 0.3 && y < 0.88 ? RIDGE : ORANGE;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = shade((pxX + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const i = (py * size + pxX) * 4;
      if (a) { px[i] = r / a; px[i + 1] = g / a; px[i + 2] = b / a; }
      px[i + 3] = Math.round((a / SAMPLES ** 2) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const out = new URL(`../extension/icons/icon${size}.png`, import.meta.url);
  writeFileSync(out, png(size, render(size)));
  console.log(`wrote ${out.pathname}`);
}
