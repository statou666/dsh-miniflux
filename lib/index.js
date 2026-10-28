/**
 * dsh-miniflux — Miniflux 插件（宿主侧）。
 *
 * 五件事：
 *   1. EPUB 内嵌图片（WebP/AVIF 用 ffmpeg 转 JPEG）
 *   2. 设置项中英双语
 *   3. 定时任务可以用 DSH 里已配置的模型（ctx.llm），也可以填自己的 OpenAI 兼容接口
 *   4. 晚报 / 精选 / 每源 EPUB 各自一条 cron 表达式
 *   5. EPUB 保存目录可设置
 *
 * 只依赖 node 内建模块 + @deepseek-ai/schemastery。
 */

import z from '@deepseek-ai/schemastery'
import { deflateRawSync } from 'node:zlib'
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'

export const name = 'miniflux'

export const inject = ['webServer', 'tools', 'llm']

/** 读配置字段（可能是 schemastery 的 live reference）。 */
function value(field, fallback) {
  if (field === undefined) return fallback
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    const current = field.get()
    return current === undefined ? fallback : current
  }
  return field
}

const B = (zh, en) => `${zh} / ${en}`

export const Config = z.object({
  enabled: z.boolean().default(true).volatile()
    .description(B('总开关，关掉后不注册路由、工具和定时任务', 'Master switch; off means no routes, no tools, no schedule')),
  minifluxUrl: z.string().default('').volatile()
    .description(B('Miniflux 实例地址，例如 http://192.168.1.10:8080 或 https://rss.example.com（必填）', 'Miniflux base URL, e.g. http://192.168.1.10:8080 or https://rss.example.com (required)')),
  minifluxToken: z.string().default('').volatile()
    .description(B('Miniflux API token（设置 → API 密钥）', 'Miniflux API token (Settings → API Keys)')),

  aiSource: z.union([z.const('dsh'), z.const('custom')]).default('dsh').volatile()
    .description(B('用哪里的模型：dsh = DSH 已配置的模型（无需再填 key）；custom = 自定义接口', 'Model source: dsh = models already configured in DSH; custom = your own endpoint')),
  dshProvider: z.string().default('deepseek-official').volatile()
    .description(B('DSH 模型的服务商名（设置 → 模型 里的 provider）', 'DSH provider name (as shown in Settings → Models)')),
  dshModel: z.string().default('deepseek-flash').volatile()
    .description(B('DSH 模型 id', 'DSH model id')),
  aiBaseUrl: z.string().default('https://api.deepseek.com/v1').volatile()
    .description(B('自定义模型的 OpenAI 兼容地址（aiSource=custom 时用）', 'OpenAI-compatible base URL (used when aiSource=custom)')),
  aiApiKey: z.string().default('').volatile()
    .description(B('自定义模型的 API Key（aiSource=custom 时用）', 'API key for the custom endpoint')),
  aiModel: z.string().default('deepseek-chat').volatile()
    .description(B('自定义模型的模型名', 'Model name for the custom endpoint')),

  digestCron: z.string().default('30 7,18 * * *').volatile()
    .description(B('AI 日报的 cron（分 时 日 月 周，本机时区）', 'Cron for the AI digest (min hour day month weekday, local time)')),
  picksCron: z.string().default('45 7,18 * * *').volatile()
    .description(B('「精选」EPUB 的 cron；留空则不生成', 'Cron for the picks EPUB; empty disables it')),
  feedEpubCron: z.string().default('0 8 * * *').volatile()
    .description(B('「自选源」EPUB 的 cron；留空则不生成', 'Cron for the per-feed EPUB; empty disables it')),

  modelTimeoutSec: z.number().step(10).min(30).max(7200).default(600).volatile()
    .description(B('单次模型调用超时（秒）。本地慢模型可以放大到 600 以上', 'Per-call model timeout in seconds; raise it for slow local models')),
  aiBatchSize: z.number().step(1).min(3).max(40).default(12).volatile()
    .description(B('AI 能力：每次模型调用处理几篇（日报与精选共用；越小越慢越稳）', 'AI batch size shared by digest and picks (smaller = slower but more reliable)')),
  lookbackHours: z.number().step(1).min(1).max(168).default(24).volatile()
    .description(B('回看多少小时内的文章', 'How many hours back to collect articles')),
  maxCandidates: z.number().step(10).min(20).max(500).default(200).volatile()
    .description(B('日报：每次最多把多少篇交给模型（24 小时内的文章）', 'Daily digest: max entries handed to the model (within the lookback window)')),
  picksSkipScreened: z.boolean().default(true).volatile()
    .description(B('精选跳过已筛过的条目（避免每次重复消耗模型）', 'Picks skip entries already screened (avoids re-spending model calls)')),
  picksCandidates: z.number().step(10).min(10).max(500).default(200).volatile()
    .description(B('精选：每次从最新未读里取多少篇交给模型', 'Picks: how many newest unread entries to hand to the model')),
  digestMaxItems: z.number().step(1).min(0).max(60).default(0).volatile()
    .description(B('日报条数建议上限，0 = 完全交给模型判断', 'Suggested item cap for the daily digest; 0 = let the model decide')),
  aiMaxPicks: z.number().step(1).min(0).max(20).default(0).volatile()
    .description(B('精选条数上限，0 = 完全交给模型判断', 'Picks cap; 0 = let the model decide')),

  epubFeedNames: z.string().default('').volatile()
    .description(B('「自选源 EPUB」收录哪些源（逗号分隔的源名或 id，留空=全部）', 'Feeds included in the per-feed EPUB (comma-separated names or ids; empty = all)')),
  epubDir: z.string().default('').volatile()
    .description(B('EPUB 保存目录（绝对路径；留空 = $DSH_HOME/miniflux-epub）', 'EPUB output directory (absolute; empty = $DSH_HOME/miniflux-epub)')),
  withImages: z.boolean().default(true).volatile()
    .description(B('EPUB 是否内嵌图片（WebP 自动转 JPEG）', 'Embed images into the EPUB (WebP converted to JPEG)')),
  imageProxy: z.string().default('').volatile()
    .description(B('抓图用的 HTTP 代理，如 http://user:pass@host:port；留空=直连', 'HTTP proxy for image downloads, e.g. http://user:pass@host:port; empty = direct')),
  autoStar: z.boolean().default(true).volatile()
    .description(B('AI 挑出的精彩文章自动加星（Miniflux 原生收藏）', 'Star the articles the model picks (native Miniflux bookmark)')),
  language: z.string().default('中文').volatile()
    .description(B('简报语言', 'Digest language')),
})

// ---------------------------------------------------------------------------
// Miniflux 客户端
// ---------------------------------------------------------------------------

