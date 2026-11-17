// fixes-test.mjs —— 针对已修 bug 的回归用例（每个用例都对应一次真实踩坑）。
//
//   1) displayPath 跨盘截断，显示成 "~/.dsh/.exe"
//   2) 「login to server failed」被误计入互踢，密钥填错却提示"疑似互踢"
//   3) 旧版 state.json 里的明文 gatePassword 迁移后仍留在原处
//   4) /port/check 接受 80 这类特权端口，与保存时的校验口径不一致
//   5) 日志时间戳曾用 toISOString() 打 UTC，与用户本机时间差 8 小时
//   6) 深色模式输入框白底白字（引用了不存在的 --dsw-alias-bg-1 / border-1）
//
// 全部离线：只写临时 DSH_HOME。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'

const results = []
const rec = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  return cond
}

// ---------- 1) displayPath ----------
{
  const { displayPath } = await import('../paths.mjs')
  const home = join(homedir(), '.dsh')
  const cross = 'D:\\tools\\frpc.exe'
  const d = displayPath(cross, home)
  rec('跨盘自定义路径原样显示（不被截成 ~/.dsh/.exe）', d === cross, d)
  rec('跨盘路径不出现半截后缀', !/^~\/\.dsh\/\.[a-z]+$/i.test(d), d)

  const inside = join(home, 'dsh-ssh-host', 'frpc.exe')
  rec('home 之下的路径仍缩成 ~/.dsh/...',
    displayPath(inside, home) === '~/.dsh/dsh-ssh-host/frpc.exe', displayPath(inside, home))
  rec('home 本身仍是 ~/.dsh', displayPath(home, home) === '~/.dsh', displayPath(home, home))
}

// ---------- 2) frpc 互踢判定 ----------
{
  const { createFrpcManager } = await import('../frpc.mjs')

  const badToken = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  for (let i = 0; i < 8; i++) badToken._feed('[E] login to server failed: token invalid')
  rec('密钥错误不再误判为互踢', badToken.snapshot().kickSuspect === false)

  const kicked = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  for (let i = 0; i < 6; i++) kicked._feed('[E] 网络波动导致数据连接断开, 正在重试: EOF')
  rec('真实断线风暴仍判定互踢', kicked.snapshot().kickSuspect === true)

  // 日志时间戳必须走本机本地时间。曾误用 toISOString() → 打的是 UTC（带 Z），
  // 比北京时间慢 8 小时，用户对照 frpc 原始输出时对不上号。
  const stamper = createFrpcManager({ frpcPath: 'x', getToken: () => 't' })
  stamper._feed('[I] 隧道启动成功')
  const logLine = stamper.logs()[0]
  const dm = logLine.match(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] /)
  rec('日志时间戳格式为 YYYY-MM-DD HH:mm:ss', Boolean(dm), logLine)
  rec('日志时间戳不再带 UTC 的 Z 后缀', !/\dZ\]/.test(logLine), logLine)
  if (dm) {
    // 按「本地时间」反向解析：若时间戳实为 UTC，这里会差出整整一个时区（8h）而被抓到
    const parsed = new Date(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], +dm[6])
    rec('日志时间戳等于本机当前时刻（±5s）',
      Math.abs(parsed.getTime() - Date.now()) < 5000,
      `parsed=${parsed.toISOString()} now=${new Date().toISOString()}`)
  }
}

