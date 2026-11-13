// ssh.mjs — SSH 主机能力:sshd 探测 / 专用 ed25519 密钥 / authorized_keys 幂等写入 / 连接命令。
//
// 设计要点(见 docs/superpowers/specs/2026-11-12-dsh-ssh-host-design.md):
//   · 探测只看事实(TCP connect 127.0.0.1:22),不依赖 root 才能查的系统设置;
//   · 私钥必须是 OpenSSH authkey 格式(`BEGIN OPENSSH PRIVATE KEY`):
//     曾选 PKCS8(`BEGIN PRIVATE KEY`)并假设 Termius 能吃,真机导入报
//     "Unsupported key type: PRIVATE KEY"(2026-11-12),故改为手工拼 authkey
//     —— 布局逐字节比对过 ssh-keygen 产物,见 encodeOpenSshPrivateKey;
//     toOpenSshPrivatePem 负责把旧版落盘的 PKCS8 私钥原地换封装(同一把密钥);
//   · 公钥写 ~/.ssh/authorized_keys 是用户目录操作,无需 sudo;
//     sshd StrictModes 要求 0700/0600,权限不对公钥认证会静默失效,必须设对;
//   · 幂等/upsert 靠行内注释标记 dsh-ssh-host:同公钥不重写、新公钥替换标记行,
//     用户已有条目(无标记)只追加不删改。

import { createHash, createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto'
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
  return `ssh-ed25519 ${publicWireBlob(raw).toString('base64')} ${comment}`
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
/** OpenSSH wire string:[4B 长度][内容] */
const wireString = (buf) => Buffer.concat([u32(buf.length), buf])
const ED25519_TYPE = Buffer.from('ssh-ed25519')

/** [4B 长度][blob] 形式的公钥 wire blob(Termius 认的 `ssh-ed25519 AAAA…` 里那段 base64)。 */
function publicWireBlob(rawPub) {
  return Buffer.concat([wireString(ED25519_TYPE), wireString(Buffer.from(rawPub))])
}

/**
 * OpenSSH 私钥(authkey)封装,无口令(cipher/kdf 均为 none)。
 *
 * 布局(xxd 逐字节比对过 ssh-keygen 产物,不是凭记忆写的):
 *   "openssh-key-v1\0" | string "none"(cipher) | string "none"(kdf)
 *   | string ""(kdf 参数) | uint32 1(密钥数) | string pubkey_blob
 *   | string 私钥区 —— 私钥区是**带 4 字节长度前缀的 string**,内部:
 *     uint32 check | uint32 check(同值) | string "ssh-ed25519"
 *     | string pub32 | string priv64(seed||pub) | string comment
 *     | padding 依次填 01 02 03… 补到 8 字节块。
 *
 * 为什么不用 PKCS8:Termius 对 ed25519 只认这个格式,PKCS8 的
 * `-----BEGIN PRIVATE KEY-----` 会报 "Unsupported key type: PRIVATE KEY"
 * (真机实测,2026-11-12)。本机 sshd 两者都能读,但用户要在手机上导入。
 */
export function encodeOpenSshPrivateKey(rawSeed, rawPub, comment = SSH_HOST_MARKER) {
  const seed = Buffer.from(rawSeed)
  const pub = Buffer.from(rawPub)
  if (seed.length !== 32 || pub.length !== 32) {
    throw new Error(`ed25519 raw key parts must be 32 bytes, got seed=${seed.length} pub=${pub.length}`)
  }
  const check = randomBytes(4)
  const privPlain = Buffer.concat([
    check, check,
    wireString(ED25519_TYPE),
    wireString(pub),
    wireString(Buffer.concat([seed, pub])),   // Ed25519 私钥 = seed||pub
    wireString(Buffer.from(comment)),
  ])
  // cipher=none 也要按 8 字节块对齐,填充值从 1 递增(OpenSSH 自家约定)
  const padLen = (8 - (privPlain.length % 8)) % 8
  const privSection = Buffer.concat([
    privPlain,
    Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1)),
  ])
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    wireString(Buffer.from('none')),
    wireString(Buffer.from('none')),
    wireString(Buffer.alloc(0)),
    u32(1),
    wireString(publicWireBlob(pub)),
    wireString(privSection),
  ])
  const b64 = blob.toString('base64').replace(/(.{70})/g, '$1\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`
}

