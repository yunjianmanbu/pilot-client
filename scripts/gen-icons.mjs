/**
 * 生成 Pilot Client（手机反控端）的应用图标：白底、黑色正体圆角 P、右下角黑点。
 *
 * 与桌面端 / Pilot Link 共用 `pilot/scripts/brand-icon.mjs` 的几何与 PNG 编码，
 * 只把配色换成浅底深字，保证三个产品是同一个字形。
 *
 * 用法（仓库根目录）：
 *
 *   node pilot/mobile-client/scripts/gen-icons.mjs
 *
 * 只写 `pilot/mobile-client/static/icons/` 与其 `icon.svg`，不动其它目录。
 * 退出码 0 = 全部写出；1 = 写入失败。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderIcon, SQUARE_P_PATH } from './brand-icon.mjs'

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
