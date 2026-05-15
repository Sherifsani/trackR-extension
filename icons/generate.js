#!/usr/bin/env node
// Generates icon16.png, icon48.png, icon128.png using only built-in Node.js.
// Run once: node icons/generate.js

const zlib = require('zlib')
const fs   = require('fs')
const path = require('path')

// CRC32 (needed for PNG chunk checksums)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const crc     = crc32(Buffer.concat([typeBuf, data]))
  const out     = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc, 8 + data.length)
  return out
}

function makePNG(size, drawFn) {
  // IHDR — width, height, 8-bit RGBA (color type 6)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA

  // Raw pixel data: each row = 1 filter byte + size * 4 RGBA bytes
  const rowLen = 1 + size * 4
  const raw    = Buffer.alloc(size * rowLen, 0)

  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0 // filter = None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawFn(x, y, size)
      const off = y * rowLen + 1 + x * 4
      raw[off]     = r
      raw[off + 1] = g
      raw[off + 2] = b
      raw[off + 3] = a
    }
  }

  const idat = zlib.deflateSync(raw)

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// trackR icon: amber rounded square with a white clock hand
function drawIcon(x, y, size) {
  const s  = size
  const cx = s / 2
  const cy = s / 2
  const r  = s * 0.42          // outer radius
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)

  // Background (transparent outside the circle)
  if (dist > r) return [0, 0, 0, 0]

  // Amber fill: #f59e0b → rgb(245, 158, 11)
  let [R, G, B, A] = [245, 158, 11, 255]

  // Clock hands (white lines from center)
  const angle = Math.atan2(y - cy, x - cx)
  const handR = r * 0.55

  // Hour hand (~10 o'clock direction)
  const hourAngle = -Math.PI * 0.5 - Math.PI * 0.333
  const dHour = Math.abs(Math.sin(angle - hourAngle) * dist)
  if (dist < handR && dHour < s * 0.055) return [255, 255, 255, 255]

  // Minute hand (straight up)
  const minAngle = -Math.PI / 2
  const dMin = Math.abs(Math.sin(angle - minAngle) * dist)
  if (dist < r * 0.7 && dMin < s * 0.055) return [255, 255, 255, 255]

  // Center dot
  if (dist < s * 0.07) return [255, 255, 255, 255]

  return [R, G, B, A]
}

const outDir = __dirname
for (const size of [16, 48, 128]) {
  const png  = makePNG(size, drawIcon)
  const file = path.join(outDir, `icon${size}.png`)
  fs.writeFileSync(file, png)
  console.log(`✓  icon${size}.png  (${png.length} bytes)`)
}
console.log('\nIcons ready. Load the extension in chrome://extensions → Load unpacked.')
