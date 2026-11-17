// ssh-front-test.mjs —— 「对接 DSH Go」模式的 SSH 前端（ssh-front.mjs）。
//
// 全部离线：只在本机 loopback 起 ssh2 服务端 + 客户端，不连公网、不碰系统 sshd。
// 覆盖：
//   · 纯函数：公钥行解析 / 公钥逐字节比对 / 启动行格式（DSH Go 的 grep 能抓到）/
//     `dsh desktop` 判定 / 垫片脚本内容；
//   · 服务端：错误密钥被拒、正确密钥可 exec、`dsh desktop` 经 PATH 垫片打印启动行
//     且保活、交互 shell 明确拒绝、direct-tcpip 只放行 DSH 端口。

import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { generateHostKey } from '../ssh.mjs'
import {
  parseEd25519PublicKeyLine, rawEd25519FromKeyData, sameEd25519Key,
  buildAttachLine, wantsDesktop, buildShimScript, withShimPath, rewriteAttachRequest, startSshFront,
  loadOrCreateFrontHostKey,
} from '../ssh-front.mjs'

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
// 与 density-test 同款：跳过也计入总数（results 里记 true），保证跨平台总数稳定 ——
// test-all.mjs 只认 `N/N passed`，README 的数字也按总数核对。
const skip = (n, why) => { results.push(true); console.log(`SKIP  ${n} — ${why}`) }

