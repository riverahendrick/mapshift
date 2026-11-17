// Builds the wordmark and banner from the one logo source, embedding the logo directly:
// browsers and GitHub do not load images referenced from inside an SVG shown as an image.
// Run: node scripts/build-assets.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../assets/', import.meta.url))
const logo = readFileSync(`${dir}logo.svg`, 'utf8')
const inner = logo
  .replace(/^[\s\S]*?<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')
  .replace(/<title[\s\S]*?<\/title>/, '')
  .trim()

/** The logo at a position and size, with its gradient ids made unique per use. */
const mark = (x, y, size, key) =>
  `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 256 256">${inner.replace(/id="(\w+)"/g, `id="$1-${key}"`).replace(/url\(#(\w+)\)/g, `url(#$1-${key})`)}</svg>`

const FONT = `'Segoe UI', Inter, system-ui, -apple-system, sans-serif`

const wordmark = (text, accent) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 128" role="img" aria-labelledby="t">
  <title id="t">Mapshift</title>
  ${mark(0, 0, 128, 'w')}
  <text x="152" y="88" font-family="${FONT}" font-size="72" font-weight="700" letter-spacing="-1.5" fill="${text}">Map<tspan fill="${accent}">shift</tspan></text>
</svg>
`

const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 400" role="img" aria-labelledby="t d">
  <title id="t">Mapshift</title>
  <desc id="d">Map your code. Shift to the right model.</desc>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#070d20"/><stop offset=".55" stop-color="#0d1a3d"/><stop offset="1" stop-color="#1a1145"/>
    </linearGradient>
    <radialGradient id="glow" cx=".78" cy=".45" r=".5">
      <stop offset="0" stop-color="#14b8a6" stop-opacity=".22"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="route" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5eead4" stop-opacity=".15"/><stop offset=".5" stop-color="#5eead4" stop-opacity=".7"/><stop offset="1" stop-color="#c4b5fd"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="400" fill="url(#sky)"/>
  <rect width="1280" height="400" fill="url(#glow)"/>
  <g stroke="#5eead4" stroke-opacity=".22" stroke-width="1.5" fill="none">
    <path d="M760 90 L870 150 L990 110 L1110 170 L1210 120"/>
    <path d="M870 150 L900 260 L1030 300 L1150 250"/>
    <path d="M990 110 L1030 300"/>
    <path d="M760 90 L700 210 L900 260"/>
    <path d="M1110 170 L1150 250 L1230 330"/>
    <path d="M700 210 L780 330 L1030 300"/>
  </g>
  <g fill="#5eead4">
    <circle cx="760" cy="90" r="5" fill-opacity=".55"/><circle cx="870" cy="150" r="7" fill-opacity=".75"/>
    <circle cx="990" cy="110" r="5" fill-opacity=".55"/><circle cx="1110" cy="170" r="6" fill-opacity=".6"/>
    <circle cx="1210" cy="120" r="4" fill-opacity=".45"/><circle cx="900" cy="260" r="9" fill-opacity=".9"/>
    <circle cx="1030" cy="300" r="6" fill-opacity=".6"/><circle cx="1150" cy="250" r="5" fill-opacity=".5"/>
    <circle cx="700" cy="210" r="4" fill-opacity=".45"/><circle cx="780" cy="330" r="5" fill-opacity=".5"/>
    <circle cx="1230" cy="330" r="4" fill-opacity=".4"/>
  </g>
  <path d="M700 210 L870 150 L900 260 L1110 170" stroke="url(#route)" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="1110" cy="170" r="10" fill="#c4b5fd"/>
  <circle cx="1110" cy="170" r="18" fill="none" stroke="#c4b5fd" stroke-opacity=".45" stroke-width="2"/>
  ${mark(96, 100, 112, 'b')}
  <text x="232" y="180" font-family="${FONT}" font-size="84" font-weight="700" letter-spacing="-2" fill="#f1f5ff">Map<tspan fill="#5eead4">shift</tspan></text>
  <text x="100" y="268" font-family="${FONT}" font-size="30" fill="#c7d2fe">Map your code. Shift to the right model.</text>
  <text x="100" y="310" font-family="${FONT}" font-size="20" fill="#8b9bc8">Fewer tokens · Lower cost · Same quality · 100% local</text>
</svg>
`

writeFileSync(`${dir}wordmark.svg`, wordmark('#0b1530', '#0e7490'))
writeFileSync(`${dir}wordmark-dark.svg`, wordmark('#f1f5ff', '#5eead4'))
writeFileSync(`${dir}banner.svg`, banner)
console.log('Built wordmark.svg, wordmark-dark.svg and banner.svg')
