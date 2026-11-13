// order-test.mjs — 设置页的填写顺序、按钮位置、用词是否说人话
//
// 用户历次反馈（每一条都对应下面的断言，改回去就会红）：
//   1. 「按顺序向下填完，还要回到最上面去更新隧道」→ 隧道排在密钥之后、端口之前
//   2. 「他说什么『对齐』，我不太明白」       → 界面文案里不许出现这个词
//   3. 「④ 隧道 移到第二个位置」              → 顺序 = 密钥 → 隧道 → 端口 → 密码
//   4. 「访问密钥最后面要有清除按钮 / 附近要获取密钥」
//   5. 「隧道名称最后的『离线』删掉，没啥用」
//   6. 「选节点时在后方显示空闲状态，并用颜色」
//   7. 「增加删除隧道的功能」→ 只删当前选中那条，删前必须二次确认
//
// 这类问题不会被语法错误或单元测试抓到，只能对源码做结构断言。
const results = []
const rec = (n, p, d = '') => { results.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`) }

import { readFileSync, readdirSync } from 'node:fs'
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')

/** 取 Panel() 渲染区（从 return h('div', { style: S.wrap } 起）用于判断视觉顺序 */
const panelSrc = client.slice(client.indexOf("h('div', { style: S.wrap }"))
const pos = (needle) => panelSrc.indexOf(needle)

// ── 1) 高级区填写顺序：隧道 → 端口 → 密码 → 保存 ──
// ① 访问密钥已从高级区移除：SSH hero 卡里「粘贴即存」，高级区不再有密钥输入框。
// 高级区只剩 DSH 网页入口相关的 ②③④（端口已自动预填，密码只在 DSH 穿透才需要）。
const pTunnel = pos('② 隧道')
const pPort = pos('③ 本机端口')
const pPwd = pos('④ 访问密码')
const pSave = panelSrc.lastIndexOf("busy ? '保存中…' : '保存'")

rec('② 隧道存在', pTunnel > 0, String(pTunnel))
rec('③ 本机端口存在', pPort > 0, String(pPort))
rec('④ 访问密码存在', pPwd > 0, String(pPwd))

rec('高级区不再有 ① 访问密钥输入框（已移入 hero）', !panelSrc.includes('① SakuraFrp 访问密钥'))
rec('隧道排在端口之前（选完隧道端口自动跟随）', pTunnel > 0 && pTunnel < pPort, `tunnel=${pTunnel} port=${pPort}`)
rec('端口排在密码之前', pPort > 0 && pPort < pPwd)
rec('密码排在保存之前', pPwd > 0 && pPwd < pSave)
rec('旧编号不再出现（② 本机端口 / ④ 隧道 已对调）',
  !panelSrc.includes('② 本机端口') && !panelSrc.includes('③ 访问密码'))

// ── 2) 访问密钥只在 hero：高级区不再有输入框 ──
// 「少填写少操作」落地：密钥只有 hero 一个入口（粘贴 → 保存并继续 → 自动建隧道）。
rec('SSH hero 有访问密钥输入框（粘贴即存）', /placeholder: '粘贴访问密钥'/.test(client))
rec('hero 保存密钥走 /config token', /await post\('\/config', \{ token: v \}\)/.test(client))
rec('高级区不再有密钥输入框与「获取密钥」按钮', !/① SakuraFrp 访问密钥/.test(client) && !/获取密钥 ↗/.test(client))

// ── 3) ② 隧道：不再拼「离线」 ──
rec('隧道下拉不再拼「离线」', !/\$\{t\.online \? '' : ' · 离线'\}/.test(client))
rec('隧道下拉只留 名字 · 节点', /`\$\{t\.name\} · \$\{t\.nodeName\}`/.test(client))

// ── 4) 节点：空闲状态 + 颜色 ──
rec('有节点状态判定函数', /function nodeStatus\(n\)/.test(client))
rec('状态分四档（空闲/一般/拥挤/满载）',
  /空闲/.test(client) && /一般/.test(client) && /拥挤/.test(client) && /满载/.test(client))
rec('状态文字写进 option（原生 option 无法着色）',
  /\$\{can \? st2\.text : '不可新建'\}/.test(client))
rec('颜色按档位给（绿/黄/橙/红）',
  /#16a34a/.test(client) && /#d97706/.test(client) && /#ea580c/.test(client) && /#dc2626/.test(client))
rec('拿不到负载时不冒充空闲', /没有|未知/.test(client) && /load < 0/.test(client))
rec('满载节点在下拉里禁用', /value: String\(n\.id\), disabled: !can/.test(client))
rec('节点用原生 select（一行放得下几十个）', /h\('select', \{[\s\S]{0,400}?— 选择节点 —/.test(client))

// ── 4b) ③ 本机端口自动预填（少填写少操作：新装不用手填端口）──
rec('前端未设端口时会请求 /ssh/host/init', /getJSON\('\/ssh\/host\/init'\)/.test(client))
rec('预填用 init.suggestPort（后端试绑的真实空闲端口）',
  /Number\.isInteger\(r\?\.suggestPort\) && r\.suggestPort >= 1024/.test(client))
rec('用户已手动编辑时不覆盖预填', /!portDirty\.current/.test(client))
rec('服务端已设端口时不预填', /!s\.gatePort/.test(client))

// ── 5) 端口：填完检测 + 双向同步 ──
rec('后端有端口检测端点', /path === '\/ssh-host\/api\/port\/check'/.test(index))
rec('前端填完就查（onBlur 触发）', /onBlur: \(\) => void checkPort\(gatePort\)/.test(client))
rec('查完给「可以用 / 被占用」的结论', /端口 \$\{n\} 可以用/.test(client) && /已被其它程序占用/.test(client))
rec('服务端改端口前先试绑（绑不上不改）', /const free = await checkPortFree\(n\)/.test(index))
rec('端口被占用时明确报错而不是静默失败', /error: 'port-in-use'/.test(index))
rec('改端口会把隧道里的端口一起改（to-panel）', /direction: 'to-panel'/.test(index))
rec('选隧道时本机端口跟随隧道（to-local）', /direction: 'to-local'/.test(index))
rec('有 adoptTunnelPort 实现', /async function adoptTunnelPort\(api\)/.test(index))
rec('隧道端口被占时反向往面板写，不一味失败', /blockedPort/.test(index))
rec('同步结果回给界面', /portSync/.test(index) && /setSyncMsg\(describeSync\(s\.portSync\)\)/.test(client))
rec('同步结论区分两个方向的说法',
  /已把本机端口改成/.test(client) && /已把隧道里的端口改成/.test(client))

// ── 6) 新建隧道：表单里带端口，建完端口两边一致 ──
rec('新建表单里有端口输入', /const \[newPort, setNewPort\]/.test(client))
rec('创建请求带 port', /port: p,/.test(client))
rec('后端接受 patch.port', /patch\.port === undefined/.test(index))
rec('后端用这个端口建隧道', /local_port: gatePort/.test(index))
rec('创建成功提示端口已同步', /本机端口也已同步/.test(client))
rec('节点列表懒加载（展开才拉）', /const openCreate = async \(\) => \{[\s\S]{0,500}?getJSON\('\/nodes'\)/.test(client))
rec('创建成功后重拉列表与状态', /await Promise\.all\(\[loadExtra\(\), loadState\(\)\]\)/.test(client))

// ── 7) 界面文案不许出现「对齐」「网关」这种内部词 ──
function uiStrings(src) {
  return src.split('\n').filter((line) => {
    const t = line.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false
    return true
  })
}
const uiLines = uiStrings(client)
const badAlign = uiLines.filter((l) => l.includes('对齐'))
const badGateway = uiLines.filter((l) => l.includes('网关'))
rec('界面代码行里没有「对齐」', badAlign.length === 0, badAlign[0]?.trim().slice(0, 60) ?? '')
rec('界面代码行里没有「网关」', badGateway.length === 0, badGateway[0]?.trim().slice(0, 60) ?? '')
rec('源码保留「为什么不用对齐」的说明', /不出现「对齐」/.test(client))

// ── 8) 端口真不一致时（在官方面板改过）仍有出口 ──
rec('不一致时按钮写明改什么', /把隧道端口改成 \$\{gatePortNum\}/.test(client))
rec('不一致时说明后果', /外网会打不开/.test(client))
rec('隧道端口做了 NaN 防护', /Number\.isFinite\(Number\(pickedTunnel\.local_port\)\)/.test(client))

// ── 9) 互踢提示里说的按钮必须真实存在 ──
rec('有 doRestart 实现', /const doRestart = async \(\) => \{/.test(client))
rec('doRestart 走 stop → start', /post\('\/stop'\)[\s\S]{0,200}?post\('\/start'\)/.test(client))
rec('互踢警告里有「重启」按钮', /kickSuspect[\s\S]{0,900}?onClick: doRestart/.test(client))

// ── 10) 后端日志也不再讲「对齐」 ──
rec('后端日志改为「改隧道端口」', /已把隧道 \$\{tunnelId\} 的端口从/.test(index))
rec('后端失败日志改为「改隧道端口失败」', /改隧道端口失败/.test(index))
rec('后端不再输出「对齐报告」', !/对齐报告/.test(index))

// ── 11) 安装后默认关闭 ──
rec('默认 enabled=false（装上就是关的）',
  /typeof state\.enabled === 'boolean' \? state\.enabled : config\.enabled === true/.test(index))
rec('不再有「默认开启」的旧写法', !/state\.enabled \?\? config\.enabled !== false/.test(index))

// ── 12) 文档同步 ──
rec('README 首次使用按新顺序（密钥→隧道→端口→密码）',
  /① 访问密钥[\s\S]{0,900}?② 隧道[\s\S]{0,900}?③ 本机端口[\s\S]{0,900}?④ 访问密码/.test(readme))
rec('README 说明四步是逐步解锁的', /逐步解锁/.test(readme))
rec('README 说明日志默认展开且实时刷新', /日志默认展开/.test(readme))
rec('README 不再叫「一键对齐」', !/一键对齐/.test(readme))

// ── 12b) 文档与「SSH 中心 + 折叠高级区」同步（README 曾经整段还在讲上游四步）──
rec('README 顶部说明界面是 SSH 中心卡 + 默认收起的高级区',
  /SSH 中心卡[\s\S]{0,300}?「高级」区/.test(readme))
rec('README 说明安装引导与日志故意留在高级区之外',
  /留在区外\*\*——缺 frpc 时 SSH 也连不上/.test(readme))
rec('README 快速开始首行不再要求先去面板配访问密钥',
  !/并且已在面板 \*\*① 访问密钥\*\* 里配好访问密钥/.test(readme))
rec('README 写明 SSH 这条路只需三步', /快速开始\(SSH 连入只需三步/.test(readme))
rec('README 说明节点由三级回退自动选定、不必手填',
  /三级回退/.test(readme) && /不需要传、也不需要人挑/.test(readme))
rec('README 说明建好隧道自动开启通道',
  /通道没开时自动开启并拉起 frpc|自动开启并拉起 frpc/.test(readme))
rec('README 说明手工关掉通道不会被自动复活', /不会被它复活/.test(readme))
rec('README 写明 authkey 不是可选的（Termius 报 Unsupported key type）',
  /`authkey` 不是可选的/.test(readme) && /Unsupported key type: PRIVATE KEY/.test(readme))
rec('README 把格式判据交给 ssh-keygen 而不是「看起来像 PEM」',
  /格式是否合法由系统 `ssh-keygen` 判[\s\S]{0,200}?逐字节一致/.test(readme)
    && /`ssh-keygen -y` 反推公钥/.test(readme))
rec('README 说明 ④ 口令只属于 DSH 网页入口，SSH 不经过它',
  /中心卡里没有任何口令概念[\s\S]{0,200}?SSH 流量不经过它/.test(readme))
rec('README 交代深链按 Darwin 主版本选 anchor', /com\.apple\.Sharing-Settings\.extension/.test(readme))
rec('README 诚实标注密度像素预算在本机是 SKIP 的', /density-test[\s\S]{0,160}?SKIP/.test(readme))
rec('README 诚实标注预览 React 桩与真 React 不等价', /preview-render\.mjs[\s\S]{0,200}?不等价/.test(readme))
// 数字最容易飘：每次加断言 README 的项数就过期一次。这里不写死数字，
// 而是校验 README 自己内部一致 —— 正文声明的总数/套件数必须等于套件表求和，
// 且表里的套件名必须和 test/ 目录实际文件一一对应。
const table = [...readme.matchAll(/^\| `([a-z-]+\.mjs)` \| (\d+) \|/gm)]
const declared = +(readme.match(/26 个套件、(\d+) 项/) || [])[1]
  || +(readme.match(/# 26 个套件、(\d+) 项/) || [])[1]
rec('README 套件表能解析出 26 行', table.length === 26, `${table.length} 行`)
rec('README 正文声明的总项数 = 套件表求和',
  table.reduce((a, m) => a + Number(m[2]), 0) === declared, `表=${table.reduce((a, m) => a + Number(m[2]), 0)} 声明=${declared}`)
// 正文里凡是「N 个套件、M 项」这种成对声明,数字必须全部一致(不写死具体值:
// 每次加断言它都会变,写死就是埋下一个过期点)。逐套件那一列由 runner 核对。
const claims = [...readme.matchAll(/(\d+) 个套件、(\d+) 项/g)]
rec('README 的总数声明彼此一致', claims.length >= 2
  && claims.every((m) => m[1] === claims[0][1] && m[2] === claims[0][2]),
  claims.map((m) => `${m[1]}/${m[2]}`).join(' '))
const listed = new Set(table.map((m) => m[1]))
const onDisk = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.mjs'))
rec('README 列出的套件与 test/ 目录实际文件一一对应',
  onDisk.filter((f) => !listed.has(f)).length === 0 && [...listed].every((f) => onDisk.includes(f)),
  `缺表=${onDisk.filter((f) => !listed.has(f)).join(',')} 多表=${[...listed].filter((f) => !onDisk.includes(f)).join(',')}`)
// 逐套件的项数不写死在这里：本套件自己是 107 还是 120 只有跑完才知道，
// 写死等于埋一个新的过期点。那层核对放在 test-all.mjs（唯一知道各套件真实项数
// 与总数的地方），它会拿实跑数字逐行比对 README 的套件表。
rec('README 套件表的项数交给 runner 逐行核对（本文件不写死数字）',
  /npm test 会核对 README 的套件表/.test(readme))
rec('README 预览形态含 adv（高级区展开态）', /`adv`/.test(readme))

// ── 13) 刷新列表按钮去掉，改为选中/新建时自动刷新 ──
rec('隧道区不再有「刷新列表」按钮', !/刷新列表/.test(client))

// ── 14) 删除隧道：只对当前选中的那条出现，且删前二次确认 ──
rec('删除按钮只在选中隧道且未展开新建表单时出现',
  /st\.tunnelId && !newOpen[\s\S]{0,700}?'删除隧道'/.test(client))
rec('删除前弹确认框，并说明不可恢复',
  /window\.confirm\([\s\S]{0,400}?删除不可恢复/.test(client))
rec('删除走 POST /tunnel/delete 且只传 id',
  /post\('\/tunnel\/delete', \{ id: Number\(id\) \}\)/.test(client))
rec('删除的是当前隧道时提示公网访问已停止',
  /s\.wasCurrent[\s\S]{0,400}?公网访问已停止/.test(client))
rec('后端路由校验 id 并调用官方 tunnelDelete',
  /\/ssh-host\/api\/tunnel\/delete[\s\S]{0,1200}?api\.tunnelDelete\(\[id\]\)/.test(index))
rec('后端把 failed 当「已删但没踢下线」而不是删除失败',
  /failed 不是「删除失败」/.test(index))
rec('删除当前隧道后清空 tunnelId 并关闭开关',
  /wasCurrent[\s\S]{0,300}?enabled = false[\s\S]{0,120}?tunnelId = ''/.test(index))

// ── 15) SSH 中心（hero 卡）：用户的唯一入口，遗留隧道 UI 收进折叠的「高级」区 ──
// 这是锁定设计的落地校验（「操作界面不要与上游过于相似」+「化繁为简，少填写少操作」）：
//   · SSH 卡在最上面，先于任何 frpc 配置出现；
//   · 卡内提供 一键复制连接命令 + 按内核版本选深链的远程登录按钮 + 通道开关；
//   · SSH 路径是纯密钥认证，卡内不得出现「密码」字样（④ 那条属于 DSH 网页入口，留在高级区）。
// 取样按真实函数体边界（到下一个组件定义为止），不用固定字符窗口：
// 窗口截断会让「卡内零某字样」这类断言漏掉后半段的内容。
const heroStart = client.indexOf('function SshHero')
const heroSrc = client.slice(heroStart, client.indexOf('function NatfrpSidebarIcon', heroStart))
rec('SshHero 组件存在', client.includes('function SshHero'))
// 注意坐标系：pos() 是 panelSrc 切片内的偏移，hero 的挂载点在切片之前（面板第一屏），
// 必须换算成同一坐标再比，否则永远「不在之前」。
const panelStart = client.indexOf("h('div', { style: S.wrap }")
// ① 已不在高级区：hero 是访问密钥的唯一入口，只要求它先于高级区折叠头即可。
const advHeaderPos = client.indexOf('── 高级（默认收起）')
rec('SSH hero 渲染在高级区折叠头之前（它是唯一入口）',
  client.indexOf('h(SshHero') > 0 && client.indexOf('h(SshHero') < advHeaderPos,
  `hero=${client.indexOf('h(SshHero')} advHeader=${advHeaderPos}`)
rec('连接命令可一键复制（clipboard + textarea 兜底）',
  /navigator\.clipboard/.test(heroSrc) && /document\.createElement\('textarea'\)/.test(heroSrc))
rec('复制后给出「已复制」反馈', /已复制/.test(heroSrc))
rec('远程登录深链按 darwinMajor 选（Ventura 起换新面板 anchor）',
  /darwinMajor/.test(heroSrc) && /com\.apple\.Sharing-Settings\.extension/.test(heroSrc)
  && /com\.apple\.preferences\.sharing\?Services/.test(heroSrc))
rec('hero 卡有通道开关（复用 doToggle 语义：POST /start|/stop）',
  /post\('\/start'\)|doToggle|onChange: \(\w+\) =>/.test(heroSrc) && /channel/.test(heroSrc))
rec('SSH hero 卡内零「密码」字样（纯密钥认证）', !/密码/.test(heroSrc),
  `${(heroSrc.match(/密码/g) || []).length} 处`)
rec('hero 卡把 sshd 未开 / 无密钥 / 无隧道三种阻塞各自说清',
  /远程登录/.test(heroSrc) && /生成|密钥/.test(heroSrc) && /隧道/.test(heroSrc))
rec('旧版硬编码深链已不再出现在 SSH 区（改由 darwinMajor 判定）',
  !/location\.href = 'x-apple\.systempreferences:com\.apple\.preferences\.sharing\?Services'/.test(client))

// ── 15b) 自动化引擎：能自动的步骤全自动，用户只填一次访问密钥 ──
// 「少填写少操作」的落地校验。这里只做结构断言（真触发过的行为验证见 reports/）：
//   · sshd 已开 + 无密钥 → 自动 POST /ssh/key/create；
//   · 有密钥 + 无隧道 + 访问密钥就位 → 自动 POST /ssh/tunnel/create；
//   · 每步只自动试一次（失败停在原因 + 「重试」按钮），靠 tried ref + autoLock 保证。
rec('有防重复触发的自动锁', /const autoLock = useRef\(false\)/.test(heroSrc))
rec('自动生成密钥只试一次（tried ref）', /const keyAutoTried = useRef\(false\)/.test(heroSrc))
rec('自动建隧道只试一次（tried ref）', /const tunnelAutoTried = useRef\(false\)/.test(heroSrc))
rec('自动生成密钥的 effect 存在且带 sshd / 密钥条件',
  /if \(!isMac \|\| ssh\?\.sshdUp !== true \|\| Boolean\(ssh\?\.key\) \|\| keyAutoTried\.current\) return\n\s+void createKey\(\{ auto: true \}\)/.test(heroSrc))
rec('自动建隧道的 effect 存在且带隧道 / 访问密钥条件',
  /if \(ch\.hasToken === false \|\| tunnelAutoTried\.current\) return\n\s+void createTunnel\(\{ auto: true \}\)/.test(heroSrc))
rec('自动生成密钥的叙事与按钮状态联动（busy==key 时出现）',
  /busy === 'key'\n\s*\? '正在自动生成密钥…/.test(heroSrc))
rec('自动创建隧道的叙事不再依赖已删除的 autoStep 状态',
  !/autoStep/.test(heroSrc))
rec('自动创建隧道的叙事与 busy 联动', /'正在自动创建隧道…（节点由系统自动选定,建好自动开启通道）'/.test(heroSrc))
rec('自动建隧道失败时给出原因', /自动建隧道没成功:/.test(heroSrc))
rec('失败后有显式「重试」按钮（不无限重试）', /'重试'/.test(heroSrc))
// 缘由：早先写成「onClick 里手动把 tried 置 false」，后来把解锁收进 createKey /
// createTunnel 的 opts.auto 参数 —— 自动调用上锁、手动点击解锁，两种入口共享同一段
// 加锁逻辑，不会再出现「点了按钮却还被锁挡住」的偏差。
rec('自动与手动共用一套加锁逻辑（auto 传参区分上锁/解锁）',
  /keyAutoTried\.current = opts\.auto \? true : false/.test(heroSrc)
  && /tunnelAutoTried\.current = opts\.auto \? true : false/.test(heroSrc))
rec('自动引擎调用时显式标 auto（防止异步期间被轮询重复触发）',
  /void createKey\(\{ auto: true \}\)/.test(heroSrc) && /void createTunnel\(\{ auto: true \}\)/.test(heroSrc))
// 缘由：早先断言 `void createKey()` 的位置，但它同时命中手动按钮那处调用；改成
// 只认带 { auto: true } 的引擎调用点。另外不能直接找 `if (!ssh) return null` 字面量 ——
// 自动化 effect 的说明注释里就引用了这行代码，会把注释当成早退位置；这里改用
// effect 回调本身当左边界，它必然在早退语句之前。
rec('自动化 effect 排在 ssh 早退之前（hook 顺序不能随加载态变化）',
  heroSrc.indexOf('if (!isMac || ssh?.sshdUp !== true || Boolean(ssh?.key) || keyAutoTried.current) return') > 0
    && heroSrc.indexOf('if (!isMac || ssh?.sshdUp !== true || Boolean(ssh?.key) || keyAutoTried.current) return')
      < heroSrc.lastIndexOf('if (!ssh) return null'))

// ── 16) 「高级」区：遗留 UI 整段收起，默认关，功能项一个不少 ──
// 折叠头在 frpc 版本条之前，容器闭合在日志锚点之前 —— 用这两条边界判断
// 遗留项是不是真的被包住了，而不是只加了个假按钮。
const advHead = client.indexOf('收起高级设置') > 0 || client.indexOf('高级（DSH 隧道')
const advAnchor = client.indexOf("const [advOpen, setAdvOpen] = useState(readAdvOpenPref)")
// 区域边界要用「折叠头」本身，不能用 state 声明：声明在函数体顶部，比整棵
// 渲染树都早，拿它当边界会把 hero 和安装引导误判成「在高级区之后」。
const advHeader = client.indexOf('── 高级（默认收起）')
const logsAnchorAbs = client.indexOf('// ── 日志 ──')
rec('「高级」折叠区锚点存在', advAnchor > 0 && advHeader > 0)
rec('SSH hero 渲染在高级区之前（主界面只讲 SSH）',
  client.indexOf('h(SshHero') > 0 && client.indexOf('h(SshHero') < advHeader)
rec('高级区默认收起（readAdvOpenPref 没存过时返回 false）',
  /function readAdvOpenPref\(\)[\s\S]{0,400}?return false/.test(client))
rec('折叠选择落盘（与日志偏好同一套 localStorage 手法）',
  /writeAdvOpenPref\(next\)/.test(client) && /dsh-ssh-host\.advOpen/.test(client))
// ① 访问密钥已随「少填写少操作」移除（hero 是唯一入口）——不再检查它。
for (const [name, needle] of [['② 隧道', "// ── ② 隧道 ──"],
  ['③ 本机端口', '③ 本机端口：选了隧道才出现'], ['④ 访问密码', "'④ 访问密码'"], ['保存按钮', "busy ? '保存中…' : '保存'"],
  ['frpc 版本条', 'h(FrpcVersionBar']]) {
  const at = client.indexOf(needle)
  rec(`${name} 收在高级区内（折叠头之后、日志之前）`,
    at > advHeader && at < logsAnchorAbs, `at=${at} advHeader=${advHeader} logs=${logsAnchorAbs}`)
}
rec('frpc 安装引导留在高级区之外（缺 frpc 时仍要第一眼看见）',
  client.indexOf('h(FrpcInstallCard') < advHeader)
rec('日志留在高级区之外（收起时也要能查故障）',
  logsAnchorAbs > client.indexOf("busy ? '保存中…' : '保存'"))
rec('折叠按钮带 aria-expanded（可被辅助技术读到开合状态）',
  /'aria-expanded': advOpen/.test(client))
rec('高级区内说明 SSH 连入不需要动它', /纯 SSH 连入不需要动/.test(client))

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} passed`)
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 200)
