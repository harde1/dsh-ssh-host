// ssh.mjs — SSH 主机能力:sshd 探测 / 专用 ed25519 密钥 / authorized_keys 幂等写入 / 连接命令。
//
// 设计要点(见 docs/superpowers/specs/2026-11-12-dsh-ssh-host-design.md):
//   · 探测只看事实(TCP connect 127.0.0.1:22),不依赖 root 才能查的系统设置;
//   · 私钥选 PKCS8 PEM:node 原生导出,OpenSSH 7.8+ 与 Termius 都能直接导入;
//     OpenSSH 新格式需要手工拼 wire format,收益不值得;
//   · 公钥写 ~/.ssh/authorized_keys 是用户目录操作,无需 sudo;
//     sshd StrictModes 要求 0700/0600,权限不对公钥认证会静默失效,必须设对;
//   · 幂等/upsert 靠行内注释标记 dsh-ssh-host:同公钥不重写、新公钥替换标记行,
//     用户已有条目(无标记)只追加不删改。

import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SSH_HOST_MARKER = 'dsh-ssh-host'
export const SSHD_PORT = 22

/** SPKI DER 的固定头部长度(ed25519):302a300506032b6570032100 = 12 字节。 */
const SPKI_ED25519_HEADER = 12

/** 把 32 字节原始公钥格式化成 OpenSSH authorized_keys 单行。 */
export function buildOpenSshPublicKey(rawKey, comment = SSH_HOST_MARKER) {
  const raw = Buffer.from(rawKey)
  if (raw.length !== 32) throw new Error(`ed25519 raw key must be 32 bytes, got ${raw.length}`)
  const type = Buffer.from('ssh-ed25519')
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
  const blob = Buffer.concat([u32(type.length), type, u32(raw.length), raw])
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`
}

/** 生成专用密钥对:OpenSSH 公钥行 + PKCS8 PEM 私钥。 */
export function generateHostKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: buildOpenSshPublicKey(raw, SSH_HOST_MARKER),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** RFC 4253/8336 风格指纹:SHA256:<base64 无 padding>。 */
export function fingerprintOf(pubOpenSsh) {
  const b64 = String(pubOpenSsh ?? '').trim().split(/\s+/)[1] ?? ''
  const digest = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

/**
 * upsert 写入 authorized_keys（Task 9 实施契约修正：标记级幂等会让「重新生成密钥」
 * 时新公钥写不进 authorized_keys，SSH 认证静默失败，故升级为 upsert 语义）。
 *
 * 返回 { file, action }，action 三态：
 *   · created   —— 无标记条目：追加新公钥行
 *   · unchanged —— 有标记条目且公钥主体（base64）相同：不动文件
 *   · replaced  —— 有标记条目且公钥主体不同：整行替换标记行（含行内旧注释；
 *                  旧私钥失效场景：泄露 / 换机）
 * 用户自己的其它条目（不含 dsh-ssh-host 标记的行）永远原样保留；
 * 写入后文件里标记行恰好一条（历史脏数据里多余的标记行一并收敛）。
 */
export function installPublicKey(pubOpenSsh, { sshDir = join(homedir(), '.ssh') } = {}) {
  const pub = String(pubOpenSsh ?? '').trim()
  if (!pub.startsWith('ssh-ed25519 ')) {
    throw new Error(`公钥格式不对(应为 ssh-ed25519 开头): ${pub.slice(0, 24)}…`)
  }
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const file = join(sshDir, 'authorized_keys')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = existing ? existing.split('\n') : []
  const markerIdxs = []
  lines.forEach((line, i) => { if (line.includes(SSH_HOST_MARKER)) markerIdxs.push(i) })
  const keyBody = pub.split(/\s+/)[1] ?? ''

  if (markerIdxs.length > 0) {
    const currentBody = lines[markerIdxs[0]].trim().split(/\s+/)[1] ?? ''
    if (currentBody === keyBody && markerIdxs.length === 1) {
      return { file, action: 'unchanged' }
    }
    // 替换第一条标记行；异常状态下多余的标记行一并收敛，保证恰好一条
    lines[markerIdxs[0]] = pub
    const next = lines
      .filter((line, i) => i === markerIdxs[0] || !markerIdxs.includes(i))
      .join('\n')
    writeFileSync(file, next, { mode: 0o600 })
    return { file, action: 'replaced' }
  }

  const next = existing ? existing.replace(/\n*$/, '\n') + pub + '\n' : pub + '\n'
  writeFileSync(file, next, { mode: 0o600 })
  return { file, action: 'created' }
}

/** 连接命令;port 必须带,避免默认 22 的歧义(公网走的是官方分配的远程端口)。 */
export function buildConnectCommand(user, host, port) {
  return `ssh ${user}@${host} -p ${port}`
}

/** net 探测的结果分类:connect = sshd 在听;其余一律视为「未就绪」。 */
export function parseSshdProbeResult(outcome) {
  return outcome === 'connect'
}