function makeClient(cfg) {
  const base = String(cfg.minifluxUrl || '').replace(/\/+$/, '')
  const token = String(cfg.minifluxToken || '')
  if (!base) throw new Error('还没填 Miniflux 地址 / Miniflux URL is not set yet')

  async function call(method, path, body, query) {
    let url = base + path
    if (query) {
      const search = new URLSearchParams()
      for (const [key, val] of Object.entries(query)) {
        if (val !== undefined && val !== null && val !== '') search.set(key, String(val))
      }
      const qs = search.toString()
      if (qs) url += '?' + qs
    }
    const headers = { Accept: 'application/json' }
    if (token) headers['X-Auth-Token'] = token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!res.ok) throw new Error(`miniflux ${method} ${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  return { call, base }
}

// ---------------------------------------------------------------------------
// 文本
// ---------------------------------------------------------------------------

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function stripProxyUrls(html) {
  return String(html || '').replace(
    /(?:https?:\/\/[^\s"']*?)?\/proxy\/[A-Za-z0-9_\-=]+\/([A-Za-z0-9_\-=]+)/g,
    (match, encoded) => {
      try {
        const decoded = Buffer.from(encoded + '='.repeat((4 - (encoded.length % 4)) % 4), 'base64url').toString('utf8')
        return /^https?:\/\//.test(decoded) ? decoded : match
      } catch { return match }
    },
  )
}

const ALLOWED_TAGS = new Set(['p', 'br', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'small', 'hr', 'a', 'img', 'figure', 'figcaption'])
const VOID_TAGS = new Set(['br', 'img', 'hr'])

/** 白名单清洗；`mapImage` 返回 null 表示丢弃该图。 */
function sanitize(html, mapImage) {
  return String(html || '')
    .replace(/<(script|style|iframe|noscript|svg|form|input|button|video|audio|source)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?([a-zA-Z0-9]+)((?:\s+[^>]*)?)>/g, (match, rawTag, attrs) => {
      const tag = rawTag.toLowerCase()
      if (!ALLOWED_TAGS.has(tag)) return ''
      if (match.startsWith('</')) return VOID_TAGS.has(tag) ? '' : `</${tag}>`
      if (tag === 'img') {
        const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)
        if (!src) return ''
        const mapped = mapImage ? mapImage(src[1]) : src[1]
        if (!mapped) return ''
        const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(attrs)
        return `<img src="${escapeHtml(mapped)}" alt="${escapeHtml(alt ? alt[1] : '')}"/>`
      }
      if (tag === 'a') {
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)
        if (!href || !/^https?:\/\//.test(href[1])) return '<a>'
        return `<a href="${escapeHtml(href[1])}">`
      }
      return VOID_TAGS.has(tag) ? `<${tag}/>` : `<${tag}>`
    })
}

function markdownToHtml(markdown) {
  const out = []
  let inList = false
  const inline = (text) => escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false } continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const quote = /^>\s?(.*)$/.exec(line)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (heading) {
      if (inList) { out.push('</ul>'); inList = false }
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`)
    } else if (quote) out.push(`<blockquote><p>${inline(quote[1])}</p></blockquote>`)
    else if (bullet) { if (!inList) { out.push('<ul>'); inList = true } out.push(`<li>${inline(bullet[1])}</li>`) }
    else { if (inList) { out.push('</ul>'); inList = false } out.push(`<p>${inline(line)}</p>`) }
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 图片：下载 + WebP/AVIF 转 JPEG
// ---------------------------------------------------------------------------

function sniffImage(data) {
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg'
  if (data.length > 8 && data.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (data.slice(0, 6).toString('latin1').startsWith('GIF8')) return 'gif'
  if (data.slice(0, 4).toString('latin1') === 'RIFF' && data.slice(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (data.slice(0, 16).toString('latin1').includes('ftypavif')) return 'avif'
  if (data.slice(0, 300).toString('latin1').toLowerCase().includes('<svg')) return 'svg'
  return ''
}

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: false, stdout: Buffer.alloc(0), stderr: 'spawn failed' })
      return
    }
    const chunks = []
    let stderr = ''
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', () => resolve({ ok: false, stdout: Buffer.concat(chunks), stderr }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout: Buffer.concat(chunks), stderr }))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** 下载一张图并归一成 EPUB 能用的格式；失败返回 null。 */
async function fetchImage(url, proxy, timeoutMs = 15000) {
  if (!/^https?:\/\//i.test(url)) return null
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  let data = null
  try {
    if (proxy) {
      const result = await run('curl', ['-sS', '-L', '--max-time', String(Math.round(timeoutMs / 1000)),
        '-x', proxy, '-A', ua, '-H', 'Accept: image/jpeg,image/png,image/gif,*/*;q=0.5', url])
      data = result.ok && result.stdout.length ? result.stdout : null
    } else {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'image/jpeg,image/png,image/gif,*/*;q=0.5' }, signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) data = Buffer.from(await res.arrayBuffer())
    }
  } catch { data = null }
  if (!data || !data.length || data.length > 8 * 1024 * 1024) return null

  const kind = sniffImage(data)
  if (kind === 'jpg' || kind === 'png' || kind === 'gif') return { data, ext: kind, type: `image/${kind}` }
  if (kind === 'webp' || kind === 'avif') {
    const converted = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-vcodec', 'mjpeg', 'pipe:1'], data)
    if (converted.ok && converted.stdout.length) return { data: converted.stdout, ext: 'jpg', type: 'image/jpeg' }
  }
  return null
}

// ---------------------------------------------------------------------------
// ZIP（EPUB 就是 zip）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  const chunks = []
  const directory = []
  let offset = 0
  const now = new Date()
  const dtime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff
  const dday = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const stored = entry.store === true || raw.length < 64
    const body = stored ? raw : deflateRawSync(raw, { level: 6 })
    const method = stored ? 0 : 8
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8); local.writeUInt16LE(dtime, 10); local.writeUInt16LE(dday, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    chunks.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt16LE(dtime, 12)
    central.writeUInt16LE(dday, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, end])
}

const EPUB_CSS = `
body{font-family:"Noto Serif CJK SC","Source Han Serif SC",serif;line-height:1.75;margin:0 4%;color:#222}
h1{font-size:1.5em;margin:0 0 .3em}.meta{color:#777;font-size:.82em;margin-bottom:1.4em;border-bottom:1px solid #ddd;padding-bottom:.6em}
.meta a{color:#4a90d9;text-decoration:none}p{margin:0 0 .85em;text-align:justify}
blockquote{margin:.8em 0;padding:.3em 1em;border-left:3px solid #ccc;color:#555}
pre,code{font-family:monospace;background:#f5f5f5}img{max-width:100%;height:auto}
figure{margin:.8em 0}figcaption{color:#777;font-size:.8em}
.cover{text-align:center;padding-top:18%}.cover h1{font-size:2em}.cover .sub{color:#666;margin-top:.8em}`

