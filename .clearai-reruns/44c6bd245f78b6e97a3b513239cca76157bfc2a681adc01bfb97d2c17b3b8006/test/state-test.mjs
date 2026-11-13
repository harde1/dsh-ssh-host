// state-test.mjs — 数据目录迁移(测 index.js 的真实 migrateLegacyDataDir) + dismiss 持久化
//
// 迁移为什么不能内联复刻:迁移逻辑长在 index.js 里,复制一份进测试只会验证「副本对副本」。
// 真实实现的迁移在模块加载期执行,且 DATA_DIR / LEGACY_DATA_DIRS 等常量基于 import 时的
// DSH_HOME 求值 —— 所以这里沿用 apply-test.mjs / credential-token-test.mjs 的手法:
// mkdtemp 临时目录 → 造 legacy 目录 → 设 process.env.DSH_HOME → 动态 import('../index.js?…')。
// 每个场景用不同的 query 拿一份新的 index.js 模块实例(同进程缓存会挡住第二次求值),
// 模块体里的 migrateLegacyDataDir() 就会对着当时的 DSH_HOME 跑一次。
//
// 迁移链(与 index.js 的 LEGACY_DATA_DIRS 一致):dsh-natfrp → dsh-sakurafrp → dsh-ssh-host。

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }
const readFileIf = (p) => existsSync(p) ? readFileSync(p, 'utf8') : null

// ── 场景 ①:单级 dsh-sakurafrp,三件套(state.json / gate-password.txt / token.txt) ──
const homeA = mkdtempSync(join(tmpdir(), 'state-test-a-'))
const sakuraA = join(homeA, 'dsh-sakurafrp')
const newDir = join(homeA, 'dsh-ssh-host') // 供下方 writeState 合并段沿用
mkdirSync(sakuraA, { recursive: true })
const sakuraStateA = JSON.stringify({
  enabled: true,
  tunnelId: '54321',
  gatePort: 3083,
  gatePassword: 'legacy-pass',
  dismissedFrpcPrompts: [],
}, null, 2)
writeFileSync(join(sakuraA, 'state.json'), sakuraStateA)
writeFileSync(join(sakuraA, 'gate-password.txt'), 'legacy-pass')
writeFileSync(join(sakuraA, 'token.txt'), 'token-abc')

process.env.DSH_HOME = homeA
await import('../index.js?state-mig-a')

rec('① 新目录已创建', existsSync(newDir))
rec('① state.json 已迁移', existsSync(join(newDir, 'state.json')))
if (existsSync(join(newDir, 'state.json'))) {
  const st = JSON.parse(readFileSync(join(newDir, 'state.json'), 'utf8'))
  rec('① enabled 保留', st.enabled === true)
  rec('① tunnelId 保留', st.tunnelId === '54321')
  rec('① gatePassword 保留(关键:不能丢)', st.gatePassword === 'legacy-pass')
}
rec('① gate-password.txt 已迁移', readFileIf(join(newDir, 'gate-password.txt')) === 'legacy-pass')
rec('① token.txt 已迁移(上游 2.3.2+ 的回退 token 文件)', readFileIf(join(newDir, 'token.txt')) === 'token-abc')
rec('① 迁移文件权限 0600', (() => {
  const p = join(newDir, 'state.json')
  if (!existsSync(p)) return false // state.json 没迁过来,权限无从谈起(失败由上一条表达)
  return process.platform === 'win32' || (statSync(p).mode & 0o777) === 0o600
})())
rec(
  '① 旧目录原样保留(复制不搬走,关键:不影响旧包)',
  readFileIf(join(sakuraA, 'state.json')) === sakuraStateA
  && readFileIf(join(sakuraA, 'gate-password.txt')) === 'legacy-pass'
  && readFileIf(join(sakuraA, 'token.txt')) === 'token-abc',
)

// ── 二次运行不应覆盖新状态(STATE_PATH 已存在 → 整个迁移早退) ──
writeFileSync(join(newDir, 'state.json'), JSON.stringify({ enabled: false, marker: 'newer' }))
await import('../index.js?state-mig-a2')
rec('二次迁移不覆盖已存在的新状态', JSON.parse(readFileSync(join(newDir, 'state.json'), 'utf8')).marker === 'newer')

