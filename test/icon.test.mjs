import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { PALETTE, SIZES } from '../scripts/gen-icons.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 只解我们自己生成的 RGBA8 PNG，足够验证配色。 */
function decodePng(file) {
  const buffer = readFileSync(file)
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${file} 不是 PNG`)
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  assert.equal(bitDepth, 8)
  assert.equal(colorType, 6, '图标必须是 RGBA')
  const raw = inflateSync(Buffer.concat(idat))
  const channels = 4
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const row = raw.subarray(pos, pos + stride)
    pos += stride
    const out = pixels.subarray(y * stride, y * stride + stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0
      const value = row[x]
      let decoded
      switch (filter) {
        case 0:
          decoded = value
          break
        case 1:
          decoded = value + left
          break
        case 2:
          decoded = value + up
          break
        case 3:
          decoded = value + ((left + up) >> 1)
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          decoded = value + predictor
          break
        }
        default:
          throw new Error(`未知的 PNG 行过滤：${filter}`)
      }
      out[x] = decoded & 0xff
    }
  }
  function pixel(px, py) {
    const at = py * stride + px * channels
    return [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]]
  }
  return { width, height, pixel }
}

const near = (value, expected, tolerance = 6) => Math.abs(value - expected) <= tolerance

test('图标：白底、黑色 P、黑色圆点', () => {
  const icon = decodePng(resolve(ROOT, 'static/icons/48.png'))
  assert.equal(icon.width, 48)
  assert.equal(icon.height, 48)

  // 圆角外透明
  assert.equal(icon.pixel(0, 0)[3], 0, '左上角应在圆角外，alpha 为 0')

  // 底色白（取 64 坐标系里的 (10,10)，位于 P 之外）
  const bg = icon.pixel(Math.floor((10 / 64) * 48), Math.floor((10 / 64) * 48))
  assert.ok(near(bg[0], 255) && near(bg[1], 255) && near(bg[2], 255), `底色应为白色，实际 ${bg}`)
  assert.equal(bg[3], 255)

  // 竖笔黑（64 坐标 (23,40)）
  const stem = icon.pixel(Math.floor((23 / 64) * 48), Math.floor((40 / 64) * 48))
  assert.ok(near(stem[0], 17) && near(stem[1], 17) && near(stem[2], 17), `P 的竖笔应为黑色，实际 ${stem}`)

  // 右下圆点黑（64 坐标 (47.5,47.5)）
  const dot = icon.pixel(Math.floor((47.5 / 64) * 48), Math.floor((47.5 / 64) * 48))
  assert.ok(near(dot[0], 17) && near(dot[1], 17), `圆点应为黑色，实际 ${dot}`)
})

test('图标：所有尺寸都已生成，且是正方形', () => {
  for (const size of SIZES) {
    const file = size === 1024 ? 'static/icons/icon.png' : `static/icons/${size}.png`
    const icon = decodePng(resolve(ROOT, file))
    assert.equal(icon.width, size, `${file} 宽度不对`)
    assert.equal(icon.height, size, `${file} 高度不对`)
  }
})

test('图标：调色板就是白底黑字黑点', () => {
  assert.deepEqual(PALETTE.background, [255, 255, 255])
  assert.deepEqual(PALETTE.ink, [17, 17, 17])
  assert.deepEqual(PALETTE.dot, [17, 17, 17])
})

test('图标：svg 使用同一套配色', () => {
  const svg = readFileSync(resolve(ROOT, 'static/icons/icon.svg'), 'utf8')
  assert.match(svg, /fill="#ffffff"/)
  const darkFills = svg.match(/fill="#111111"/g) || []
  assert.equal(darkFills.length, 2, 'SVG 里 P 与圆点都应是黑色')
})
