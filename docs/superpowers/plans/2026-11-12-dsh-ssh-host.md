# dsh-ssh-host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 dsh-sakurafrp 2.4.0 fork 出 dsh-ssh-host 插件:本机作 SSH 主机,手机经 SakuraFrp TCP 隧道用标准 SSH 客户端控制本机。

**Architecture:** 三阶段。阶段一同步上游 2.4.0 建 700 项测试基线并修两个遗留缺陷;阶段二新增 `ssh.mjs` 模块(sshd 探测/ed25519 密钥/authorized_keys 幂等写入)+ index.js 的 SSH 路由与 frpc 多隧道(NATFRP_TARGET="dshId,sshId",SSH 流量直连 22 不过网关)+ client.js 的「SSH 远程访问」渐进解锁区块;阶段三改名 dsh-ssh-host、重写 README、推送 origin/master。SSH 隧道与 DSH 隧道并存于同一 frpc 进程,互不干扰。

**Tech Stack:** Node.js ≥18.2(实测 v22.11.0)、原生 `node:crypto`(ed25519)/`node:net`/`node:os`、上游自带的 zero-dep 测试框架(`test-all.mjs` 串行跑 25 套件)、React(宿主注入,client.js 用 `h()` 无 JSX)。

**Spec:** `docs/superpowers/specs/2026-11-12-dsh-ssh-host-design.md`

**推送目标:** origin → `git@github.com:harde1/dsh-ssh-host.git`;上游另存 remote `upstream` → `https://github.com/MentholTea/dsh-sakurafrp`。

---

### Task 1: 上游同步 + 基线

**Files:**
- Modify: 全部源文件(检出 origin/master 即上游 2.4.0 的内容)
- 不动: `clear/`(已入 `.git/info/exclude`)、`docs/superpowers/specs/`

- [ ] **Step 1.1: 从上游拉取 2.4.0 并检出全部文件**

```bash
cd /Users/mac/Project/dsh-ssh-host
git fetch origin master
git checkout origin/master -- .
```

预期:README.md、test/(25 套件)、test-all.mjs、locale/、icon.svg、LICENSE、screenshots.json、assets/、docs/、scripts/ 全部出现;`grep '"version"' package.json` → `2.4.0`。

- [ ] **Step 1.2: 提交同步**

```bash
git add -A
git commit -m "sync: import upstream dsh-sakurafrp 2.4.0 as base"
```

- [ ] **Step 1.3: 建 700 项基线**

```bash
npm test
```

预期:`25 个套件 · 700 项 · 全部通过`(test-all.mjs 末尾汇总行)。**若上游本身有红项:停下,如实记录红项清单,不进入后续任务**(基线不绿不动代码)。

- [ ] **Step 1.4: 记录基线数字到计划备注**

把实际套件数/项数写进 commit message 附注或本文件 Task 1 末尾(实测口径),供 Task 10 回归对照。

> **实测口径(2026-11-12,上游 2.4.0,origin/master=344c448,Node v22.11.0):** `npm test` → **700/700 项 · 25 个套件 · 全部通过**(test-all.mjs 汇总行原文:`全部通过：700/700 项，25 个套件`;24 个 `*-test.mjs` + `verify.mjs`)。基线无红项。

---

### Task 2: remote 重定向 + 设计文档入库

**Files:**
- Modify: `.git/config`(经 git remote 命令)
- Create: `docs/superpowers/plans/2026-11-12-dsh-ssh-host.md`(本文件)

- [ ] **Step 2.1: origin 指向用户仓库,上游改存 upstream**

```bash
git remote set-url origin git@github.com:harde1/dsh-ssh-host.git
git remote add upstream https://github.com/MentholTea/dsh-sakurafrp.git
git remote -v
```

预期:origin(fetch/push)= git@github.com:harde1/dsh-ssh-host.git;upstream = MentholTea/dsh-sakurafrp。

- [ ] **Step 2.2: 提交设计与计划文档**

```bash
git add docs/superpowers/
git commit -m "docs: dsh-ssh-host design spec and implementation plan"
```

---

### Task 3: 修复 UA 版本硬编码(TDD)

**Files:**
- Modify: `natfrp.mjs:9,24-36`(createClient 签名与 UA)
- Modify: `index.js:361-364`(apiOrNull 传 version)
- Test: `test/verify.mjs`(API 客户端所在套件)

- [ ] **Step 3.1: 写失败测试**

在 `test/verify.mjs` 中找到现有 createClient 的 describe/组(搜 `createClient`),同组追加两条断言(沿用该文件的断言风格与 import):

```js
// UA 版本:默认 0.0.0,传入 version 后随调用方版本走。
// 上游曾在 UA 硬编码 2.2.0(index.js 头注释记载过这类坑),锁死不再复发。
{
  const c1 = createClient('t')
  assert.ok(
    c1.userAgent.includes('dsh-sakurafrp/0.0.0'),
    `default UA should contain dsh-sakurafrp/0.0.0, got: ${c1.userAgent}`,
  )
  assert.ok(
    !c1.userAgent.includes('/2.2.0'),
    `default UA must not pin an old hardcoded version, got: ${c1.userAgent}`,
  )
  const c2 = createClient('t', { version: '9.9.9' })
  assert.ok(
    c2.userAgent.includes('dsh-sakurafrp/9.9.9'),
    `UA should honor opts.version, got: ${c2.userAgent}`,
  )
}
```

- [ ] **Step 3.2: 跑测试确认失败**

```bash
node test/verify.mjs
```

预期:FAIL —— `c1.userAgent is undefined`(客户端尚未暴露 userAgent)。

- [ ] **Step 3.3: 最小实现**

`natfrp.mjs` 改两处:

```js
// 第 9 行附近,删除硬编码常量,改为默认值:
const DEFAULT_UA_VERSION = '0.0.0'
```

`createClient` 内(原 `const UA = ...` 所在处改为):

```js
export function createClient(token, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 12000
  const version = String(opts.version || DEFAULT_UA_VERSION)
  const UA = `dsh-sakurafrp/${version} (DeepSeek Harness plugin)`
  const log = opts.log ?? (() => {})
  // ……其余不变;并在返回对象中暴露 UA 供测试断言:
```

返回对象追加一个只读字段:

```js
  return {
    userAgent: UA,
    tunnels: () => call('GET', '/tunnels'),
    // ……其余方法原样
```

`index.js` 的 `apiOrNull`(约 361-364 行)传入插件版本:

```js
  function apiOrNull(token) {
    if (!token) return null
    return createClient(token, {
      version: PLUGIN_VERSION,
      log: (m) => logWarn(`natfrp: api ${m}`),
    })
  }
```

- [ ] **Step 3.4: 跑测试确认通过**

```bash
node test/verify.mjs
```

预期:PASS(含两条新断言)。

- [ ] **Step 3.5: 提交**

```bash
git add natfrp.mjs index.js test/verify.mjs
git commit -m "fix: derive API UA version from plugin version instead of hardcoded 2.2.0"
```

---

### Task 4: 修复 Windows 属主 UID 提示(TDD)

**Files:**
- Modify: `index.js`(模块级新增 `ownerNoteFor`,`diagnoseWriteFailure` 约 838-857 行改用它)
- Test: `test/verify.mjs`(index.js 可导入——它 export apply/ownerNoteFor;该文件已有 import index.js 的先例,搜现有 import 方式)