// ---------- 3) 旧 state.json 明文密码迁移 ----------
const home = mkdtempSync(join(tmpdir(), 'dsh-fixes-test-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'dsh-ssh-host'), { recursive: true })
writeFileSync(
  join(home, 'dsh-ssh-host', 'state.json'),
  JSON.stringify({ enabled: false, tunnelId: '', gatePassword: 'legacy-plain-pass' }),
)

const mod = await import('../index.js')
let handler = null
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
  webServer: { port: 65000, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '', set: async () => {} },
  connection: { authenticatedUrl: (u) => u },
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}
mod.apply(ctx, { enabled: false })

{
  const stateRaw = readFileSync(join(home, 'dsh-ssh-host', 'state.json'), 'utf8')
  const state = JSON.parse(stateRaw)
  rec('state.json 不再包含 gatePassword', !('gatePassword' in state), stateRaw.slice(0, 100))
  rec('state.json 里搜不到明文密码', !stateRaw.includes('legacy-plain-pass'))
  const pwFile = join(home, 'dsh-ssh-host', 'gate-password.txt')
  rec('密码已迁到 0600 密码文件', existsSync(pwFile) && readFileSync(pwFile, 'utf8') === 'legacy-plain-pass')
}

// ---------- 4) /port/check 与保存口径一致 ----------
let base = ''
let localSrv = null
{
  const srv = createServer((req, res) => handler(req, res))
  localSrv = srv
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${srv.address().port}`

  const r80 = await fetch(`${base}/ssh-host/api/port/check?port=80`)
  rec('特权端口 80 → 400', r80.status === 400, `status=${r80.status}`)

  const rOk = await fetch(`${base}/ssh-host/api/port/check?port=65001`)
  const body = await rOk.json().catch(() => null)
  rec('合法端口 65001 → 200 且 inRange', rOk.status === 200 && body?.inRange === true, `status=${rOk.status}`)

  const rBad = await fetch(`${base}/ssh-host/api/port/check?port=99999`)
  rec('越界端口 99999 → 400', rBad.status === 400, `status=${rBad.status}`)
}

// ---------- 5) 清空密码后重启，config 里的旧密码不能复活 ----------
{
  // 用子进程模拟"重启"：apply() 的密码来源只在模块加载 + apply 时求值
  const bootPath = join(home, 'boot.mjs')
  writeFileSync(bootPath, `
import { createServer } from 'node:http'
const mod = await import(${JSON.stringify(new URL('../index.js', import.meta.url).href)})
let handler = null
const ctx = {
  logger: () => ({}),
  webServer: { port: 1, register: ({ handler: h }) => { handler = h; return () => {} } },
  credentials: { resolve: async () => '' },
  connection: {},
  timer: {},
  effect: (fn) => { const d = fn?.(); if (typeof d === 'function') d(); return () => {} },
  inject: () => {},
  get: () => undefined,
}
mod.apply(ctx, { enabled: false, gatePassword: 'cfg-pass' })
const srv = createServer((req, res) => handler(req, res))
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const res = await fetch('http://127.0.0.1:' + srv.address().port + '/ssh-host/api/state')
const j = await res.json()
console.log('CONFIGURED=' + j.gatePasswordConfigured)
srv.close()
process.exit(0)
`)
  const boot = () => execFileSync(process.execPath, [bootPath], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  })

  const postCfg = (patch) => fetch(`${base}/ssh-host/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  })
  const stateFile = join(home, 'dsh-ssh-host', 'state.json')

  let r = await postCfg({ clearGatePassword: true })
  rec('清空密码 → 200', r.status === 200, `status=${r.status}`)
  rec('清空后落「已清空」墓碑', JSON.parse(readFileSync(stateFile, 'utf8')).gatePasswordCleared === true)
  rec('重启后 config 里的密码不复活', /CONFIGURED=false/.test(boot()), boot().trim().split('\n').pop())

  r = await postCfg({ gatePassword: 'brand-new-pass' })
  rec('重设密码 → 200', r.status === 200, `status=${r.status}`)
  rec('重设后撤掉墓碑', JSON.parse(readFileSync(stateFile, 'utf8')).gatePasswordCleared === false)
  rec('重启后密码正常生效', /CONFIGURED=true/.test(boot()), boot().trim().split('\n').pop())
}

// ---------- 6) 一次 API 失败不能被永久记成「接口异常」 ----------
{
  // 给插件一个假 token，让 apiOrNull() 真的建出客户端
  writeFileSync(join(home, 'dsh-ssh-host', 'token.txt'), 'fake-token-for-test')

  const realFetch = globalThis.fetch
  let apiMode = 'fail'
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input)
    if (u.includes('api.natfrp.com')) {
      return apiMode === 'fail'
        ? new Response(JSON.stringify({ code: 500, msg: 'boom' }), { status: 500, headers: { 'content-type': 'application/json' } })
        : new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  }

  const state = async () => (await fetch(`${base}/ssh-host/api/state`)).json()

  const bad = await fetch(`${base}/ssh-host/api/tunnels`)
  rec('API 失败时 tunnels → 502', bad.status === 502, `status=${bad.status}`)
  rec('失败后 apiError 有值', Boolean((await state()).apiError))

  apiMode = 'ok'
  const good = await fetch(`${base}/ssh-host/api/tunnels`)
  rec('API 恢复后 tunnels → 200', good.status === 200, `status=${good.status}`)
  rec('成功后 apiError 自愈（不会永久标红）', (await state()).apiError === undefined)

  globalThis.fetch = realFetch
}

