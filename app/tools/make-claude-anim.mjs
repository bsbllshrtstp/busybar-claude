#!/usr/bin/env node
// Draws the Claude character, one section per Claude Code state, and encodes it as a BUSY Bar
// .anim file (format "bicycle1", see busybar-firmware documentation/File Formats.dox.md and
// scripts/seq2anim.py). No dependencies.
//
//   node tools/make-claude-anim.mjs                 # writes src/animations/claude.anim
//   node tools/make-claude-anim.mjs --preview x.png # also writes a 10x preview, one row per state

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SIZE = 16;
const FPS = 8;

const ORANGE = [0xd9, 0x77, 0x57];
const SHADE = [0xa8, 0x55, 0x3c];
const WHITE = [0xff, 0xff, 0xff];
const GRAY = [0x80, 0x80, 0x80];
const RED = [0xff, 0x3b, 0x30];
const YELLOW = [0xff, 0xcc, 0x00];
const BLACK = [0, 0, 0];

// ---------------------------------------------------------------- drawing

function canvas() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => BLACK));
}

function px(c, x, y, color) {
  if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) c[y][x] = color;
}

function fill(c, x, y, w, h, color) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(c, x + i, y + j, color);
}

/**
 * The character: a wide orange block with slit eyes, stubby arms and four legs.
 * At rest it stands on the bottom row; `dy` lifts it, `squash` flattens it.
 */
function claude(c, o = {}) {
  const { dy = 0, eyes = "open", look = 0, arms = "out", legs = "stand", squash = 0 } = o;
  const h = 8 - squash; // body height
  const w = 12 + squash; // body width
  const x = Math.floor((SIZE - w) / 2);
  const legH = legs === "tuck" ? 1 : 2;
  const top = SIZE - legH - h - dy;

  fill(c, x, top, w, h, ORANGE);
  fill(c, x, top + h - 1, w, 1, SHADE); // a darker bottom edge reads as volume

  // Eyes: 1 px wide slits, 3 px tall (2 when squashed). Black is the background colour,
  // so an eye is a hole in the body.
  const eyeY = top + 2;
  const eyeH = squash > 1 ? 2 : 3;
  const lx = x + 3 + look;
  const rx = x + w - 4 + look;
  if (eyes === "open") {
    fill(c, lx, eyeY, 1, eyeH, BLACK);
    fill(c, rx, eyeY, 1, eyeH, BLACK);
  } else if (eyes === "closed") {
    fill(c, lx - 1, eyeY + 2, 2, 1, BLACK);
    fill(c, rx, eyeY + 2, 2, 1, BLACK);
  } else if (eyes === "happy") {
    // ^ ^
    px(c, lx - 1, eyeY + 2, BLACK);
    px(c, lx, eyeY + 1, BLACK);
    px(c, lx + 1, eyeY + 2, BLACK);
    px(c, rx - 1, eyeY + 2, BLACK);
    px(c, rx, eyeY + 1, BLACK);
    px(c, rx + 1, eyeY + 2, BLACK);
  }

  // Arms: 2x2 nubs on the sides; "up" raises them above the shoulders.
  const armY = top + 4;
  const arm = (side, mode) => {
    const ax = side < 0 ? x - 2 : x + w;
    if (mode === "up") fill(c, ax, top - 1, 2, 3, ORANGE);
    else if (mode === "down") fill(c, ax, armY + 1, 2, 2, ORANGE);
    else fill(c, ax, armY, 2, 2, ORANGE);
  };
  const [la, ra] = Array.isArray(arms) ? arms : [arms, arms];
  arm(-1, la);
  arm(1, ra);

  // Legs: four 1 px legs; "walkA"/"walkB" lift alternate pairs.
  const legX = [x + 2, x + 4, x + w - 5, x + w - 3];
  legX.forEach((lxx, i) => {
    let lh = legH;
    if (legs === "walkA" && i % 2 === 0) lh = 1;
    if (legs === "walkB" && i % 2 === 1) lh = 1;
    fill(c, lxx, top + h, 1, lh, ORANGE);
  });
  return { top, x, w };
}