function xhtml(title, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body></html>`
}

function randomId() {
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`
}

function buildEpub({ title, author = 'dsh-miniflux', chapters }) {
  const files = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: 'OEBPS/style.css', data: EPUB_CSS },
  ]
  const manifest = ['<item id="css" href="style.css" media-type="text/css"/>',
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>']
  const spine = ['<itemref idref="cover"/>']
  const navItems = []
  const seenImages = new Set()

  chapters.forEach((chapter, index) => {
    const id = `c${String(index + 1).padStart(3, '0')}`
    files.push({
      name: `OEBPS/${id}.xhtml`,
      data: xhtml(chapter.title, `<h1>${escapeHtml(chapter.title)}</h1>${chapter.meta ? `<div class="meta">${chapter.meta}</div>` : ''}${chapter.html || ''}`),
    })
    manifest.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="${id}"/>`)
    navItems.push(`<li><a href="${id}.xhtml">${escapeHtml(chapter.title)}</a></li>`)

    for (const image of chapter.images || []) {
      if (seenImages.has(image.name)) continue
      seenImages.add(image.name)
      files.push({ name: `OEBPS/images/${image.name}`, data: image.data, store: true })
      manifest.push(`<item id="img${seenImages.size}" href="images/${image.name}" media-type="${image.type}"/>`)
    }
  })

  files.push({ name: 'OEBPS/cover.xhtml', data: xhtml(title, `<div class="cover"><h1>${escapeHtml(title)}</h1><div class="sub">${escapeHtml(author)} · ${chapters.length} 篇 · ${new Date().toISOString().slice(0, 10)}</div></div>`) })
  files.push({ name: 'OEBPS/nav.xhtml', data: xhtml('目录', `<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>目录</h1><ol>${navItems.join('')}</ol></nav>`) })

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  files.splice(2, 0, {
    name: 'OEBPS/content.opf',
    data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${randomId()}</dc:identifier>
    <dc:title>${escapeHtml(title)}</dc:title><dc:language>zh-CN</dc:language>
    <dc:creator>${escapeHtml(author)}</dc:creator><dc:date>${now}</dc:date>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>${manifest.join('')}</manifest><spine>${spine.join('')}</spine>
</package>`,
  })

  return makeZip(files)
}

/** 文章正文 -> 清洗 + 抓图 + 改写成本地路径。 */
async function chapterFromEntry(entry, cfg, index, cache) {
  const images = []
  const raw = sanitize(stripProxyUrls(entry.content))
  const srcs = [...raw.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1])
  let html = raw
  let counter = 0
  for (const src of srcs) {
    const key = src
    if (!cache.has(key)) cache.set(key, cfg.withImages ? await fetchImage(src, cfg.imageProxy) : null)
    const image = cache.get(key)
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (!image) {
      html = html.replace(new RegExp(`<img src="${escaped}"[^>]*/>`, 'g'), '')
      continue
    }
    const name = `c${String(index).padStart(3, '0')}_${++counter}.${image.ext}`
    images.push({ name, data: image.data, type: image.type })
    html = html.replace(new RegExp(`<img src="${escaped}"`, 'g'), `<img src="images/${name}"`)
  }
  return { html, images }
}

