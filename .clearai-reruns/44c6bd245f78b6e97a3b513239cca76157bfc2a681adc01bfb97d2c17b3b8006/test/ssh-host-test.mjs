// ssh-host-test.mjs — ssh.mjs 的 SSH 主机能力：ed25519 专用密钥 / authorized_keys upsert 写入 /
// 连接命令 / sshd 探测（注入点），以及 index.js 的 SSH 路由与 frpc 多隧道（Task 9）。
//
// 与其它套件同款骨架（rec/results + 末尾 `N/N passed`，test-all.mjs 靠这个行汇总）。
// 全部离线：密钥内存生成，authorized_keys 写进 mkdtemp 临时目录，不碰真实 ~/.ssh；
// sshd 真探测（TCP 127.0.0.1:22）按仓库约定不测，只测注入点；官方 API 全部被 fetch 桩
// 拦在本地（tunnel-create-test.mjs 手法）；frpc 用「假 frpc 脚本」观察 NATFRP_TARGET。
//
// 与计划 Step 8.1 / Task 9 的差异（逐条核对过）：
//   · 断言从裸 assert 换成套件统一的 rec 骨架，语义逐条保留；
//   · 计划块 3 的偏移算术错误：wire 布局 `[4B len][11B type][4B len][32B raw]`，
//     原始字节在偏移 19（非 15），已修测试并补长度字段断言；
//   · installPublicKey 契约按 Task 9「实施契约修正」从标记级幂等升级为 upsert 三态
//     （created / unchanged / replaced）——标记级幂等会让「重新生成密钥」时新公钥
//     写不进 authorized_keys，SSH 认证静默失败；断言已按新契约改写；
//   · 计划 Step 9.1 设想的 makeCtxWithFrpcSpy / handleViaCtx 桩在 apply-test.mjs 里
//     并不存在（其桩名为 ctx/handler + 真 HTTP server），按「照抄现有构造」的
//     要求改为复用 apply-test.mjs / tunnel-create-test.mjs 的真实写法；
//     frpc 桩用假可执行脚本观察 env NATFRP_TARGET（ESM 静态 import 无注入点，
//     且 env 传播是 frpc.mjs:171 的真实链路，比 spy start 参数更端到端）。

import { mkdtempSync, mkdirSync, statSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, userInfo as osUserInfo, release as osRelease } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import {
  buildOpenSshPublicKey, generateHostKey, fingerprintOf,
  installPublicKey, buildConnectCommand, parseSshdProbeResult,
  checkSshd, setSshdProberForTests, toOpenSshPrivatePem, publicKeyFromPrivatePem,
} from '../ssh.mjs'

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const markerLines = (text) => text.split('\n').filter((l) => l.includes('dsh-ssh-host')).length
// 给 ssh-keygen 落盘用的临时目录（只放测试自己生成的私钥，不碰 ~/.ssh）
const homeForTest = mkdtempSync(join(tmpdir(), 'dsh-ssh-keygen-'))

// ── 1) generateHostKey：OpenSSH ed25519 公钥行 + OpenSSH authkey 私钥 ──
// 私钥格式是真机反馈逼出来的:Termius 对 ed25519 只认
// `BEGIN OPENSSH PRIVATE KEY`,PKCS8 的 `BEGIN PRIVATE KEY` 报
// "Unsupported key type: PRIVATE KEY"(2026-11-12)。
{
  const k = generateHostKey()
  const blob = Buffer.from(k.publicKey.split(/\s+/)[1], 'base64')
  rec('公钥行以 ssh-ed25519 开头', k.publicKey.startsWith('ssh-ed25519 '), k.publicKey.split(/\s+/)[0])
  rec('公钥行带 dsh-ssh-host 标记注释', k.publicKey.endsWith(' dsh-ssh-host'), k.publicKey.split(/\s+/).pop())
  rec('wire blob 长度 >= 51（4+11+4+32）', blob.length >= 51, `len=${blob.length}`)
  rec('blob 首段长度 11（ssh-ed25519）', blob.readUInt32BE(0) === 11, String(blob.readUInt32BE(0)))
  rec('blob 类型串是 ssh-ed25519', blob.subarray(4, 15).toString() === 'ssh-ed25519', blob.subarray(4, 15).toString())
  rec('私钥是 OpenSSH authkey 格式（Termius 可导入）',
    k.privateKey.includes('BEGIN OPENSSH PRIVATE KEY'), k.privateKey.split('\n')[0])
  rec('私钥不是 PKCS8（旧格式已被真机否掉）', !k.privateKey.includes('BEGIN PRIVATE KEY'))
  // 权威判据:系统 ssh-keygen 能读这把私钥,并且推导出的公钥 == 我们的公钥行。
  // 手工拼的 wire format 只要错一个字节,这里就红。
  {
    const f = join(homeForTest, `probe-${Math.random().toString(36).slice(2)}.key`)
    writeFileSync(f, k.privateKey, { mode: 0o600 })
    let derived = ''
    try {
      derived = execFileSync('ssh-keygen', ['-y', '-f', f], { encoding: 'utf8' }).trim()
    } catch (e) { derived = `__SSH_KEYGEN_FAILED__ ${e?.message ?? e}` }
    rec('ssh-keygen 能读该私钥（格式合法）', !derived.startsWith('__SSH_KEYGEN_FAILED__'), derived.slice(0, 40))
    rec('ssh-keygen 推导的公钥与私钥内嵌 blob 一致（密钥对真的对应）',
      derived === k.publicKey, `${derived.slice(0, 30)}… vs ${k.publicKey.slice(0, 30)}…`)
    try { rmSync(f, { force: true }) } catch { /* noop */ }
  }
  const k2 = generateHostKey()
  rec('每次生成都是新密钥', k.publicKey !== k2.publicKey)
  rec('公钥文件丢失时能从私钥解出同一公钥（自愈）', publicKeyFromPrivatePem(k.privateKey) === k.publicKey)
  rec('私钥换封装幂等', toOpenSshPrivatePem(k.privateKey) === k.privateKey)
}

