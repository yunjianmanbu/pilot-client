import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SPLASH_RETRY_DELAYS, closeSplash, installSplashGuard, resolveSplashDelay } from '../lib/splash.js'
import { PALETTE, SPLASH, renderSplash } from '../scripts/gen-icons.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPLASH_FILE = resolve(ROOT, 'static/splash.9.png')

/** 极简 PNG 解码，只用于断言启动图（8bit RGBA、无隔行）。 */
function decodePng(file) {
  const buffer = readFileSync(file)
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '不是 PNG')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const colorType = buffer[25]
  assert.equal(colorType, 6, '启动图必须是 RGBA')
  const chunks = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflate(Buffer.concat(chunks))
  const stride = width * 4
  const pixels = Buffer.alloc(height * stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    const line = raw.subarray(cursor, cursor + stride)
    cursor += stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      pixels[y * stride + x] = value & 0xff
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const index = (y * width + x) * 4
      return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]
    }
  }
}

function inflate(buffer) {
  // 复用 node 的 zlib（测试环境有，运行时不需要）。
  return zlibInflate(buffer)
}

let zlibInflate = (buffer) => buffer

test.before(async () => {
  const zlib = await import('node:zlib')
  zlibInflate = zlib.inflateSync
})

test('启动图：文件存在且是 386×386 的 9-patch 画布', () => {
  assert.ok(existsSync(SPLASH_FILE), 'static/splash.9.png 缺失，先跑 npm run icons')
  const image = decodePng(SPLASH_FILE)
  assert.equal(image.width, SPLASH.size)
  assert.equal(image.height, SPLASH.size)
})

test('启动图：白底黑 P，内容区不透明', () => {
  const image = decodePng(SPLASH_FILE)
  // 四角在可绘制区内是白底（9-patch 标记只在顶/左最外一行一列）。
  assert.deepEqual(image.pixel(4, 4), [255, 255, 255, 255])
  assert.deepEqual(image.pixel(SPLASH.size - 5, SPLASH.size - 5), [255, 255, 255, 255])
  // 正中是 P 的笔画，必须是不透明的深色。
  const center = image.pixel(SPLASH.size >> 1, SPLASH.size >> 1)
  assert.equal(center[3], 255)
  assert.ok(center[0] < 80 && center[1] < 80 && center[2] < 80, `正中像素 ${center} 不是深色笔画`)
})

test('启动图：9-patch 标记只占顶边与左边的两侧段', () => {
  const image = decodePng(SPLASH_FILE)
  const marked = (x, y) => image.pixel(x, y)[3] > 0
  // 顶边中间一段（Logo 区域之上）不标记 = 不拉伸。
  assert.equal(marked(SPLASH.size >> 1, 0), false)
  // 两侧标记。
  assert.equal(marked(4, 0), true)
  assert.equal(marked(SPLASH.size - 5, 0), true)
  assert.equal(marked(0, 4), true)
  assert.equal(marked(0, SPLASH.size - 5), true)
  // 底边与右边完全透明（不限内容区）。
  assert.equal(marked(SPLASH.size >> 1, SPLASH.size - 1), false)
  assert.equal(marked(SPLASH.size - 1, SPLASH.size >> 1), false)
})

test('启动图：渲染函数与仓库里的文件同源', () => {
  assert.deepEqual(renderSplash(PALETTE), readFileSync(SPLASH_FILE))
})

test('splash 兜底：没有 plus 时什么都不做', () => {
  assert.equal(closeSplash(null), false)
  const cancel = installSplashGuard({ plusApi: null })
  assert.equal(typeof cancel, 'function')
  cancel()
})

test('splash 兜底：按多个时间点反复关闭，取消后不再调用', () => {
  const calls = []
  const timers = []
  const cancel = installSplashGuard({
    plusApi: { navigator: { closeSplashscreen: () => calls.push(1) } },
    scheduler: (fn, ms) => {
      timers.push({ fn, ms })
      return ms
    },
    clearer: () => {}
  })
  assert.deepEqual(timers.map((timer) => timer.ms), SPLASH_RETRY_DELAYS)
  timers[0].fn()
  assert.equal(calls.length, 1)
  cancel()
  for (const timer of timers) timer.fn()
  assert.equal(calls.length, 1, '取消后不应再关闭启动图')
})

test('splash 兜底：非法延时退回默认值', () => {
  assert.equal(resolveSplashDelay(undefined), 800)
  assert.equal(resolveSplashDelay(-5), 800)
  assert.equal(resolveSplashDelay('abc'), 800)
  assert.equal(resolveSplashDelay(0), 0)
  assert.equal(resolveSplashDelay('1200'), 1200)
})

test('splash 兜底：运行时抛错不会中断主流程', () => {
  const cancel = installSplashGuard({
    plusApi: {
      navigator: {
        closeSplashscreen() {
          throw new Error('splash not ready')
        }
      }
    },
    delays: [0],
    scheduler: (fn) => {
      fn()
      return 1
    },
    clearer: () => {}
  })
  cancel()
})
