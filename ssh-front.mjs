// ssh-front.mjs —— 「对接 DSH Go」模式下的 SSH 前端。
//
// 为什么需要它：插件不在系统 sshd 的明文路径上（SSH 隧道 local_port=22 直连 sshd），
// 所以 `dsh desktop` 这个命令根本到不了插件手里。这一模式下插件自己当 SSH 服务端，
// 把隧道的 local_port 指过来，才能拿到 exec 请求；关掉模式时前端根本不启动，
// 隧道回到 22 —— 那时就是纯粹的 SSH 主机，系统 sshd 原样服务 Termius。
//
// 边界（必须与文案一致）：
//   · 认证只用插件自己生成的那把 ed25519 公钥（~/.dsh/dsh-ssh-host/ssh-host-key.pub），
//     不引入第二套凭据；私钥在用户手机里，插件只持有公钥；
//   · exec 通过 `sh -c <命令>` 执行，PATH 前置一个垫片目录，里面的 `dsh` 只拦
//     `desktop` 子命令、其余原样 exec 真 dsh —— 垫片只作用于本前端起的会话，
//     不写用户任何 shell profile；
//   · 桌面版的 launch token 经环境变量 `DSH_ATTACH_LINE` 传给垫片，**不落盘**；
//   · 交互 shell 不在这条线上提供（它是给 DSH Go 的）：收到 shell/pty 请求时明确
//     回一句「请用 SSH 隧道」，而不是静默失败；
//   · direct-tcpip 只放行到本机回环的 DSH 端口（DSH Go 靠它把 127.0.0.1:<port>
//     转发到自己那边），其余目标一律拒绝 —— 前端不是跳板机。

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { dirname } from 'node:path'
import { generateHostKey } from './ssh.mjs'

/** DSH Go 用它抓启动行：`grep -E 'https?://[^ ]*[?&]token='`（见 dsh-go remote_bootstrap）。 */
export const ATTACH_LINE_PREFIX = 'dsh web: '

/** 把 `ssh-ed25519 AAAA… comment` 解析成原始 32 字节公钥；格式不对返回 null。 */
export function parseEd25519PublicKeyLine(line) {
  const parts = String(line ?? '').trim().split(/\s+/)
  if (parts.length < 2 || parts[0] !== 'ssh-ed25519') return null
  let blob
  try {
    blob = Buffer.from(parts[1], 'base64')
  } catch {
    return null
  }
  // wire 布局：[4B len]["ssh-ed25519"][4B len][32B raw]
  if (blob.length !== 4 + 11 + 4 + 32) return null
  if (blob.readUInt32BE(0) !== 11) return null
  if (blob.subarray(4, 15).toString() !== 'ssh-ed25519') return null
  if (blob.readUInt32BE(15) !== 32) return null
  return Buffer.from(blob.subarray(19, 51))
}

/** ssh2 的 `ctx.key.data` 可能带也可能不带 `[len]"ssh-ed25519"[len]` 前缀，两种都认。 */
export function rawEd25519FromKeyData(data) {
  const b = Buffer.from(data ?? [])
  if (b.length === 32) return b
  if (b.length === 51 && b.readUInt32BE(0) === 11 && b.subarray(4, 15).toString() === 'ssh-ed25519'
    && b.readUInt32BE(15) === 32) {
    return Buffer.from(b.subarray(19, 51))
  }
  return null
}

/** 客户端出示的公钥是否就是插件那把（逐字节比 32 字节原始公钥，不比 base64 文本）。 */
export function sameEd25519Key(keyData, rawPublicKey) {
  const raw = rawEd25519FromKeyData(keyData?.data ?? keyData)
  if (!raw || !rawPublicKey || rawPublicKey.length !== 32) return false
  return raw.equals(rawPublicKey)
}

/** DSH Go 抓的那一行。格式与 `dsh web` 自己打印的一致，客户端只认这行。 */
export function buildAttachLine({ port, token }) {
  return `${ATTACH_LINE_PREFIX}http://127.0.0.1:${String(port)}/?token=${encodeURIComponent(String(token ?? ''))}`
}

/**
 * 这条 exec 命令是不是要启动桌面版。
 *
 * DSH Go 的托管模式会把启动命令包进它自己的探测/启动脚本（`sh -lc '… dsh desktop …'`），
 * 所以这里判的是「命令里是否出现 dsh desktop」，不是「命令等于 dsh desktop」。
 * 真正拦下它的仍是 PATH 垫片 —— 我们只决定要不要把垫片挂上去。
 */