// ── 2) fingerprintOf：RFC 4253/8336 风格 SHA256:<base64 无 padding> ──
{
  const k = generateHostKey()
  const fp = fingerprintOf(k.publicKey)
  rec('指纹以 SHA256: 开头', fp.startsWith('SHA256:'), fp.slice(0, 11) + '…')
  rec('指纹无 base64 padding', !fp.includes('='))
  rec('同一把密钥指纹稳定', fp === fingerprintOf(k.publicKey))
  rec('不同密钥指纹不同', fp !== fingerprintOf(generateHostKey().publicKey))
}

// ── 3) buildOpenSshPublicKey：纯格式化，与生成解耦，原始字节原样保留 ──
{
  const raw = Buffer.alloc(32, 7)
  const line = buildOpenSshPublicKey(raw, 'dsh-ssh-host')
  const blob = Buffer.from(line.split(/\s+/)[1], 'base64')
  rec('类型前缀是 ssh-ed25519', line.startsWith('ssh-ed25519 '))
  rec('注释后缀是 dsh-ssh-host', line.endsWith(' dsh-ssh-host'))
  // wire 布局：[4B len=11][11B "ssh-ed25519"][4B len=32][32B raw] —— 原始字节在偏移 19。
  // 计划 Step 8.1 原写 subarray(15)，漏算了 raw 前面的 4 字节长度字段（其块 1 自己
  // 断言了 readUInt32BE(0)===11 / subarray(4,15) 为类型串），按实现的真实布局修正。
  rec('raw 前的长度字段是 32', blob.readUInt32BE(15) === 32, String(blob.readUInt32BE(15)))
  rec('原始 32 字节原样保留', blob.subarray(19).toString('hex') === raw.toString('hex'),
    blob.subarray(19).toString('hex').slice(0, 16) + '…')
}

// ── 4) installPublicKey：upsert 三态 + 权限（sshd StrictModes 要求 0700/0600，否则公钥认证静默失效）──
//    契约（Task 9 实施契约修正，硬性要求）：
//      · 无标记条目 → 追加新公钥行，action=created
//      · 有标记条目且公钥主体（base64）相同 → 不动文件，action=unchanged
//      · 有标记条目且公钥主体不同 → 替换该标记行（旧私钥失效场景），action=replaced
//      · 用户自己的其它条目（无标记）永远原样保留；写入后标记行恰好一条
{
  const dir = mkdtempSync(join(tmpdir(), 'sshhost-'))
  const k = generateHostKey()
  const r1 = installPublicKey(k.publicKey, { sshDir: dir })
  rec('无标记目录 → action=created（追加）', r1.action === 'created', `action=${r1.action}`)
  const before = readFileSync(join(dir, 'authorized_keys'), 'utf8')
  const r2 = installPublicKey(k.publicKey, { sshDir: dir })
  rec('同目录同公钥二次安装 → action=unchanged', r2.action === 'unchanged', `action=${r2.action}`)
  rec('unchanged 文件不变（字节级一致）', readFileSync(join(dir, 'authorized_keys'), 'utf8') === before)
  const other = generateHostKey()
  const r3 = installPublicKey(other.publicKey, { sshDir: dir })
  rec('同目录不同公钥 → action=replaced', r3.action === 'replaced', `action=${r3.action}`)
  const text = readFileSync(join(dir, 'authorized_keys'), 'utf8')
  rec('旧公钥行被替换（旧主体不在文件里）', !text.includes(k.publicKey.split(' ')[1]))
  rec('新公钥主体在文件里', text.includes(other.publicKey.split(' ')[1]))
  rec('标记行恰好一条（替换而不是追加）', markerLines(text) === 1, `count=${markerLines(text)}`)
  const st = statSync(join(dir, 'authorized_keys'))
  rec('authorized_keys 权限 0600', (st.mode & 0o777) === 0o600, `mode=${(st.mode & 0o777).toString(8)}`)
  const stDir = statSync(dir)
  rec('ssh 目录权限 0700', (stDir.mode & 0o777) === 0o700, `mode=${(stDir.mode & 0o777).toString(8)}`)
}

// ── 4.5) upsert 对用户已有条目的保护 ──
//    目录里已有用户自己的条目（无本插件标记）时：created 只追加；
//    replaced 只动标记行（含行内旧注释），用户行原样保留。
{
  const dir = mkdtempSync(join(tmpdir(), 'sshhost-'))
  const preUser = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDfakeuserkey user@laptop'
  writeFileSync(join(dir, 'authorized_keys'), `${preUser}\n`, { mode: 0o600 })
  const k = generateHostKey()
  const r1 = installPublicKey(k.publicKey, { sshDir: dir })
  rec('有用户条目、无标记 → action=created（只追加不覆盖）', r1.action === 'created', `action=${r1.action}`)
  let text = readFileSync(join(dir, 'authorized_keys'), 'utf8')
  rec('用户已有条目原样保留（created 后）', text.includes(preUser))
  const other = generateHostKey()
  const r2 = installPublicKey(other.publicKey, { sshDir: dir })
  rec('不同公钥再装 → action=replaced（替换标记行）', r2.action === 'replaced', `action=${r2.action}`)
  text = readFileSync(join(dir, 'authorized_keys'), 'utf8')
  rec('用户已有条目原样保留（replaced 后）', text.includes(preUser))
  rec('旧的插件公钥被替换掉', !text.includes(k.publicKey.split(' ')[1]))
  rec('新公钥主体在文件里', text.includes(other.publicKey.split(' ')[1]))
  rec('混合文件里标记恰好一条', markerLines(text) === 1, `count=${markerLines(text)}`)
}

