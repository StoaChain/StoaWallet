/**
 * Generate the StoaWallet extension icons (16/32/48/128 px PNGs the MV3 manifest
 * points at, and the Web Store / toolbar slot uses).
 *
 * The mark is the Stoa diamond COMPOSED OF FOUR SQUARES (cf. the ❖ glyph): a large
 * rotated square split along BOTH diagonals into four sub-squares (top / right /
 * bottom / left rhombi), separated by a thin dark X, in two gold shades so the
 * four pieces read. The diamond is large so the GOLD dominates the tile (brown
 * shows only in the rounded corners) — the way the MetaMask fox fills its slot.
 *
 * Self-contained: no SVG rasterizer / image lib — it samples the vector geometry
 * with 4×4 supersampling for clean anti-aliased edges and hand-encodes the PNG
 * (single zlib-deflated IDAT, CRC32 per chunk) via Node built-ins. Re-run with
 * `pnpm -C apps/extension run icons` after a design tweak.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'public', 'icons');
const SIZES = [16, 32, 48, 128];

// ── minimal PNG (RGBA, 8-bit) encoder ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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
function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the icon, in normalized [0,1] space ──
const RR = 0.22; // rounded-corner radius (fraction of the tile)
const HALF = 0.46; // diamond half-extent (|dx|+|dy| ≤ HALF) — large = gold-dominant
const GAP = 0.03; // dark separator half-width along the diagonals (the X)
const GOLD_A = [236, 205, 110]; // lighter squares (top + bottom)
const GOLD_B = [183, 146, 47]; // darker squares (left + right)
const TILE_TL = [58, 44, 22]; // brown gradient — top-left (corners only)
const TILE_BR = [26, 19, 10]; // brown gradient — bottom-right

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Sample the icon at normalized (nx,ny) → [r,g,b,a]. */
function sample(nx, ny) {
  // Rounded-rect tile mask — outside the rounded corners is transparent.
  const cx = Math.min(Math.max(nx, RR), 1 - RR);
  const cy = Math.min(Math.max(ny, RR), 1 - RR);
  const ex = nx - cx;
  const ey = ny - cy;
  if (ex * ex + ey * ey > RR * RR) return [0, 0, 0, 0];

  const tile = lerp(TILE_TL, TILE_BR, (nx + ny) / 2);
  const dx = nx - 0.5;
  const dy = ny - 0.5;

  if (Math.abs(dx) + Math.abs(dy) <= HALF) {
    // Inside the diamond: a thin dark X (along the diagonals) separates the FOUR
    // SQUARES (top / right / bottom / left rhombi).
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) < GAP) return [...tile, 255];
    // The taller axis picks top/bottom vs left/right; opposite squares share a
    // shade, adjacent squares differ — so the four pieces read distinctly.
    const col = Math.abs(dy) > Math.abs(dx) ? GOLD_A : GOLD_B;
    return [...col, 255];
  }
  return [...tile, 255];
}

const SS = 4; // supersample factor per axis → 16 samples/pixel for AA
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const [pr, pg, pb, pa] = sample(
            (x + (sx + 0.5) / SS) / size,
            (y + (sy + 0.5) / SS) / size,
          );
          r += pr * pa;
          g += pg * pa;
          b += pb * pa;
          a += pa;
        }
      }
      const i = (y * size + x) * 4;
      const coverage = a / (SS * SS);
      if (a <= 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      } else {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
        rgba[i + 3] = Math.round(coverage);
      }
    }
  }
  return rgba;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(path.join(OUT_DIR, `icon-${size}.png`), encodePng(size, render(size)));
}
process.stdout.write(`Generated ${SIZES.length} icons in ${OUT_DIR}\n`);