// ── 场景 ②:两级并存(dsh-natfrp + dsh-sakurafrp)——dsh-sakurafrp 的 state.json 优先,
//    dsh-natfrp 独有的文件仍被合并 ──
const homeB = mkdtempSync(join(tmpdir(), 'state-test-b-'))
const natB = join(homeB, 'dsh-natfrp')
const sakuraB = join(homeB, 'dsh-sakurafrp')
const newDirB = join(homeB, 'dsh-ssh-host')
mkdirSync(natB, { recursive: true })
mkdirSync(sakuraB, { recursive: true })
const natStateB = JSON.stringify({ tunnelId: '111', gatePassword: 'old-pass' })
const sakuraStateB = JSON.stringify({ tunnelId: '222', gatePassword: 'new-pass' })
writeFileSync(join(natB, 'state.json'), natStateB)
writeFileSync(join(natB, 'gate-password.txt'), 'old-pass')
writeFileSync(join(natB, 'token.txt'), 'old-token')
writeFileSync(join(sakuraB, 'state.json'), sakuraStateB)
writeFileSync(join(sakuraB, 'gate-password.txt'), 'new-pass')

process.env.DSH_HOME = homeB
await import('../index.js?state-mig-b')

rec(
  '② 两级并存:dsh-sakurafrp 的 state.json 优先(tunnelId=222)',
  JSON.parse(readFileIf(join(newDirB, 'state.json')) ?? '{}').tunnelId === '222',
)
rec('② 两级并存:dsh-sakurafrp 的 gate-password.txt 覆盖旧值', readFileIf(join(newDirB, 'gate-password.txt')) === 'new-pass')
rec('② 两级并存:dsh-natfrp 独有的 token.txt 仍被合并', readFileIf(join(newDirB, 'token.txt')) === 'old-token')
rec(
  '② 两级旧目录都原样保留',
  readFileIf(join(natB, 'state.json')) === natStateB
  && readFileIf(join(sakuraB, 'state.json')) === sakuraStateB
  && readFileIf(join(natB, 'token.txt')) === 'old-token',
)

// ── 场景 ④:新目录已有 state.json —— 不动(连旧目录的其它文件也不搬) ──
const homeC = mkdtempSync(join(tmpdir(), 'state-test-c-'))
const natC = join(homeC, 'dsh-natfrp')
const newDirC = join(homeC, 'dsh-ssh-host')
mkdirSync(natC, { recursive: true })
mkdirSync(newDirC, { recursive: true })
writeFileSync(join(newDirC, 'state.json'), JSON.stringify({ marker: 'already-mine' }))
writeFileSync(join(natC, 'state.json'), JSON.stringify({ tunnelId: '999' }))
writeFileSync(join(natC, 'gate-password.txt'), 'old-pass')

process.env.DSH_HOME = homeC
await import('../index.js?state-mig-c')

rec('③ 新目录已有 state.json 时不动', JSON.parse(readFileSync(join(newDirC, 'state.json'), 'utf8')).marker === 'already-mine')
rec('③ 早退后不搬任何文件(旧 gate-password.txt 不出现在新目录)', !existsSync(join(newDirC, 'gate-password.txt')))
rec('③ 旧目录原样保留', readFileIf(join(natC, 'state.json')) === JSON.stringify({ tunnelId: '999' }))

// ── 场景 ④:无 legacy —— 不留空目录(mkdir 后 copied=0 会 rmdir 掉) ──
const homeD = mkdtempSync(join(tmpdir(), 'state-test-d-'))
const newDirD = join(homeD, 'dsh-ssh-host')

process.env.DSH_HOME = homeD
await import('../index.js?state-mig-d')

rec('④ 无 legacy 时不留空目录', !existsSync(newDirD))

// ── writeState 合并语义 ──
function makeWriteState(statePath) {
  return (patch) => {
    const read = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')) ?? {} } catch { return {} } }
    const merged = { ...read(), ...patch }
    // 与 index.js 的 writeState 保持一致：访问密码永不落 state.json
    delete merged.gatePassword
    writeFileSync(statePath, JSON.stringify(merged, null, 2))
    return merged
  }
}
{
  const p = join(newDir, 'merge.json')
  writeFileSync(p, JSON.stringify({ enabled: true, tunnelId: '999', gatePassword: 'keep-me' }))
  const write = makeWriteState(p)
  write({ dismissedFrpcPrompts: ['missing::C:\\x\\frpc.exe'] })
  const st = JSON.parse(readFileSync(p, 'utf8'))
  rec('合并写入保留 enabled', st.enabled === true)
  rec('合并写入保留 tunnelId', st.tunnelId === '999')
  rec('合并写入剥掉 gatePassword（密码不落 state.json）', !('gatePassword' in st))
  rec('合并写入添加 dismiss 记录', Array.isArray(st.dismissedFrpcPrompts) && st.dismissedFrpcPrompts.length === 1)
}

for (const home of [homeA, homeB, homeC, homeD]) rmSync(home, { recursive: true, force: true })

const ok = results.every(Boolean)
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`)
setTimeout(() => process.exit(ok ? 0 : 1), 200)