// ── 5) installPublicKey 拒绝非 ed25519 输入 ──
{
  const dir = mkdtempSync(join(tmpdir(), 'sshhost-'))
  let threw = null
  try { installPublicKey('ssh-rsa AAAA fake', { sshDir: dir }) } catch (e) { threw = e }
  rec('非 ed25519 公钥被拒绝（抛错并点名 ssh-ed25519）',
    threw !== null && /ssh-ed25519/.test(threw?.message ?? ''), threw?.message)
}

// ── 6) buildConnectCommand：port 必须显式带上，避免默认 22 的歧义 ──
rec('连接命令拼接（user@host -p port）',
  buildConnectCommand('mac', 'cn-bos-1.natfrp.cloud', 12345) === 'ssh mac@cn-bos-1.natfrp.cloud -p 12345')

// ── 7) parseSshdProbeResult：只有 connect 算 sshd 在听，其余一律视为未就绪 ──
rec('connect → 在听', parseSshdProbeResult('connect') === true)
rec('timeout → 未就绪', parseSshdProbeResult('timeout') === false)
rec('ECONNREFUSED → 未就绪', parseSshdProbeResult('ECONNREFUSED') === false)
rec('ETIMEDOUT → 未就绪', parseSshdProbeResult('ETIMEDOUT') === false)