// Tiny glyphs drawn above the character.
function dots(c, n) {
  for (let i = 0; i < n; i++) px(c, 5 + i * 3, 1, WHITE);
}
function bang(c, color) {
  fill(c, 14, 0, 1, 3, color);
  px(c, 14, 4, color);
}
function zee(c, x, y, color) {
  fill(c, x, y, 4, 1, color);
  px(c, x + 2, y + 1, color);
  px(c, x + 1, y + 2, color);
  fill(c, x, y + 3, 4, 1, color);
}

// ---------------------------------------------------------------- sections

/** state -> frames; each frame is a function drawing onto a fresh canvas. */
const SECTIONS = {
  // Standing, blinks once.
  ready: [0, 0, 0, 0, 0, 0, 1, 0].map((b) => (c) => claude(c, { eyes: b ? "closed" : "open" })),

  // Looks around while a thought bubbles up: . .. ...
  think: Array.from({ length: 16 }, (_, i) => (c) => {
    const look = [0, 0, -1, -1, -1, -1, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0][i];
    claude(c, { look, dy: i % 8 < 4 ? 0 : 1, eyes: i === 14 ? "closed" : "open" });
    dots(c, Math.min(3, Math.floor(i / 4) + 1) * (i < 15 ? 1 : 0));
  }),

  // Busy: marches in place, arms pumping.
  tool: Array.from({ length: 4 }, (_, i) => (c) =>
    claude(c, {
      dy: i % 2,
      legs: i < 2 ? "walkA" : "walkB",
      arms: i < 2 ? ["up", "down"] : ["down", "up"],
    }),
  ),

  // Needs you: jumps and waves, with a blinking red "!".
  input: Array.from({ length: 4 }, (_, i) => (c) => {
    claude(c, { dy: i === 1 ? 2 : i === 2 ? 1 : 0, arms: i % 2 ? "up" : "out" });
    if (i < 2) bang(c, RED);
  }),

  // Compacting: squashes down and springs back.
  compact: [0, 1, 2, 3, 3, 2, 1, 0].map((s) => (c) => claude(c, { squash: s })),

  // Done: hops with a happy face and a sparkle at the top of the jump, then rests a while.
  done: Array.from({ length: 24 }, (_, i) => (c) => {
    const dy = [0, 2, 4, 5, 4, 2, 0][i] ?? 0;
    claude(c, { dy, eyes: "happy", arms: dy > 2 ? "up" : "out", legs: dy ? "tuck" : "stand" });
    if (dy >= 4) {
      px(c, 1, 1, YELLOW);
      px(c, 14, 2, YELLOW);
      px(c, 0, 5, YELLOW);
    }
  }),

  // Waiting: asleep, breathing slowly, z's drifting up.
  idle: Array.from({ length: 16 }, (_, i) => (c) => {
    claude(c, { eyes: "closed", arms: "down", squash: i % 8 < 4 ? 0 : 1 });
    const y = 4 - Math.floor(i / 4);
    if (y >= 0) zee(c, 12, y, i < 8 ? WHITE : GRAY);
  }),
};

// ---------------------------------------------------------------- .anim encoder

/** One frame as packed BGR888 pixels (the "rgb888" color mode). */
function packBGR(canvasRows, mask) {
  const out = [];
  canvasRows.flat().forEach(([r, g, b], i) => {
    if (!mask || mask[i]) out.push(b, g, r);
  });
  return Buffer.from(out);
}

