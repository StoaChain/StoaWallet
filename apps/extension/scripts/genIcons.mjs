// Generates the placeholder MV3 toolbar icons (16/32/48/128) as REAL, parseable
// PNG files so the @crxjs build and the store-readiness validator load them like
// any shipped asset. The art is intentionally a placeholder — a gold rhombus
// glyph on a near-black field — because final branded artwork is an ops task,
// not an engineering one. We hand-encode the PNG (single IDAT, zlib-deflated,
// CRC32 per chunk) rather than pull a raster dependency, keeping the icon
// pipeline self-contained and reproducible.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'public', 'icons');

const SIZES = [16, 32, 48, 128];

// Near-black background and StoaWallet gold foreground.
const BG = [0x0a, 0x0a, 0x0a];
const FG = [0xe8, 0xb4, 0x32];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 (IEEE) table + helper for PNG chunk checksums.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// A centered rhombus (diamond) glyph: pixel is foreground when its Manhattan
// distance from center is within ~38% of the icon size.
function isGlyphPixel(x, y, size) {
  const c = (size - 1) / 2;
  const radius = size * 0.38;
  return Math.abs(x - c) + Math.abs(y - c) <= radius;
}

function buildPng(size) {
  // RGBA raw scanlines, each prefixed with filter byte 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = isGlyphPixel(x, y, size) ? FG : BG;
      const px = rowStart + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, buildPng(size));
}

process.stdout.write(`Generated ${SIZES.length} icons in ${OUT_DIR}\n`);