// ── 8) checkSshd 注入点（Task 9 Step 9.3(c)）：prober 注入直接决定结果；
//       真 TCP 探测路径按仓库「全部离线」约定不测 ──
{
  setSshdProberForTests(async () => true)
  rec('checkSshd 注入 prober=true → true（不发起 TCP）', await checkSshd() === true)
  setSshdProberForTests(async () => false)
  rec('checkSshd 注入 prober=false → false', await checkSshd() === false)
  setSshdProberForTests(null)
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 9 Part B：index.js SSH 路由（state / key / tunnel）+ frpc 多隧道
//
// 桩全部照抄既有套件的构造方式，不发明新体系：
//   · 宿主 ctx 桩 —— apply-test.mjs 的 webServer/credentials/timer/connection/effect；
//   · HTTP 驱动 —— tunnel-create-test.mjs 的「真插件 + 本地 server + fetch 拦官方 API」；
//   · frpc —— 仓库对 frpc.mjs 是 ESM 静态 import、没有注入点，沿用 tunnel-create-test
//     的「走真实路径」思路：config.frpcPath 指向假 frpc 脚本（-V 时报 sakura 版本，
//     通过 installer 判定；被 frpc.start 拉起时把 $NATFRP_TARGET 写进文件后常驻），
//     在 env 传播这条真实链路上观察 startAll 拼出的隧道列表（frpc.mjs 的
//     NATFRP_TARGET=tunnelIds.join(',')），比 spy start 参数更端到端。
//
// 全部离线：sshd 探测走 setSshdProberForTests 注入；官方 API 被 fetch 桩拦下；
// DSH_HOME / DSH_SSH_DIR 都指到 mkdtemp 临时目录，不碰真实 ~/.dsh 与 ~/.ssh。
// ═══════════════════════════════════════════════════════════════════════════
{
  // paths.mjs 在模块加载时读 DSH_HOME —— 必须在 import 插件之前设（apply-test.mjs 手法）
  const home = mkdtempSync(join(tmpdir(), 'dsh-ssh-host-route-'))
  process.env.DSH_HOME = home
  const statePath = join(home, 'dsh-ssh-host', 'state.json')
  const writeStateFile = (obj) => {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, JSON.stringify(obj, null, 2))
  }

  const { apply: applyPlugin } = await import('../index.js')

  // 假 DSH WebServer（apply-test.mjs 手法）：webServer.port 只被透传/拼接，不真转发
  const upstream = createServer((req, res) => { res.writeHead(200); res.end('dsh-ok') })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))

  const freePort = async () => {
    const s = createServer()
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const p = s.address().port
    await new Promise((r) => s.close(r))
    return p
  }

  // 官方 API 桩（tunnel-create-test.mjs 手法：只拦 api.natfrp.com，其余放行）
  const jsonRes = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
  const realFetch = globalThis.fetch
  const apiCalls = []
  let tunnelsList = []
  // 节点表桩：默认只给可创建的内地节点 2（原有断言依赖它);自动化用例可整体替换。
  let nodesMap = { 2: { name: '内地节点', host: 'cn.natfrp.cloud', description: '', vip: 0, flag: 0b0100 | 0b1000 } }
  let apiTunnelsDown = false
  let deleteReply = null // null = 默认 { deleted: ids, failed: [] }
  let tunnelCreatePayload = null
  let nextCreatedId = 333
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    if (u.hostname !== 'api.natfrp.com') return realFetch(input, init)
    const method = (init.method ?? 'GET').toUpperCase()
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body)).entries()) : null
    apiCalls.push({ method, path: u.pathname, body })
    if (u.pathname === '/v4/tunnels' && method === 'GET') {
      if (apiTunnelsDown) return jsonRes({ code: 500, msg: 'stub down' }, 500)
      return jsonRes(tunnelsList)
    }
    if (u.pathname === '/v4/nodes') {
      return jsonRes(nodesMap)
    }
    if (u.pathname === '/v4/tunnels' && method === 'POST') {
      tunnelCreatePayload = body
      const id = nextCreatedId++
      tunnelsList = [...tunnelsList, {
        id, name: body?.name ?? 'SSH', node: Number(body?.node), type: 'tcp',
        local_ip: '127.0.0.1', local_port: Number(body?.local_port), online: true, remote: 23456,
      }]
      return jsonRes({ id, name: body?.name ?? 'SSH', remote: 23456 })
    }
    if (u.pathname === '/v4/tunnel/delete' && method === 'POST') {
      const ids = String(body?.ids ?? '').split(',').map(Number)
      return jsonRes(deleteReply ?? { deleted: ids, failed: [] })
    }
    return jsonRes({ code: 404, msg: 'not mocked' }, 404)
  }

  // 假 frpc：被 -V 调用时报 sakura 版本（installer 判定通过）；
  // 被 frpc.start 拉起时把 $NATFRP_TARGET 写进文件后常驻（避免退避重启噪音）
  const fakeFrpc = () => {
    const targetFile = join(home, `natfrp-target-${Math.random().toString(36).slice(2)}.txt`)
    const path = join(home, `fake-frpc-${Math.random().toString(36).slice(2)}.sh`)
    writeFileSync(path, [
      '#!/bin/sh',
      'if [ "$1" = "-V" ]; then echo "0.51.0-sakura-15.1"; exit 0; fi',
      `printf '%s' "$NATFRP_TARGET" > '${targetFile}'`,
      'exec sleep 60',
      '',
    ].join('\n'), { mode: 0o755 })
    return { path, targetFile }
  }

  const waitFor = async (fn, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() > deadline) return null
      await new Promise((r) => setTimeout(r, 40))
    }
  }
  const readTarget = (f) => { try { return readFileSync(f, 'utf8') } catch { return null } }

  // 宿主 ctx 桩（apply-test.mjs 构造的照抄）+ 一次性 apply，跑完收 disposers
  const disposers = []
  const serve = async (box) => {
    const srv = createServer((req, res) => box.handler(req, res))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    return {
      base: `http://127.0.0.1:${srv.address().port}`,
      close: () => new Promise((r) => srv.close(r)),
    }
  }
  const getJSON = async (base, p) => {
    const r = await fetch(base + p)
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const postJSON = async (base, p, body) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }
  const withApply = async (stateObj, config, fn) => {
    writeStateFile(stateObj)
    const box = { handler: null }
    applyPlugin({
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, log: () => {} }),
      webServer: {
        port: upstream.address().port,
        register: ({ handler: h }) => { box.handler = h; return () => {} },
      },
      // 给一个假密钥，否则所有官方调用都会以 no-token 提前返回（tunnel-create-test 手法）
      credentials: { resolve: async () => 'FAKE-TOKEN', set: async () => {} },
      connection: { authenticatedUrl: (u) => `${u}/?token=abc` },
      timer: {},
      effect: (fn2) => { const d = fn2?.(); if (typeof d === 'function') disposers.push(d); return () => {} },
      inject: () => {},
      get: () => undefined,
    }, config)
    const out = await fn?.(box)
    for (const d of disposers.splice(0)) { try { await d() } catch { /* noop */ } }
    return out
  }

  // ── (a) NATFRP_TARGET 多隧道拼接：startAll 把 tunnelId + sshTunnelId 去重后一起交给 frpc ──
  {
    // 单隧道：只配 tunnelId → NATFRP_TARGET=111
    const GP1 = await freePort()
    const f1 = fakeFrpc()
    let target1 = null
    await withApply({ enabled: true, tunnelId: '111', gatePort: GP1 },
      { enabled: true, tunnelId: '111', gatePort: GP1, frpcPath: f1.path, autoAlign: false },
      async () => { target1 = await waitFor(() => readTarget(f1.targetFile)) })
    rec('(a) 只配 DSH 隧道 → NATFRP_TARGET=111', target1 === '111', `NATFRP_TARGET=${target1}`)

    // 多隧道：state.json 里已有 sshTunnelId → 重启 apply 后两条一起拼进 NATFRP_TARGET
    const GP2 = await freePort()
    const f2 = fakeFrpc()
    let target2 = null
    await withApply({ enabled: true, tunnelId: '111', sshTunnelId: '222', gatePort: GP2 },
      { enabled: true, tunnelId: '111', gatePort: GP2, frpcPath: f2.path, autoAlign: false },
      async () => { target2 = await waitFor(() => readTarget(f2.targetFile)) })
    rec('(a) tunnelId+sshTunnelId → NATFRP_TARGET=111,222（多隧道同一 frpc 进程）',
      target2 === '111,222', `NATFRP_TARGET=${target2}`)

    // 去重：sshTunnelId 与 tunnelId 相同时只保留一条
    const GP3 = await freePort()
    const f3 = fakeFrpc()
    let target3 = null
    await withApply({ enabled: true, tunnelId: '111', sshTunnelId: '111', gatePort: GP3 },
      { enabled: true, tunnelId: '111', gatePort: GP3, frpcPath: f3.path, autoAlign: false },
      async () => { target3 = await waitFor(() => readTarget(f3.targetFile)) })
    rec('(a) sshTunnelId 与 tunnelId 相同时去重（NATFRP_TARGET=111）',
      target3 === '111', `NATFRP_TARGET=${target3}`)

    // 全空：targetIds 为空数组才报 no-tunnel，frpc 不启动
    const GP4 = await freePort()
    const f4 = fakeFrpc()
    await withApply({ enabled: true, tunnelId: '', sshTunnelId: '', gatePort: GP4 },
      { enabled: true, tunnelId: '', gatePort: GP4, frpcPath: f4.path, autoAlign: false },
      async (box) => {
        const srv4 = await serve(box)
        await new Promise((r) => setTimeout(r, 600))
        const s4 = await getJSON(srv4.base, '/ssh-host/api/state')
        rec('(a) 两条隧道都为空 → frpc 不启动（空数组才报 no-tunnel）',
          !existsSync(f4.targetFile) && s4.body?.frpc?.running === false,
          `targetExists=${existsSync(f4.targetFile)} running=${s4.body?.frpc?.running}`)
        await srv4.close()
      })
  }

  // ── 路由级：一次 apply（enabled=false），DSH_SSH_DIR 注入到临时目录（不碰真实 ~/.ssh）──
  const sshDirTmp = mkdtempSync(join(tmpdir(), 'dsh-ssh-dir-'))
  const userLine = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDfakeuserkey user@laptop'
  writeFileSync(join(sshDirTmp, 'authorized_keys'), `${userLine}\n`, { mode: 0o600 })
  process.env.DSH_SSH_DIR = sshDirTmp

  await withApply({ enabled: false }, { gatePort: await freePort(), autoAlign: false }, async (box) => {
    tunnelsList = [{ id: 90001, name: 'DSH', node: 2, type: 'tcp', local_ip: '127.0.0.1', local_port: -1, online: true, remote: 41234 }]
    const srvB = await serve(box)
    const B = srvB.base

    // ── /ssh-host/api/ssh/state：平台 / sshd 探测 / 密钥摘要 / 用户名 ──
    setSshdProberForTests(async () => true)
    let stState = await getJSON(B, '/ssh-host/api/ssh/state')
    rec('/ssh/state → 200', stState.status === 200, `status=${stState.status}`)
    rec('/ssh/state.platform=当前平台', stState.body?.platform === process.platform, String(stState.body?.platform))
    // darwinMajor 给前端选「系统设置」深链用:Ventura(13, Darwin 22)起是新「系统设置」,
    // 旧 anchor com.apple.preferences.sharing 在新面板上无效;非 darwin 平台为 null。
    {
      const expectMajor = process.platform === 'darwin'
        ? Number(String(osRelease()).split('.')[0]) || null
        : null
      rec('/ssh/state.darwinMajor=内核主版本(darwin)/null(其它)',
        stState.body?.darwinMajor === expectMajor,
        `got=${JSON.stringify(stState.body?.darwinMajor)} expect=${JSON.stringify(expectMajor)}`)
    }
    rec('/ssh/state.sshdUp 跟随探测注入（true）', stState.body?.sshdUp === true, String(stState.body?.sshdUp))
    rec('/ssh/state 未生成密钥时 key=null', stState.body?.key === null, JSON.stringify(stState.body?.key))
    rec('/ssh/state.user 是当前登录名', stState.body?.user === osUserInfo().username, String(stState.body?.user))
    rec('/ssh/state 无隧道时 tunnel=null 且 connectCmd=null',
      stState.body?.tunnel === null && stState.body?.connectCmd === null)
    setSshdProberForTests(async () => false)
    stState = await getJSON(B, '/ssh-host/api/ssh/state')
    rec('/ssh/state.sshdUp 跟随探测注入（false）', stState.body?.sshdUp === false, String(stState.body?.sshdUp))
    setSshdProberForTests(null)
    const snap0 = await getJSON(B, '/ssh-host/api/state')
    rec('快照带轻量 sshTunnelId 字段', 'sshTunnelId' in (snap0.body ?? {}), String(snap0.body?.sshTunnelId))
    rec('快照不带 sshdUp（4s 轮询不做 TCP 探测）',
      !('sshdUp' in (snap0.body ?? {})) && !('sshSshdUp' in (snap0.body ?? {})))

    // ── hero 卡要的通道状态:/ssh/state 里带 channel（enabled / running / hasToken）──
    // 前端 hero 卡是 SSH 的唯一入口,必须能显示「通道开着但 frpc 没在跑」这类
    // 组合态,并据此决定按钮文案;这些字段都是内存/配置读取,不新增网络探测。
    {
      const chState = await getJSON(B, '/ssh-host/api/ssh/state')
      const ch = chState.body?.channel
      rec('/ssh/state.channel 带 enabled/running/hasToken 三态布尔',
        ch && typeof ch.enabled === 'boolean' && typeof ch.running === 'boolean'
        && typeof ch.hasToken === 'boolean', JSON.stringify(ch))
      rec('/ssh/state.channel.enabled 与快照 enabled 一致（同一个权威变量）',
        ch?.enabled === snap0.body?.enabled, `channel=${ch?.enabled} snap=${snap0.body?.enabled}`)
      rec('/ssh/state.channel.hasToken=true（本 box 凭据桩给了 FAKE-TOKEN）',
        ch?.hasToken === true, String(ch?.hasToken))
      rec('/ssh/state.channel.running=false（enabled=false 时 frpc 没被拉起）',
        ch?.running === false, String(ch?.running))
    }

    // ── (b) sshd 未监听 → 409 sshd-down ──
    setSshdProberForTests(async () => false)
    const down = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', { node: 7 })
    rec('(b) sshd 未监听 → 409 sshd-down', down.status === 409 && down.body?.error === 'sshd-down',
      `status=${down.status} body=${JSON.stringify(down.body)}`)
    rec('(b) 被拒时不打官方接口', !apiCalls.some((c) => c.path === '/v4/tunnels' && c.method === 'POST'))
    setSshdProberForTests(null)

    // ── (c) 创建成功：local_port 恒 22、type=tcp、落 state ──
    setSshdProberForTests(async () => true)
    const created1 = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', { node: 7 })
    rec('(c) 创建成功 → 200 且带回 id', created1.status === 200 && created1.body?.id === 333,
      `status=${created1.status} body=${JSON.stringify(created1.body)}`)
    rec('(c) 发给官方的 local_port 恒为 22（直连本机 sshd）', Number(tunnelCreatePayload?.local_port) === 22,
      String(tunnelCreatePayload?.local_port))
    rec('(c) 发给官方的 type=tcp / local_ip=127.0.0.1',
      tunnelCreatePayload?.type === 'tcp' && tunnelCreatePayload?.local_ip === '127.0.0.1',
      JSON.stringify(tunnelCreatePayload))
    rec('(c) 显式传的 node=7 生效', Number(tunnelCreatePayload?.node) === 7, String(tunnelCreatePayload?.node))
    const snapC = await getJSON(B, '/ssh-host/api/state')
    rec('(c) sshTunnelId 落 state.json（重启后仍生效）', String(snapC.body?.sshTunnelId) === '333',
      String(snapC.body?.sshTunnelId))
    const again = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', { node: 7 })
    rec('(c) 已有 SSH 隧道再建 → 409 already-created',
      again.status === 409 && again.body?.error === 'already-created',
      `status=${again.status} body=${JSON.stringify(again.body)}`)
    setSshdProberForTests(null)

    // 节点缺省回退 lastTunnelInfo.node：先把 DSH 隧道切到桩隧道 90001（node=2）
    const cfgSwitch = await postJSON(B, '/ssh-host/api/config', { tunnelId: '90001' })
    rec('切到桩隧道 90001 → 200（lastTunnelInfo 就位）', cfgSwitch.status === 200, `status=${cfgSwitch.status}`)

    // ── tunnel/remove：复用 2.4.0 tunnelDelete 语义（deleted 才算成功；failed 只是没踢下线）──
    deleteReply = { deleted: [333], failed: [333] }
    const removed = await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')
    rec('remove：deleted 命中即成功（failed 只是没踢下线）→ 200',
      removed.status === 200 && removed.body?.ok === true,
      `status=${removed.status} body=${JSON.stringify(removed.body)}`)
    rec('remove：打到官方 /tunnel/delete', apiCalls.some((c) => c.path === '/v4/tunnel/delete'))
    rec('remove 后本地 sshTunnelId 清空',
      String((await getJSON(B, '/ssh-host/api/state')).body?.sshTunnelId) === '')
    const removedAgain = await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')
    rec('remove：没有 SSH 隧道 → 400 no-tunnel',
      removedAgain.status === 400 && removedAgain.body?.error === 'no-tunnel',
      `status=${removedAgain.status}`)

    // ── 节点缺省回退：不传 node → 用 lastTunnelInfo.node（=2）──
    setSshdProberForTests(async () => true)
    const fallback = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', {})
    rec('不传 node → 回退 lastTunnelInfo.node=2',
      fallback.status === 200 && fallback.body?.id === 334 && Number(tunnelCreatePayload?.node) === 2,
      `status=${fallback.status} node=${tunnelCreatePayload?.node} id=${fallback.body?.id}`)
    setSshdProberForTests(null)

    // ── /ssh/state：隧道摘要与连接命令（sshTunnelId=334，桩隧道 node=2）──
    apiTunnelsDown = true
    const broken = await getJSON(B, '/ssh-host/api/ssh/state')
    rec('/ssh/state：隧道 API 失败 → 仍 200 且 tunnel=null（如实显示未连）',
      broken.status === 200 && broken.body?.tunnel === null, `status=${broken.status}`)
    apiTunnelsDown = false
    setSshdProberForTests(async () => true)
    const stFull = await getJSON(B, '/ssh-host/api/ssh/state')
    rec('/ssh/state：带出 SSH 隧道摘要（id/remote/online）',
      stFull.body?.tunnel?.id === 334 && stFull.body?.tunnel?.remote === 23456
        && stFull.body?.tunnel?.online === true, JSON.stringify(stFull.body?.tunnel))
    rec('/ssh/state：nodeHost 来自节点表', stFull.body?.tunnel?.nodeHost === 'cn.natfrp.cloud',
      String(stFull.body?.tunnel?.nodeHost))
    rec('/ssh/state：connectCmd 拼好（ssh user@host -p remote）',
      stFull.body?.connectCmd === `ssh ${osUserInfo().username}@cn.natfrp.cloud -p 23456`,
      String(stFull.body?.connectCmd))
    rec('/ssh/state：sshTunnelId 带回', String(stFull.body?.sshTunnelId) === '334',
      String(stFull.body?.sshTunnelId))
    setSshdProberForTests(null)

    // ── remove 失败路径：官方 deleted 里没有 → 502 且本地状态不动 ──
    deleteReply = { deleted: [], failed: [334] }
    const badRemove = await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')
    rec('remove：官方没删掉 → 502 delete-failed',
      badRemove.status === 502 && badRemove.body?.error === 'delete-failed',
      `status=${badRemove.status} body=${JSON.stringify(badRemove.body)}`)
    rec('remove 失败后本地 sshTunnelId 不动',
      String((await getJSON(B, '/ssh-host/api/state')).body?.sshTunnelId) === '334')
    deleteReply = null
    const removedOk = await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')
    rec('remove 重试成功 → 200 且清空', removedOk.status === 200
      && String((await getJSON(B, '/ssh-host/api/state')).body?.sshTunnelId) === '')

    // ── 自动化：节点三级回退(前端自动建隧道不传 node,这三档是零操作的前提)──
    {
      // 档 2:lastTunnelInfo 失效(config 切到不存在隧道),tunnelsList 首条 node=5
      const cfgOff = await postJSON(B, '/ssh-host/api/config', { tunnelId: 'nope' })
      rec('自动化前置：切到不存在隧道 → 200', cfgOff.status === 200, `status=${cfgOff.status}`)
      tunnelsList = [{ id: 90001, name: 'DSH', node: 5, type: 'tcp', local_ip: '127.0.0.1', local_port: -1, online: true, remote: 41234 }]
      setSshdProberForTests(async () => true)
      const autoNode = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', {})
      rec('自动化:无 lastTunnelInfo → 官方隧道列表首条 node=5',
        autoNode.status === 200 && Number(tunnelCreatePayload?.node) === 5,
        `status=${autoNode.status} node=${tunnelCreatePayload?.node}`)
      await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')

      // 档 3:隧道列表也空 → 可建节点排序第一(桩 nodesMap 的 2)
      tunnelsList = []
      const autoNode2 = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', {})
      rec('自动化:无隧道可参照 → 可建节点排序第一 node=2',
        autoNode2.status === 200 && Number(tunnelCreatePayload?.node) === 2,
        `status=${autoNode2.status} node=${tunnelCreatePayload?.node}`)
      await postJSON(B, '/ssh-host/api/ssh/tunnel/remove')

      // 三级全空 → 400 no-node
      tunnelsList = []
      const savedNodes = nodesMap
      nodesMap = {}
      const autoNode3 = await postJSON(B, '/ssh-host/api/ssh/tunnel/create', {})
      rec('自动化:三级全空 → 400 no-node',
        autoNode3.status === 400 && autoNode3.body?.error === 'no-node',
        `status=${autoNode3.status} body=${JSON.stringify(autoNode3.body)}`)
      nodesMap = savedNodes
      setSshdProberForTests(null)
      tunnelsList = [{ id: 90001, name: 'DSH', node: 2, type: 'tcp', local_ip: '127.0.0.1', local_port: -1, online: true, remote: 41234 }]
    }

    // ── (d) 私钥路由：未生成 404 → 生成 → 返回 OpenSSH authkey PEM；重新生成 → upsert replaced ──
    // 格式选择来自真机反馈:Termius 导入 PKCS8 报 "Unsupported key type: PRIVATE KEY"。
    const noKey = await getJSON(B, '/ssh-host/api/ssh/key/private')
    rec('(d) 未生成密钥时 /key/private → 404 no-key',
      noKey.status === 404 && noKey.body?.error === 'no-key',
      `status=${noKey.status} body=${JSON.stringify(noKey.body)}`)
    const mk1 = await postJSON(B, '/ssh-host/api/ssh/key/create')
    rec('(d) key/create → 200 且 action=created', mk1.status === 200 && mk1.body?.action === 'created',
      `status=${mk1.status} action=${mk1.body?.action}`)
    rec('(d) 响应带 SHA256 指纹与 authorized_keys 落盘路径',
      /^SHA256:/.test(String(mk1.body?.fingerprint)) && String(mk1.body?.file).endsWith('authorized_keys'),
      JSON.stringify({ fp: mk1.body?.fingerprint, file: mk1.body?.file }))
    const priv1 = await getJSON(B, '/ssh-host/api/ssh/key/private')
    rec('(d) 生成后 /key/private → 200 且是 OpenSSH authkey PEM（Termius 可导入）',
      priv1.status === 200 && String(priv1.body?.privateKey).includes('BEGIN OPENSSH PRIVATE KEY'),
      `status=${priv1.status} head=${String(priv1.body?.privateKey).split('\n')[0]}`)
    rec('(d) /key/private 不再是 PKCS8（旧格式被真机否掉）',
      !String(priv1.body?.privateKey).includes('BEGIN PRIVATE KEY'))
    rec('(d) /key/private 带公钥行与指纹',
      String(priv1.body?.publicKey).startsWith('ssh-ed25519 ') && /^SHA256:/.test(String(priv1.body?.fingerprint)))
    rec('(d) 指纹与公钥一致（同一把密钥算出来的）', priv1.body?.fingerprint === mk1.body?.fingerprint)
    const mk2 = await postJSON(B, '/ssh-host/api/ssh/key/create')
    rec('(d) 再次 key/create → action=replaced（重新生成密钥场景）',
      mk2.status === 200 && mk2.body?.action === 'replaced', `action=${mk2.body?.action}`)
    const priv2 = await getJSON(B, '/ssh-host/api/ssh/key/private')
    rec('(d) 重新生成后私钥已换（新 PEM 覆盖旧文件）', priv2.body?.privateKey !== priv1.body?.privateKey)
    rec('(d) 重新生成后指纹已换', priv2.body?.fingerprint !== mk1.body?.fingerprint)

    // ── (e) 落盘：DATA_DIR 私钥/公钥 0600；authorized_keys 落在 DSH_SSH_DIR 注入目录 ──
    const keyFile = join(home, 'dsh-ssh-host', 'ssh-host-key')
    const pubFile = join(home, 'dsh-ssh-host', 'ssh-host-key.pub')
    rec('(e) 私钥落 DATA_DIR/ssh-host-key 且 0600',
      existsSync(keyFile) && (statSync(keyFile).mode & 0o777) === 0o600,
      `mode=${existsSync(keyFile) ? (statSync(keyFile).mode & 0o777).toString(8) : 'missing'}`)
    rec('(e) 公钥落 DATA_DIR/ssh-host-key.pub 且 0600',
      existsSync(pubFile) && (statSync(pubFile).mode & 0o777) === 0o600,
      `mode=${existsSync(pubFile) ? (statSync(pubFile).mode & 0o777).toString(8) : 'missing'}`)
    rec('(e) 私钥文件内容与 /key/private 一致（重启后 hostKey 从盘上恢复）',
      readFileSync(keyFile, 'utf8').trim() === String(priv2.body?.privateKey).trim())
    const akPath = join(sshDirTmp, 'authorized_keys')
    rec('(e) authorized_keys 落在 DSH_SSH_DIR 注入目录（不碰真实 ~/.ssh）', existsSync(akPath), akPath)
    const akText = readFileSync(akPath, 'utf8')
    rec('(e) authorized_keys 权限 0600', (statSync(akPath).mode & 0o777) === 0o600,
      `mode=${(statSync(akPath).mode & 0o777).toString(8)}`)
    rec('(e) 用户已有条目原样保留', akText.includes(userLine))
    rec('(e) 标记行恰好一条', markerLines(akText) === 1, `count=${markerLines(akText)}`)
    rec('(e) 标记行是最新公钥（旧公钥已被 upsert 替换）',
      akText.includes(String(priv2.body?.publicKey).split(/\s+/)[1])
        && !akText.includes(String(priv1.body?.publicKey).split(/\s+/)[1]))

    await srvB.close()
  })

  // ── 自动化 2：建完 SSH 隧道自动拉起通道（用户不该再点一次「开启」）──
  // 另开一台 box：这里要观察 frpc 真被 startAll 拉起，必须挂假 frpc 脚本与本机端口
  // （上面那台是 enabled:false 且没配 frpcPath，起不来）。
  {
    const f = fakeFrpc()
    const GP9 = await freePort()
    setSshdProberForTests(async () => true)
    await withApply(
      { enabled: false, tunnelId: '90001', gatePort: GP9 },
      { enabled: false, tunnelId: '90001', gatePort: GP9, frpcPath: f.path, autoAlign: false },
      async (box) => {
        const srvA2 = await serve(box)
        const created = await postJSON(srvA2.base, '/ssh-host/api/ssh/tunnel/create', {})
        rec('自动化2：建隧道 → 200（enabled 原本为 false）',
          created.status === 200 && created.body?.id, `status=${created.status}`)
        const wantTarget = `90001,${created.body?.id}`
        const got = await waitFor(() => {
          const t = readTarget(f.targetFile)
          return t === wantTarget ? t : null
        })
        rec('自动化2：建完自动拉起 frpc，NATFRP_TARGET 含两条隧道',
          got === wantTarget, `target=${got ?? readTarget(f.targetFile)}`)
        const st = await getJSON(srvA2.base, '/ssh-host/api/state')
        rec('自动化2：state.enabled 自动置 true',
          st.body?.enabled === true, `enabled=${st.body?.enabled}`)
        const stateOnDisk = JSON.parse(readFileSync(join(home, 'dsh-ssh-host', 'state.json'), 'utf8'))
        rec('自动化2：state.json 里 enabled=true（重启后仍是开的）',
          stateOnDisk.enabled === true, JSON.stringify(stateOnDisk.enabled))
        await srvA2.close()
      })
    setSshdProberForTests(null)
  }

  // ── (f) 旧盘上 PKCS8 私钥的自愈：真机反馈 Termius 拒收 PKCS8，
  //          已生成过密钥的用户盘上就是 PKCS8，重新加载必须原地换封装，
  //          且公钥/authorized_keys 都不许动（换公钥等于让用户重连一次）。
  {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const spki = publicKey.export({ type: 'spki', format: 'der' })
    const pubLine = buildOpenSshPublicKey(spki.subarray(spki.length - 32))
    const keyFile = join(home, 'dsh-ssh-host', 'ssh-host-key')
    const pubFile = keyFile + '.pub'
    const akPath = join(sshDirTmp, 'authorized_keys')
    writeFileSync(keyFile, pkcs8, { mode: 0o600 })
    writeFileSync(pubFile, pubLine, { mode: 0o600 })
    // authorized_keys 里放这条公钥 + 用户自己的条目
    writeFileSync(akPath, `${userLine}\n${pubLine}\n`, { mode: 0o600 })
    const akBefore = readFileSync(akPath, 'utf8')

    await withApply({ enabled: false }, { gatePort: await freePort(), autoAlign: false }, async (box) => {
      const srvF = await serve(box)
      const priv = await getJSON(srvF.base, '/ssh-host/api/ssh/key/private')
      rec('(f) 旧 PKCS8 私钥在加载后换封装为 OpenSSH authkey',
        priv.status === 200 && String(priv.body?.privateKey).includes('BEGIN OPENSSH PRIVATE KEY'),
        `status=${priv.status} head=${String(priv.body?.privateKey).split('\n')[0]}`)
      rec('(f) 换封装不动公钥（authorized_keys 无需重写，用户不必重连）',
        String(priv.body?.publicKey).trim() === pubLine,
        `${String(priv.body?.publicKey).slice(0, 30)}… vs ${pubLine.slice(0, 30)}…`)
      rec('(f) 盘上私钥文件已被就地改写为 authkey',
        readFileSync(keyFile, 'utf8').includes('BEGIN OPENSSH PRIVATE KEY'))
      rec('(f) authorized_keys 一个字节都没动', readFileSync(akPath, 'utf8') === akBefore)
      rec('(f) 指纹与公钥行自洽', priv.body?.fingerprint === fingerprintOf(pubLine),
        String(priv.body?.fingerprint))
      await srvF.close()
    })

    // 自愈后再加载一次必须稳态：不重复改写、不改公钥、不报错
    await withApply({ enabled: false }, { gatePort: await freePort(), autoAlign: false }, async (box) => {
      const srvG = await serve(box)
      const again = await getJSON(srvG.base, '/ssh-host/api/ssh/key/private')
      rec('(f) 二次加载幂等（仍是同一把密钥，authorized_keys 未动）',
        again.body?.publicKey === pubLine && readFileSync(akPath, 'utf8') === akBefore,
        `fp=${String(again.body?.fingerprint)}`)
      await srvG.close()
    })
  }

  // ── 清场：关测试服务器、恢复 fetch、清 env（disposers 已在 withApply 里跑完，
  //          假 frpc 常驻进程随之被杀）──
  setSshdProberForTests(null)
  globalThis.fetch = realFetch
  delete process.env.DSH_SSH_DIR
}

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