function encodeAnim(sections) {
  const frames = [];
  const named = [];
  for (const [name, list] of Object.entries(sections)) {
    named.push({ name, start: frames.length, end: frames.length + list.length - 1 });
    for (const draw of list) {
      const c = canvas();
      draw(c);
      frames.push(c);
    }
  }
  const allSections = [{ name: "default", start: 0, end: frames.length - 1 }, ...named];
  const keyframes = new Set(allSections.map((s) => s.start));

  // Frames: a section start is a keyframe (every pixel); others carry only changed pixels.
  const encoded = [];
  let prev = null;
  frames.forEach((c, i) => {
    const flat = c.flat().map((p) => p.join(","));
    let maskEnc, maskBytes, maskBits, pixels;
    if (keyframes.has(i) || !prev) {
      maskEnc = 1; // FULLY_WHITE
      maskBytes = Buffer.alloc(0);
      maskBits = 0;
      pixels = packBGR(c, null);
    } else {
      const mask = flat.map((p, j) => p !== prev[j]);
      if (!mask.some(Boolean)) {
        maskEnc = 0; // FULLY_BLACK: nothing changed
        maskBytes = Buffer.alloc(0);
        maskBits = 0;
        pixels = Buffer.alloc(0);
      } else {
        maskEnc = 4; // BITMAP, MSB first
        maskBytes = Buffer.alloc(Math.ceil(mask.length / 8));
        mask.forEach((m, j) => {
          if (m) maskBytes[j >> 3] |= 128 >> (j & 7);
        });
        maskBits = mask.length;
        pixels = packBGR(c, mask);
      }
    }
    const head = Buffer.alloc(5);
    head.writeUInt8(0 /* RAW pixels */ | (maskEnc << 4), 0);
    head.writeUInt16LE(maskBits, 1);
    head.writeUInt16LE(pixels.length, 3);
    encoded.push({ buf: Buffer.concat([head, maskBytes, pixels]), maskBits, pixLen: pixels.length });
    prev = flat;
  });

  const HEADER_LEN = 8 + 4 + 6 + 8 + 8;
  const sectionBufs = allSections.map((s) => Buffer.concat([Buffer.alloc(12), Buffer.from(s.name + "\0")]));
  const sectionsLen = sectionBufs.reduce((n, b) => n + b.length, 0);
  let offs = HEADER_LEN + sectionsLen;
  const frameOffsets = encoded.map((f) => {
    const o = offs;
    offs += f.buf.length;
    return o;
  });
  allSections.forEach((s, i) => {
    sectionBufs[i].writeUInt32LE(s.start, 0);
    sectionBufs[i].writeUInt32LE(s.end, 4);
    sectionBufs[i].writeUInt32LE(frameOffsets[s.start], 8);
  });

  // "<8s BBBB HHBB II II"
  const header = Buffer.alloc(HEADER_LEN);
  header.write("bicycle1", 0, "ascii");
  header.writeUInt8(0, 8); // flags
  header.writeUInt8(SIZE, 9); // width
  header.writeUInt8(SIZE, 10); // height
  header.writeUInt8(0, 11); // color mode: rgb888
  header.writeUInt16LE(Math.max(...encoded.map((f) => f.maskBits)), 12);
  header.writeUInt16LE(Math.max(...encoded.map((f) => f.pixLen)), 14);
  header.writeUInt8(FPS, 16);
  header.writeUInt8(0, 17);
  header.writeUInt32LE(sectionsLen, 18);
  header.writeUInt32LE(offs - HEADER_LEN - sectionsLen, 22);
  header.writeUInt32LE(allSections.length, 26);
  header.writeUInt32LE(encoded.length, 30);

  return { data: Buffer.concat([header, ...sectionBufs, ...encoded.map((f) => f.buf)]), frames, named };
}

// ---------------------------------------------------------------- preview PNG

function writePng(file, width, height, rgbAt) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) rgbAt(x, y).forEach((v, k) => (raw[y * (width * 3 + 1) + 1 + x * 3 + k] = v));
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let r = 0xffffffff;
    for (const x of b) r = table[(r ^ x) & 0xff] ^ (r >>> 8);
    return (r ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", zlib.deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

function preview(file, frames, named) {
  const K = 6; // scale
  const GAP = 2;
  const cols = Math.max(...named.map((s) => s.end - s.start + 1));
  const cell = SIZE * K + GAP;
  writePng(file, cols * cell, named.length * cell, (x, y) => {
    const row = Math.floor(y / cell);
    const col = Math.floor(x / cell);
    const fx = Math.floor((x % cell) / K);
    const fy = Math.floor((y % cell) / K);
    const s = named[row];
    if (fx >= SIZE || fy >= SIZE || col > s.end - s.start) return [40, 40, 40];
    return frames[s.start + col][fy][fx];
  });
}

// ---------------------------------------------------------------- main

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "src", "animations", "claude.anim");
const { data, frames, named } = encodeAnim(SECTIONS);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, data);
console.log(`${out}: ${data.length} bytes, ${frames.length} frames, sections: ${named.map((s) => s.name).join(" ")}`);

const p = process.argv.indexOf("--preview");
if (p > 0) {
  preview(process.argv[p + 1], frames, named);
  console.log(`preview: ${process.argv[p + 1]}`);
}
