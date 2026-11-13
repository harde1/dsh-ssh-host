# dsh-sakurafrp 完善设计(升级 2.4.0 + 修复已知缺陷)

- 日期:2026-11-12
- 范围:`/Users/mac/Project/dsh-ssh-host`(实为 DSH 插件 dsh-sakurafrp 的工作副本)
- 上游:`https://github.com/MentholTea/dsh-sakurafrp`(公开仓库,default branch `master`)
- 性质:同步 + 缺陷修复;不新增功能、不改既有行为

## 背景

本地目录是 2.3.2 的无 git 拷贝,与上游 2.4.0 逐文件 diff 确认**本地无任何独立修改**
(全部差异方向为"上游独有":新增 `/natfrp/api/tunnel/delete` 路由、frpc 日志本地时间戳、
README 套件数统一等)。本地缺失 package.json `files`/`exports` 已声明的文件:
`test-all.mjs`、`test/*.mjs`(25 套件)、`locale/*.json`、`icon.svg`、`screenshots.json`、
`LICENSE`、`assets/`、`docs/`、`scripts/`。README 第 355 行承诺的 `npm test` 可复核性
在本地当前形态下不成立。

上游 2.4.0 仍存在两个经源码核实的缺陷:

1. **UA 版本硬编码**:`natfrp.mjs:9` `const UA = 'dsh-sakurafrp/2.2.0 (...)'`,
   而实际版本 2.4.0。`index.js:20-35` 注释明确记载"版本号硬编码已被这个仓库踩过一次"
   (natfrp.mjs 的 UA 正是该坑的漏网之鱼)。
2. **Windows 属主提示显示 undefined**:`index.js:843`
   ``ownerNote = `（当前文件属主可能不是你的账号，属主 UID ${st.uid}）` ``,
   Windows 的 `statSync` 结果没有 `uid` 字段,用户会看到"属主 UID undefined"。

## 设计

### 1. 仓库建立与上游同步

```
git init(已完成)→ remote add origin(已完成)
.git/info/exclude 追加 clear/(本机研究状态,不入公开仓库,不改上游 .gitignore)
git fetch origin master
git checkout origin/master -- .(把 2.4.0 全部文件检出到工作区,覆盖本地同名文件)
git add -A && git commit -m "sync: update to upstream 2.4.0"
```

- 验收:`git status` 除 `clear/` 外干净;README/test/locale/icon/LICENSE 齐全;
  `npm test` 25 套件 700 项全绿(若上游本身有红项,如实记录,不掩盖、不顺手修)。
- Node v22.11.0 满足 engines >= 18.2。

### 2. 缺陷修复 ①:UA 版本硬编码

- `natfrp.mjs` 的 `createClient(token, opts)` 增加可选 `opts.version`;
  UA 拼为 `dsh-sakurafrp/${version || '0.0.0'} (DeepSeek Harness plugin)`。
- `index.js` 的两处 `createClient` 调用(`apiOrNull`)传入已有的 `PLUGIN_VERSION`
  (该常量已从 package.json 现读,机制现成,不引入新依赖)。
- **不采用** `import ... from './package.json' with { type: 'json' }`:engines 声明
  `>=18.2`,import attributes 在该区间的 Node 版本行为碎片化(assert vs with),
  收益(省一个参数)远小于兼容风险。
- 验收:`verify.mjs` 增加断言——默认 UA 含 `dsh-sakurafrp/0.0.0` 且不含 `2.2.0`;
  传入 `version: '9.9.9'` 时 UA 含 `dsh-sakurafrp/9.9.9`。

### 3. 缺陷修复 ②:Windows 属主 UID 提示

- `index.js` 提取模块级纯函数 `ownerNoteFor(stat)`:仅当 `Number.isFinite(stat?.uid)`
  时返回 `（当前文件属主可能不是你的账号，属主 UID ${stat.uid}）`,否则返回空串。
  `diagnoseWriteFailure` 的 EPERM/EACCES 分支改用它拼接 `hint`。
- 提取为纯函数的目的:Windows/Unix 两种输入都能直接单测,不必构造真实 EPERM 场景。
- 验收:新增断言——`{ uid: 501 }` 输出含"属主 UID 501";`{}`(undefined)输出空串。

### 4. 版本、提交与推送

- `package.json` version 2.4.0 → **2.4.1**(patch:两处缺陷修复,无行为新增)。
- 提交拆两笔:`sync: update to upstream 2.4.0` 与 `fix: derive UA version and guard
  owner-uid note (2.4.1)`。
- 推送 `git push origin master`(用户即仓库主人;若本机无推送凭据,停在本地提交并明确告知)。

## 错误处理与回滚

- 同步后先建 700 项基线再动代码;基线不绿不进入修复步骤(先报告差异)。
- 全部动作可由 git 回滚(`git reset --hard <commit>`),无不可逆操作。
- 推送失败不重试第二把,读清原因后报告。

## 测试

- 基线:`npm test`(25 套件 700 项,离线,不连 SakuraFrp)。
- 新增断言并入现有套件(`verify.mjs` 管 API 客户端;`ownerNoteFor` 放同一套件或
  `fixes-test.mjs`,以套件现有组织为准)。
- 完成态:全部套件绿 + 两处新断言通过 + `git status` 干净。

## 边界

- 不动功能行为、不加新功能、不改上游测试的既有断言。
- `clear/` 与 `docs/superpowers/`(本设计文档)视情况:设计文档随仓库提交
  (它属于本工作副本的历史),`clear/` 永不入库。