- [ ] **Step 4.1: 写失败测试**

```js
// ownerNoteFor: Windows 的 statSync 结果没有 uid 字段,
// 旧实现直接拼进模板串,用户看到「属主 UID undefined」。
{
  const withUid = ownerNoteFor({ uid: 501 })
  assert.ok(withUid.includes('501'), `should mention uid 501, got: ${withUid}`)
  assert.ok(withUid.includes('属主'), 'should explain owner')
  const noUid = ownerNoteFor({})
  assert.equal(noUid, '', 'missing uid must yield empty note (Windows)')
  const nulish = ownerNoteFor(undefined)
  assert.equal(nulish, '', 'undefined stat must yield empty note')
}
```

- [ ] **Step 4.2: 跑测试确认失败**

```bash
node test/verify.mjs
```

预期:FAIL —— `ownerNoteFor is not a function` 或 import 错误。

- [ ] **Step 4.3: 最小实现**

`index.js` 模块级(apply 之外,`safeRead` 附近)新增:

```js
/**
 * 属主注记:仅当 stat 带数字 uid(POSIX)时提示属主 UID。
 * Windows 的 statSync 结果没有 uid,直接拼模板会显示「属主 UID undefined」。
 */
function ownerNoteFor(stat) {
  const uid = stat?.uid
  return Number.isFinite(uid)
    ? `（当前文件属主可能不是你的账号，属主 UID ${uid}）`
    : ''
}
export { ownerNoteFor }
```

`diagnoseWriteFailure` 的 EPERM/EACCES 分支(约 838-857 行)替换取属主那段:

```js
      // 进一步区分:目录可写吗?文件属主是谁?
      let ownerNote = ''
      try {
        ownerNote = ownerNoteFor(statSync(path))
      } catch { /* 拿不到就算了 */ }
```

(下方 hint 模板里的 `${ownerNote}` 引用保持不变。)

- [ ] **Step 4.4: 跑测试确认通过**

```bash
node test/verify.mjs
```

- [ ] **Step 4.5: 提交**

```bash
git add index.js test/verify.mjs
git commit -m "fix: guard owner-uid note when stat has no uid (Windows)"
```

---

### Task 5: 改名 dsh-ssh-host(宿主半侧)

**Files:**
- Modify: `package.json`(name/description/keywords)
- Modify: `cordis.patch.yml`(id/name/注释)
- Modify: `index.js`(name/pluginName、DATA_DIR、迁移链、路由前缀、cookie 常量、UA、文案)
- Modify: `gate.mjs`(cookie 名、POLYFILL data 属性)
- Modify: `natfrp.mjs`(UA 串)
- Modify: `paths.mjs`(PLUGIN_DATA_DIR_NAME)
- Modify: `locale/*.json`(meta.title/description)
- Modify: `installer.mjs`(注释与下载提示里出现的包名,如有)

- [ ] **Step 5.1: 宿主半侧统一改名(每个替换都用 grep 确认命中数后再替换)**

| 旧 | 新 | 出现位置 |
|---|---|---|
| `dsh-sakurafrp` | `dsh-ssh-host` | package.json name、UA(改为变量拼接见 Task 3,这里改默认串里的包名)、paths.mjs:114、index.js DATA_DIR/LEGACY、注释 |
| `'dsh-natfrp'` (LEGACY_DATA_DIR) | `'dsh-sakurafrp'` | index.js:52 —— 迁移链变为 dsh-natfrp→(旧链)→dsh-sakurafrp→dsh-ssh-host:保留两级迁移(migrateLegacyDataDir 改成循环迁移表 `['dsh-natfrp','dsh-sakurafrp']` 依次尝试) |
| `export const name = 'natfrp'` | `export const name = 'sshhost'` | index.js:18(cordis 实例 id,slug 用 sshhost) |
| `export { name as pluginName }` | 不变 | index.js:1677 |
| `isAdminPath` 正则 `/^\/natfrp/` | `/^\/ssh-host/` | index.js:85 |
| 路由串 `'/natfrp/api/...'` 与 `'/natfrp'` 首页 | `'/ssh-host/api/...'`、`'/ssh-host'` | index.js 全部 handleOwnRoutes 与 webServer.register(path: '/natfrp' → '/ssh-host') |
| `snapshot` 里 `logsUrl` 拼接 | `/ssh-host/api/logs` | index.js:783 |
| cookie `'natfrp_gate'` | `'sshhost_gate'` | gate.mjs:243 |
| `natfrp_tok` / `natfrp_heal` | `sshhost_tok` / `sshhost_heal` | gate.mjs:488,593 |
| `data-natfrp-*` HTML 属性 | `data-sshhost-*` | gate.mjs POLYFILL(4 处)与 index.js 如有 |
| UA 串 `dsh-sakurafrp/` | `dsh-ssh-host/` | natfrp.mjs DEFAULT_UA_VERSION 拼接处 |
| cordis.patch.yml `id: natfrp`、`name: 'dsh-sakurafrp'` | `id: sshhost`、`name: 'dsh-ssh-host'` | cordis.patch.yml:5-6 |
| `PLUGIN_DATA_DIR_NAME = 'dsh-sakurafrp'` | `'dsh-ssh-host'` | paths.mjs:114 |

批量替换命令(逐条执行,先 grep 计数):

```bash
cd /Users/mac/Project/dsh-ssh-host
grep -rn "natfrp_gate\|natfrp_tok\|natfrp_heal\|data-natfrp" gate.mjs index.js | wc -l   # 心里有数
sed -i '' 's/natfrp_gate/sshhost_gate/g; s/natfrp_tok/sshhost_tok/g; s/natfrp_heal/sshhost_heal/g; s/data-natfrp-/data-sshhost-/g' gate.mjs index.js
sed -i '' "s|export const name = 'natfrp'|export const name = 'sshhost'|" index.js
sed -i '' 's|^/natfrp|/__IGNORED__|g; s|"/natfrp|"/ssh-host|g; s|`/natfrp|`/ssh-host|g; s|'\''/natfrp|'\''/ssh-host|g; s|/natfrp/api|/ssh-host/api|g; s|__IGNORED__|/natfrp|g' index.js   # 见下方核对步骤,误伤即手工回改
sed -i '' "s/PLUGIN_DATA_DIR_NAME = 'dsh-sakurafrp'/PLUGIN_DATA_DIR_NAME = 'dsh-ssh-host'/" paths.mjs
```

**核对步骤(必须)**:`grep -rn "/natfrp" index.js gate.mjs natfrp.mjs paths.mjs installer.mjs cordis.patch.yml locale/ | grep -v "ssh-host"` —— 输出为空才算换干净(注释里的历史叙述类 "natfrp" 字样不算路由,允许保留语义性注释,但路由串/常量必须清零)。

- [ ] **Step 5.2: index.js 数据目录迁移链**

`index.js` 顶部常量与 `migrateLegacyDataDir` 改为:

