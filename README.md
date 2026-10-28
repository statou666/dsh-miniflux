# dsh-miniflux

Miniflux 插件（DSH Web GUI）：AI 写早晚报、挑精彩文章收藏、按 cron 自动生成三种 EPUB。
Settings live in the plugin settings page; every field is bilingual (中文 / English).

## 安装 / Install

```bash
dsh plugin --profile <name> add link:/path/to/dsh-miniflux
# 重启 dsh web 后生效 / restart the dsh web process to mount
```

设置页在「设置 → 插件 → Miniflux」。改完即时生效（`volatile` 字段热应用），不用重启。
Settings → Plugins → Miniflux. Changes apply live, no restart.


## 依赖 / Requirements

- DSH `>=0.2.0-rc.2`
- 系统有 `ffmpeg`（EPUB 内嵌图片时把 WebP/AVIF 转 JPEG；没有也能跑，只是这类图会被跳过）
- 抓外网图片需要代理时，在设置里填 `imageProxy`（例如 `http://user:pass@host:port`）

## 安装 / Install

**从仓库链接安装（开发态）**

```bash
git clone <repo> dsh-miniflux
cd dsh-miniflux && npm install          # 装上 @deepseek-ai/schemastery
dsh plugin --profile <name> add link:$PWD
```

`link:` 安装不会自动装依赖，所以要先 `npm install` 一次；如果改用 npm 上发布的包，`dsh plugin add dsh-miniflux` 会自己装。

装完重启一次 dsh web，左侧栏就会出现 **Miniflux** 图标。

## 设置项 / Settings

| 字段 Field | 说明 Description |
| --- | --- |
| `enabled` | 总开关 / master switch |
| `minifluxUrl` / `minifluxToken` | 实例地址与 API token / base URL and API token |
| `aiSource` | `dsh` = 用 DSH 里已配置的模型（不用再填 key）；`custom` = 自己的 OpenAI 兼容接口 / use DSH-configured models, or your own endpoint |
| `dshProvider` / `dshModel` | DSH 模型的 provider 与 model id / provider and model id from Settings → Models |
| `aiBaseUrl` / `aiApiKey` / `aiModel` | `custom` 模式用 / used when `aiSource=custom` |
| `digestCron` | 早晚报的 cron，如 `30 7,18 * * *` / cron for digests |
| `picksCron` | 「精选」EPUB 的 cron，留空则关闭 / cron for the picks EPUB |
| `feedEpubCron` | 「自选源」EPUB 的 cron，留空则关闭 / cron for the per-feed EPUB |
| `lookbackHours` / `digestMaxItems` / `aiMaxPicks` | 回看时长 / 简报条数 / 每次最多挑几条 |
| `epubFeedNames` | 「自选源」收录哪些源（逗号分隔的源名或 id，空=全部）/ feeds for the per-feed EPUB |
| `epubDir` | EPUB 保存目录（绝对路径，空=`$DSH_HOME/miniflux-epub`）/ output directory |
| `withImages` | EPUB 是否内嵌图片 / embed images |
| `imageProxy` | 抓图代理，如 `http://user:pass@host:port` / proxy for image downloads |
| `autoStar` | AI 挑中的文章自动加星 / star the model's picks |
| `language` | 简报语言 / digest language |

## 三种 EPUB

| 任务 | 触发器 | 内容 |
| --- | --- | --- |
| 早晚报 | `digestCron` | AI 写的分类简报 |
| 精选 | `picksCron` | AI 挑的 3–5 篇，带挑选理由，并加星 |
| 自选源 | `feedEpubCron` | `epubFeedNames` 里那些源最近的文章 |

cron 是标准 5 字段（分 时 日 月 周），按宿主机本地时区。
Express cron (min hour day month weekday), host local time.

## 技术要点

- **图片**：下载后用魔数嗅探真实格式；WebP/AVIF 交给系统 `ffmpeg` 转 JPEG（EPUB 阅读器普遍不支持 WebP）；配了 `imageProxy` 时用 `curl` 走代理。
- **ZIP**：自己实现的最小 ZIP 写入器，不引第三方依赖；mimetype 首位且不压缩。
- **模型**：`dsh` 模式走 `ctx.llm.stream({ provider, model, system, messages })`，和 DSH 的模型设置共用；`custom` 模式走 `POST {base}/chat/completions`。
- **判断**：没有任何本地打分公式，重要性完全由模型按提示词（影响面/时效性/信息增量/一手信源）判断。

## agent 工具

`miniflux_feeds` · `miniflux_search` · `miniflux_read` · `miniflux_digest` · `miniflux_epub` · `miniflux_feed_epub` · `miniflux_star`

## 路由

`GET /api/dsh-miniflux/status` — 连通性与生效配置
`POST /api/dsh-miniflux/generate?what=digest|feed-epub&kind=morning|evening` — 立刻生成

---

## 如果这个插件帮到你 / If this saved you some time

花了不少 token，有帮助的话帮帮忙吧。

It took a fair number of tokens to build this. If it helped you, a small tip is appreciated.

<p align="center">
  <img src="assets/support.jpg" alt="支持作者 / support the author" width="260">
</p>
