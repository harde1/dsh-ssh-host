// ssh-host-test.mjs — ssh.mjs 的 SSH 主机能力：ed25519 专用密钥 / authorized_keys 幂等写入 /
// 连接命令 / sshd 探测结果分类。
//
// 与其它套件同款骨架（rec/results + 末尾 `N/N passed`，test-all.mjs 靠这个行汇总）。
// 全部离线：密钥内存生成，authorized_keys 写进 mkdtemp 临时目录，不碰真实 ~/.ssh，
// 不发起任何 TCP 连接（checkSshd 的真探测与注入点属 Task 9，随路由一起测）。
//
// 与计划 Step 8.1 / Task 9 实施契约修正的差异（逐条核对过）：
//   · 断言从裸 assert 换成套件统一的 rec 骨架，语义逐条保留；
//   · 计划块 3 的偏移算术错误：wire 布局 `[4B len][11B type][4B len][32B raw]`，
//     原始字节在偏移 19（非 15），已修测试并补长度字段断言；
//   · installPublicKey 契约按 Task 9「实施契约修正」从标记级幂等升级为 upsert 三态
//     （created / unchanged / replaced）——标记级幂等会让「重新生成密钥」时新公钥
//     写不进 authorized_keys，SSH 认证静默失败；断言已按新契约改写。

import { mkdtempSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildOpenSshPublicKey, generateHostKey, fingerprintOf,
  installPublicKey, buildConnectCommand, parseSshdProbeResult,
} from '../ssh.mjs'

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const markerLines = (text) => text.split('\n').filter((l) => l.includes('dsh-ssh-host')).length

// ── 1) generateHostKey：OpenSSH ed25519 公钥行 + PKCS8 私钥，每次生成都是新的 ──
{
  const k = generateHostKey()
  const blob = Buffer.from(k.publicKey.split(/\s+/)[1], 'base64')
  rec('公钥行以 ssh-ed25519 开头', k.publicKey.startsWith('ssh-ed25519 '), k.publicKey.split(/\s+/)[0])
  rec('公钥行带 dsh-ssh-host 标记注释', k.publicKey.endsWith(' dsh-ssh-host'), k.publicKey.split(/\s+/).pop())
  rec('wire blob 长度 >= 51（4+11+4+32）', blob.length >= 51, `len=${blob.length}`)
  rec('blob 首段长度 11（ssh-ed25519）', blob.readUInt32BE(0) === 11, String(blob.readUInt32BE(0)))
  rec('blob 类型串是 ssh-ed25519', blob.subarray(4, 15).toString() === 'ssh-ed25519', blob.subarray(4, 15).toString())
  rec('私钥是 PKCS8 PEM（node 原生导出）', k.privateKey.includes('BEGIN PRIVATE KEY'), k.privateKey.split('\n')[0])
  rec('私钥不是 OpenSSH 新格式（Termius 也能导入）', !k.privateKey.includes('OPENSSH PRIVATE KEY'))
  const k2 = generateHostKey()
  rec('每次生成都是新密钥', k.publicKey !== k2.publicKey)
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

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
