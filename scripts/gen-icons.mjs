/**
 * 生成 Pilot Client（手机反控端）的应用图标：白底、黑色正体圆角 P、右下角黑点。
 *
 * 与桌面端 / Pilot Link 共用 `pilot/scripts/brand-icon.mjs` 的几何与 PNG 编码，
 * 只把配色换成浅底深字，保证三个产品是同一个字形。
 *
 * 用法（仓库根目录）：
 *
 *   node pilot/pilot-client/scripts/gen-icons.mjs
 *
 * 只写 `pilot/pilot-client/static/icons/` 与其 `icon.svg`，不动其它目录。
 * 退出码 0 = 全部写出；1 = 写入失败。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePng, renderIcon, renderIconPixels, SQUARE_P_PATH } from './brand-icon.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 白底 #FFFFFF、黑字 #111111、黑点 #111111。 */
export const PALETTE = {
  background: [255, 255, 255],
  ink: [17, 17, 17],
  dot: [17, 17, 17]
}

/** Android 各 dpi 需要的尺寸；1024 给应用市场与官网下载区。 */
export const SIZES = [48, 72, 96, 144, 192, 1024]

const hex = (color) => `#${color.map((n) => n.toString(16).padStart(2, '0')).join('')}`

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <rect x="2" y="2" width="60" height="60" rx="14.5" fill="${hex(PALETTE.background)}"/>
  <path d="${SQUARE_P_PATH}" fill="${hex(PALETTE.ink)}"/>
  <circle cx="47.5" cy="47.5" r="5.5" fill="${hex(PALETTE.dot)}"/>
</svg>
`

/**
 * 启动图（splash）尺寸与 9-patch 网格。
 *
 * 和 Pilot Link 的 `static/splash.9.png` 用同一套网格：386×386 画布，最外 1px 是
 * 9-patch 标记框，顶边/左边只把两侧 96px 标成可拉伸，中间 192px 固定，正好放 Logo。
 * 这样全面屏、18:9、4:3 各种长宽比下 P 都不会被拉变形。
 */
export const SPLASH = { size: 386, logo: 192, patch: 96 }

/**
 * 生成白底黑 P 的启动图 9-patch。
 *
 * 底色沿用图标的白底，Logo 复用 `renderIconPixels`（与桌面端/官网同一个字形），
 * 圆角外的透明区域在白底上自然不可见，所以看到的只有黑色 P 与黑点。
 */
export function renderSplash(palette = PALETTE, options = {}) {
  const size = options.size ?? SPLASH.size
  const logo = options.logo ?? SPLASH.logo
  const patch = options.patch ?? SPLASH.patch
  const rgba = Buffer.alloc(size * size * 4)
  const put = (x, y, r, g, b, a) => {
    const index = (y * size + x) * 4
    rgba[index] = r
    rgba[index + 1] = g
    rgba[index + 2] = b
    rgba[index + 3] = a
  }
  const background = palette.background
  // 可绘制区 = 去掉最外 1px 标记框，整块铺底色（不透明，避免启动图透出黑底）。
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) put(x, y, background[0], background[1], background[2], 255)
  }
  // Logo 居中：先取未压缩像素，再按 alpha 合成到底色上（不做透明叠加）。
  const icon = renderIconPixels(logo, palette)
  const offset = Math.round((size - logo) / 2)
  for (let y = 0; y < logo; y++) {
    for (let x = 0; x < logo; x++) {
      const src = (y * logo + x) * 4
      const alpha = icon[src + 3] / 255
      if (alpha <= 0) continue
      const dx = offset + x
      const dy = offset + y
      put(
        dx,
        dy,
        Math.round(icon[src] * alpha + background[0] * (1 - alpha)),
        Math.round(icon[src + 1] * alpha + background[1] * (1 - alpha)),
        Math.round(icon[src + 2] * alpha + background[2] * (1 - alpha)),
        255
      )
    }
  }
  // 9-patch 标记：顶边与左边两段黑色不透明像素 = 可拉伸；右下不标记 = 不限内容区。
  for (let i = 1; i <= patch; i++) {
    put(i, 0, 0, 0, 0, 255)
    put(size - 1 - i, 0, 0, 0, 0, 255)
    put(0, i, 0, 0, 0, 255)
    put(0, size - 1 - i, 0, 0, 0, 255)
  }
  return encodePng(size, size, rgba)
}

export function generate(outDir = resolve(ROOT, 'static/icons')) {
  mkdirSync(outDir, { recursive: true })
  const written = []
  for (const size of SIZES) {
    const name = size === 1024 ? 'icon.png' : `${size}.png`
    const file = resolve(outDir, name)
    writeFileSync(file, renderIcon(size, PALETTE))
    written.push(file)
  }
  const svg = resolve(outDir, 'icon.svg')
  writeFileSync(svg, ICON_SVG)
  written.push(svg)
  const splash = resolve(ROOT, 'static/splash.9.png')
  writeFileSync(splash, renderSplash())
  written.push(splash)
  return written
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const file of generate()) {
      process.stdout.write(`${file.slice(ROOT.length + 1)}\n`)
    }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`)
    process.exit(1)
  }
}