// ---------- 7) 登录后回跳原地址（deep link 不再被丢回首页） ----------
{
  const { createPasswordGate } = await import('../gate.mjs')
  const gate = createPasswordGate({ getPassword: () => 'test-pass' })

  const fakeReq = (body, { url, method = 'GET' } = {}) => {
    const r = Readable.from(body ? [Buffer.from(body)] : [])
    r.method = method
    r.url = url
    r.headers = method === 'POST'
      ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }
      : { accept: 'text/html' }
    r.socket = { remoteAddress: '127.0.0.1' }
    return r
  }
  const run = (req) => {
    let status = 0
    let loc = ''
    let page = ''
    const res = {
      writeHead: (s, h = {}) => { status = s; loc = h?.location ?? '' },
      end: (b) => { page = String(b ?? '') },
      destroy: () => {},
    }
    return gate.handle(req, res).then(() => ({ status, loc, page }))
  }

  // 未登录访问深链 → 登录页带隐藏 next，登录成功后回到原页
  const lp = await run(fakeReq(null, { url: '/ssh-host?x=1' }))
  rec('登录页带上回跳地址', lp.page.includes('name="next" value="/ssh-host?x=1"'))

  // next 来自请求 URL，可被攻击者构造 —— 嵌进属性前必须转义
  const xss = await run(fakeReq(null, { url: '/a?b="><script>alert(1)</script>' }))
  rec('next 的 HTML 特殊字符被转义', !xss.page.includes('"><script'))

  const login = (next) => run(fakeReq(
    `password=${encodeURIComponent('test-pass')}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
    { method: 'POST', url: '/__gate/login' },
  ))
  rec('登录成功回跳原地址', (await login('/ssh-host?a=1')).loc === '/ssh-host?a=1')
  rec('没带 next 回首页', (await login('')).loc === '/')
  // 开放重定向防线：只认站内绝对路径
  rec('//evil.com 被拒回首页', (await login('//evil.com')).loc === '/')
  rec('https://evil.com 被拒回首页', (await login('https://evil.com')).loc === '/')
  rec('/__gate/login 不能作为回跳目标', (await login('/__gate/login')).loc === '/')
}

// ---------- 8) 快照脱敏与实名徽标两处小修 ----------
{
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  rec('快照的 tokenFile 走 displayPath 脱敏', /tokenFile: displayPath\(/.test(index))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  rec('实名徽标不再无守卫渲染 Lundefined',
    !new RegExp("\\? '已实名' : `实名 L").test(client) && /realnameText/.test(client))
}

// ---------- 9) 深色模式输入框：只能引用宿主真实 token ----------
{
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 旧写法用的 --dsw-alias-bg-1 / --dsw-alias-border-1 在 DSH 里不存在，
  // fallback 永远是白色，深色模式下就成了白底白字。
  rec('输入框背景用真实 token --dsw-alias-bg-layer-2',
    /background: 'var\(--dsw-alias-bg-layer-2,/.test(client))
  rec('输入框文字用真实 token --dsw-alias-label-primary',
    /color: 'var\(--dsw-alias-label-primary,/.test(client))
  rec('不再引用不存在的 --dsw-alias-bg-1',
    !/var\(--dsw-alias-bg-1,/.test(client))
  rec('不再引用不存在的 --dsw-alias-border-1',
    !/var\(--dsw-alias-border-1,/.test(client))
  rec('不再引用不存在的 --dsw-alias-border-2',
    !/var\(--dsw-alias-border-2,/.test(client))
  // placeholder 的配色只能靠选择器（inline style 管不到伪元素），
  // 且必须限定在本插件面板内，不能污染宿主。
  rec('placeholder 走面板作用域的样式',
    /\[data-sshhost-panel\] input::placeholder/.test(client)
    && /'data-sshhost-panel': ''/.test(client))
}


// ---------- 10) 请求层：超时 / 在飞去重 / 写后作废 / 轮询闸门 ----------
//
// 背景（2026-11-16 排查）：面板所有请求都走裸 fetch 且**没有超时**。桌面宿主是
// 单浏览器上下文，同源 HTTP/1.1 只有 6 条连接，几条挂死的轮询就能把池子占满。
//
// 这里不用正则断言，而是把 client.js 里真实的函数体抽出来**真跑一遍**：
// 「代码字面在」不等于「行为对」—— 去重没生效、退避算错、闸门把首帧饿死、
// 写之后复用旧快照，这几类只有实际执行才会暴露。
{
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  /** 按名字取函数声明（括号配平），与 test/scroll-test.mjs 的 grab 同一套做法 */
  function grabFn(name) {
    const m = new RegExp('(?:async )?function ' + name + '\\s*\\(').exec(client)
    if (!m) return null
    const start = m.index
    let i = client.indexOf('{', start)
    let depth = 0
    const from = i
    for (; i < client.length; i++) {
      if (client[i] === '{') depth++
      else if (client[i] === '}') { depth--; if (depth === 0) break }
    }
    return client.slice(start, i + 1)
  }

  const need = ['timeoutSignal', 'requestWithTimeout', 'rethrowTimeout', 'invalidateSharedGets',
    'sharedGet', 'docVisible', 'panelVisible', 'createPollGate', 'getJSON', 'post']
  const missing = need.filter((n) => grabFn(n) === null)
  rec('请求层的函数都能在 client.js 里定位', missing.length === 0, missing.join(','))

  // 超时预算在这里换成 150ms 才能测；真实值 8000/20000 由下面的静态断言钉住
  const src = [
    'const API = ""',
    'const GET_TIMEOUT_MS = 150',
    'const POST_TIMEOUT_MS = 150',
    'const pendingGets = new Map()',
    ...need.map(grabFn),
    'export { pendingGets, timeoutSignal, sharedGet, docVisible, panelVisible, createPollGate, getJSON, post }',
  ].join('\n')
  const layerPath = join(home, 'req-layer-test.mjs')
  writeFileSync(layerPath, src)
  const { pathToFileURL } = await import('node:url')
  const layer = await import(pathToFileURL(layerPath).href)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const jsonRes = (obj) => new Response(JSON.stringify(obj),
    { status: 200, headers: { 'content-type': 'application/json' } })
  const realFetch = globalThis.fetch
  let hits = []

  try {
    // ── A) 挂死的请求必须在预算内被终止 ──
    globalThis.fetch = async (url, init = {}) => {
      hits.push(String(url))
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000)
        const sig = init && init.signal
        if (sig && typeof sig.addEventListener === 'function') {
          sig.addEventListener('abort', () => {
            clearTimeout(t)
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })
    }
    const t0 = Date.now()
    let err = null
    try { await layer.getJSON('/state') } catch (e) { err = e }
    const took = Date.now() - t0
    rec('挂死的 GET 带 signal（不是裸 fetch）', Boolean(err), String(err && err.message))
    rec('超时在预算内终止，不会永久挂起', took < 1500, `耗时 ${took}ms`)
    rec('超时报错写明「超时」并带 timedOut 标记',
      /超时/.test(String(err && err.message)) && err && err.timedOut === true, String(err && err.message))

    // ── B) 同一 GET 在途只发一次 ──
    hits = []
    globalThis.fetch = async (url) => { hits.push(String(url)); await sleep(25); return jsonRes({ n: hits.length }) }
    const trio = await Promise.all([layer.getJSON('/state'), layer.getJSON('/state'), layer.getJSON('/state')])
    rec('并发同名 GET 只打一次网络', hits.length === 1, `实际 ${hits.length} 次`)
    rec('三个调用方拿到同一份结果', trio[0] === trio[1] && trio[1] === trio[2])
    rec('在途表结束后自动清空（不会永远复用旧数据）', layer.pendingGets.size === 0, String(layer.pendingGets.size))

    hits = []
    await layer.getJSON('/state')
    rec('上一轮结束后照常重新请求（去重不牺牲新鲜度）', hits.length === 1, String(hits.length))

    // ── C) 写操作作废在途快照 ──
    hits = []
    globalThis.fetch = async (url) => {
      hits.push(String(url))
      await sleep(String(url) === '/state' ? 200 : 20) // GET 慢、POST 快
      return jsonRes({ ok: 1 })
    }
    const inflight = layer.getJSON('/state')
    await layer.post('/config', { x: 1 })
    rec('POST 之后在途表立即作废', layer.pendingGets.size === 0, String(layer.pendingGets.size))
    await layer.getJSON('/state') // 必须重新发，而不是复用 POST 之前那条
    const stateHits = hits.filter((h) => h === '/state')
    rec('写之后的读重新发请求（没把写前数据当写后）', stateHits.length === 2, `命中 ${stateHits.length} 次`)
    await inflight

    // ── D) 轮询闸门：首帧必放行 / 失败翻倍 / 成功复位 / base 覆盖 ──
    const g = layer.createPollGate(1000, () => true)
    const T = 1_000_000
    rec('闸门首次调用一定放行（首帧不会被饿死）', g.allow(T) === true)
    // 健康态（fails===0）闸门**故意**不额外限速：节奏归 setInterval，同一轮里的
    // 重复请求由 sharedGet 去重。这里钉住这个分工，别以后误以为闸门会拦健康轮询。
    rec('健康态不额外限速（去重归 sharedGet，节奏归 setInterval）', g.allow(T + 1) === true)
    g.bad()
    rec('失败一次 → 下次间隔翻倍', g.allow(T + 1001) === false && g.allow(T + 2001) === true)
    g.bad(); g.bad()
    rec('连续失败 → 退避继续累计', g.failures() === 3, String(g.failures()))
    g.ok()
    rec('成功一次 → 退避立刻复位', g.failures() === 0)

    // 退避期间 base 覆盖才是关键：装机 400ms 快轮若沿用默认 4s 预算，
    // 一旦上游出错，进度条会退化成 4s 一跳（看起来像假死）。
    const g4 = layer.createPollGate(4000, () => true)
    const S = 9_000_000
    g4.allow(S)
    g4.bad()
    rec('退避期间默认 4s 预算拦掉 400ms（这是回归的反面）', g4.allow(S + 400) === false)
    // need = base(400) × 2^fails(1) = 800ms，所以第 801ms 才该放行；
    // 若沿用默认 4s 预算（上面那条已证明会被拦），进度条就要 8s 才跳一次。
    rec('装机快轮传 400 base 后按 400×2 档恢复（进度条不会假死）', g4.allow(S + 801, 400) === true)
    rec('退避上限 60s（不会指数爆到几分钟不更新）', (function () {
      const gc = layer.createPollGate(4000, () => true)
      for (let i = 0; i < 12; i++) gc.bad()
      gc.allow(0)
      return gc.allow(60_000) === true && gc.allow(60_001) === false
    })())

    // ── E) 不可见时歇下来，但不能永久饿死 ──
    let vis = false
    const gv = layer.createPollGate(4000, () => vis)
    const V = 20_000_000
    rec('不可见时第一次仍放行（保证首屏有数据）', gv.allow(V) === true)
    rec('不可见期间拦掉轮询', gv.allow(V + 4000) === false)
    rec('不可见超过 30s 仍放行一次探活', gv.allow(V + 31_000) === true)
    vis = true
    rec('回到前台立刻恢复', gv.allow(V + 32_000) === true)

    // ── F) 可见性判据本身：判据不可用时必须保守放行 ──
    delete globalThis.document
    rec('无 DOM 时 panelVisible 保守放行（不漏掉首屏）', layer.panelVisible() === true)
    globalThis.document = { hidden: true }
    rec('document.hidden → docVisible 为 false', layer.docVisible() === false)
    globalThis.document = {
      hidden: false,
      querySelector: () => ({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }),
    }
    rec('面板零尺寸（宿主藏起来）→ panelVisible 为 false', layer.panelVisible() === false)
    globalThis.document = {
      hidden: false,
      querySelector: () => ({ getBoundingClientRect: () => ({ width: 900, height: 600 }) }),
    }
    rec('面板可见 → panelVisible 为 true', layer.panelVisible() === true)
    globalThis.document = { hidden: false, querySelector: () => null }
    rec('找不到探针元素时放行（判据不可用 ≠ 不该轮询）', layer.panelVisible() === true)

    // ── G) 老内核没有 AbortSignal.timeout 时退化路径仍会超时 ──
    const realSignal = globalThis.AbortSignal
    try {
      globalThis.AbortSignal = { timeout: undefined }
      hits = []
      globalThis.fetch = async (url, init = {}) => {
        hits.push(String(url))
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5000)
          const sig = init && init.signal
          if (sig && typeof sig.addEventListener === 'function') {
            sig.addEventListener('abort', () => {
              clearTimeout(t)
              const e = new Error('aborted')
              e.name = 'AbortError'
              reject(e)
            })
          }
        })
      }
      const t1 = Date.now()
      let err2 = null
      try { await layer.getJSON('/compat') } catch (e) { err2 = e }
      rec('缺 AbortSignal.timeout 时仍由手动 controller 终止', Boolean(err2) && Date.now() - t1 < 1500, String(err2 && err2.message))
    } finally {
      globalThis.AbortSignal = realSignal
    }
  } finally {
    globalThis.fetch = realFetch
    try { delete globalThis.document } catch { /* noop */ }
  }

  // ── H) 真实预算：前端 8s/20s，后端读 6s 必须早于前端 ──
  rec('前端 GET 预算 8000ms', /const GET_TIMEOUT_MS = 8000/.test(client))
  rec('前端 POST 预算 20000ms', /const POST_TIMEOUT_MS = 20000/.test(client))
  rec('面板里除 requestWithTimeout 外没有裸 fetch',
    (client.match(/\bfetch\(/g) || []).length === 1,
    `命中 ${(client.match(/\bfetch\(/g) || []).length} 处`)
  rec('侧边栏闸门用 docVisible 而不是 panelVisible（面板没开也要工作）',
    /const sidebarGate = createPollGate\(5000, docVisible\)/.test(client))
  rec('SSH 卡闸门用 panelVisible（它渲染在主面板里）',
    /createPollGate\(8000, panelVisible\)/.test(client))
  rec('侧边栏超时不标红（没答案 ≠ 有故障）',
    /if \(e\?\.timedOut\) return/.test(client))
}

// ---------- 11) 后端读路由的上游超时必须早于前端 ──────────────
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  rec('读路由上限默认 6s（早于前端 8s）',
    /readTimeoutMs: Number\(config\.readTimeoutMs\) > 0 \? Number\(config\.readTimeoutMs\) : 6000/.test(idx))
  rec('READ_TIMEOUT_MS 取自 cfg（链路慢的用户可调，不是写死）',
    /const READ_TIMEOUT_MS = cfg\.readTimeoutMs/.test(idx))
  for (const route of ['/ssh-host/api/tunnels', '/ssh-host/api/nodes', '/ssh-host/api/user', '/ssh-host/api/ssh/state']) {
    const at = idx.indexOf(`path === '${route}'`)
    rec(`存在读路由 ${route}`, at >= 0)
    rec(`${route} 的 apiOrNull 带读超时`, /apiOrNull\(token, READ_TIMEOUT_MS\)/.test(idx.slice(at, at + 900)))
  }
  const createAt = idx.indexOf("path === '/ssh-host/api/tunnel/create'")
  const seg = idx.slice(createAt, createAt + 400)
  rec('写路由（建隧道）不缩短超时——用户主动等的动作', /apiOrNull\(token\)/.test(seg) && !/READ_TIMEOUT_MS/.test(seg))
}

// ---------- 12) /user 的两个上游调用必须并行 ──────────────
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const at = idx.indexOf("path === '/ssh-host/api/user'")
  const seg = idx.slice(at, at + 1300)
  rec('/user 用 Promise.all 并行取 userInfo 与 dataPlans', /Promise\.all\(\[\s*\n\s*api\.userInfo\(\),/.test(seg))
  rec('/user 里 dataPlans 单独 catch（不拖垮账号信息）', /catch\(\(e\) => \(\{\s*\n\s*plansError:/.test(seg))
  rec('/user 不再是「先 await userInfo 再 await dataPlans」',
    !/await api\.userInfo\(\)[\s\S]{0,500}?await api\.dataPlans/.test(seg))
}

// ---------- 13) 读路由真的在预算内出结论（实测，非字面断言） ----------
//
// 上一节证明的是「代码里有超时」；这里证明「跑起来真的会超时中止」。
// 用 readTimeoutMs: 300 把预算压小，测试才能又快又确定。
{
  const realFetch = globalThis.fetch
  const nap = (ms) => new Promise((r) => setTimeout(r, ms))
  // 只劫持上游域名，本地请求仍走真 fetch —— 否则会把测试自己挂死（第一次踩坑）
  let hang = false
  let failPlans = false
  let aborts = 0
  const slowMs = 200
  globalThis.fetch = async (input, init) => {
    const u = String(input?.url ?? input)
    if (!u.includes('api.natfrp.com')) return realFetch(input, init)
    if (hang) {
      return new Promise((_, reject) => {
        const sig = init && init.signal
        const timer = setTimeout(() => {
          const e = new Error('net')
          reject(e)
        }, 30000)
        if (sig && typeof sig.addEventListener === 'function') {
          sig.addEventListener('abort', () => {
            aborts++
            clearTimeout(timer)
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        }
      })
    }
    await nap(slowMs)
    if (init && init.signal && init.signal.aborted) {
      const e = new Error('aborted')
      e.name = 'AbortError'
      throw e
    }
    if (failPlans && u.includes('data_plans')) {
      return new Response(JSON.stringify({ code: 500, msg: 'plans boom' }),
        { status: 500, headers: { 'content-type': 'application/json' } })
    }
    // 上游是**裸 JSON**（natfrp.mjs:63-75 不做 {code,data} 拆包），照它的真实形状给
    const body = u.includes('data_plans') ? [{ id: 1, total: 10, remaining: 5 }]
      : u.includes('/nodes') ? { 1: { name: 'n1', host: 'n1.example' } }
        : u.includes('/tunnels') ? [] : { id: 7, name: 'mac' }
    return new Response(JSON.stringify(body),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }

  let srv = null
  try {
    // 重新 apply 一次：把读超时压到 300ms（cfg 每次 apply 求值，见 index.js readTimeoutMs）
    mod.apply(ctx, { enabled: false, readTimeoutMs: 300 })
    srv = createServer((req, res) => handler(req, res))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const b = `http://127.0.0.1:${srv.address().port}`

    hang = true
    const t0 = Date.now()
    const hung = await realFetch(`${b}/ssh-host/api/tunnels`)
    const hungMs = Date.now() - t0
    const hungBody = await hung.json().catch(() => ({}))
    rec('上游挂死时读路由在预算内出结论（不是等上游自己醒）',
      hung.status === 502 && hungMs < 2000, `status=${hung.status} 耗时 ${hungMs}ms`)
    rec('超时报错来自后端而非前端放弃', /请求超时/.test(String(hungBody.message)), String(hungBody.message))
    rec('后端真的中止了在途上游请求（连接没有被继续占用）', aborts > 0, `abort ${aborts} 次`)

    // 并行证明：每个上游 200ms，串行需 400ms > 300ms 预算 → 会 502；并行 200ms < 300ms → 200
    hang = false
    const t1 = Date.now()
    const user = await realFetch(`${b}/ssh-host/api/user`)
    const userMs = Date.now() - t1
    rec('/user 的两个上游调用确实并行（串行会超预算变 502）',
      user.status === 200 && userMs < 300, `status=${user.status} 耗时 ${userMs}ms`)
    const uj = await user.json().catch(() => ({}))
    rec('并行后 dataPlans 仍随 /user 返回', Array.isArray(uj.dataPlans) && uj.dataPlans.length === 1,
      JSON.stringify(uj.dataPlans))
    // dataPlans 单独 catch 的真正价值：流量包接口坏了，账号信息与总量之外的一切
    // 仍要能用 —— 整个 /user 不该因此 502。
    failPlans = true
    const degraded = await realFetch(`${b}/ssh-host/api/user`)
    const dj = await degraded.json().catch(() => ({}))
    failPlans = false
    rec('流量包接口失败时 /user 仍 200（不整体 502）', degraded.status === 200, `status=${degraded.status}`)
    rec('流量包失败降级为 dataPlans:null + plansError 文案',
      dj.dataPlans === null && /plans boom/.test(String(dj.dataPlansError)), JSON.stringify(dj.dataPlansError))
    rec('流量包失败不影响账号字段', dj.id === 7, JSON.stringify(dj.id))

    // 正常路径没被超时机制打断
    const ok = await realFetch(`${b}/ssh-host/api/tunnels`)
    rec('上游正常时读路由照常 200（超时机制不误伤）', ok.status === 200, `status=${ok.status}`)
  } finally {
    globalThis.fetch = realFetch
    srv && srv.close()
    mod.apply(ctx, { enabled: false }) // 复位，不影响后续套件对默认配置的假设
  }
}

console.log(results.join('\n'))
const passed = results.filter((x) => x.startsWith('PASS')).length
console.log(`\n${passed}/${results.length} passed`)
localSrv?.close()
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 100)
