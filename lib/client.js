/**
 * dsh-miniflux — 浏览器半身。
 *
 * 注册一个左侧栏入口（sidebar.panellist）和一个主区域页面（main），
 * 页面上是 Miniflux 连接参数、模型选择、cron 与 EPUB 设置，保存后立刻生效。
 *
 * 任何异常都在本地吞掉，不能影响宿主界面。
 */
window.__ModuleLoader__.load({
  id: 'dsh-miniflux',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const jsx = require('react/jsx-runtime')
    const { useState, useEffect, useCallback } = require('react')

    /** 面板入口图标：外壳靠这个 data 属性把图标和面板关联起来。 */
    function MinifluxIcon({ size }) {
      return jsx.jsxs('svg', {
        'data-dsh-panel-entry': 'miniflux',
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.5',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          jsx.jsx('rect', { x: '1.75', y: '2.25', width: '12.5', height: '11.5', rx: '1.75' }),
          jsx.jsx('path', { d: 'M4.5 5.5h5M4.5 8h7M4.5 10.5h4' }),
        ],
      })
    }

    const S = {
      page: { padding: '18px 22px', maxWidth: 720, fontFamily: 'inherit', fontSize: 13 },
      title: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' },
      hint: { opacity: 0.65, margin: '0 0 18px', lineHeight: 1.5 },
      group: { margin: '0 0 18px', padding: '12px 14px', border: '1px solid rgba(128,128,128,.25)', borderRadius: 10 },
      legend: { fontSize: 12, fontWeight: 600, opacity: 0.8, margin: '0 0 10px' },
      row: { display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10, alignItems: 'center', margin: '0 0 8px' },
      label: { fontSize: 12, opacity: 0.85, lineHeight: 1.35 },
      input: { width: '100%', padding: '6px 8px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 0' },
      button: { padding: '6px 12px', fontSize: 12, borderRadius: 6, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      status: { fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: '10px 0 0', opacity: 0.85 },
      ok: { color: '#2e7d32' },
      bad: { color: '#c62828' },
    }

    const FIELDS = [
      { key: 'minifluxUrl', label: 'Miniflux 地址 / URL', placeholder: 'http://192.168.1.10:8080' },
      { key: 'minifluxToken', label: 'API Token', placeholder: 'Miniflux → 设置 → API 密钥', secret: true },
    ]

    const ADVANCED = [
      { key: 'epubFeedNames', label: '自选源 / Feed names', placeholder: '留空=全部，逗号分隔' },
      { key: 'epubDir', label: 'EPUB 目录 / Output dir', placeholder: '留空 = $DSH_HOME/miniflux-epub' },
      { key: 'digestCron', label: '日报 cron / Daily cron', placeholder: '30 7,18 * * *' },
      { key: 'picksCron', label: '精选 cron / Picks cron', placeholder: '45 7,18 * * *' },
      { key: 'feedEpubCron', label: '自选源 cron / Feed EPUB cron', placeholder: '0 8 * * *' },
      { key: 'modelTimeoutSec', label: '模型超时(秒) / Model timeout', placeholder: '600' },
      { key: 'aiBatchSize', label: 'AI 每批篇数 / AI batch size', placeholder: '12' },
      { key: 'maxCandidates', label: '日报候选上限 / Digest candidates', placeholder: '200' },
      { key: 'picksCandidates', label: '精选取未读篇数 / Picks candidates', placeholder: '200' },
      { key: 'feedEpubMax', label: '自选源篇数上限 / Feed EPUB max', placeholder: '120' },
      { key: 'imageProxy', label: '抓图代理 / Image proxy', placeholder: 'http://user:pass@host:port' },
      { key: 'language', label: '语言 / Language', placeholder: '中文' },
    ]

    function Field({ field, value, onChange }) {
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('span', { style: S.label, children: field.label }),
          jsx.jsx('input', {
            style: S.input,
            type: field.secret ? 'password' : 'text',
            placeholder: field.placeholder || '',
            value: value ?? '',
            onChange: (event) => onChange(field.key, event.target.value),
          }),
        ],
      })
    }

    function Toggle({ label, checked, onChange }) {
      return jsx.jsxs('div', {
        style: S.row,
        children: [
          jsx.jsx('span', { style: S.label, children: label }),
          jsx.jsx('input', { type: 'checkbox', checked: Boolean(checked), onChange: (event) => onChange(event.target.checked) }),
        ],
      })
    }

    function MinifluxPage() {
      const [config, setConfig] = useState(null)
      const [providers, setProviders] = useState([])
      const [status, setStatus] = useState(null)
      const [files, setFiles] = useState({ dir: '', files: [] })
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState('')

      const load = useCallback(async () => {
        try {
          const res = await fetch('/api/dsh-miniflux/config', { headers: { Accept: 'application/json' } })
          const data = await res.json()
          setConfig(data.config || {})
        } catch (error) {
          setMessage(`读取配置失败 / failed to load config: ${error?.message || error}`)
        }
        try {
          const res = await fetch('/api/dsh-miniflux/models', { headers: { Accept: 'application/json' } })
          const data = await res.json()
          setProviders(Array.isArray(data.providers) ? data.providers : [])
        } catch { setProviders([]) }
        try {
          const res = await fetch('/api/dsh-miniflux/status', { headers: { Accept: 'application/json' } })
          setStatus(await res.json())
        } catch { setStatus(null) }
        try {
          const res = await fetch('/api/dsh-miniflux/files', { headers: { Accept: 'application/json' } })
          const data = await res.json()
          setFiles({ dir: data.dir || '', files: Array.isArray(data.files) ? data.files : [] })
        } catch { setFiles({ dir: '', files: [] }) }
      }, [])

      useEffect(() => { void load() }, [load])

      const setField = (key, value) => setConfig((current) => ({ ...(current || {}), [key]: value }))

      const save = async () => {
        setBusy('save'); setMessage('')
        try {
          const res = await fetch('/api/dsh-miniflux/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config || {}),
          })
          const data = await res.json()
          if (data.ok) { setConfig(data.config); setMessage('已保存 / saved') } else setMessage(`保存失败 / save failed: ${data.message || ''}`)
        } catch (error) {
          setMessage(`保存失败 / save failed: ${error?.message || error}`)
        } finally { setBusy('') }
      }

      const run = async (what) => {
        setBusy(what); setMessage('任务已提交，正在后台生成…（模型慢的话可能要几分钟）')
        try {
          const res = await fetch(`/api/dsh-miniflux/generate?what=${what}`, { method: 'POST' })
          const data = await res.json()
          if (!data.ok) { setMessage(`无法开始 / cannot start: ${data.message || ''}`); setBusy(''); return }
        } catch (error) {
          setMessage(`失败 / failed: ${error?.message || error}`); setBusy(''); return
        }
        // 轮询后台任务
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 3000))
          let state
          try {
            state = await (await fetch('/api/dsh-miniflux/job')).json()
          } catch { continue }
          if (state.state === 'running') { setMessage(`生成中… 已用 ${state.elapsedSec || 0} 秒（可切走，跑完回来点刷新）/ running`); continue }
          if (state.state === 'done') {
            const result = state.result || {}
            const target = result.digestEpub || result.picksEpub || result.epub || result.title || ''
            setMessage(result.ok
              ? `完成 / done（${state.elapsedSec} 秒）: ${target}${result.skippedScreened ? ` · 跳过已筛 ${result.skippedScreened} 篇` : ''}${result.starred?.length ? ` · 收藏 ${result.starred.length} 条` : ''}${result.read ? ` · 已读 ${result.read} 条` : ''}`
              : `失败 / failed: ${result.message || ''}`)
          } else if (state.state === 'failed') {
            setMessage(`失败 / failed: ${state.error || ''}`)
          } else {
            setMessage('空闲 / idle')
          }
          setBusy('')
          return
        }
      }

      const testModel = async () => {
        setBusy('test'); setMessage('')
        try {
          const res = await fetch('/api/dsh-miniflux/test-model', { method: 'POST' })
          const data = await res.json()
          if (data.ok) setMessage(`模型可用 / model ok: ${data.provider} / ${data.model} → “${data.reply}”`)
          else setMessage(`模型调用失败 / model failed: ${data.provider || ''} / ${data.model || ''} → ${data.message || ''}`)
        } catch (error) {
          setMessage(`测试失败 / test failed: ${error?.message || error}`)
        } finally { setBusy('') }
      }

      const chosenProvider = (config && config.dshProvider) || ''
      const providerEntry = providers.find((item) => item.id === chosenProvider)
      const modelOptions = providerEntry?.models || []

      return jsx.jsxs('div', {
        style: S.page,
        children: [
          jsx.jsx('h2', { style: S.title, children: 'Miniflux' }),
          jsx.jsx('p', {
            style: S.hint,
            children: 'AI 日报、精选与自选源 EPUB。连接参数和模型都在这里填，保存后立即生效（无需重启）。 / Fill in the connection and model here; changes apply immediately.',
          }),

          jsx.jsxs('div', {
            style: S.group,
            children: [
              jsx.jsx('div', { style: S.legend, children: '连接 / Connection' }),
              ...FIELDS.map((field) => jsx.jsx(Field, {
                field, value: config?.[field.key], onChange: setField,
              }, field.key)),
            ],
          }),

          jsx.jsxs('div', {
            style: S.group,
            children: [
              jsx.jsx('div', { style: S.legend, children: '模型 / Model' }),
              jsx.jsxs('div', {
                style: S.row,
                children: [
                  jsx.jsx('span', { style: S.label, children: '来源 / Source' }),
                  jsx.jsxs('select', {
                    style: S.input,
                    value: config?.aiSource || 'dsh',
                    onChange: (event) => setField('aiSource', event.target.value),
                    children: [
                      jsx.jsx('option', { value: 'dsh', children: 'DSH 已连接的模型 / models connected to DSH' }),
                      jsx.jsx('option', { value: 'custom', children: '自定义接口 / custom OpenAI-compatible endpoint' }),
                    ],
                  }),
                ],
              }),
              ...(config?.aiSource === 'custom'
                ? [
                  jsx.jsx(Field, { field: { key: 'aiBaseUrl', label: '接口地址 / Base URL', placeholder: 'https://api.deepseek.com/v1' }, value: config?.aiBaseUrl, onChange: setField }, 'aiBaseUrl'),
                  jsx.jsx(Field, { field: { key: 'aiApiKey', label: 'API Key', placeholder: 'sk-...', secret: true }, value: config?.aiApiKey, onChange: setField }, 'aiApiKey'),
                  jsx.jsx(Field, { field: { key: 'aiModel', label: '模型名 / Model id', placeholder: 'deepseek-chat' }, value: config?.aiModel, onChange: setField }, 'aiModel'),
                ]
                : [
                  jsx.jsxs('div', {
                    style: S.row,
                    children: [
                      jsx.jsx('span', { style: S.label, children: '服务商 / Provider' }),
                      jsx.jsxs('select', {
                        style: S.input,
                        value: chosenProvider,
                        onChange: (event) => {
                          const next = event.target.value
                          const entry = providers.find((item) => item.id === next)
                          setConfig((current) => ({
                            ...(current || {}),
                            dshProvider: next,
                            dshModel: entry?.models?.[0] || current?.dshModel || '',
                          }))
                        },
                        children: [
                          jsx.jsx('option', { value: '', children: providers.length ? '请选择 / select' : '（模型列表不可用，可手填）/ list unavailable, type below' }),
                          ...providers.map((item) => jsx.jsx('option', { value: item.id, children: item.name }, item.id)),
                        ],
                      }),
                    ],
                  }),
                  modelOptions.length
                    ? jsx.jsxs('div', {
                      style: S.row,
                      children: [
                        jsx.jsx('span', { style: S.label, children: '模型 / Model' }),
                        jsx.jsxs('select', {
                          style: S.input,
                          value: config?.dshModel || '',
                          onChange: (event) => setField('dshModel', event.target.value),
                          children: modelOptions.map((id) => jsx.jsx('option', { value: id, children: id }, id)),
                        }),
                      ],
                    })
                    : jsx.jsx(Field, { field: { key: 'dshModel', label: '模型 / Model', placeholder: 'deepseek-flash' }, value: config?.dshModel, onChange: setField }, 'dshModel'),
                ]),
            ],
          }),

          jsx.jsxs('div', {
            style: S.group,
            children: [
              jsx.jsx('div', { style: S.legend, children: 'AI 能力、定时与产出 / AI, schedule & output' }),
              ...ADVANCED.map((field) => jsx.jsx(Field, { field, value: config?.[field.key], onChange: setField }, field.key)),
              jsx.jsx(Toggle, { label: '内嵌图片 / Embed images', checked: config?.withImages !== false, onChange: (v) => setField('withImages', v) }),
              jsx.jsx(Toggle, { label: '自动加星 / Auto star picks', checked: config?.autoStar !== false, onChange: (v) => setField('autoStar', v) }),
              jsx.jsx(Toggle, { label: '跳过已筛过的 / Skip screened', checked: config?.picksSkipScreened !== false, onChange: (v) => setField('picksSkipScreened', v) }),
            ],
          }),

          jsx.jsxs('div', {
            style: S.actions,
            children: [
              jsx.jsx('button', { style: S.button, disabled: busy === 'save', onClick: save, children: busy === 'save' ? '保存中…' : '保存 / Save' }),
              jsx.jsx('button', { style: S.button, disabled: busy === 'digest', onClick: () => run('digest'), children: busy === 'digest' ? '生成中…' : '生成日报 / Daily digest' }),
              jsx.jsx('button', { style: S.button, disabled: busy === 'picks', onClick: () => run('picks'), children: busy === 'picks' ? '生成中…' : '生成精选 / Picks now' }),
              jsx.jsx('button', { style: S.button, disabled: busy === 'feed-epub', onClick: () => run('feed-epub'), children: busy === 'feed-epub' ? '生成中…' : '生成自选源 EPUB / Feed EPUB now' }),
              jsx.jsx('button', { style: S.button, disabled: busy === 'test', onClick: testModel, children: busy === 'test' ? '测试中…' : '测试模型 / Test model' }),
              jsx.jsx('button', {
                style: S.button,
                onClick: async () => {
                  setMessage('')
                  try {
                    const res = await fetch('/api/dsh-miniflux/reset-screened', { method: 'POST' })
                    const data = await res.json()
                    setMessage(`已清空筛选记录 / ledger cleared: 移除 ${data.removed ?? 0} 条`)
                  } catch (error) { setMessage(`清空失败 / failed: ${error?.message || error}`) }
                },
                children: '清空筛选记录 / Clear screened',
              }),
              jsx.jsx('button', { style: S.button, onClick: load, children: '刷新 / Refresh' }),
            ],
          }),

          message ? jsx.jsx('div', { style: S.status, children: message }) : null,

          jsx.jsxs('div', {
            style: S.group,
            children: [
              jsx.jsx('div', { style: S.legend, children: '最近生成 / Recent files' }),
              jsx.jsx('div', { style: S.label, children: `目录 / dir: ${files.dir || '(未配置)'}` }),
              ...(files.files.length
                ? files.files.map((file) => jsx.jsx('div', {
                  style: S.label,
                  children: `${file.name} · ${Math.round(file.bytes / 1024)} KB · ${new Date(file.mtime).toLocaleString()}`,
                }, file.path))
                : [jsx.jsx('div', { style: S.label, children: '（还没有生成过文件）/ no files yet' })]),
            ],
          }),

          status
            ? jsx.jsxs('div', { style: S.status, children: [
              jsx.jsx('div', { style: status.miniflux?.ok ? S.ok : S.bad, children: status.miniflux?.ok ? `Miniflux 已连接 / connected · ${status.minifluxUrl || ''}` : `Miniflux 未连通 / not connected: ${status.miniflux?.error || ''}` }),
              jsx.jsx('div', { children: `模型 / model: ${status.model || '-'}` }),
              jsx.jsx('div', { children: `EPUB 目录 / dir: ${status.epubDir || '-'}` }),
            ] })
            : null,
        ],
      })
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        const disposers = []
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'miniflux',
          order: 40,
          label: () => 'Miniflux',
        }, MinifluxIcon)))
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'miniflux',
        }, MinifluxPage)))
        ctx.effect?.(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'dsh-miniflux: client slots')
      } catch (error) {
        console.error('[dsh-miniflux] client mount failed:', error?.message || error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