```js
const DATA_DIR = join(DSH_HOME, 'dsh-ssh-host')
// 历史迁移链:最早的 dsh-natfrp → dsh-sakurafrp → 现在的 dsh-ssh-host。
// 每级都「复制不搬走」(旧包可能仍装着),且只在新目录没有 state.json 时动作。
const LEGACY_DATA_DIRS = [join(DSH_HOME, 'dsh-natfrp'), join(DSH_HOME, 'dsh-sakurafrp')]
const STATE_PATH = join(DATA_DIR, 'state.json')
const PASSWORD_FILE = join(DATA_DIR, 'gate-password.txt')

function migrateLegacyDataDir() {
  try {
    if (existsSync(STATE_PATH)) return
    mkdirSync(DATA_DIR, { recursive: true })
    let copied = 0
    for (const LEGACY_DATA_DIR of LEGACY_DATA_DIRS) {
      if (!existsSync(LEGACY_DATA_DIR)) continue
      for (const file of ['state.json', 'gate-password.txt', 'token.txt']) {
        const from = join(LEGACY_DATA_DIR, file)
        if (!existsSync(from)) continue
        try { writeFileSync(join(DATA_DIR, file), readFileSync(from), { mode: 0o600 }); copied += 1 } catch { /* 单文件失败不影响其它 */ }
      }
    }
    if (copied === 0) { try { rmdirSync(DATA_DIR) } catch { /* 不留空目录 */ } }
  } catch { /* 权限/IO 问题 —— 退化为重新配置 */ }
}
```

注意迁移文件清单补 `token.txt`(上游 2.3.2+ 的 FALLBACK_TOKEN_FILE 在数据目录里)。

- [ ] **Step 5.3: package.json / cordis.patch.yml / locale**

```bash
sed -i '' 's/"name": "dsh-sakurafrp"/"name": "dsh-ssh-host"/' package.json
sed -i '' 's/dsh-sakurafrp/dsh-ssh-host/g' cordis.patch.yml
sed -i '' 's/id: natfrp/id: sshhost/' cordis.patch.yml
# description 改为插件新定位(package.json 与 locale/*.json 的 meta.description):
```

package.json description 改为:

```json
  "description": "DeepSeek Harness 插件:本机作为 SSH 主机,经 SakuraFrp 隧道供远方手机端 SSH 控制;另保留 DSH 界面的公网穿透与密码门。",
```

locale/zh-CN.json 与 locale/en-US.json(取回的上游文件)同步改 meta.title → `"SSH 主机 (SakuraFrp 隧道)"` / `"SSH Host (SakuraFrp tunnel)"` 与 description;保留 JSON 结构不动。

- [ ] **Step 5.4: 宿主半侧冒烟**

```bash
node --check index.js && node --check gate.mjs && node --check natfrp.mjs && node --check paths.mjs && node -e "import('./index.js').then(m=>console.log('import ok, name=',m.name)).catch(e=>{console.error(e);process.exit(1)})"
```

预期:`import ok, name= sshhost`。

- [ ] **Step 5.5: 提交(此时测试预期大面积红,改名未完成,不跑全量)**

```bash
git add -A
git commit -m "refactor: rename host-side identity to dsh-ssh-host (routes /ssh-host, cookies sshhost_*, data dir migration chain)"
```

---

### Task 6: 改名 dsh-ssh-host(客户端半侧)

**Files:**
- Modify: `client.js`(module id、API 常量、CSS 命名空间、localStorage key、aria-label、文案)

- [ ] **Step 6.1: client.js 统一改名**

```bash
sed -i '' "s/id: 'dsh-sakurafrp'/id: 'dsh-ssh-host'/" client.js
sed -i '' "s|const API = '/natfrp/api'|const API = '/ssh-host/api'|" client.js
sed -i '' 's/dsh-sakurafrp\/sidebar-dot.css/dsh-ssh-host\/sidebar-dot.css/; s/data-plugin="dsh-sakurafrp"/data-plugin="dsh-ssh-host"/; s/data-pluginCss = /data-pluginCss = /' client.js
sed -i '' 's/dsh-sakurafrp:logsOpen/dsh-ssh-host:logsOpen/' client.js
sed -i '' 's/button\[aria-label="内网穿透"\]/button[aria-label="SSH 主机"]/g' client.js
sed -i '' 's/aria-label="内网穿透"/aria-label="SSH 主机"/g' client.js
sed -i '' 's/label: '"'"'内网穿透 (SakuraFrp)'"'"'/label: '"'"'SSH 主机'"'"'/; s/label: '"'"'内网穿透'"'"'/label: '"'"'SSH 主机'"'"'/' client.js
sed -i '' "s/querySelectorAll('button\[aria-label=\"内网穿透\"\]')/querySelectorAll('button[aria-label=\"SSH 主机\"]')/g" client.js
sed -i '' 's/NATFRP_SIDEBAR_ORDER = 21/NATFRP_SIDEBAR_ORDER = 21/' client.js   # 顺序不动
sed -i '' 's/dsh-sakurafrp/dsh-ssh-host/g' client.js   # 收尾:剩余串(注释、title 提示里的包名)
```

**核对步骤**:`grep -n "natfrp\|内网穿透" client.js | grep -v ssh-host` —— 除纯注释叙述外应为空;UI 可见文案里的「内网穿透」一律改「SSH 主机」(标题行、开关 title、侧边栏 label)。

- [ ] **Step 6.2: 语法冒烟**

```bash
node --check client.js
```

- [ ] **Step 6.3: 提交**

```bash
git add client.js
git commit -m "refactor: rename client-side identity to dsh-ssh-host (module id, API base, sidebar label)"
```

---

### Task 7: 测试断言同步 + 全量回归

**Files:**
- Modify: `test/*.mjs`(25 个套件中引用旧名/旧路由/旧 cookie 的断言)
- Modify: `preview-render.mjs`(如有旧名)

- [ ] **Step 7.1: 批量更新测试断言**

```bash
cd /Users/mac/Project/dsh-ssh-host
grep -rln "natfrp\|dsh-sakurafrp\|内网穿透" test/ | tee /tmp/test-files-to-fix
# 对命中文件统一替换(顺序与 Task 5/6 的映射完全一致):
sed -i '' 's/natfrp_gate/sshhost_gate/g; s/natfrp_tok/sshhost_tok/g; s/natfrp_heal/sshhost_heal/g; s/data-natfrp-/data-sshhost-/g; s|/natfrp/api|/ssh-host/api|g; s|"/natfrp|"/ssh-host|g; s|'\''/natfrp|'\''/ssh-host|g; s|`/natfrp|`/ssh-host|g; s/dsh-sakurafrp/dsh-ssh-host/g; s/name = .natfrp./name = '\''sshhost'\''/g; s/内网穿透/SSH 主机/g' $(cat /tmp/test-files-to-fix)
```

- [ ] **Step 7.2: 跑全量测试,逐红项修**

```bash
npm test
```

预期:红项集中在「路由前缀」「cookie 名」「实例名」「aria-label」四类断言;每类红项回源码核对是断言过时还是真回归——断言过时改断言,真回归改回代码。**禁止为绿而删测试**:确属旧身份专属且语义已被新名替代的断言,改写而不是删除。

- [ ] **Step 7.3: 全绿后提交**

```bash
git add -A
git commit -m "test: sync assertions to dsh-ssh-host identity (routes, cookies, module id, labels)"
```