export function wantsDesktop(command) {
  const s = String(command ?? '')
  // 前一个字符只要是「非标识符字符」就算：真机上 DSH Go 的脚本是 `sh -lc 'dsh desktop …'`，
  // `dsh` 前面紧跟的是单引号 —— 字符类里漏掉引号就会静默漏判（2026-11-17 真机就是这么漏的）。
  // 这里判宽一点无害：真正的拦截仍由垫片自己做，这里只决定是否注入启动行与点灯。
  return /(?:^|[^\w-])dsh\s+(?:--profile\s+)?desktop(?:\s|$)/.test(s)
}

/**
 * 把垫片目录塞进命令的 PATH —— 必须塞在 **登录 shell 的 `-c` 脚本体里面**。
 *
 * 真机反馈（2026-11-17）：DSH Go 用 `sh -lc '<脚本>'` 执行启动脚本，而 login shell 会读
 * /etc/profile → path_helper，把我们注入进程环境的 PATH **整个重建**（实测传入的自定义
 * 前缀被丢掉，见 `PATH=/tmp/x:$PATH /bin/sh -lc 'echo $PATH'`）。所以只在 spawn 的 env 里
 * prepend 是无效的，`dsh` 仍然解析到 /usr/local/bin/dsh，报
 * `profile "desktop" is managed exclusively by the Electron application`。
 *
 * 正确做法：把 `export PATH` 塞进 `-c` 的脚本体，它在 profile 之后才执行，于是脚本里的
 * `dsh` 才落到垫片上。前缀只用双引号，避免与 DSH Go 的单引号转义打架。
 */
export function withShimPath(command, shimDir) {
  const s = String(command ?? '')
  const prefix = `PATH="${String(shimDir).replace(/"/g, '\\"')}:$PATH"; export PATH;`
  // `sh -lc '<脚本>'`：在开引号之后插入前缀（脚本体在 profile 之后执行）
  const wrapped = /^sh\s+-lc\s+'([\s\S]*)'\s*$/.exec(s)
  if (wrapped) return `sh -lc '${prefix} ${wrapped[1]}'`
  // 其它形态（直接给命令，或不是 sh -lc）：前置到命令本身
  return `${prefix} ${s}`
}

/**
 * 「dsh web 外壳」的请求判定（纯函数，路由与测试共用）。
 *
 * 为什么不能自己做密码门：真机报 `DshProtocolException: login redirect carried no dsh-auth
 * cookie`。DSH Go 的握手是「拿 `/?token=<票>` 换 303 + `set-cookie: dsh-auth-…`」，而这个
 * cookie **只能由桌面版自己签**。我们若替它回 302/303（网关那套密码门就是如此），客户端拿不到
 * dsh-auth 就会直接判定握手失败。
 *
 * 所以外壳只做两件事：
 *   1. 票据正确 → 把 URL 里的 `token` 换成**真 launch token**，原样转给桌面版，让 303 与
 *      set-cookie 原样流回手机；
 *   2. 已经带着 `dsh-auth-*` 会话 cookie 的后续请求 → 直接转发（cookie 归属由桌面版自己校验）。
 * 票据错、且没有 dsh-auth 的请求一律 401 —— 不渲染登录页（那不是 dsh web 的形态）。
 */
export const DSH_AUTH_COOKIE_RE = /(?:^|;\s*)dsh-auth(?:-[A-Za-z0-9_-]+)?=/

export function rewriteAttachRequest({ url, cookie = '' } = {}, { ticket = '', launchToken = '' } = {}) {
  let u
  try {
    u = new URL(String(url ?? '/'), 'http://127.0.0.1')
  } catch {
    return { action: 'deny', reason: 'bad-url' }
  }
  const given = u.searchParams.get('token')
  if (given != null) {
    if (!ticket || given !== ticket) return { action: 'deny', reason: 'bad-ticket' }
    if (!launchToken) return { action: 'deny', reason: 'no-launch-token' }
    u.searchParams.set('token', launchToken)
    return { action: 'proxy', url: `${u.pathname}${u.search}` }
  }
  if (DSH_AUTH_COOKIE_RE.test(String(cookie ?? ''))) return { action: 'proxy', url: `${u.pathname}${u.search}` }
  return { action: 'deny', reason: 'no-session' }
}

