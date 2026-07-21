// Generates the FRIENDLE app icons from two inline SVG masters.
// Psychedelic-rainbow Wordle tile with a bold "F" (drawn as vector rects so
// rendering never depends on a font being installed). Run: node tools/build-icons.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = resolve(ROOT, 'icons');

// Rainbow stops — vivid full-spectrum sweep, biased to include FRIENDLE's own
// green (#58f26f) and yellow (#f2d558) tile hues so the icon matches the game.
const RAINBOW = `
  <linearGradient id="rb" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0"    stop-color="#ff2d7e"/>
    <stop offset="0.16" stop-color="#ff8a00"/>
    <stop offset="0.32" stop-color="#f2d558"/>
    <stop offset="0.5"  stop-color="#58f26f"/>
    <stop offset="0.66" stop-color="#32d6e6"/>
    <stop offset="0.82" stop-color="#5e7cff"/>
    <stop offset="1"    stop-color="#bf5af2"/>
  </linearGradient>`;

// An "F" built from three rects, sized/positioned relative to a tile rect.
function fMark(tx, ty, ts) {
  const p = ts * 0.20;                 // inner padding
  const x = tx + p, y = ty + p;
  const h = ts - p * 2;                // F height
  const stemW = ts * 0.15;             // vertical bar width
  const armH = ts * 0.145;             // horizontal bar thickness
  const topW = ts * 0.50;              // top arm length
  const midW = ts * 0.40;              // middle arm length
  const c = '#0d0d0e';
  return `
    <g fill="${c}">
      <rect x="${x}" y="${y}" width="${stemW}" height="${h}" rx="${stemW * 0.22}"/>
      <rect x="${x}" y="${y}" width="${topW}" height="${armH}" rx="${armH * 0.22}"/>
      <rect x="${x}" y="${y + h * 0.42}" width="${midW}" height="${armH}" rx="${armH * 0.22}"/>
    </g>`;
}

function tile(tx, ty, ts, radius) {
  // faint larger rainbow echo behind the tile = soft psychedelic glow
  const g = ts * 0.10;
  return `
    <rect x="${tx - g}" y="${ty - g}" width="${ts + g * 2}" height="${ts + g * 2}"
          rx="${radius + g}" fill="url(#rb)" opacity="0.28"/>
    <rect x="${tx}" y="${ty}" width="${ts}" height="${ts}" rx="${radius}" fill="url(#rb)"/>
    ${fMark(tx, ty, ts)}`;
}

// Standard icon: rounded black card, centered rainbow tile (transparent corners).
const standardSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${RAINBOW}</defs>
  <rect width="512" height="512" rx="112" fill="#121213"/>
  ${tile(112, 112, 288, 44)}
</svg>`;

// Maskable / apple-touch: full-bleed black (launcher applies its own mask), tile
// kept inside the 80% safe zone.
const maskableSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${RAINBOW}</defs>
  <rect width="512" height="512" fill="#121213"/>
  ${tile(140, 140, 232, 40)}
</svg>`;

writeFileSync(resolve(ROOT, 'favicon.svg'), standardSVG);
writeFileSync(resolve(ICONS, 'icon.svg'), standardSVG);
writeFileSync(resolve(ICONS, 'icon-maskable.svg'), maskableSVG);

const jobs = [
  ['icon-192.png', standardSVG, 192],
  ['icon-512.png', standardSVG, 512],
  ['icon-maskable-512.png', maskableSVG, 512],
  ['apple-touch-icon.png', maskableSVG, 180],
  ['apple-touch-icon-152.png', maskableSVG, 152],
  ['apple-touch-icon-167.png', maskableSVG, 167],
  ['favicon-32.png', standardSVG, 32],
  ['favicon-16.png', standardSVG, 16],
];

for (const [name, svg, size] of jobs) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(resolve(ICONS, name));
  console.log('wrote icons/' + name + '  (' + size + 'px)');
}
console.log('wrote favicon.svg, icons/icon.svg, icons/icon-maskable.svg');
