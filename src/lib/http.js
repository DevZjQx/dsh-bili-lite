/**
 * node:http 应答/请求体小工具（宿主路由用；与 B 站无关）。
 * json() 统一带上 no-store：设置与凭据状态不进任何缓存。
 */
export function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/** 请求体上限 32KB：设置页用不到更多，够防误用 */
export function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