/** 垫片内容：只拦 `desktop`，其余原样 exec 真 dsh；命中时打印启动行并保活。 */
export function buildShimScript(realDshPath) {
  const real = String(realDshPath ?? 'dsh').replace(/'/g, `'\\''`)
  return [
    '#!/bin/sh',
    '# dsh-ssh-host: 只在「对接 DSH Go」模式的 SSH 前端会话里生效（PATH 前置）。',
    '# 目的：让 DSH Go 的启动命令 `dsh desktop` 落到插件手里，而不是撞 DSH 的 profile 保护。',
    'attach=0',
    'case "$1" in',
    '  desktop) attach=1 ;;',
    '  --profile) [ "$2" = "desktop" ] && attach=1 ;;',
    'esac',
    'if [ "$attach" = 1 ]; then',
    '  if [ -z "$DSH_ATTACH_LINE" ]; then',
    '    printf \'dsh desktop: 插件尚未就绪（缺少启动行），请在 SSH 主机面板确认开关\\n\' >&2',
    '    exit 1',
    '  fi',
    '  printf \'%s\\n\' "$DSH_ATTACH_LINE"',
    '  # 打印完就退出：DSH Go 的探测发现 pid 已死就会重新拉起，从而每次拿到**当前**的',
    '  # 外壳端口与票。刻意不保活 —— 插件重启会换端口和票，保活只会让客户端拿着旧链接',
    '  # 反复重连到一个已经不存在的端口。',
    '  exit 0',
    'fi',
    `exec '${real}' "$@"`,
    '',
  ].join('\n')
}

/**
 * 前端的 host key：**必须持久化**，不能每次启动现生成。
 *
 * 真机反馈（2026-11-17）：「主机指纹经常重置」。原因是前端每次 start 都 `generateHostKey()`
 * 造一把新的 —— SSH 客户端把 host key 当身份做信任固定（DSH Go 的 SshHostConfig 里就有
 * hostKeyType/hostKeyFingerprint，Termius 同理），指纹一变就要重新确认，看起来像「又重置了」。
 * 现在落盘到 ~/.dsh/dsh-ssh-host/ssh-front-host-key（0600），模式开关怎么切都是同一把。
 */
export function loadOrCreateFrontHostKey(file) {
  try {
    const text = readFileSync(file, 'utf8')
    if (text.includes('OPENSSH PRIVATE KEY')) return text
  } catch { /* 没有就生成 */ }
  const gen = generateHostKey()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, gen.privateKey, { mode: 0o600 })
  return gen.privateKey
}

/**
 * 启动 SSH 前端。
 *
 * @param {object} opts
 * @param {string} opts.publicKeyLine 插件公钥行（`ssh-ed25519 AAAA… dsh-ssh-host`）
 * @param {string} opts.attachLine    DSH Go 要抓的启动行
 * @param {string} opts.shimDir      垫片目录（里面必须有可执行的 `dsh`）
 * @param {string} [opts.hostKey]    前端的 host key（OpenSSH authkey 文本）。生产必须传
 *                                  持久化的那把（见 loadOrCreateFrontHostKey），否则每次启动
 *                                  换身份，客户端会以为指纹被重置；不传则内存现生成（测试用）。
 * @param {number} [opts.desktopPort] 允许 direct-tcpip 转发到的本机端口
 * @param {number} [opts.port]        监听端口（0 = 随机，默认 0）
 * @param {string} [opts.host]        监听地址（默认 127.0.0.1，不给外网留口）
 * @param {(info)=>void} [opts.onAttach] 收到 desktop 启动请求时回调（红绿灯用）
 * @param {(msg)=>void} [opts.log]
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startSshFront({
  publicKeyLine,
  attachLine,
  shimDir,
  desktopPort = 0,
  host = '127.0.0.1',
  port = 0,
  hostKey = null,
  onAttach = () => {},
  log = () => {},
} = {}) {
  // 交互/exec 都走 POSIX 的 `sh -c`；插件 SSH 主机能力本身也只支持 macOS，
  // 这里明确拒绝而不是在 Windows 上跑出半套行为。
  if (process.platform === 'win32') throw new Error('ssh-front: 仅支持 macOS / Linux')
  const rawPublicKey = parseEd25519PublicKeyLine(publicKeyLine)
  if (!rawPublicKey) throw new Error('ssh-front: 公钥行不可解析（需要 ssh-ed25519 …）')

  // ssh2 是 CJS 包：ESM `import()` 下构造器在 default 上（Node 的 CJS 互操作）。
  const ssh2 = await import('ssh2')
  const Server = ssh2.Server ?? ssh2.default?.Server
  // 前端自己的 host key：每次启动内存生成一把（OpenSSH authkey 文本），不落盘 ——
  // 它只服务这一条隧道的会话。复用 ssh.mjs 的编码器，避免依赖 ssh2 对 PEM 的支持范围。
  const serverHostKey = hostKey ?? generateHostKey().privateKey

  // 记下每条连接：close() 时要主动断开，否则 server.close() 会一直等现有连接结束
  // （测试里最典型：垫片 `exec sleep 86400` 保活，连接不断，close() 永不 resolve）。
  const connections = new Set()

  const server = new Server({ hostKeys: [serverHostKey] }, (client) => {
    connections.add(client)
    client.on('close', () => connections.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      if (!sameEd25519Key(ctx.key, rawPublicKey)) return ctx.reject(['publickey'])
      return ctx.accept()
    })

    // direct-tcpip：DSH Go 用它把远端的 127.0.0.1:<DSH 端口> 转发到手机侧。
    // ⚠️ 这个事件挂在连接上（ServerClient），不是挂在 session 上（ssh2 的 API 如此）。
    // 只放行回环 + 那个端口；别的一律拒绝（前端不是跳板机）。
    client.on('tcpip', (acceptTcp, rejectTcp, info) => {
      const destIP = String(info?.destIP ?? '')
      const destPort = Number(info?.destPort) || 0
      const loopback = destIP === '127.0.0.1' || destIP === '::1' || destIP === 'localhost'
      if (!loopback || !desktopPort || destPort !== desktopPort) {
        log(`ssh-front: 拒绝转发 ${destIP}:${destPort}`)
        return rejectTcp()
      }
      const stream = acceptTcp()
      const socket = netConnect({ host: '127.0.0.1', port: destPort })
      socket.on('connect', () => {
        stream.pipe(socket)
        socket.pipe(stream)
      })
      socket.on('error', () => { try { stream.close() } catch { /* noop */ } })
      stream.on('close', () => { try { socket.destroy() } catch { /* noop */ } })
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        // 交互 shell 不在这条线上提供：这条隧道是给 DSH Go 的，Termius 走原来的 SSH 隧道。
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('dsh-ssh-host: 这条隧道只用于「对接 DSH Go」。\r\n交互终端请连原来的 SSH 隧道（端口 22）。\r\n')
          stream.exit(1)
          stream.end()
        })
        session.on('pty', (acceptPty) => acceptPty())
        session.on('window-change', (acceptWc) => acceptWc())

        session.on('exec', (acceptExec, _reject, info) => {
          const command = String(info?.command ?? '')
          const stream = acceptExec()
          const attach = wantsDesktop(command)
          if (attach) onAttach({ command })
          const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }
          if (attach) env.DSH_ATTACH_LINE = attachLine
          // 垫片要生效，PATH 必须写进 `sh -lc` 的脚本体里（登录 shell 会重建 PATH，见 withShimPath）。
          const runCommand = withShimPath(command, shimDir)
          const child = spawn('/bin/sh', ['-c', runCommand], { env, stdio: ['pipe', 'pipe', 'pipe'] })
          child.stdout.on('data', (d) => stream.write(d))
          child.stderr.on('data', (d) => stream.stderr.write(d))
          stream.on('data', (d) => child.stdin.write(d))
          child.on('close', (code) => {
            stream.exit(code ?? 0)
            stream.end()
          })
          child.on('error', (e) => {
            stream.stderr.write(`dsh-ssh-host: 执行失败: ${e?.message ?? e}\n`)
            stream.exit(127)
            stream.end()
          })
          stream.on('close', () => { try { child.kill() } catch { /* 已经没了 */ } })
        })
      })
    })

    client.on('error', (e) => log(`ssh-front: 客户端错误: ${e?.message ?? e}`))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const boundPort = server.address()?.port ?? port
  log(`ssh-front: 监听 ${host}:${boundPort}`)

  return {
    port: boundPort,
    close: () => new Promise((resolve) => {
      for (const c of connections) {
        try { c.end() } catch { /* noop */ }
        try { setTimeout(() => c.destroy?.(), 50) } catch { /* noop */ }
      }
      connections.clear()
      try { server.close(() => resolve()) } catch { resolve() }
    }),
  }
}