---

### Task 8: ssh.mjs 模块(TDD)

**Files:**
- Create: `ssh.mjs`
- Test: `test/ssh-host-test.mjs`(新建,沿用 test-all.mjs 的套件注册方式——先看 `test-all.mjs` 里套件列表的组织,把新文件追加进去)

- [ ] **Step 8.1: 写失败测试 `test/ssh-host-test.mjs`**

套件骨架(与其它 test/*.mjs 相同的断言库导入方式——参考 `test/paths-test.mjs` 头部):

```js
import assert from 'node:assert/strict'
import {
  buildOpenSshPublicKey, generateHostKey, fingerprintOf,
  installPublicKey, buildConnectCommand, parseSshdProbeResult,
} from '../ssh.mjs'

// —— generateHostKey ——
{
  const k = generateHostKey()
  assert.ok(k.publicKey.startsWith('ssh-ed25519 '), 'public key must be OpenSSH ed25519 line')
  assert.ok(k.publicKey.endsWith(' dsh-ssh-host'), 'public key must carry marker comment')
  const b64 = k.publicKey.split(/\s+/)[1]
  const blob = Buffer.from(b64, 'base64')
  assert.ok(blob.length >= 51, `wire blob length should be >= 51 (4+11+4+32), got ${blob.length}`)
  assert.equal(blob.readUInt32BE(0), 11)
  assert.equal(blob.subarray(4, 15).toString(), 'ssh-ed25519')
  assert.ok(k.privateKey.includes('BEGIN PRIVATE KEY'), 'private key must be PKCS8 PEM')
  assert.ok(!k.privateKey.includes('OPENSSH PRIVATE KEY'), 'PKCS8 is the chosen portable format')
  const k2 = generateHostKey()
  assert.notEqual(k.publicKey, k2.publicKey, 'each generation must be fresh')
}

// —— fingerprintOf ——
{
  const k = generateHostKey()
  const fp = fingerprintOf(k.publicKey)
  assert.ok(fp.startsWith('SHA256:'), `fingerprint format, got ${fp}`)
  assert.ok(!fp.includes('='), 'no base64 padding in fingerprint')
  assert.equal(fp, fingerprintOf(k.publicKey), 'stable for same key')
  assert.notEqual(fp, fingerprintOf(generateHostKey().publicKey), 'differs across keys')
}

// —— buildOpenSshPublicKey(纯格式化,与生成解耦) ——
{
  const raw = Buffer.alloc(32, 7)
  const line = buildOpenSshPublicKey(raw, 'dsh-ssh-host')
  assert.ok(line.startsWith('ssh-ed25519 '), 'type prefix')
  assert.ok(line.endsWith(' dsh-ssh-host'), 'comment suffix')
  const blob = Buffer.from(line.split(/\s+/)[1], 'base64')
  assert.equal(blob.subarray(15).toString('hex'), raw.toString('hex'), 'raw key bytes preserved')
}

// —— installPublicKey(幂等 + 权限) ——
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'sshhost-'))
  const k = generateHostKey()
  const r1 = installPublicKey(k.publicKey, { sshDir: dir })
  assert.equal(r1.added, true, 'first install adds')
  const r2 = installPublicKey(k.publicKey, { sshDir: dir })
  assert.equal(r2.added, false, 'second install is idempotent no-op')
  const other = generateHostKey()
  const r3 = installPublicKey(other.publicKey, { sshDir: dir })
  assert.equal(r3.added, true, 'a different key still installs (multi-key scenario)')
  const { statSync, readFileSync } = await import('node:fs')
  const st = statSync(join(dir, 'authorized_keys'))
  assert.equal(st.mode & 0o777, 0o600, 'authorized_keys must be 0600 (sshd StrictModes)')
  const stDir = statSync(dir)
  assert.equal(stDir.mode & 0o777, 0o700, 'ssh dir must be 0700')
  const text = readFileSync(join(dir, 'authorized_keys'), 'utf8')
  assert.equal(text.split('\n').filter((l) => l.includes('dsh-ssh-host')).length, 1,
    'marker must appear exactly once despite two installs')
  assert.ok(text.includes(k.publicKey.split(' ')[1]), 'first key line present')
  assert.ok(text.includes(other.publicKey.split(' ')[1]), 'second key line present')
}

// —— installPublicKey 拒绝非 ed25519 输入 ——
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'sshhost-'))
  assert.throws(() => installPublicKey('ssh-rsa AAAA fake', { sshDir: dir }), /ssh-ed25519/,
    'non-ed25519 keys must be rejected')
}

// —— buildConnectCommand ——
{
  assert.equal(buildConnectCommand('mac', 'cn-bos-1.natfrp.cloud', 12345),
    'ssh mac@cn-bos-1.natfrp.cloud -p 12345')
}

// —— parseSshdProbeResult(把 net 探测的结果分类,纯函数便于测试) ——
{
  assert.equal(parseSshdProbeResult('connect'), true)
  assert.equal(parseSshdProbeResult('timeout'), false)
  assert.equal(parseSshdProbeResult('ECONNREFUSED'), false)
  assert.equal(parseSshdProbeResult('ETIMEDOUT'), false)
}
```

- [ ] **Step 8.2: 把新套件注册进 test-all.mjs**

打开 `test-all.mjs`,找到套件文件名数组(按列表里 `paths-test.mjs` 一行的样式),追加 `'test/ssh-host-test.mjs'`。

- [ ] **Step 8.3: 跑测试确认失败**

```bash
node test/ssh-host-test.mjs
```

预期:FAIL —— `Cannot find module '../ssh.mjs'`。

- [ ] **Step 8.4: 实现 `ssh.mjs`**

```js
// ssh.mjs — SSH 主机能力:sshd 探测 / 专用 ed25519 密钥 / authorized_keys 幂等写入 / 连接命令。
//
// 设计要点(见 docs/superpowers/specs/2026-11-12-dsh-ssh-host-design.md):
//   · 探测只看事实(TCP connect 127.0.0.1:22),不依赖 root 才能查的系统设置;
//   · 私钥选 PKCS8 PEM:node 原生导出,OpenSSH 7.8+ 与 Termius 都能直接导入;
//     OpenSSH 新格式需要手工拼 wire format,收益不值得;
//   · 公钥写 ~/.ssh/authorized_keys 是用户目录操作,无需 sudo;
//     sshd StrictModes 要求 0700/0600,权限不对公钥认证会静默失效,必须设对;
//   · 幂等靠行内注释标记 dsh-ssh-host,只追加不删改用户已有条目。

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
 * 幂等写入 authorized_keys。
 * 返回 { added, file, reason? } —— 已有同标记条目时不重复写(added:false)。
 * 只追加;对用户已有条目(其它密钥)不读不删不改。
 */
export function installPublicKey(pubOpenSsh, { sshDir = join(homedir(), '.ssh') } = {}) {
  const pub = String(pubOpenSsh ?? '').trim()
  if (!pub.startsWith('ssh-ed25519 ')) {
    throw new Error(`公钥格式不对(应为 ssh-ed25519 开头): ${pub.slice(0, 24)}…`)
  }
  mkdirSync(sshDir, { recursive: true, mode: 0o700 })
  const file = join(sshDir, 'authorized_keys')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (existing.split('\n').some((line) => line.includes(SSH_HOST_MARKER))) {
    return { added: false, file, reason: '已有本插件生成的公钥,不重复写入' }
  }
  const entry = `${pub}`
  const next = existing ? existing.replace(/\n*$/, '\n') + entry + '\n' : entry + '\n'
  writeFileSync(file, next, { mode: 0o600 })
  return { added: true, file }
}

/** 连接命令;port 必须带,避免默认 22 的歧义(公网走的是官方分配的远程端口)。 */
export function buildConnectCommand(user, host, port) {
  return `ssh ${user}@${host} -p ${port}`
}

/** net 探测的结果分类:connect = sshd 在听;其余一律视为「未就绪」。 */
export function parseSshdProbeResult(outcome) {
  return outcome === 'connect'
}
```

- [ ] **Step 8.5: 跑测试确认通过**

```bash
node test/ssh-host-test.mjs
```

预期:全 PASS。

- [ ] **Step 8.6: 提交**

```bash
git add ssh.mjs test/ssh-host-test.mjs test-all.mjs
git commit -m "feat: ssh.mjs — sshd probe, ed25519 host key, idempotent authorized_keys install"
```

---

### Task 9: index.js SSH 路由 + frpc 多隧道(TDD)

**Files:**
- Modify: `index.js`(sshTunnelId 状态、startAll 目标拼接、5 个路由、snapshot 附 ssh 摘要)
- Test: `test/ssh-host-test.mjs`(路由级测试用 index.js 的 apply 钩子——参考 `test/apply-test.mjs` 与 `test/admin-auth-test.mjs` 现有的宿主 ctx 桩写法)

- [ ] **Step 9.1: 写失败测试(追加到 test/ssh-host-test.mjs)**

先读 `test/apply-test.mjs` 的宿主 ctx 桩(它构造了 webServer/credentials/timer/connection 的最小实现与 apply 调用),复用同一套桩。追加:

```js
// —— SSH 路由(index.js apply 级;桩复用 test/apply-test.mjs 的构造方式) ——
import { apply as applyPlugin } from '../index.js'
// ……此处沿用 apply-test.mjs 的 makeCtx/makeReq/makeRes 桩(照抄其构造,不重写),
// 关键断言:

// (a) NATFRP_TARGET 多隧道拼接:启用 + tunnelId + sshTunnelId 时,
//     frpc.start 收到的 tunnelIds 应为 ['111','222'] 去重序。
//     frpc 用桩替换(apply-test 已有同款手法,搜 createFrpcManager 的替换点)。
{
  const ctx = makeCtxWithFrpcSpy()
  applyPlugin(ctx, { enabled: true, tunnelId: '111', gatePort: 3083 })
  // 模拟已建 SSH 隧道:直接写 state.json 的 sshTunnelId,重启 apply
  writeStateFile({ enabled: true, tunnelId: '111', sshTunnelId: '222', gatePort: 3083 })
  const ctx2 = makeCtxWithFrpcSpy()
  applyPlugin(ctx2, { enabled: true, tunnelId: '111', gatePort: 3083 })
  // 桩记录:start 的 tunnelIds
  assert.deepEqual(frpcSpy.lastTunnelIds, ['111', '222'])
}

// (b) SSH 隧道创建:sshd 未监听时被拒(409 sshd-down)。
{
  // checkSshd 不可注入 net 时,用环境变量 DSH_SSHD_PROBE=off 的桩开关?—— 不引入测试开关,
  // 改为依赖注入:applyPlugin 第三个参数不存在的既有签名不能动,
  // 采用「模块级可替换」:index.js import { checkSshd } from './ssh.mjs',
  // 测试里用 node:test 的 mock?—— 本仓库无 node:test,
  // 沿用仓库手法:ssh.mjs 导出 setSshdProberForTests(fn)(仅测试注入,生产不调用)。
  setSshdProberForTests(async () => false)
  const { req, res } = makeReqRes('POST', '/ssh-host/api/ssh/tunnel/create')
  await handleViaCtx(req, res)   // apply-test 的路由驱动桩
  assert.equal(res.statusCode, 409)
  assert.equal(JSON.parse(res.body).error, 'sshd-down')
  setSshdProberForTests(null)
}

// (c) SSH 隧道创建成功:local_port 恒为 22。
{
  setSshdProberForTests(async () => true)
  apiStub.tunnelCreate = async (p) => {
    sshdCreatePayload = p
    return { id: 333, remote: 23456 }
  }
  const { req, res } = makeReqRes('POST', '/ssh-host/api/ssh/tunnel/create', { node: 7 })
  await handleViaCtx(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(sshdCreatePayload.local_port, 22, 'SSH tunnel must target local sshd port 22')
  assert.equal(sshdCreatePayload.type, 'tcp')
  assert.equal(JSON.parse(res.body).id, 333)
  setSshdProberForTests(null)
}

// (d) 私钥路由:未生成密钥时 404;生成后返回 PKCS8 PEM。
{
  const { req, res } = makeReqRes('GET', '/ssh-host/api/ssh/key/private')
  await handleViaCtx(req, res)
  assert.equal(res.statusCode, 404)
  // 生成:
  const { req: r2, res: w2 } = makeReqRes('POST', '/ssh-host/api/ssh/key/create')
  await handleViaCtx(r2, w2)
  assert.equal(w2.statusCode, 200)
  const { req: r3, res: w3 } = makeReqRes('GET', '/ssh-host/api/ssh/key/private')
  await handleViaCtx(r3, w3)
  const body = JSON.parse(w3.body)
  assert.ok(body.privateKey.includes('BEGIN PRIVATE KEY'))
  assert.ok(body.fingerprint.startsWith('SHA256:'))
}

// (e) key/create 落盘到注入的 HOME(测试设 DSH_HOME 到临时目录),
//     authorized_keys 出现在临时 home 的 .ssh 下且权限 0600。
{
  // installPublicKey 默认用真实 homedir() —— 为可测,ssh.mjs 的 installPublicKey
  // 已支持 sshDir 注入;index.js 里调用处读 env DSH_SSH_DIR(缺省真实 ~/.ssh),
  // 测试设 DSH_SSH_DIR 指向临时目录。
}
```

**实现注意**:测试桩的具体构造在写测试时**照抄 apply-test.mjs 的现有桩**(makeCtxWithFrpcSpy / makeReqRes / handleViaCtx 等,以该文件实际命名为准),本步骤不发明新桩体系。

- [ ] **Step 9.2: 跑测试确认失败**

```bash
node test/ssh-host-test.mjs
```

预期:FAIL —— 路由 404 / tunnelIds 仍是单值。

- [ ] **Step 9.3: 实现 index.js 改动**

(a) 顶部 import:

```js
import { checkSshd, generateHostKey, fingerprintOf, installPublicKey, buildConnectCommand } from './ssh.mjs'
import { userInfo as osUserInfo } from 'node:os'
```

(b) 状态(在 `let tunnelId = ...` 之后):

```js
  let sshTunnelId = String(state.sshTunnelId ?? '').trim()
  // 私钥注入目录:默认真实 ~/.ssh;测试可经 DSH_SSH_DIR 指到临时目录。
  const sshDir = String(process.env.DSH_SSH_DIR ?? '').trim() || join(homedir(), '.ssh')
  let hostKey = null
  try {
    const pk = safeRead(join(DATA_DIR, 'ssh-host-key'))
    if (pk) hostKey = { privateKey: pk, publicKey: safeRead(join(DATA_DIR, 'ssh-host-key.pub')) }
  } catch { /* 读不到就当没有 */ }
```

(私钥与公钥分别落 `DATA_DIR/ssh-host-key` / `ssh-host-key.pub`,0600。)

(c) sshd 探测注入点(ssh.mjs 追加,供路由测试):

```js
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
```

(d) startAll 的 frpc 目标(原 `frpc.start({ tunnelIds: [tunnelId] })`):

```js
      // SSH 与 DSH 两条隧道同一 frpc 进程承载(NATFRP_TARGET 逗号多值):
      // frpc 支持多隧道;SSH 隧道 local_port=22 直连 sshd,不过网关。
      const targetIds = [...new Set([tunnelId, sshTunnelId].filter(Boolean))]
      if (!targetIds.length) {
        logError('natfrp: 未配置隧道 ID')
        return
      }
      const r = frpc.start({ tunnelIds: targetIds })
```

(原有 `if (!tunnelId)` 的单独校验删除,并入上面的空数组校验;日志串同步带上 ssh 隧道数。)

(e) 路由(handleOwnRoutes 内、`/ssh-host/api/align` 之前插入):

```js
    // ---------- SSH 主机 ----------

    if (path === '/ssh-host/api/ssh/state' && req.method === 'GET') {
      const [sshdUp] = await Promise.all([checkSshd()])
      let tunnel = null
      if (sshTunnelId) {
        try {
          const token = await resolveToken()
          const api = apiOrNull(token)
          if (api) {
            const [list, nodes] = await Promise.all([
              api.tunnels(),
              api.nodes().catch(() => ({})),
            ])
            noteApiOk()
            const tn = (Array.isArray(list) ? list : []).find((t) => String(t.id) === sshTunnelId)
            if (tn) {
              const nodeHost = nodes?.[tn.node]?.host ?? ''
              const remote = Number(tn.remote) || null
              tunnel = {
                id: tn.id,
                online: tn.online === true,
                remote,
                nodeHost,
                node: tn.node,
              }
            }
          }
        } catch { /* 拉不到就如实显示「未连」 */ }
      }
      const user = osUserInfo().username
      json(res, 200, {
        platform: process.platform,
        sshdUp,
        key: hostKey ? { fingerprint: fingerprintOf(hostKey.publicKey), hasPrivate: true } : null,
        sshTunnelId,
        tunnel,
        user,
        connectCmd: tunnel?.remote && tunnel?.nodeHost
          ? buildConnectCommand(user, tunnel.nodeHost, tunnel.remote)
          : null,
      })
      return true
    }

    if (path === '/ssh-host/api/ssh/key/create' && req.method === 'POST') {
      try {
        const gen = generateHostKey()
        mkdirSync(DATA_DIR, { recursive: true })
        writeFileSync(join(DATA_DIR, 'ssh-host-key'), gen.privateKey, { mode: 0o600 })
        writeFileSync(join(DATA_DIR, 'ssh-host-key.pub'), `${gen.publicKey}\n`, { mode: 0o600 })
        hostKey = gen
        const inst = installPublicKey(gen.publicKey, { sshDir })
        logInfo(`natfrp: SSH 公钥${inst.added ? '已写入' : '已存在'} ${inst.file}`)
        json(res, 200, {
          ok: true,
          added: inst.added,
          file: inst.file,
          fingerprint: fingerprintOf(gen.publicKey),
        })
      } catch (e) {
        json(res, 500, { error: 'ssh-key-failed', message: String(e?.message ?? e) })
      }
      return true
    }

    if (path === '/ssh-host/api/ssh/key/private' && req.method === 'GET') {
      if (!hostKey) {
        json(res, 404, { error: 'no-key', message: '还没有生成密钥' })
        return true
      }
      json(res, 200, {
        privateKey: hostKey.privateKey,
        publicKey: hostKey.publicKey,
        fingerprint: fingerprintOf(hostKey.publicKey),
      })
      return true
    }

    if (path === '/ssh-host/api/ssh/tunnel/create' && req.method === 'POST') {
      if (process.platform !== 'darwin') {
        json(res, 400, { error: 'unsupported-platform', message: 'SSH 主机功能第一阶段仅支持 macOS' })
        return true
      }
      if (!(await checkSshd())) {
        json(res, 409, {
          error: 'sshd-down',
          message: '本机 sshd(远程登录)没有开启:系统设置 → 通用 → 共享 → 远程登录,打开后重试',
        })
        return true
      }
      if (sshTunnelId) {
        json(res, 409, { error: 'already-created', message: `已有 SSH 隧道 ${sshTunnelId},先删除再建` })
        return true
      }
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      const raw = await readBody(req)
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch { /* 空 body 允许 */ }
      // 节点:显式传 > 当前 DSH 隧道的节点(同节点,延迟一致)> 都没有就报错
      let node = Number(body.node) || null
      if (!node && lastTunnelInfo) node = Number(lastTunnelInfo.node) || null
      if (!node || !Number.isInteger(node) || node <= 0) {
        json(res, 400, {
          error: 'no-node',
          message: '没有可用节点:先在上方选一条隧道(SSH 会复用它的节点),或显式传 node',
        })
        return true
      }
      try {
        const created = await api.tunnelCreate({
          name: String(body.name ?? 'SSH').trim().slice(0, 24) || 'SSH',
          type: 'tcp',
          node,
          local_ip: '127.0.0.1',
          local_port: SSHD_PORT,
          note: '由 dsh-ssh-host 创建',
        })
        const id = created?.id
        if (!id) {
          json(res, 502, { error: 'api-failed', message: '官方返回成功但没给隧道 ID' })
          return true
        }
        sshTunnelId = String(id)
        writeState({ sshTunnelId })
        logInfo(`natfrp: SSH 隧道已创建 ${id} (node=${node}, local=127.0.0.1:${SSHD_PORT})`)
        if (enabled) { frpc.stop(); void startAll('ssh tunnel created') }
        json(res, 200, {
          ok: true,
          id,
          remote: created?.remote ?? null,
          warning: created?.important_warning_for_ai ?? null,
        })
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : String(e?.message ?? e)
        logWarn(`natfrp: SSH 隧道创建失败: ${msg}`)
        json(res, 502, { error: 'api-failed', message: msg })
      }
      return true
    }

    if (path === '/ssh-host/api/ssh/tunnel/remove' && req.method === 'POST') {
      if (!sshTunnelId) { json(res, 400, { error: 'no-tunnel', message: '没有 SSH 隧道可删' }); return true }
      const token = await resolveToken()
      const api = apiOrNull(token)
      if (!api) { json(res, 400, { error: 'no-token' }); return true }
      const idNum = Number(sshTunnelId)
      try {
        const r = await api.tunnelDelete([idNum])
        noteApiOk()
        const deleted = (Array.isArray(r?.deleted) ? r.deleted : []).map(Number)
        // 与上游 tunnel/delete 同语义:failed 只是「没把在线 frpc 踢下线」,
        // deleted 才算真删了;本地必须停 frpc 重启,否则它拿着死隧道反复重连。
        if (!deleted.includes(idNum)) {
          json(res, 502, { error: 'delete-failed', message: '官方没有删掉这条隧道(可能已不存在或不属于当前账号)' })
          return true
        }
        sshTunnelId = ''
        writeState({ sshTunnelId: '' })
        frpc.stop()
        if (enabled) void startAll('ssh tunnel removed')
        json(res, 200, { ok: true })
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : String(e?.message ?? e)
        json(res, 502, { error: 'api-failed', message: msg })
      }
      return true
    }
```

(f) snapshot 附 SSH 摘要(可选字段,前端直接读 /ssh/state,快照只加轻量两键):

```js
      sshTunnelId,
      sshSshdUp: null, // 探测是异步 TCP connect,快照不阻塞;前端单独打 /ssh/state
```

(实际上 snapshot 不放 sshdUp,避免 4s 轮询每次做 TCP 探测;前端 SSH 区块独立 8s 轮询 /ssh/state。)

- [ ] **Step 9.4: 跑测试确认通过**

```bash
node test/ssh-host-test.mjs && npm test
```

预期:新套件全 PASS;全量 26 套件全绿。

- [ ] **Step 9.5: 提交**

```bash
git add index.js ssh.mjs test/ssh-host-test.mjs
git commit -m "feat: SSH host routes (state/key/tunnel) + frpc multi-tunnel NATFRP_TARGET"
```

---

### Task 10: client.js「SSH 远程访问」区块

**Files:**
- Modify: `client.js`(新增 SshPanel 组件,插在 Panel 渲染树:密码门区块之后)

- [ ] **Step 10.1: 实现 SshPanel 组件(client.js,Panel 定义之后、NatfrpSidebarIcon 之前)**

```js
    // ── SSH 远程访问区块 ──
    // 渐进解锁四态(与 DSH 四步同风格):
    //   非macOS → sshd 未开(指引+重新检测)→ 无密钥(一键生成)→ 无 SSH 隧道(一键建)→ 就绪(连接命令)
    // 独立 8s 轮询 /ssh/state:快照轮询(4s)不做 TCP 探测,探测开销只在这里承担。
    function SshPanel() {
      const [ssh, setSsh] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [showPriv, setShowPriv] = useState(false)
      const [privKey, setPrivKey] = useState('')
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        const load = async () => {
          try {
            const s = await getJSON('/ssh/state')
            if (mounted.current) setSsh(s)
          } catch { /* 拉不到保持上一份 */ }
        }
        void load()
        const t = setInterval(() => void load(), 8000)
        return () => { mounted.current = false; clearInterval(t) }
      }, [])

      if (!ssh) return null   // 首次加载不占位,避免闪一块空卡

      const isMac = ssh.platform === 'darwin'

      const createKey = async () => {
        setBusy('key'); setMsg('')
        try {
          const r = await post('/ssh/key/create')
          setMsg(r.added ? '✓ 密钥已生成,公钥已写入 ~/.ssh/authorized_keys' : '✓ 密钥已存在(不重复写入)')
        } catch (e) { setMsg(`密钥生成失败:${e.message}`) }
        finally { setBusy('') }
      }

      const createTunnel = async () => {
        setBusy('tunnel'); setMsg('')
        try {
          const r = await post('/ssh/tunnel/create', {})
          setMsg(r.warning ? `⚠ ${r.warning}` : '✓ SSH 隧道已创建,等 frpc 重连后生效')
        } catch (e) { setMsg(`创建失败:${e.message}`) }
        finally { setBusy('') }
      }

      const removeTunnel = async () => {
        const ok = typeof window === 'undefined' || window.confirm('删除 SSH 隧道后手机将无法 SSH 连入,确定删除?')
        if (!ok) return
        setBusy('remove'); setMsg('')
        try {
          await post('/ssh/tunnel/remove')
          setMsg('✓ SSH 隧道已删除')
        } catch (e) { setMsg(`删除失败:${e.message}`) }
        finally { setBusy('') }
      }

      const revealPrivate = async () => {
        if (privKey) { setShowPriv((v) => !v); return }
        setBusy('priv')
        try {
          const r = await getJSON('/ssh/key/private')
          setPrivKey(r.privateKey)
          setShowPriv(true)
        } catch (e) { setMsg(`读取私钥失败:${e.message}`) }
        finally { setBusy('') }
      }

      // 态判定
      const platformBlock = !isMac
      const sshdBlock = isMac && !ssh.sshdUp
      const keyBlock = ssh.sshdUp && !ssh.key
      const tunnelBlock = ssh.key && !ssh.sshTunnelId
      const ready = Boolean(ssh.sshTunnelId && ssh.tunnel?.remote && ssh.tunnel?.nodeHost && ssh.tunnel?.online)

      return h('div', { style: { ...S.field, gridTemplateColumns: '1fr', gap: '8px' } },
        h('div', { style: { ...S.row, gap: '10px' } },
          h('div', { style: S.label }, 'SSH 远程访问'),
          ssh.key
            ? h('span', {
              style: S.code, title: '手机端导入私钥后可比对这串指纹',
            }, ssh.key.fingerprint)
            : null),

        platformBlock
          ? h('div', { style: S.hint },
            'SSH 主机功能当前阶段仅支持 macOS(需要系统 sshd)。Windows 的 OpenSSH Server 支持在路线图上。')
          : null,

        sshdBlock
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: S.warn },
              '本机 sshd(远程登录)没有开启。到「系统设置 → 通用 → 共享 → 远程登录」打开,然后点重新检测。'),
            h('div', {},
              h('button', {
                type: 'button', style: S.btnGhost,
                onClick: () => {
                  // 系统设置的「共享」面板深链;打不开就按提示手点
                  try { location.href = 'x-apple.systempreferences:com.apple.preferences.sharing?Services' }
                  catch { /* noop */ }
                },
              }, '打开系统设置'),
              ' ',
              h('span', { style: S.hint }, '打开后等下一轮自动检测(≤8 秒),或重启设置页。')))
          : null,

        keyBlock
          ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { style: { ...S.hint, flex: '1 1 240px' } },
              '生成一把专用于 SSH 连入的密钥:公钥写进本机 ~/.ssh/authorized_keys,私钥导出到手机(Termius 等)。'),
            h('button', {
              type: 'button', style: busy === 'key' ? { ...S.btn, opacity: 0.6 } : S.btn,
              disabled: busy === 'key', onClick: createKey,
            }, busy === 'key' ? '生成中…' : '生成 SSH 密钥'))
          : null,

        tunnelBlock
          ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('div', { style: { ...S.hint, flex: '1 1 240px' } },
              '建一条 TCP 隧道直连本机 22 端口(远程端口官方分配;SSH 流量不经过密码门,由 SSH 认证保护)。'),
            h('button', {
              type: 'button', style: busy === 'tunnel' ? { ...S.btn, opacity: 0.6 } : S.btn,
              disabled: busy === 'tunnel', onClick: createTunnel,
            }, busy === 'tunnel' ? '创建中…' : '创建 SSH 隧道'))
          : null,

        ssh.sshTunnelId && ssh.tunnel
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('span', { style: S.badge(ssh.tunnel.online) },
                ssh.tunnel.online ? 'SSH 隧道在线' : 'SSH 隧道未连'),
              ssh.connectCmd
                ? h('span', { style: { ...S.code, userSelect: 'all' } }, ssh.connectCmd)
                : h('span', { style: S.hint }, '等隧道上线后显示连接命令(需要官方分配到远程端口)'),
              h('button', {
                type: 'button', style: S.btnGhost, disabled: busy === 'remove',
                onClick: removeTunnel,
              }, busy === 'remove' ? '删除中…' : '删除隧道')),
            ssh.tunnel.remote && !ssh.tunnel.online
              ? h('div', { style: S.warn },
                '隧道建好了但还没连上:确认总开关已开、frpc 正在运行;若刚创建,等几秒自动重连。')
              : null)
          : null,

        hostKey
          ? null : null, // hostKey 是宿主侧变量,这里删除占位(保持结构清晰)

        ssh.key
          ? h('div', {},
            h('button', {
              type: 'button', style: { ...S.btnGhost, fontSize: '12px' },
              onClick: revealPrivate,
            }, showPriv ? '收起私钥' : '查看私钥(导入手机)'),
            showPriv && privKey
              ? h('pre', {
                style: {
                  marginTop: '6px', padding: '8px 10px', borderRadius: '6px',
                  background: 'rgba(127,127,127,.08)', fontSize: '11px', lineHeight: 1.5,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all',
                },
              }, privKey)
              : null,
            showPriv && privKey
              ? h('div', { style: { ...S.hint, marginTop: '4px' } },
                '整段复制(含 BEGIN/END 行),在 Termius 里 Keychain → + → Import 保存,主机认证选这把钥匙。')
              : null)
          : null,

        msg ? h('div', { style: /^⚠|^失败/.test(msg) ? S.err : S.ok }, msg) : null)
    }
