#!/usr/bin/env node
// test-all.mjs —— 一把跑完全部离线测试套件
//
// 约定：文件名以 `-test.mjs` 结尾，或就是 `verify.mjs`。
// 每个套件自己打印 `N/N passed`，本脚本只做编排与汇总，不改任何一个套件的断言。
//
//   node test-all.mjs          全部跑一遍
//   node test-all.mjs path     只跑名字含 "path" 的套件
//
// 全部离线：不连 SakuraFrp、不需要访问密钥、不写任何用户目录。

import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const suiteDir = join(here, 'test')
const filter = process.argv[2] ?? ''

const suites = readdirSync(suiteDir)
  .filter((f) => f.endsWith('-test.mjs') || f === 'verify.mjs')
  .filter((f) => !filter || f.includes(filter))
  .sort()

if (suites.length === 0) {
  console.error(`没有匹配的套件${filter ? `（关键字：${filter}）` : ''}`)
  process.exit(1)
}

let passed = 0
let failed = 0
const actual = []
const failedNames = []

for (const file of suites) {
  const r = spawnSync(process.execPath, [join(suiteDir, file)], { encoding: 'utf8', timeout: 120_000 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/(\d+)\/(\d+) passed/)
  const [got, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0]

  if (r.status === 0 && m && got === total) {
    passed += total
    actual.push([file, total])
    console.log(`  ok   ${file.padEnd(26)} ${got}/${total}`)
  } else {
    failed += total - got || 1
    failedNames.push(file)
    console.log(`  FAIL ${file.padEnd(26)} ${got}/${total}`)
    const tail = out.trim().split('\n').slice(-6).join('\n')
    if (tail) console.log(tail.replace(/^/gm, '       '))
  }
}

const total = passed + failed
console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed}/${total} 项，${suites.length} 个套件`)

// ── 文档数字核对 ──
// README 的套件表逐项写了「哪个套件几项」。这类数字每次加断言就会过期,而人不会
// 记得改 —— 之前它长期停在 807 项/92 项就是例子。本脚本是唯一知道每个套件真实
// 项数的地方,所以由它来判:对不上就红(且带 filtered 跑时跳过,局部跑不该改文档)。
if (!filter) {
  const readme = readFileSync(join(here, 'README.md'), 'utf8')
  const rows = [...readme.matchAll(/^\| `([a-z-]+\.mjs)` \| (\d+) \|/gm)]
  const claimed = new Map(rows.map((m) => [m[1], Number(m[2])]))
  const wrong = actual.filter(([f, n]) => claimed.get(f) !== n)
    .map(([f, n]) => `${f}: README 写 ${claimed.get(f) ?? '缺行'},实跑 ${n}`)
  const missing = suites.filter((f) => !claimed.has(f))
  const stale = rows.map(([, f]) => f).filter((f) => !suites.includes(f))
  const sum = actual.reduce((a, [, n]) => a + n, 0)
  const decl = [...readme.matchAll(/(\d+) 个套件、(\d+) 项/g)]
  const docBad = [
    ...wrong,
    ...missing.map((f) => `README 套件表缺 ${f}`),
    ...stale.map((f) => `README 套件表有 ${f},但 test/ 里没有这个套件`),
    ...(sum === 0 ? [] : [
      ...(decl.some((m) => Number(m[2]) !== sum) ? [`README 声明总项数 ${[...new Set(decl.map((m) => m[2]))].join('/')} ≠ 实跑 ${sum}`] : []),
      ...(decl.some((m) => Number(m[1]) !== suites.length) ? [`README 声明套件数 ≠ ${suites.length}`] : []),
    ]),
  ]
  if (docBad.length) {
    console.log('\nREADME 数字过期:')
    for (const d of docBad) console.log(`  - ${d}`)
    process.exitCode = 1
  } else if (failed === 0) {
    console.log(`(README 数字与实跑一致：${total} 项 / ${suites.length} 个套件)`)
  }
}
if (failedNames.length) {
  console.log(`失败套件：${failedNames.join(', ')}`)
  process.exit(1)
}