// ---------------------------------------------------------------------------
// 模型调用：DSH 模型 或 自定义接口
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是一名资深新闻编辑，为一个人的 RSS 阅读器写简报并挑出值得收藏的文章。
只输出一个 JSON 对象，不要解释：
{"headline":"不超过24字，概括今天最重要的两三条，用 · 分隔","digest_markdown":"..."}
要求：
- digest_markdown 用二级标题分组（地缘/中国/财经/科技…），每条一行：- **[标题](链接)** — 一句话说明为什么重要（≤40 字）
- 开头一行：> 覆盖 X 小时 · 候选 N 篇 · 精选 M 条
- 按影响面、时效性、信息增量、是否一手信源取舍；明显是榜单、热搜聚合、广告、纯观点水文的不选
- 条目数量由你判断：只写真正重要的，不要凑数
- 不要编造标题和链接`

function candidatePrompt(cfg, entries, hours, maxItems) {
  const lines = entries.map((entry) => {
    const snippet = htmlToText(entry.content).slice(0, 110).replace(/\n/g, ' ')
    return `- id=${entry.id} 源=${entry.feed?.title || ''} 时间=${entry.published_at} 标题=${entry.title} 链接=${entry.url}\n  摘要：${snippet}`
  })
  const cap = maxItems ? `\n本批最多收录 ${maxItems} 条（宁少勿滥）。` : ''
  return `语言：${cfg.language}\n覆盖最近 ${hours} 小时，候选如下：${cap}\n${lines.join('\n')}`
}

function extractPicks(raw) {
  const picks = []
  const pattern = /"id"\s*:\s*(\d+)[\s\S]{0,80}?"reason"\s*:\s*"([^"]*)"/g
  let match
  while ((match = pattern.exec(raw)) !== null) {
    const id = Number(match[1])
    if (Number.isFinite(id) && !picks.some((item) => item.id === id)) {
      picks.push({ id, reason: String(match[2] || '').slice(0, 40) })
    }
  }
  return picks
}

/**
 * 容错解析模型输出。
 * 弱模型（小量化）经常不吐完整 JSON，这里退化成「整段当正文」，
 * 保证一次失败的批次不会拖垮整次生成。
 */
function parseModelReply(text) {
  const raw = String(text || '').trim()
  if (!raw) return { markdown: '', picks: [] }

  const fence = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(raw)
  const candidate = fence ? fence[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  if (candidate && candidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(candidate)
      return {
        markdown: String(parsed.digest_markdown || parsed.markdown || '').trim(),
        picks: Array.isArray(parsed.picks)
          ? parsed.picks.filter((p) => Number.isFinite(Number(p?.id))).map((p) => ({ id: Number(p.id), reason: String(p.reason || '').slice(0, 40) }))
          : [],
      }
    } catch { /* 落到下面的容错分支 */ }
  }

  // 有 "digest_markdown" 但 JSON 不完整：把字段内容抠出来
  const field = /"digest_markdown"\s*:\s*"([\s\S]*?)"\s*[,}]/.exec(raw)
  if (field) {
    const body = field[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
    return { markdown: body.trim(), picks: extractPicks(raw) }
  }

  // 完全不是 JSON：当成 markdown 正文，拣出可能出现的 id
  const cleaned = raw.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/i, '').trim()
  return { markdown: cleaned, picks: extractPicks(raw) }
}

async function callModel(ctx, cfg, prompt, systemPrompt = SYSTEM_PROMPT) {
  if (cfg.aiSource === 'dsh') {
    const llm = ctx.llm
    if (!llm) throw new Error('DSH 模型服务不可用（ctx.llm 不存在）/ ctx.llm is unavailable')
    let text = ''
    const controller = new AbortController()
    const timeoutMs = (Number(cfg.modelTimeoutSec) || 600) * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const stream = llm.stream({
        provider: cfg.dshProvider,
        model: cfg.dshModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.3,
        maxTokens: 1400,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') text += chunk.text
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`模型 ${cfg.dshProvider}/${cfg.dshModel} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回，换个更快的模型试试 / model timed out`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    return parseModelReply(text)
  }

  const base = String(cfg.aiBaseUrl || '').replace(/\/+$/, '')
  if (!base || !cfg.aiApiKey) throw new Error('没有配置 aiBaseUrl / aiApiKey')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.aiApiKey}` },
    body: JSON.stringify({
      model: cfg.aiModel,
      temperature: 0.3,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) throw new Error(`模型接口 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return parseModelReply(data?.choices?.[0]?.message?.content ?? '')
}

/** 探测当前配置的模型是否真的可用；返回模型原话。 */
async function chatOnce(ctx, cfg, prompt) {
  if (cfg.aiSource === 'dsh') {
    const llm = ctx.llm
    if (!llm) throw new Error('ctx.llm 不可用 / unavailable')
    let text = ''
    const stream = llm.stream({
      provider: cfg.dshProvider,
      model: cfg.dshModel,
      system: '你是一个测试助手，只回答被要求的内容，不要寒暄。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0,
      maxTokens: 80,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') text += chunk.text
    }
    return text.trim()
  }
  const base = String(cfg.aiBaseUrl || '').replace(/\/+$/, '')
  if (!base || !cfg.aiApiKey) throw new Error('没有配置 aiBaseUrl / aiApiKey')
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.aiApiKey}` },
    body: JSON.stringify({ model: cfg.aiModel, temperature: 0, max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const data = await res.json()
  return String(data?.choices?.[0]?.message?.content || '').trim()
}

// ---------------------------------------------------------------------------
// cron（5 字段：分 时 日 月 周）
// ---------------------------------------------------------------------------

function parseCronField(field, min, max) {
  const values = new Set()
  for (const part of String(field).split(',')) {
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) { for (let i = min; i <= max; i += Number(step[1])) values.add(i); continue }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part)
    if (range) {
      const from = Number(range[1]); const to = Number(range[2]); const inc = Number(range[3] || 1)
      for (let i = from; i <= to; i += inc) values.add(i)
      continue
    }
    if (part === '*') { for (let i = min; i <= max; i++) values.add(i); continue }
    const num = Number(part)
    if (Number.isFinite(num) && num >= min && num <= max) values.add(num)
  }
  return values
}

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/)
  if (parts.length !== 5) return null
  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    day: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12),
    weekday: parseCronField(parts[4], 0, 6),
  }
}

export function cronMatches(cron, date = new Date()) {
  if (!cron) return false
  return cron.minute.has(date.getMinutes()) && cron.hour.has(date.getHours()) && cron.month.has(date.getMonth() + 1)
}

// ---------------------------------------------------------------------------
// 业务
// ---------------------------------------------------------------------------

function resolveDir(cfg) {
  if (cfg.epubDir && isAbsolute(cfg.epubDir)) return cfg.epubDir
  return join(process.env.DSH_HOME || process.env.HOME || homedir(), 'miniflux-epub')
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function pickFeeds(feeds, namesRaw) {
  const names = String(namesRaw || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!names.length) return new Set(feeds.map((feed) => feed.id))
  const ids = new Set()
  for (const feed of feeds) {
    if (names.some((name) => String(feed.id) === name || feed.title.includes(name))) ids.add(feed.id)
  }
  return ids
}

async function collect(client, cfg) {
  const since = Math.floor(Date.now() / 1000) - Number(cfg.lookbackHours) * 3600
  const data = await client.call('GET', '/v1/entries', undefined, {
    status: 'unread', published_after: since, limit: Math.min(Number(cfg.maxCandidates) || 200, 500), order: 'published_at', direction: 'desc',
  })
  const feeds = (await client.call('GET', '/v1/feeds')) || []
  const scope = pickFeeds(feeds, cfg.epubFeedNames)
  return (data?.entries || []).filter((entry) => scope.has(entry.feed?.id))
}

/**
 * 精选的候选池：**最新的未读条目**，按时间倒序，取前 N 条（不看时间窗）。
 * @returns entries 数组
 */
async function collectNewestUnread(client, cfg) {
  const limit = Math.min(Number(cfg.picksCandidates) || Number(cfg.maxCandidates) || 200, 500)
  const data = await client.call('GET', '/v1/entries', undefined, {
    status: 'unread', limit, order: 'published_at', direction: 'desc',
  })
  const feeds = (await client.call('GET', '/v1/feeds')) || []
  const scope = pickFeeds(feeds, cfg.epubFeedNames)
  return (data?.entries || []).filter((entry) => scope.has(entry.feed?.id))
}

async function writeEpub(cfg, name, chapters, title, author = 'dsh-miniflux') {
  const dir = resolveDir(cfg)
  await mkdir(dir, { recursive: true })
  const target = join(dir, `${name}.epub`)
  const cache = new Map()
  const built = []
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]
    if (chapter.rawHtml !== undefined) {
      const { html, images } = await chapterFromEntry({ content: chapter.rawHtml }, cfg, i + 1, cache)
      built.push({ title: chapter.title, meta: chapter.meta, html, images })
    } else {
      built.push({ title: chapter.title, meta: chapter.meta, html: chapter.html })
    }
  }
  const buffer = buildEpub({ title, author, chapters: built })
  await writeFile(target, buffer)
  const images = built.reduce((sum, chapter) => sum + (chapter.images?.length || 0), 0)
  return { target, bytes: buffer.length, chapters: built.length, images }
}