/**
 * 私钥 PEM → OpenSSH authkey 格式(幂等:已是目标格式就原样返回)。
 * 用来自愈旧版本落盘的 PKCS8 私钥:同一把密钥换个封装,公钥不变,
 * authorized_keys 里的条目也不用动,手机端只需重新导出一次。
 */
export function toOpenSshPrivatePem(pem) {
  const text = String(pem ?? '')
  if (text.includes('BEGIN OPENSSH PRIVATE KEY')) return text
  if (!text.includes('BEGIN PRIVATE KEY')) {
    throw new Error('不是可识别的私钥 PEM(缺 BEGIN PRIVATE KEY / OPENSSH PRIVATE KEY)')
  }
  const der = createPrivateKey({ key: text, format: 'pem' }).export({ type: 'pkcs8', format: 'der' })
  const rawSeed = seedFromPkcs8Der(der)
  // JWK 的 x 就是 32 字节原始公钥;换封装用同一把密钥,公钥不会变。
  const jwk = createPrivateKey({ key: text, format: 'pem' }).export({ format: 'jwk' })
  const rawPub = Buffer.from(String(jwk.x ?? ''), 'base64url')
  return encodeOpenSshPrivateKey(rawSeed, rawPub)
}

/**
 * ed25519 的 PKCS8 DER 是 48 字节:`…0422 0420 <32B seed>`,
 * **只含 seed,不含公钥**(早期实现按 64 字节切尾部,切出来的是半截头部)。
 * 公钥要从 SPKI 单独拿,或干脆用 JWK 的 d。
 */
function seedFromPkcs8Der(der) {
  if (der.length < 32) throw new Error(`PKCS8 DER 太短,不像 ed25519(${der.length} 字节)`)
  return der.subarray(der.length - 32)
}

/**
 * 从 OpenSSH authkey 私钥里解出公钥行(私钥区内嵌了 pub32,见上面的布局)。
 * 用途:公钥文件丢失时仍能恢复指纹,不必让用户重新生成密钥。
 * 只解无口令(cipher=none)的私钥 —— 本插件生成的就是这种。
 */
export function publicKeyFromPrivatePem(pem) {
  const text = String(pem ?? '')
  if (!text.includes('BEGIN OPENSSH PRIVATE KEY')) return null
  const b64 = text.replace(/-----(BEGIN|END) OPENSSH PRIVATE KEY-----/g, '').replace(/\s+/g, '')
  const buf = Buffer.from(b64, 'base64')
  const magic = Buffer.from('openssh-key-v1\0', 'latin1')
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) return null
  let off = magic.length
  const readStr = () => {
    if (off + 4 > buf.length) throw new Error('私钥截断')
    const len = buf.readUInt32BE(off)
    off += 4
    const v = buf.subarray(off, off + len)
    off += len
    return v
  }
  const cipher = readStr().toString()
  readStr()            // kdf name
  readStr()            // kdf options
  const nKeys = buf.readUInt32BE(off); off += 4
  const pubBlob = readStr()
  if (nKeys !== 1 || cipher !== 'none') return null
  // 公钥 blob = [4B type len][type][4B pub len][pub]
  const typeLen = pubBlob.readUInt32BE(0)
  const pubLen = pubBlob.readUInt32BE(4 + typeLen)
  const rawPub = pubBlob.subarray(4 + typeLen + 4, 4 + typeLen + 4 + pubLen)
  if (rawPub.length !== 32) return null
  return buildOpenSshPublicKey(rawPub, SSH_HOST_MARKER)
}

/** 生成专用密钥对:OpenSSH 公钥行 + OpenSSH authkey 私钥(Termius 可导入)。 */
export function generateHostKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const rawPub = spki.subarray(spki.length - 32)
  // JWK 的 d 就是 32 字节 seed,比手工切 DER 稳
  const rawSeed = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })
    .subarray(-32))
  return {
    publicKey: buildOpenSshPublicKey(rawPub, SSH_HOST_MARKER),
    privateKey: encodeOpenSshPrivateKey(rawSeed, rawPub),
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

// sshd 探测。生产路径是真实 TCP connect(127.0.0.1:22);测试经 setSshdProberForTests
// 注入假探测,避免测试套件真的去连本机 22 端口(仓库约定全部离线)。生产代码不调用注入点。
let sshdProber = null
export function setSshdProberForTests(fn) { sshdProber = fn }
export async function checkSshd(host = '127.0.0.1', port = SSHD_PORT, timeoutMs = 1500) {
  if (sshdProber) return sshdProber(host, port)
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = (up) => { if (!done) { done = true; socket.destroy(); resolve(up) } }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}