```

注意:上面 `hostKey ? null : null` 一行是写作时的结构占位,**实现时删除该行**(SshPanel 不引用宿主变量)。

- [ ] **Step 10.2: 挂进 Panel 渲染树**

在 Panel 返回的 `h('div', { style: S.wrap }, ...)` 里,「── 保存 ──」块之后、日志块之前插入:

```js
        h('div', { style: S.divider }),

        // ── SSH 远程访问(四态渐进解锁)──
        h(SshPanel),
```

- [ ] **Step 10.3: 预览渲染冒烟**

```bash
node --check client.js
PREVIEW_VARIANT=ready node preview-render.mjs /tmp/ssh-preview.html && grep -c "SSH 远程访问" /tmp/ssh-preview.html
```

预期:输出 ≥1(区块渲染进面板);`node --check` 无错。

- [ ] **Step 10.4: 全量回归**

```bash
npm test
```

预期:26 套件全绿(UI 断言在 order-test/progressive-test 里针对 Panel 结构,新增区块可能触发「顺序」类断言——按同样的「改断言不删测试」原则处理)。

- [ ] **Step 10.5: 提交**

```bash
git add client.js test/
git commit -m "feat: SSH remote-access panel with progressive unlock (sshd/key/tunnel/connect)"
```

---

### Task 11: README 重写 + 版本 0.1.0 + 收尾

**Files:**
- Modify: `README.md`(重写为 dsh-ssh-host 定位)
- Modify: `package.json`(version → 0.1.0)
- Modify: `icon.svg`(可沿用上游;若改,保持单文件 SVG)

- [ ] **Step 11.1: package.json 版本与元信息**

```bash
sed -i '' 's/"version": "2.4.0"/"version": "0.1.0"/' package.json
```

keywords 数组加 `"ssh"`、`"ssh-server"`、`"ssh-host"`,保留上游 frp 相关词。

- [ ] **Step 11.2: README 重写**

结构(全部新写,保留上游 README 中仍然正确的通用章节如「证书警告与白屏问题」/「已知边界」的 DSH 穿透部分,改包名与路由前缀):

1. 标题 `dsh-ssh-host` + 一句话定位:**本机作为 SSH 主机,远方手机 SSH 控制本机;基于 dsh-sakurafrp 2.4.0 fork,同时保留 DSH 界面公网穿透**
2. 「AI 协作产物」免责声明(沿用上游措辞,更新测试数字为实测)
3. 快速开始四步:装插件 → 开「远程登录」→ 点「生成 SSH 密钥」→ 点「创建 SSH 隧道」→ 手机 Termius 导入私钥,连 `ssh <user>@<节点host> -p <远程端口>`
4. 架构图(两条隧道并存:SSH 直连 22 不过网关;DSH 走密码门网关)
5. 配置表:沿用上游 + 新增说明(无新 config 键——SSH 状态全落 state.json 的 `sshTunnelId`)
6. 管理接口:上游清单改名 /ssh-host 前缀 + 5 个 SSH 路由
7. 安全说明:密钥为主、私钥 0600 不入 state.json、SSH 流量不经密码门(SSH 自带认证)、失败锁定与密码门的既有边界
8. 验证:`npm test`(26 套件,实测数字)
9. 与上游的关系:fork 自 MentholTea/dsh-sakurafrp 2.4.0,上游更新经 `upstream` remote 手动同步
10. 已知边界:第一阶段 macOS only;Windows OpenSSH Server 在路线图

- [ ] **Step 11.3: 全量回归 + 提交**

```bash
npm test
git add -A
git commit -m "release: dsh-ssh-host 0.1.0 — SSH host plugin based on dsh-sakurafrp 2.4.0"
```

预期:26 套件全绿。

- [ ] **Step 11.4: 推送**

```bash
git push origin master
```

预期:推送成功(首次推送建立 origin/master)。若 SSH key 认证失败,读清报错(凭据问题不是代码问题),停下告知用户,本地提交已完整。

---

### Task 12: 真机冒烟(可选,需用户配合)

- [ ] **Step 12.1: 本机开启「远程登录」后,重启 DSH 加载插件,面板四态应全部走通到「就绪」**
- [ ] **Step 12.2: 手机 Termius 导入私钥,连面板显示的连接命令,`uname -a` 应返回本机信息**
- [ ] **Step 12.3: 冒烟结果(成功/失败与现象)追加到本 Task;失败项回对应 Task 修**

---

## Self-Review 记录

- **Spec 覆盖**:阶段一(Task 1-4)、阶段二(Task 8-10:ssh.mjs/路由/UI)、阶段三(Task 5-7 改名、Task 11 发布)全覆盖;spec 的「信任边界说明」「平台边界」「回滚」落进对应任务注释与 README 章节。无缺口。
- **占位符扫描**:Task 9.1 的测试桩明确指向「照抄 apply-test.mjs 现有桩」而非发明;Task 10.1 的 `hostKey ? null : null` 占位行已标注「实现时删除」。其余步骤均带完整代码/命令。
- **类型一致性**:`generateHostKey()` 返回 `{publicKey, privateKey}`;`installPublicKey(pubOpenSsh, {sshDir})` 返回 `{added, file, reason?}`;`checkSshd()` 返回 `Promise<boolean>`;`buildConnectCommand(user, host, port)`;路由路径统一 `/ssh-host/api/ssh/*`。一致。
