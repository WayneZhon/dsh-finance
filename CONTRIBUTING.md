# 贡献指南

先谢谢你来。这个插件存在的理由是「记账太累，所以让它自动一点」，任何让这件事更省力的改动都欢迎。

## 最快的上手方式

```bash
git clone <repo> @wayne/dsh-finance
cd @wayne/dsh-finance
npm run build      # 把 locale 字典编译进 client.js
npm test           # 169 例，全离线，不需要模型也不需要网络
```

然后在 Harness 的插件管理器里 `install_bundle`，`target` 填这个目录的绝对路径。

## 开发循环

| 你改了什么 | 怎么看到效果 |
|---|---|
| `client.src.js` / `locale/*.json` | `npm run build` 后刷新页面即可 |
| `index.js` / `lib/*.js` | 需要在插件管理器里关掉再打开这个插件（或重启 Harness） |

**`client.js` 是构建产物，不要手改。** 它由 `scripts/build.mjs` 从 `client.src.js` + `locale/*.json` 生成；CI 和 `prepublishOnly` 都会用 `--check` 验证它是否与源码一致。

## 三条硬约束

1. **金额一律用「分」的整数。** `1234` 表示 ¥12.34。只有展示时才除以 100。任何在计算路径上出现浮点元的写法都会被 review 拦下。
2. **浏览器半边只能 require `react` 和 `react/jsx-runtime`。** 其余全部用平台无关的 DOM、SVG 和 `--dsw-*` 主题 token。构建脚本会拦住违规的 require。
3. **Host 半边不 import 任何 `@deepseek-ai/*`。** 只通过 `ctx.tools` / `ctx.webServer` / `ctx.llm` 这些 `ctx.*` 服务取能力。

还有一条软约束但很重要：**AI 永远是可选的增强。** 没配模型 / 超时 / 返回垃圾内容时，必须降级到规则结果，并且界面要如实标注来源，不能假装是 AI 算的。

## 加一个账单格式

这是最欢迎的贡献类型——各家银行导出的格式千奇百怪。

1. 把一份**脱敏后**的样例放到 `scripts/fixtures/`（把真实姓名、卡号、账号换成 `张三` / `1234`）。
2. 在 `lib/importer.js` 的表头别名表里补上这种格式的列名，或在方向值映射里补上它的写法。
3. 在 `lib/importer.test.mjs` 加一条用例，断言「行数不丢 + 方向正确 + 金额单位正确」。

解析的黄金规则是**绝不丢行**：认不出来的行进 `skipped` 并给一句人话 warning，不静默丢弃。

## 提交前自查

```bash
npm run build      # 重建产物
npm test           # 169 例必须全绿
npm run check      # 语法 + 产物是否最新
npm run pack:check # 看看发布出去的 tarball 里有啥
```

如果 `npm test` 里有你改掉的旧断言，请确认是**需求变了**而不是为了让测试变绿而放宽断言——这个仓库的面板测试有 34 条，故意写得比较紧。

## 关于隐私的约定

这是一个理财插件，数据敏感程度很高。以下几条不接受折衷：

- 不新增任何把账单内容发到第三方的路径。唯一的出网调用是 AI 洞察，走用户自己的默认模型，且只发聚合后的数字摘要，不发逐笔商户明细。
- 不引入需要统计/埋点的依赖。
- 示例数据必须纯虚构，且不能长得像真实账号（用 `example.com`、`1234` 这类）。

## Issue / PR

- Bug 请附：账单格式（脱敏）、期望看到的数字、实际看到的数字。
- 新功能请先开 issue 说清使用场景，避免辛辛苦苦写完发现方向不对。
- PR 保持小而集中，一个 PR 一件事。

## 行为准则

对事不对人。这是个让人钱包更清楚的小工具，不是辩论场。