async function generateDigest(ctx, client, cfg, kind) {
  const candidates = (await collect(client, cfg)).slice(0, Number(cfg.maxCandidates) || 200)
  if (!candidates.length) return { ok: false, message: '最近没有新文章 / no recent entries' }

  // 分批调用：弱模型（2-bit 量化）在长上下文上会明显变慢甚至跑飞，
  // 拆成小批反而更快更稳，代价是调用次数变多。
  const size = Math.max(3, Number(cfg.aiBatchSize) || 12)
  const hardCap = Number(cfg.digestMaxItems) || 0
  const batches = []
  for (let i = 0; i < candidates.length; i += size) batches.push(candidates.slice(i, i + size))

  const parts = []
  const mergedPicks = []
  let headlineHint = ''
  for (let index = 0; index < batches.length; index++) {
    const perBatch = hardCap > 0 ? Math.max(2, Math.ceil(hardCap / batches.length)) : 0
    const parsed = await callModel(ctx, cfg, candidatePrompt(cfg, batches[index], cfg.lookbackHours, perBatch))
    if (!headlineHint && parsed.headline) headlineHint = parsed.headline
    if (parsed.markdown) {
      // 每批都会带一行「> 覆盖…」，合并时去掉，最后统一加
      const body = parsed.markdown.split('\n').filter((line) => !line.trim().startsWith('>')).join('\n').trim()
      if (body) parts.push(body)
    }
    for (const pick of parsed.picks) {
      if (!mergedPicks.some((item) => item.id === pick.id)) mergedPicks.push(pick)
    }
  }
  if (!parts.length) return { ok: false, message: '模型没有返回简报正文 / model returned no digest' }

  const markdown = `> 覆盖最近 ${cfg.lookbackHours} 小时 · 候选 ${candidates.length} 篇 · 分 ${batches.length} 批生成\n\n` + parts.join('\n\n')
  const parsed = { markdown, picks: mergedPicks.slice(0, Number(cfg.aiMaxPicks) || 5) }

  // 标题交给模型概括（拿不到就退化成第一条要点）
  let headline = headlineHint || ''
  if (!headline) {
    try {
      headline = await chatOnce(ctx, cfg, `以下是今天日报的正文，请用不超过 24 个字概括最重要的两三条新闻，用「·」分隔，只输出这一行：\n\n${markdown.slice(0, 1500)}`)
    } catch { headline = '' }
  }
  headline = String(headline || '').replace(/^["'「]+|["'」]+$/g, '').trim()
  if (!headline) {
    const firstBullet = markdown.split('\n').find((line) => line.trim().startsWith('-'))
    headline = firstBullet ? firstBullet.replace(/^[-*\s]+/, '').replace(/\*\*/g, '').slice(0, 30) : '今日要闻'
  }

  const label = kind === 'morning' ? '早报' : '晚报'
  // 文件名带时分，避免同一天重复生成时相互覆盖
  const clock = new Date().toTimeString().slice(0, 5).replace(':', '')
  const slug = headline.replace(/[\\/:*?"<>|\s·]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)
  const baseName = `${stamp()}-${clock}-日报${slug ? '-' + slug : ''}`
  const title = `${stamp()} ${label}｜${headline}`
  const digest = await writeEpub(cfg, baseName, [{ title, html: markdownToHtml(parsed.markdown) }], title)

  // 简报只产出简报本身：不收藏、不改已读、不生成精选。
  // 「精选」是独立任务（picksCron / 左侧栏按钮），那边才会加星 + 已读化 + 出精选 EPUB。
  return {
    ok: true,
    kind,
    title,
    headline,
    markdown: parsed.markdown,
    starred: [],
    digestEpub: digest,
    picksEpub: null,
    candidates: candidates.length,
    batches: batches.length,
  }
}

const PICKS_PROMPT = `你是一名资深新闻编辑，要从候选中挑出这个人最值得存下来细读的文章。
只输出 JSON：{"picks":[{"id":数字,"reason":"不超过20字"}]}
判断标准：影响面、信息增量、一手信源、长期参考价值；排除榜单/热搜聚合/广告/纯观点水文。
只从候选里挑，挑几条由你判断，不要凑数。`

async function generatePicks(ctx, client, cfg) {
  const all = await collectNewestUnread(client, cfg)
  if (!all.length) return { ok: false, message: '没有未读条目 / no unread entries' }

  const state = await loadState()
  const skipScreened = cfg.picksSkipScreened !== false
  const candidates = skipScreened ? all.filter((entry) => !(String(entry.id) in state.screened)) : all
  const skippedScreened = all.length - candidates.length
  if (!candidates.length) {
    return {
      ok: false,
      skippedScreened,
      message: `最近 ${all.length} 条未读都已经筛过了，跳过 / all ${all.length} unread entries were already screened`,
    }
  }

  // 与日报共用同一套 AI 能力设置：按 aiBatchSize 分批，每批让模型自己判断
  const size = Math.max(3, Number(cfg.aiBatchSize) || 12)
  const batches = []
  for (let i = 0; i < candidates.length; i += size) batches.push(candidates.slice(i, i + size))

  const chosenPicks = []
  for (const batch of batches) {
    const reply = await callModel(ctx, cfg, candidatePrompt(cfg, batch, cfg.lookbackHours), PICKS_PROMPT)
    for (const pick of reply.picks) {
      if (!chosenPicks.some((item) => item.id === pick.id)) chosenPicks.push(pick)
    }
    // 这一批不管选没选中都算「筛过」：下一轮直接跳过，不再浪费模型
    const now = Date.now()
    for (const entry of batch) state.screened[String(entry.id)] = now
    await saveState()
  }

  const cap = Number(cfg.aiMaxPicks) || 0
  const picks = cap > 0 ? chosenPicks.slice(0, cap) : chosenPicks.slice(0, 40)
  if (!picks.length) return { ok: false, message: '模型没有挑出文章 / the model picked nothing' }

  const byId = new Map(candidates.map((entry) => [entry.id, entry]))
  const chosen = picks.map((pick) => ({ pick, entry: byId.get(pick.id) })).filter((item) => item.entry)
  if (!chosen.length) return { ok: false, message: '挑出的 id 不在候选里 / picks not in candidates' }

  const ids = chosen.map((item) => item.entry.id)
  // 精选：加星（可选）+ 标记已读
  await client.call('PUT', '/v1/entries', { entry_ids: ids, starred: Boolean(cfg.autoStar), status: 'read' })

  const clock = new Date().toTimeString().slice(0, 5).replace(':', '')
  const lead = chosen[0].entry.title.replace(/[\\/:*?"<>|\s·]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  const baseName = `${stamp()}-${clock}-精选${lead ? '-' + lead : ''}`
  const title = `${stamp()} 精选｜${chosen.slice(0, 3).map((item) => item.entry.title).join(' · ').slice(0, 60)}`

  const epub = await writeEpub(cfg, baseName, chosen.map(({ pick, entry }) => ({
    title: entry.title,
    meta: `${escapeHtml(entry.feed?.title || '')} · <a href="${escapeHtml(entry.url)}">原文</a>${pick.reason ? ` · ${escapeHtml(pick.reason)}` : ''}`,
    rawHtml: entry.content,
  })), title)

  return {
    ok: true,
    title,
    headline: title,
    starred: cfg.autoStar ? ids : [],
    read: ids.length,
    epub,
    picks,
    candidates: candidates.length,
    skippedScreened,
    batches: batches.length,
  }
}

async function generateFeedEpub(client, cfg) {
  const candidates = await collect(client, cfg)
  if (!candidates.length) return { ok: false, message: '自选源最近没有新文章 / no entries in the selected feeds' }
  const title = `${stamp()} 自选源`
  const picked = candidates.slice(0, 40)
  const epub = await writeEpub(cfg, `${stamp()}-自选源`, picked.map((entry) => ({
    title: entry.title,
    meta: `${escapeHtml(entry.feed?.title || '')} · <a href="${escapeHtml(entry.url)}">原文</a>`,
    rawHtml: entry.content,
  })), title)
  // 自选源：生成完成后已读化
  await client.call('PUT', '/v1/entries', { entry_ids: picked.map((entry) => entry.id), status: 'read' })
  return { ok: true, title, epub, candidates: candidates.length, read: picked.length }
}

// ---------------------------------------------------------------------------
// agent 工具
// ---------------------------------------------------------------------------

function text(content) {
  return [{ type: 'text', text: String(content) }]
}

/** 把属性表简写转成对象根 JSON Schema（per-property `required` 移入根 required 数组）。 */
function jsonSchemaOf(params) {
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(params)) {
    properties[key] = { ...node }
    if (properties[key].required === true) {
      delete properties[key].required
      required.push(key)
    }
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: jsonSchemaOf(spec.parameters || {}),
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, result) => text(typeof result === 'string' ? result : JSON.stringify(result, null, 2)),
    },
    isConcurrencySafe: () => true,
    execute: spec.execute,
  }
}

function makeTools(ctx, getCfg) {
  const clientFor = () => makeClient(getCfg())
  return [
    tool({
      name: 'miniflux_feeds',
      description: 'List Miniflux subscriptions with unread counts (id, unread, category, title). Feed titles are what `epubFeedNames` matches.',
      parameters: {},
      async execute() {
        const client = clientFor()
        const feeds = (await client.call('GET', '/v1/feeds')) || []
        const counters = (await client.call('GET', '/v1/feeds/counters')) || {}
        const unread = counters.unreads || {}
        return feeds.map((feed) => `${feed.id}\t${unread[String(feed.id)] ?? 0}\t${feed.category?.title || ''}\t${feed.title}`).sort().join('\n')
      },
    }),
    tool({
      name: 'miniflux_search',
      description: 'Search Miniflux entries by keyword; returns id, feed, title, url and a snippet around the match.',
      parameters: {
        keyword: { type: 'string', description: 'Keyword.', required: true },
        limit: { type: 'integer', description: 'Max results (default 10).' },
        feed_id: { type: 'integer', description: 'Restrict to one feed id.' },
      },
      async execute(args) {
        const client = clientFor()
        const data = await client.call('GET', '/v1/entries', undefined, {
          search: args.keyword, limit: Math.min(Number(args.limit) || 10, 50), order: 'published_at', direction: 'desc', feed_id: args.feed_id,
        })
        const rows = (data?.entries || []).map((entry) => {
          const body = htmlToText(entry.content)
          const pos = body.toLowerCase().indexOf(String(args.keyword).toLowerCase())
          const snippet = pos >= 0 ? body.slice(Math.max(0, pos - 80), pos + 80).replace(/\n/g, ' ') : ''
          return `[${entry.id}] ${entry.title}\n  ${entry.feed?.title} · ${entry.published_at}\n  ${entry.url}${snippet ? `\n  …${snippet}…` : ''}`
        })
        return rows.length ? rows.join('\n\n') : '没有命中 / no match'
      },
    }),
    tool({
      name: 'miniflux_read',
      description: 'Read the full text of one or more entries (HTML stripped).',
      parameters: {
        ids: { type: 'array', items: { type: 'integer' }, description: 'Entry ids.', required: true },
        max_chars: { type: 'integer', description: 'Truncate each entry (default 4000).' },
      },
      async execute(args) {
        const client = clientFor()
        const limit = Number(args.max_chars) || 4000
        const out = []
        for (const id of args.ids || []) {
          const entry = await client.call('GET', `/v1/entries/${id}`)
          out.push(`# [${id}] ${entry.title}\n${entry.feed?.title} · ${entry.published_at}\n${entry.url}\n\n${htmlToText(entry.content).slice(0, limit)}`)
        }
        return out.join('\n\n---\n\n')
      },
    }),
    tool({
      name: 'miniflux_digest',
      description: 'Generate the daily digest now with the configured model: writes the digest EPUB, stars the picks and builds the picks EPUB.',
      parameters: { kind: { type: 'string', enum: ['morning', 'evening'], description: 'Digest kind (default evening).' } },
      async execute(args) {
        const cfg = getCfg()
        const result = await generateDigest(ctx, clientFor(), cfg, args.kind === 'morning' ? 'morning' : 'evening')
        if (!result.ok) return result.message
        return [`# ${result.title}`, '', result.markdown, '',
          `— 候选 ${result.candidates} 篇 · 收藏 ${result.starred.length} 条`,
          `— 简报 EPUB: ${result.digestEpub.target}（${result.digestEpub.images} 张图）`,
          result.picksEpub ? `— 精选 EPUB: ${result.picksEpub.target}（${result.picksEpub.images} 张图）` : ''].join('\n')
      },
    }),
    tool({
      name: 'miniflux_epub',
      description: 'Build an EPUB from specific entries (images embedded) and return the path.',
      parameters: {
        ids: { type: 'array', items: { type: 'integer' }, description: 'Entry ids.', required: true },
        title: { type: 'string', description: 'Book title.' },
      },
      async execute(args) {
        const cfg = getCfg()
        const client = clientFor()
        const chapters = []
        for (const id of args.ids || []) {
          const entry = await client.call('GET', `/v1/entries/${id}`)
          chapters.push({
            title: entry.title,
            meta: `${escapeHtml(entry.feed?.title || '')} · <a href="${escapeHtml(entry.url)}">原文</a>`,
            rawHtml: entry.content,
          })
        }
        const title = args.title || `${stamp()} 精选`
        const result = await writeEpub(cfg, `${title}-${Date.now() % 100000}`, chapters, title)
        return `已生成 / written: ${result.target}（${result.chapters} 篇 · ${result.images} 张图 · ${Math.round(result.bytes / 1024)} KB）`
      },
    }),
    tool({
      name: 'miniflux_feed_epub',
      description: 'Build the per-feed EPUB now from the configured feeds (epubFeedNames) and return the path.',
      parameters: {},
      async execute() {
        const result = await generateFeedEpub(clientFor(), getCfg())
        if (!result.ok) return result.message
        return `已生成 / written: ${result.epub.target}（${result.epub.chapters} 篇 · ${result.epub.images} 张图）`
      },
    }),
    tool({
      name: 'miniflux_star',
      description: 'Star or unstar entries.',
      parameters: {
        ids: { type: 'array', items: { type: 'integer' }, required: true },
        starred: { type: 'boolean', description: 'true = star, false = unstar (default true).' },
      },
      async execute(args) {
        await clientFor().call('PUT', '/v1/entries', { entry_ids: args.ids, starred: args.starred !== false })
        return `${args.starred !== false ? '已收藏' : '已取消收藏'} ${args.ids.length} 条`
      },
    }),
  ]
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  try {
    applyImpl(ctx, config)
  } catch (error) {
    console.error('[dsh-miniflux] mount failed:', error?.message || error)
  }
}


// ---------------------------------------------------------------------------
// 配置存储：面板里保存的值写在 $DSH_HOME/dsh-miniflux.json，覆盖 schema 默认值
// ---------------------------------------------------------------------------

function storePath() {
  const home = process.env.DSH_HOME || process.env.HOME || homedir()
  return join(home, 'dsh-miniflux.json')
}

async function readStore() {
  try {
    return JSON.parse(await readFile(storePath(), 'utf8'))
  } catch {
    return {}
  }
}

const STATE_MAX = 20000

function statePath() {
  const home = process.env.DSH_HOME || process.env.HOME || homedir()
  return join(home, 'dsh-miniflux-state.json')
}

let stateCache = null

/** 已筛过的条目台账：{ screened: { "<entryId>": <时间戳> } } */
async function loadState() {
  if (!stateCache) {
    try {
      stateCache = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch {
      stateCache = {}
    }
    if (!stateCache.screened || typeof stateCache.screened !== 'object') stateCache.screened = {}
  }
  return stateCache
}

async function saveState() {
  const state = await loadState()
  const keys = Object.keys(state.screened)
  if (keys.length > STATE_MAX) {
    keys.sort((a, b) => state.screened[b] - state.screened[a])
    for (const key of keys.slice(STATE_MAX)) delete state.screened[key]
  }
  await mkdir(dirname(statePath()), { recursive: true })
  await writeFile(statePath(), JSON.stringify(state))
}

async function writeStore(patch) {
  const current = await readStore()
  const next = { ...current, ...patch }
  await mkdir(dirname(storePath()), { recursive: true })
  await writeFile(storePath(), JSON.stringify(next, null, 2))
  return next
}

const EDITABLE_FIELDS = ['minifluxUrl', 'minifluxToken', 'aiSource', 'dshProvider', 'dshModel',
  'aiBaseUrl', 'aiApiKey', 'aiModel', 'digestCron', 'picksCron', 'feedEpubCron',
  'epubFeedNames', 'epubDir', 'withImages', 'imageProxy', 'autoStar', 'language',
  'lookbackHours', 'digestMaxItems', 'aiMaxPicks', 'modelTimeoutSec', 'aiBatchSize', 'maxCandidates', 'picksCandidates', 'picksSkipScreened']

function applyImpl(ctx, config) {
  // 面板保存的值；启动时从文件载入，保存后即时替换
  let stored = {}

  const base = () => ({
    enabled: value(config?.enabled, true),
    minifluxUrl: value(config?.minifluxUrl, 'http://127.0.0.1:8080'),
    minifluxToken: value(config?.minifluxToken, ''),
    aiSource: value(config?.aiSource, 'dsh'),
    dshProvider: value(config?.dshProvider, 'deepseek'),
    dshModel: value(config?.dshModel, 'deepseek-chat'),
    aiBaseUrl: value(config?.aiBaseUrl, ''),
    aiApiKey: value(config?.aiApiKey, ''),
    aiModel: value(config?.aiModel, 'deepseek-chat'),
    digestCron: value(config?.digestCron, ''),
    picksCron: value(config?.picksCron, ''),
    feedEpubCron: value(config?.feedEpubCron, ''),
    modelTimeoutSec: Number(value(config?.modelTimeoutSec, 600)) || 600,
    aiBatchSize: Number(value(config?.aiBatchSize, value(config?.digestBatchSize, 12))) || 12,
    lookbackHours: Number(value(config?.lookbackHours, 24)) || 24,
    maxCandidates: Number(value(config?.maxCandidates, 200)) || 200,
    picksSkipScreened: value(config?.picksSkipScreened, true),
    picksCandidates: Number(value(config?.picksCandidates, 200)) || 200,
    digestMaxItems: Number(value(config?.digestMaxItems, 0)) || 0,
    aiMaxPicks: Number(value(config?.aiMaxPicks, 0)) || 0,
    epubFeedNames: value(config?.epubFeedNames, ''),
    epubDir: value(config?.epubDir, ''),
    withImages: value(config?.withImages, true),
    imageProxy: value(config?.imageProxy, ''),
    autoStar: value(config?.autoStar, true),
    language: value(config?.language, '中文'),
  })
  const cfg = () => ({ ...base(), ...stored })

  const fired = new Set()
  let timer = null
  // 后台任务：模型很慢时不能占住 HTTP 请求，前端改成轮询
  let job = { state: 'idle', kind: '', startedAt: 0, finishedAt: 0, result: null, error: null }

  const startJob = (kind, run) => {
    job = { state: 'running', kind, startedAt: Date.now(), finishedAt: 0, result: null, error: null }
    Promise.resolve()
      .then(run)
      .then((result) => { job = { ...job, state: 'done', finishedAt: Date.now(), result } })
      .catch((error) => { job = { ...job, state: 'failed', finishedAt: Date.now(), error: error?.message || String(error) } })
    return job
  }

  const runTask = async (label, fn) => {
    try {
      const result = await fn()
      const where = result.digestEpub?.target || result.epub?.target || result.title
      console.log(`[dsh-miniflux] ${label}: ${result.ok ? where : result.message}`)
    } catch (error) {
      console.error(`[dsh-miniflux] ${label} failed:`, error?.message || error)
    }
  }

  const tick = () => {
    const settings = cfg()
    if (!settings.enabled) return
    const now = new Date()
    const minuteKey = `${stamp(now)}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    const jobs = [
      { name: 'digest', expr: settings.digestCron, run: () => generateDigest(ctx, makeClient(settings), settings, now.getHours() < 12 ? 'morning' : 'evening') },
      { name: 'picks', expr: settings.picksCron, run: () => generatePicks(ctx, makeClient(settings), settings) },
      { name: 'feed-epub', expr: settings.feedEpubCron, run: () => generateFeedEpub(makeClient(settings), settings) },
    ]

    for (const job of jobs) {
      const cron = parseCron(job.expr)
      if (!cron || !cronMatches(cron, now)) continue
      const key = `${job.name}:${minuteKey}`
      if (fired.has(key)) continue
      fired.add(key)
      void runTask(job.name, job.run)
    }

    for (const key of [...fired]) if (!key.endsWith(minuteKey)) fired.delete(key)
  }

  const schedule = () => {
    if (timer) clearInterval(timer)
    timer = setInterval(tick, 20_000)
    timer.unref?.()
    tick()
  }

  // 启动即载入面板保存过的值
  void readStore().then((data) => { stored = data })

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  const readBody = (req) => new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })

  const routes = [
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/config',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          json(res, 200, { ok: true, config: { ...base(), ...stored } })
          return
        }
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        const body = await readBody(req)
        const patch = {}
        for (const key of EDITABLE_FIELDS) {
          if (body[key] !== undefined) patch[key] = body[key]
        }
        stored = await writeStore(patch)
        schedule()
        json(res, 200, { ok: true, config: { ...base(), ...stored } })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/models',
      handler: async (_req, res) => {
        try {
          const llm = ctx.llm
          if (!llm) { json(res, 200, { ok: false, providers: [], error: 'ctx.llm unavailable' }); return }
          const providers = await llm.listProviders()
          const out = []
          for (const provider of providers || []) {
            let models = []
            try { models = await llm.listModels(provider.id || provider.name || provider) } catch { models = [] }
            out.push({
              id: provider.id || provider.name || String(provider),
              name: provider.name || provider.id || String(provider),
              models: (models || []).map((model) => model.id || model.name || String(model)),
            })
          }
          json(res, 200, { ok: true, providers: out })
        } catch (error) {
          json(res, 200, { ok: false, providers: [], error: error?.message || String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/test-model',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        const settings = cfg()
        try {
          const reply = await chatOnce(ctx, settings, '请只回复这四个字：模型正常')
          json(res, 200, {
            ok: true,
            aiSource: settings.aiSource,
            provider: settings.aiSource === 'dsh' ? settings.dshProvider : settings.aiBaseUrl,
            model: settings.aiSource === 'dsh' ? settings.dshModel : settings.aiModel,
            reply,
          })
        } catch (error) {
          json(res, 200, {
            ok: false,
            aiSource: settings.aiSource,
            provider: settings.dshProvider,
            model: settings.dshModel,
            message: error?.message || String(error),
          })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/reset-screened',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        const state = await loadState()
        const removed = Object.keys(state.screened).length
        state.screened = {}
        await saveState()
        json(res, 200, { ok: true, removed })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/files',
      handler: async (_req, res) => {
        const settings = cfg()
        const dir = resolveDir(settings)
        try {
          const names = await readdir(dir)
          const rows = []
          for (const name of names) {
            if (!name.endsWith('.epub')) continue
            const full = join(dir, name)
            const info = await stat(full)
            rows.push({ name, path: full, bytes: info.size, mtime: info.mtimeMs })
          }
          rows.sort((a, b) => b.mtime - a.mtime)
          json(res, 200, { ok: true, dir, files: rows.slice(0, 12) })
        } catch (error) {
          json(res, 200, { ok: false, dir, files: [], message: error?.message || String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/job',
      handler: async (_req, res) => {
        json(res, 200, {
          state: job.state,
          kind: job.kind,
          elapsedSec: job.startedAt ? Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000) : 0,
          result: job.result
            ? {
              ok: job.result.ok,
              message: job.result.message,
              title: job.result.title,
              starred: job.result.starred,
              read: job.result.read,
              digestEpub: job.result.digestEpub?.target,
              picksEpub: job.result.picksEpub?.target,
              epub: job.result.epub?.target,
              candidates: job.result.candidates,
              batches: job.result.batches,
              skippedScreened: job.result.skippedScreened,
            }
            : null,
          error: job.error,
        })
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/status',
      handler: async (_req, res) => {
        const settings = cfg()
        let probe = { ok: false }
        try {
          await makeClient(settings).call('GET', '/v1/me')
          probe = { ok: true }
        } catch (error) {
          probe = { ok: false, error: error?.message || String(error) }
        }
        const payload = JSON.stringify({
          ok: true,
          enabled: settings.enabled,
          miniflux: probe,
          aiSource: settings.aiSource,
          model: settings.aiSource === 'dsh' ? `${settings.dshProvider}/${settings.dshModel}` : settings.aiModel,
          crons: { digest: settings.digestCron, picks: value(config?.picksCron, ''), feedEpub: settings.feedEpubCron },
          epubDir: resolveDir(settings),
          feeds: settings.epubFeedNames,
        })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
        res.end(payload)
      },
    },
    {
      kind: 'exact',
      path: '/api/dsh-miniflux/generate',
      handler: async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405).end(); return }
        const url = new URL(req.url, 'http://localhost')
        const settings = cfg()
        const client = makeClient(settings)
        const what = url.searchParams.get('what') || 'digest'
        const kind = url.searchParams.get('kind') === 'morning' ? 'morning' : 'evening'
        if (job.state === 'running') { json(res, 200, { ok: false, running: true, message: '已有任务在跑 / a job is already running' }); return }
        startJob(what, () => {
          if (what === 'feed-epub') return generateFeedEpub(client, settings)
          if (what === 'picks') return generatePicks(ctx, client, settings)
          return generateDigest(ctx, client, settings, kind)
        })
        json(res, 200, { ok: true, started: true })
      },
    },
  ]

  const disposeRoutes = routes.map((route) => ctx.webServer.register(route))
  const disposeTools = makeTools(ctx, cfg).map((item) => ctx.tools.register(item))

  schedule()

  ctx.effect(() => () => {
    for (const dispose of disposeRoutes) dispose()
    for (const dispose of disposeTools) dispose()
    if (timer) clearInterval(timer)
  }, 'dsh-miniflux: dispose')

  ctx.on('loader/volatile-update', () => schedule())
}

/** 自测用内部实现。 */
export const __internals = {
  chatOnce, buildEpub, makeZip, htmlToText, markdownToHtml, sanitize, stripProxyUrls,
  fetchImage, sniffImage, parseCron, cronMatches, makeClient, writeEpub, generateDigest, generateFeedEpub, chapterFromEntry,
}
