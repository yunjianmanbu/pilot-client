/**
 * SHA-256（纯 JS，返回小写 hex）。
 *
 * 为什么不引依赖：Pilot Client 是零依赖的 uni-app 工程（`npm test` 直接读源码），
 * 也不走打包器，加一个 npm 依赖就得进 HBuilderX 的构建链；这里只需要算一个
 * 几百 KB ~ 几 MB 资源包的摘要，自带一份足够。
 *
 * 实现是标准的 FIPS 180-4 SHA-256，输入 Uint8Array，输出 64 位十六进制。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits))

const IV = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]

function toBytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input)
}

/**
 * 增量 SHA-256：`update()` 可以反复喂分块，`digest()` 收尾输出小写 hex。
 *
 * 为什么需要增量：更新包校验必须**分块**从原生桥读取再算摘要。HTML5+ 的
 * readAsArrayBuffer 一次性读十几 MB 时可能一直没有回调，界面就永远停在校验阶段。
 * 同一个实现也让 sha256Hex 与增量版本不会算出两种结果。
 */
export function createSha256() {
  const H = new Uint32Array(IV)
  const W = new Uint32Array(64)
  const block = new Uint8Array(64)
  let blockLength = 0
  let totalLength = 0
  let finished = false

  function compress(view, offset) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  return {
    /** 喂入一块字节（Uint8Array / Buffer），返回自身便于链式调用。 */
    update(chunk) {
      if (finished) throw new Error('sha256: digest() 之后不能再 update()')
      const bytes = toBytes(chunk)
      totalLength += bytes.length
      let offset = 0
      if (blockLength > 0) {
        const take = Math.min(64 - blockLength, bytes.length)
        block.set(bytes.subarray(0, take), blockLength)
        blockLength += take
        offset = take
        if (blockLength < 64) return this
        compress(new DataView(block.buffer, block.byteOffset, block.byteLength), 0)
        blockLength = 0
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      while (offset + 64 <= bytes.length) {
        compress(view, offset)
        offset += 64
      }
      if (offset < bytes.length) {
        block.set(bytes.subarray(offset), 0)
        blockLength = bytes.length - offset
      }
      return this
    },
    /** 收尾：补位（0x80 + 0 填充 + 64 位大端位长），输出小写 hex。只能调用一次。 */
    digest() {
      if (finished) throw new Error('sha256: digest() 只能调用一次')
      finished = true
      const bitLength = totalLength * 8
      const tail = new Uint8Array(blockLength < 56 ? 64 : 128)
      tail.set(block.subarray(0, blockLength))
      tail[blockLength] = 0x80
      const view = new DataView(tail.buffer)
      // 长度超过 2^32 位（512MB）时高位才非零，这里仍按规范写满 8 字节。
      view.setUint32(tail.length - 8, Math.floor(bitLength / 0x100000000))
      view.setUint32(tail.length - 4, bitLength >>> 0)
      for (let offset = 0; offset < tail.length; offset += 64) compress(view, offset)
      let hex = ''
      for (const word of H) hex += word.toString(16).padStart(8, '0')
      return hex
    }
  }
}

/** 计算 SHA-256，输入 Uint8Array（或 Buffer），返回小写 hex 字符串。 */
export function sha256Hex(input) {
  return createSha256().update(input).digest()
}
