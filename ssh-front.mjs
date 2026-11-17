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
import { connect as netConnect } from 'node:net'
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
  return /(?:^|[\s;|&(])dsh\s+desktop(?:\s|$)/.test(s)
    || /(?:^|[\s;|&(])dsh\s+--profile\s+desktop(?:\s|$)/.test(s)
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
    '  # 保活：DSH Go 会记录本进程 pid 并在下次连接时复用（kill -0 判活）。',
    '  exec sleep 86400',
    'fi',
    `exec '${real}' "$@"`,
    '',
  ].join('\n')
}

/**
 * 启动 SSH 前端。
 *
 * @param {object} opts
 * @param {string} opts.publicKeyLine 插件公钥行（`ssh-ed25519 AAAA… dsh-ssh-host`）
 * @param {string} opts.attachLine    DSH Go 要抓的启动行
 * @param {string} opts.shimDir      垫片目录（里面必须有可执行的 `dsh`）
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
  const hostKey = generateHostKey()

  const server = new Server({ hostKeys: [hostKey.privateKey] }, (client) => {
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
          // 垫片只在这个会话的 PATH 里生效：DSH Go 的启动脚本原样跑，里面的 `dsh` 落到垫片。
          const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] })
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
      try { server.close(() => resolve()) } catch { resolve() }
    }),
  }
}