// ── 1) 纯函数 ──
{
  const kp = generateHostKey()
  const raw = parseEd25519PublicKeyLine(kp.publicKey)
  rec('parseEd25519PublicKeyLine：解析出 32 字节原始公钥', raw?.length === 32, `len=${raw?.length}`)
  rec('parseEd25519PublicKeyLine：非 ed25519 行返回 null',
    parseEd25519PublicKeyLine('ssh-rsa AAAAB3NzaC1yc2E x') === null
    && parseEd25519PublicKeyLine('') === null
    && parseEd25519PublicKeyLine('ssh-ed25519') === null)
  rec('parseEd25519PublicKeyLine：截断的 blob 返回 null',
    parseEd25519PublicKeyLine('ssh-ed25519 AAAA') === null)

  rec('rawEd25519FromKeyData：32 字节原样、51 字节带前缀都能还原',
    rawEd25519FromKeyData(raw)?.equals(raw) === true
    && rawEd25519FromKeyData(Buffer.concat([
      Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw,
    ]))?.equals(raw) === true
    && rawEd25519FromKeyData(Buffer.alloc(7)) === null)

  const other = generateHostKey()
  rec('sameEd25519Key：同一把为 true、不同的一把为 false',
    sameEd25519Key({ data: raw }, raw) === true
    && sameEd25519Key({ data: raw }, parseEd25519PublicKeyLine(other.publicKey)) === false)

  const line = buildAttachLine({ port: 58920, token: 'abc123' })
  rec('buildAttachLine：形如 `dsh web: http://127.0.0.1:<port>/?token=<t>`',
    line === 'dsh web: http://127.0.0.1:58920/?token=abc123', line)
  // DSH Go 抓行规则（dsh-go remote_bootstrap.dart: `grep -E 'https?://[^ ]*[?&]token='`）
  rec('buildAttachLine：能被 DSH Go 的 grep 规则抓到',
    /https?:\/\/[^ ]*[?&]token=/.test(line))
  rec('buildAttachLine：token 做 URL 编码（特殊字符不破坏查询串）',
    buildAttachLine({ port: 1, token: 'a b&c' }) === 'dsh web: http://127.0.0.1:1/?token=a%20b%26c')

  rec('wantsDesktop：认出 dsh desktop / --profile desktop（含嵌在脚本里的形态）',
    wantsDesktop('dsh desktop --host 127.0.0.1 --port 0 --no-open')
    && wantsDesktop("sh -lc 'dsh desktop --host 127.0.0.1 --port 0 --no-open'")
    && wantsDesktop("sh -lc 'nohup dsh desktop --host 127.0.0.1 --port 0 --no-open'")
    && wantsDesktop('dsh --profile desktop --host 127.0.0.1'))
  rec('wantsDesktop：不误判 dsh web / dsh-desktop / xdsh desktop',
    !wantsDesktop('dsh web --port 0')
    && !wantsDesktop('dsh-desktop')
    && !wantsDesktop('xdsh desktop'))

  // 真机回归（2026-11-17）：DSH Go 用 `sh -lc` 跑启动脚本，login shell 会读 /etc/profile
  // 把进程环境里的 PATH 整个重建，只在 spawn env 里 prepend 无效 —— `dsh desktop` 于是
  // 落到真 dsh，报 `profile "desktop" is managed exclusively by the Electron application`。
  // 修复：把 export PATH 塞进 `-c` 的脚本体（profile 之后执行）。
  const wrapped = withShimPath("sh -lc 'dsh desktop --host 127.0.0.1 --port 0 --no-open'", '/shim/dir')
  rec('withShimPath：PATH 导出写进 `sh -lc` 的脚本体（profile 之后才生效）',
    /^sh -lc 'PATH="\/shim\/dir:\$PATH"; export PATH; dsh desktop/.test(wrapped), wrapped)
  rec('withShimPath：非 `sh -lc` 形态前置导出，且带引号的目录被转义（不破坏 DSH Go 的引号）',
    withShimPath('dsh desktop --host 127.0.0.1', '/shim/dir')
      === 'PATH="/shim/dir:$PATH"; export PATH; dsh desktop --host 127.0.0.1'
    && withShimPath("sh -lc 'x'", '/it"s').includes('PATH="/it\\"s:$PATH"'))

  // 真机回归（2026-11-17，第二次）：DSH Go 报 `login redirect carried no dsh-auth cookie`。
  // dsh-auth 只能由桌面版自己签 -> 外壳不能替它回重定向，只能把票换成真 token 后原样转发。
  {
    const opt = { ticket: 'TICKET', launchToken: 'REAL' }
    const hit = rewriteAttachRequest({ url: '/?token=TICKET' }, opt)
    rec('外壳判定：票据对 → 换成真 launch token 后放行（让桌面版的 303 流回去）',
      hit.action === 'proxy' && hit.url === '/?token=REAL', JSON.stringify(hit))
    rec('外壳判定：票据错 → 拒绝（不渲染登录页，那不是 dsh web 的形态）',
      rewriteAttachRequest({ url: '/?token=nope' }, opt).action === 'deny'
      && rewriteAttachRequest({ url: '/?token=nope' }, opt).reason === 'bad-ticket')
    rec('外壳判定：已带 dsh-auth 会话 cookie 的后续请求直接转发',
      rewriteAttachRequest({ url: '/api/x', cookie: 'a=1; dsh-auth-ABC=1' }, opt).action === 'proxy')
    rec('外壳判定：既没票也没会话 → 拒绝',
      rewriteAttachRequest({ url: '/', cookie: 'mine=1' }, opt).action === 'deny')
  }

  // 真机反馈（2026-11-17）：「主机指纹经常重置」。旧实现每次 start 都现生成 host key，
  // 客户端把 host key 当身份做信任固定，指纹一变就要重新确认。这里钉住「持久化后不变」。
  {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-front-hk-'))
    const file = join(dir, 'ssh-front-host-key')
    const first = loadOrCreateFrontHostKey(file)
    const second = loadOrCreateFrontHostKey(file)
    rec('host key 持久化：两次加载同一文件得到同一把（指纹不再变）',
      first === second && first.includes('OPENSSH PRIVATE KEY'))
    rec('host key 持久化：落盘 0600（只有本用户可读）',
      (statSync(file).mode & 0o777) === 0o600, `mode=${(statSync(file).mode & 0o777).toString(8)}`)
    rec('host key 持久化：文件被写坏时重新生成而不是崩',
      (writeFileSync(file, 'garbage', { mode: 0o600 }), loadOrCreateFrontHostKey(file).includes('OPENSSH PRIVATE KEY')))
    rec('host key 持久化：不同安装目录是不同的身份（不会跨机共用）',
      loadOrCreateFrontHostKey(join(dir, 'other')) !== readFileSync(file, 'utf8'))
  }

  const shim = buildShimScript('/usr/local/bin/dsh')
  rec('buildShimScript：命中 desktop 时打印启动行后退出（不保活，避免拿旧端口重连），其余原样 exec 真 dsh',
    shim.includes('desktop) attach=1') && shim.includes('printf \'%s\\n\' "$DSH_ATTACH_LINE"')
    && shim.includes('exit 0') && !shim.includes('sleep 86400')
    && shim.includes("exec '/usr/local/bin/dsh' \"$@\""))
}

// ── 2) 服务端行为（本机 loopback，真 ssh2 握手）──
if (process.platform === 'win32') {
  // 前端明确只支持 POSIX（exec 走 `sh -c`，插件 SSH 主机能力本身也只支持 macOS）。
  // 这 8 条按平台跳过，但计入总数。
  for (const name of [
    'ssh-front：非插件密钥被拒（认证失败）',
    'ssh-front：插件这把密钥可以连上',
    'ssh-front：普通 exec 原样执行（echo 透传）',
    'ssh-front：`dsh desktop` 经垫片打印启动行（DSH Go 能抓到的形态）',
    'ssh-front：收到 desktop 启动请求时回调 onAttach（红绿灯依据）',
    'ssh-front：交互 shell 明确拒绝并指路到 SSH 隧道',
    'ssh-front：direct-tcpip 放行到 DSH 端口（DSH Go 靠它访问 127.0.0.1:<port>）',
    'ssh-front：direct-tcpip 拒绝其它端口（前端不是跳板机）',
  ]) skip(name, 'Windows 无 /bin/sh，SSH 前端仅支持 macOS/Linux')
} else {
{
  // 登录 shell 会 source 用户的 profile（本机有 rvm/brew，慢且会真跑 ps）。这里把 HOME 指到
  // 临时目录：/etc/profile 的 path_helper 照样会重建 PATH（正是我们要复现的机制），但不加载
  // 用户的私有初始化，套件从 3 分钟降到秒级。
  const realHome = process.env.HOME
  process.env.HOME = mkdtempSync(join(tmpdir(), 'dsh-ssh-front-home-'))
  try {
  const ssh2 = await import('ssh2')
  const Client = ssh2.Client ?? ssh2.default?.Client
  const kp = generateHostKey()
  const otherKp = generateHostKey()
  const shimDir = mkdtempSync(join(tmpdir(), 'dsh-ssh-front-shim-'))
  writeFileSync(join(shimDir, 'dsh'), buildShimScript('/bin/echo'), { mode: 0o755 })
  chmodSync(join(shimDir, 'dsh'), 0o755)

  // DSH 端口（direct-tcpip 放行目标）与「别的端口」（必须被拒）
  const echoSrv = createServer((s) => s.pipe(s))
  await new Promise((r) => echoSrv.listen(0, '127.0.0.1', r))
  const dshPort = echoSrv.address().port
  const otherSrv = createServer((s) => s.pipe(s))
  await new Promise((r) => otherSrv.listen(0, '127.0.0.1', r))
  const otherPort = otherSrv.address().port

  const attachLine = buildAttachLine({ port: dshPort, token: 'TK-test' })
  const attachHits = []
  const front = await startSshFront({
    publicKeyLine: kp.publicKey,
    attachLine,
    shimDir,
    desktopPort: dshPort,
    onAttach: (i) => attachHits.push(i),
  })

  const connect = (privateKey) => new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => resolve(c))
    c.on('error', reject)
    c.connect({ host: '127.0.0.1', port: front.port, username: 'mac', privateKey, readyTimeout: 5000 })
  })

  // 2a) 错误密钥：握手必须失败（拒绝认证），不能靠"连上了就算通"
  let rejected = false
  await connect(otherKp.privateKey).then(
    (c) => { c.end(); rejected = false },
    () => { rejected = true },
  )
  rec('ssh-front：非插件密钥被拒（认证失败）', rejected === true)

  const client = await connect(kp.privateKey)
  rec('ssh-front：插件这把密钥可以连上', true === true)

  // 2b) 普通 exec：原样执行，输出透传
  const execOut = await new Promise((resolve) => {
    client.exec('echo hi-from-front', (err, stream) => {
      if (err) return resolve(`ERR ${err.message}`)
      let out = ''
      stream.on('data', (d) => { out += d })
      stream.on('close', () => resolve(out))
      stream.stderr.on('data', (d) => { out += d })
    })
  })
  rec('ssh-front：普通 exec 原样执行（echo 透传）', execOut.includes('hi-from-front'), JSON.stringify(execOut))

  // 2c) DSH Go 的托管启动脚本形态：`dsh desktop …` 落到 PATH 垫片 → 打印启动行
  const attachOut = await new Promise((resolve) => {
    client.exec("sh -lc 'dsh desktop --host 127.0.0.1 --port 0 --no-open'", (err, stream) => {
      if (err) return resolve(`ERR ${err.message}`)
      let out = ''
      stream.on('data', (d) => { out += d; if (out.includes('token=')) { stream.close(); resolve(out) } })
      stream.stderr.on('data', (d) => { out += d })
      stream.on('close', () => resolve(out))
      setTimeout(() => { stream.close(); resolve(out) }, 3000)
    })
  })
  rec('ssh-front：登录 shell 包一层的 `dsh desktop`（DSH Go 的真实形态）经垫片打印启动行',
    attachOut.includes('dsh web: http://127.0.0.1:') && attachOut.includes('token=TK-test'),
    JSON.stringify(attachOut))
  rec('ssh-front：收到 desktop 启动请求时回调 onAttach（红绿灯依据）',
    attachHits.length === 1, `hits=${attachHits.length}`)

  // 2d) 交互 shell：明确拒绝并指路，不是静默失败
  const shellOut = await new Promise((resolve) => {
    client.shell((err, stream) => {
      if (err) return resolve(`ERR ${err.message}`)
      let out = ''
      stream.on('data', (d) => { out += d })
      stream.on('close', () => resolve(out))
      setTimeout(() => resolve(out), 2000)
    })
  })
  rec('ssh-front：交互 shell 明确拒绝并指路到 SSH 隧道', /对接 DSH Go/.test(shellOut) && /192|22|隧道/.test(shellOut), JSON.stringify(shellOut))

  // 2e) direct-tcpip：DSH 端口放行，别的端口拒绝
  const forward = (dstPort) => new Promise((resolve) => {
    client.forwardOut('127.0.0.1', 1234, '127.0.0.1', dstPort, (err, stream) => {
      if (err) return resolve(false)
      let out = ''
      stream.on('data', (d) => { out += d })
      stream.on('close', () => resolve(out.length > 0))
      stream.write('ping')
      setTimeout(() => { try { stream.close() } catch { /* noop */ } resolve(out.length > 0) }, 1500)
    })
  })
  rec('ssh-front：direct-tcpip 放行到 DSH 端口（DSH Go 靠它访问 127.0.0.1:<port>）',
    (await forward(dshPort)) === true)
  rec('ssh-front：direct-tcpip 拒绝其它端口（前端不是跳板机）',
    (await forward(otherPort)) === false)

  client.end()
  await front.close()
  await new Promise((r) => echoSrv.close(r))
  await new Promise((r) => otherSrv.close(r))
  } finally {
    process.env.HOME = realHome
  }
}
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
// 前端连接与 ssh2 句柄可能留住事件循环，显式收尾 —— 否则套件打印完
// 「21/21 passed」后进程不退出，test-all.mjs 只会等到超时。
process.exit(passed === results.length ? 0 : 1)
