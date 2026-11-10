/**
 * 个人理财工作台的八个 agent 工具。
 *
 * 每个工具的结果都只走一条路返回给模型：`output.render` 把字符串渲染成
 * `[{ type: "text", text }]` — 与宿主内置工具（`read_file` / `web_search`）
 * 的卡片一致。模型读到的是**人话**，不是 JSON 字符串。
 *
 * 注册契约以宿主 `tools` Service 的 `ToolDefinition` 为准：
 *
 * ```ts
 * interface ToolDefinition extends ToolSchema {   // name / description / parameters
 *   readonly output: ToolOutputDefinition;         // { schema: JsonSchemaNode, render(args, value): ContentBlock[] }
 *   execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
 *   isConcurrencySafe?(args: unknown): boolean;
 *   presentCall?(args: unknown): ToolCallView | undefined;
 * }
 * ```
 *
 * 参数用**原始 JSON Schema**（宿主 `JsonSchemaNode` 的形状），不依赖
 * `defineTool`，也不 import 任何 `@deepseek-ai/*`。
 *
 * **金额单位**：工具参数一律用**元**（`number`，可以是小数），内部转成分入库。
 * 模型更容易说清楚「35 块」；分只在插件内部使用。
 *
 * 用法（index.js 里）：
 * ```js
 * const disposers = registerTools(ctx, { store, ai, config });  // ctx 已 inject: ["tools"]
 * ```
 *
 * @module dsh-finance/lib/tools
 */

import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";

import {
  ASSET_KINDS,
  CATEGORIES,
  EXPENSE_CATEGORIES,
  HOLDING_TYPES,
  INCOME_CATEGORY,
  KIND_LABELS,
  LIABILITY_KINDS,
  PURPOSES,
  currentMonth,
  dateInMonth,
  dayKey,
  formatCents,
  isDateText,
  isMonthText,
  monthKey,
  monthRange
} from "./domain.js";
import { classify, autoRateOf } from "./classify.js";
import { parseBillWithCategories } from "./importer.js";
import { needsAiOf } from "./ai.js";
import { financeSnapshot } from "./analysis.js";


/** 八个工具的名字，顺序固定。 */
export const TOOL_NAMES = Object.freeze([
  "finance_overview",
  "finance_add_txn",
  "finance_query_txns",
  "finance_import_bill",
  "finance_net_worth",
  "finance_investments",
  "finance_budget",
  "finance_export"
]);

/** 一个账单文件的大小上限（字节）：再大就不该走 agent 工具了。 */
const MAX_BILL_BYTES = 32 * 1024 * 1024;

/** 查询流水默认条数。 */
const DEFAULT_QUERY_LIMIT = 30;

/** 查询流水上限。 */
const MAX_QUERY_LIMIT = 200;

/** 导出 CSV 默认文件名前缀。 */
const EXPORT_PREFIX = "dsh-finance";

// ── schema 与描述 ────────────────────────────────────────────────────────

/**
 * 组一个对象 schema：`additionalProperties: false`，必填字段单独列。
 * @param {Record<string, unknown>} properties 字段。
 * @param {string[]} [required] 必填字段名。
 * @returns {Record<string, unknown>} JSON Schema。
 */
function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

/** 月份参数描述。 */
const MONTH_HELP = "月份，格式 YYYY-MM（例如 2026-11）。不传就用当前月份。";

/** 分类枚举（不含「收入」，收入方向单独表达）。 */
const EXPENSE_CATEGORY_ENUM = EXPENSE_CATEGORIES;

/** `finance_overview` 的参数。 */
export function overviewParameters() {
  return objectSchema({ month: { type: "string", description: MONTH_HELP } });
}

/** `finance_add_txn` 的参数。 */
export function addTxnParameters() {
  return objectSchema(
    {
      amount: { type: "number", description: "金额，单位**元**（不是分），恒填正数。例如 35 表示 35 元，12.5 表示 12 元 5 角。" },
      direction: {
        type: "string",
        enum: ["expense", "income"],
        description: "expense 支出（默认），income 收入。用户说「收了 / 进账 / 发工资」就是 income。"
      },
      category: {
        type: "string",
        enum: [...EXPENSE_CATEGORY_ENUM, INCOME_CATEGORY],
        description: "可选分类。不传就按商户名自动归类；用户明确说了类别（「打车」→交通、「吃饭」→餐饮）就传。收入方向固定用「收入」。"
      },
      merchant: { type: "string", description: "商户或摘要，例如「星巴克」「公司发工资」。尽量用用户原话里的词。" },
      date: { type: "string", description: "日期 YYYY-MM-DD。不传就记成今天；用户说「昨天 / 上周五」请先算好再传。" },
      purpose: {
        type: "string",
        enum: [...PURPOSES],
        description: "可选记账目的。不传就按分类推。收入行的 purpose 会被忽略。"
      },
      account: { type: "string", description: "可选付款账户，例如「支付宝」「招商银行」「现金」。不传就用「现金」。" },
      note: { type: "string", description: "可选备注。" }
    },
    ["amount"]
  );
}

/** `finance_query_txns` 的参数。 */
export function queryTxnsParameters() {
  return objectSchema({
    month: { type: "string", description: `月份 YYYY-MM；不传就查全部月份的最近 ${DEFAULT_QUERY_LIMIT} 笔。` },
    q: { type: "string", description: "可选关键词，匹配商户、备注、账户、分类。" },
    category: { type: "string", enum: [...EXPENSE_CATEGORY_ENUM, INCOME_CATEGORY], description: "可选分类。" },
    direction: { type: "string", enum: ["expense", "income"], description: "可选方向。" },
    limit: { type: "integer", description: `最多返回几笔，默认 ${DEFAULT_QUERY_LIMIT}，上限 ${MAX_QUERY_LIMIT}。` }
  });
}

/** `finance_import_bill` 的参数。 */
export function importBillParameters() {
  return objectSchema({
    path: { type: "string", description: "用户给出的账单文件**完整路径**，例如 /Users/x/Downloads/支付宝账单.csv。不要自己编路径。" },
    confirm: {
      type: "boolean",
      description: "是否直接入库。默认 false：只预览并回报「读了 N 笔、自动归类 M 笔」，让用户确认后再传 true 入库。"
    }
  }, ["path"]);
}

/** `finance_net_worth` 的参数。 */
export function netWorthParameters() {
  return objectSchema({});
}

/** `finance_investments` 的参数。 */
export function investmentsParameters() {
  return objectSchema({});
}

/** `finance_budget` 的参数。 */
export function budgetParameters() {
  return objectSchema({
    op: {
      type: "string",
      enum: ["view", "set_budget", "remove_budget", "add_goal", "contribute_goal"],
      description:
        "view 只看（默认）；set_budget 设预算；remove_budget 删预算；add_goal 新建存钱目标；contribute_goal 往目标里存钱。"
    },
    month: { type: "string", description: `set_budget / remove_budget 的月份，YYYY-MM 或 default（默认档）。不传就用当前月。` },
    category: {
      type: "string",
      enum: [...EXPENSE_CATEGORY_ENUM],
      description: "set_budget / remove_budget 必填：预算分类。"
    },
    limit: { type: "number", description: "set_budget 必填：预算限额，单位**元**。" },
    name: { type: "string", description: "add_goal 必填：目标名字，例如「应急金」。" },
    target: { type: "number", description: "add_goal 必填：目标金额，单位**元**。" },
    deadline: { type: "string", description: "add_goal 可选：截止日期 YYYY-MM-DD。" },
    saved: { type: "number", description: "add_goal 可选：已经存了多少，单位**元**。" },
    goalId: { type: "string", description: "contribute_goal 必填：目标 id（先 op:view 拿到）。" },
    amount: { type: "number", description: "contribute_goal 必填：这次存入多少，单位**元**（可为负数表示取出）。" }
  });
}

/** `finance_export` 的参数。 */
export function exportParameters() {
  return objectSchema({
    month: { type: "string", description: "只导出该月流水（YYYY-MM）；不传就导出全部流水。资产/负债/持仓/预算/目标始终全部包含。" },
    format: { type: "string", enum: ["csv", "json"], description: "csv（默认，Excel 能直接打开）或 json（完整备份）。" },
    path: { type: "string", description: "可选：保存路径（绝对路径或相对当前工作目录）。不传就写到工作区根目录。" }
  });
}

/** `finance_overview` 的模型说明。 */
function overviewDescription() {
  return [
    "看用户的理财看板概况：某个月的收入、支出、结余、支出分类占比、最近趋势、净资产、预算使用、存钱目标。",
    "用户问「我这个月花了多少 / 钱花哪儿了 / 这个月怎么样 / 我的财务状况」时用这个。",
    "返回的都是现算的数字（单位元），不用自己再算；回答时把关键数字讲清楚，不要罗列全部字段。"
  ].join("");
}

/** `finance_add_txn` 的模型说明。 */
function addTxnDescription() {
  return [
    "给用户记一笔账（流水），立刻写进他本机的账本。",
    "用户说「记一笔 / 帮我记一下 / 刚花了 / 今天买了 / 收到工资」并给出了跟钱有关的事与金额时，直接调用，不要反问要不要记。",
    "金额 amt 单位是**元**；只给了支出就不用传 direction。用户没说的字段不要编：date 不传就记今天。",
    "分类能不传就不传，让规则根据商户名自动归类；用户明确说了类别再传 category。",
    "示例：用户「记一笔 35 块咖啡」→ {amount:35, merchant:\"咖啡\"}；",
    "示例：用户「昨天打车花了 42」→ {amount:42, merchant:\"打车\", category:\"交通\", date:\"<昨天的 YYYY-MM-DD>\"}。"
  ].join("");
}

/** `finance_query_txns` 的模型说明。 */
function queryTxnsDescription() {
  return [
    "按月份 / 关键词 / 分类 / 方向查用户的流水明细，返回每一笔的日期、商户、金额、分类。",
    "用户问「上个月餐饮花了多少 / 有没有一笔 200 多块的 / 我最近都买了什么」时用；需要明细或核对具体某笔时用它，看汇总用 finance_overview。",
    "结果最多返回 limit 笔，并会说明总共有多少笔；不够就调大 limit 或加条件收窄。"
  ].join("");
}

/** `finance_import_bill` 的模型说明。 */
function importBillDescription() {
  return [
    "把用户给的支付宝 / 微信 / 银行账单文件（CSV、TSV、xlsx）读进来，自动识别列、自动分类，然后入库。",
    "用户说「导入这个账单 / 帮我把这份账单记到账本里」并给出文件路径时用；路径必须来自用户原话，不要自己猜或拼接。",
    "默认只**预览**（confirm 不传或 false）：读了多少笔、新增多少、重复多少、自动归类多少，然后问用户要不要入库。",
    "用户确认后再调一次并传 confirm:true 真正入库。重复的行（同日期/金额/商户/方向）会自动跳过，不会记两遍。"
  ].join("");
}

/** `finance_net_worth` 的模型说明。 */
function netWorthDescription() {
  return [
    "看资产、负债与净资产的明细：各项资产估值与构成、每笔负债余额与还款日、近 30 天要还的钱、净资产走势。",
    "用户问「我有多少资产 / 净资产多少 / 还欠多少钱 / 下个月要还什么 / 房贷还剩多少」时用。"
  ].join("");
}

/** `finance_investments` 的模型说明。 */
function investmentsDescription() {
  return [
    "看持仓的成本、市值、盈亏和收益率，以及按类型（基金/股票/债券）的配置比例。",
    "用户问「我的基金赚了还是亏了 / 投资情况怎么样 / 持仓怎么配的」时用。",
    "只陈述账本里记录的数字；**不要**给任何买卖建议、目标价或调仓建议。"
  ].join("");
}

/** `finance_budget` 的模型说明。 */
function budgetDescription() {
  return [
    "查看、设置预算，查看和操作存钱目标。",
    "用户说「这个月餐饮预算 2000 / 预算改一下 / 看看预算用了多少 / 新建一个应急金目标 / 往目标里存 5000」时用。",
    "op 默认 view，返回预算使用情况与目标进度；set_budget 需要 category 与 limit（元）；remove_budget 需要 category；",
    "add_goal 需要 name 与 target（元）；contribute_goal 需要 goalId 与 amount（元）。"
  ].join("");
}

/** `finance_export` 的模型说明。 */
function exportDescription() {
  return [
    "把账本导出成文件放到用户的工作区，方便他打开或备份；返回保存的路径。",
    "用户说「导出 / 导出来我看看 / 备份一下 / 给我一份流水表」时用。默认 csv（Excel 能直接打开），要完整备份用 json。",
    "导出后把**文件的完整路径**告诉用户。"
  ].join("");
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

/**
 * `output.render` 的统一形状：一个 text 块。
 * @param {string} text 文本。
 * @returns {Array<{ type: "text", text: string }>} 内容块。
 */
function textBlock(text) {
  return [{ type: "text", text }];
}

/** 分 → 元（给工具文本用，不带 ¥ 时更清爽）。 */
const yuan = (cents, options = {}) => formatCents(cents, { symbol: true, group: true, ...options });

/** 百分比。 */
const pct = (ratio, digits = 0) => `${(Number(ratio) * 100).toFixed(digits)}%`;

/** 一行日期到「2026-11-03」的可靠输出。 */
const dateLabel = (value) => (isDateText(value) ? value : dayKey(value) || "");

/** 把正文压成一行。 */
const oneLine = (text, max = 80) => String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

// ── 定义 ─────────────────────────────────────────────────────────────────

/**
 * 建八个工具定义。不依赖 cordis：`execute` 只用到注入的依赖，测试可以直接调。
 *
 * `deps` 里的 `fs` / `env` 让 `finance_import_bill` 与 `finance_export` 可以在
 * 宿主里用 `ctx.get("fs")`，也能在测试里塞一个假的。
 *
 * @param {{ store: object, ai?: object, fs?: object | null, cwd?: string, now?: () => number, config?: object }} deps 依赖。
 * @returns {Array<Record<string, unknown>>} 八个工具定义，顺序固定。
 */
export function buildToolDefinitions(deps) {
  const store = deps.store;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const cwd = typeof deps.cwd === "string" && deps.cwd !== "" ? deps.cwd : process.cwd();
  const fsService = deps.fs ?? null;
  /** 导出的默认目录：配置里给的，否则工作目录。 */
  const exportDir = typeof deps.config?.exportDir === "string" && deps.config.exportDir !== "" ? deps.config.exportDir : cwd;

  /** 取一份快照（工具共用）。 */
  const snapshot = async (month) => {
    await store.ready?.();
    const target = isMonthText(month) ? month : currentMonth(now());
    return financeSnapshot(store.getDb(), { month: target, now: now() });
  };

  /**
   * 统一包一层：任何异常都变成一句人话，不让一个工具失败拖垮其余。
   * @param {(input: Record<string, unknown>) => Promise<string>} run 真正的实现。
   * @returns {(args: unknown) => Promise<string>} 工具 execute。
   */
  const safeExecute =
    (run) =>
    async (args) => {
      const input = args !== null && typeof args === "object" ? /** @type {Record<string, unknown>} */ (args) : {};
      try {
        return await run(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `理财工作台：操作没成功——${message}`;
      }
    };

  // ── 1. overview ─────────────────────────────────────────────────────────
  const overviewTool = {
    name: "finance_overview",
    description: overviewDescription(),
    parameters: overviewParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "查看本月收支概况", kind: "read", rawInput: args }),
    execute: safeExecute(async (input) => {
      const snap = await snapshot(input.month);
      const { summary, byCategory, byPurpose, trend, topExpenses } = snap;
      if (summary.txnCount === 0) {
        const head = `${snap.month} 还没有流水记录。`;
        const worth = `目前净资产 ${yuan(snap.netWorth)}（资产 ${yuan(snap.assets.total)}，负债 ${yuan(snap.liabilities.total)}）。`;
        return `${head}${worth}可以让用户导入支付宝/微信账单，或者直接说「记一笔 …」。`;
      }
      const lines = [];
      lines.push(
        `${snap.month}：收入 ${yuan(summary.income)}，支出 ${yuan(summary.expense)}，结余 ${yuan(summary.balance)}，共 ${summary.txnCount} 笔。`
      );
      if (summary.income > 0 || summary.expense > 0) {
        const rate = summary.income > 0 ? summary.balance / summary.income : 0;
        lines.push(`结余率 ${pct(rate)}${rate < 0 ? "（这个月是净流出）" : ""}。`);
      }
      if (byCategory.length > 0) {
        lines.push(
          `支出排前面的是：${byCategory
            .slice(0, 5)
            .map((row) => `${row.category} ${yuan(row.amount)}（${pct(row.share)}，${row.count} 笔）`)
            .join("；")}。`
        );
      }
      if (byPurpose.length > 0) {
        lines.push(`按目的看：${byPurpose.map((row) => `${row.purpose} ${pct(row.share)}`).join("、")}。`);
      }
      if (topExpenses.length > 0) {
        lines.push(`本月最大一笔：${oneLine(topExpenses[0].merchant, 24)} ${yuan(topExpenses[0].amount)}（${topExpenses[0].date}）。`);
      }
      const recent = trend.slice(-3);
      if (recent.length > 1) {
        lines.push(`最近几个月：${recent.map((row) => `${row.month.slice(5)} 月收入 ${yuan(row.income, { symbol: false })} / 支出 ${yuan(row.expense, { symbol: false })}`).join("，")}。`);
      }
      lines.push(`净资产 ${yuan(snap.netWorth)}（资产 ${yuan(snap.assets.total)}，负债 ${yuan(snap.liabilities.total)}）。`);
      if (snap.budgetTotal.limit > 0) {
        const left = snap.budgetTotal.limit - snap.budgetTotal.spent;
        lines.push(
          `预算 ${yuan(snap.budgetTotal.limit)} 用掉 ${pct(snap.budgetTotal.used)}${left >= 0 ? `，还剩 ${yuan(left)}` : `，超了 ${yuan(-left)}`}。`
        );
      }
      if (snap.goals.length > 0) {
        lines.push(`存钱目标：${snap.goals.slice(0, 3).map((goal) => `${goal.name} ${pct(goal.progress)}`).join("、")}。`);
      }
      lines.push(`自动分类率 ${pct(summary.autoRate)}（${summary.autoClassified}/${summary.txnCount} 笔）。`);
      return lines.join("\n");
    })
  };

  // ── 2. add_txn ──────────────────────────────────────────────────────────
  const addTxnTool = {
    name: "finance_add_txn",
    description: addTxnDescription(),
    parameters: addTxnParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "记一笔账", kind: "edit", rawInput: args }),
    execute: safeExecute(async (input) => {
      const amountYuan = Number(input.amount);
      if (!Number.isFinite(amountYuan) || amountYuan <= 0) throw new Error("金额要填大于 0 的数字（单位是元）");
      const amount = Math.round(amountYuan * 100);
      const direction = input.direction === "income" ? "income" : "expense";
      const date = isDateText(String(input.date ?? "")) ? String(input.date) : dayKey(now());
      const merchant = typeof input.merchant === "string" && input.merchant.trim() !== "" ? input.merchant.trim() : direction === "income" ? "收入" : "日常支出";
      await store.ready?.();
      const wanted = typeof input.category === "string" ? input.category.trim() : "";
      const categoryIn = CATEGORIES.includes(wanted) ? wanted : "";
      const guessed = classify({ merchant, note: String(input.note ?? ""), category: categoryIn, direction, amount }, store.getRules());
      const category = direction === "income" ? INCOME_CATEGORY : categoryIn || guessed.category;
      const purpose = direction === "income" ? "" : PURPOSES.includes(String(input.purpose)) ? String(input.purpose) : guessed.purpose;
      const { txn } = await store.addTxn({
        date,
        amount,
        direction,
        category,
        purpose,
        merchant,
        account: typeof input.account === "string" && input.account.trim() !== "" ? input.account.trim() : "现金",
        note: typeof input.note === "string" ? input.note : "",
        source: "agent"
      });
      const spell = direction === "income" ? "收入" : "支出";
      return [
        `已记一笔：${date} ${oneLine(txn.merchant, 30)} ${spell} ${yuan(txn.amount)}，分类「${txn.category}」`,
        txn.purpose === "" ? "" : `，目的「${txn.purpose}」`,
        `，账户「${txn.account}」。记账 id：${txn.id}。`
      ].join("");
    })
  };

  // ── 3. query_txns ───────────────────────────────────────────────────────
  const queryTxnsTool = {
    name: "finance_query_txns",
    description: queryTxnsDescription(),
    parameters: queryTxnsParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "查流水", kind: "search", rawInput: args }),
    execute: safeExecute(async (input) => {
      const month = isMonthText(String(input.month ?? "")) ? String(input.month) : "";
      const category = CATEGORIES.includes(String(input.category)) ? String(input.category) : "";
      const direction = input.direction === "income" || input.direction === "expense" ? input.direction : "";
      const q = typeof input.q === "string" ? input.q.trim() : "";
      const limitRaw = Number(input.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), MAX_QUERY_LIMIT) : DEFAULT_QUERY_LIMIT;
      await store.ready?.();
      const result = store.listTxns({
        ...(month === "" ? {} : { month }),
        ...(q === "" ? {} : { q }),
        ...(category === "" ? {} : { category }),
        ...(direction === "" ? {} : { direction }),
        limit
      });
      if (result.total === 0) {
        const where = [month === "" ? "" : month, category === "" ? "" : `分类「${category}」`, q === "" ? "" : `包含「${q}」`].filter((part) => part !== "").join("、");
        return where === "" ? "账本里还没有流水。" : `没有找到${where}的流水。`;
      }
      const scope = [month === "" ? "全部月份" : month, category === "" ? "" : `分类「${category}」`, direction === "" ? "" : direction === "income" ? "只看收入" : "只看支出", q === "" ? "" : `关键词「${q}」`]
        .filter((part) => part !== "")
        .join("、");
      const sum = result.txns.reduce((acc, txn) => acc + (txn.direction === "expense" ? -txn.amount : txn.amount), 0);
      const header = `${scope}：共 ${result.total} 笔，下面列出 ${result.txns.length} 笔（合计 ${yuan(sum)}，收入为正）：`;
      const body = result.txns
        .map(
          (txn, index) =>
            `${index + 1}. ${txn.date} ${oneLine(txn.merchant, 24)} ${txn.direction === "expense" ? "-" : "+"}${yuan(txn.amount, { symbol: false })}【${txn.category}】${txn.account === "" ? "" : ` ${oneLine(txn.account, 12)}`}  [${txn.id}]`
        )
        .join("\n");
      const tail = result.total > result.txns.length ? `\n……还有 ${result.total - result.txns.length} 笔未列出，可调大 limit 或加条件收窄。` : "";
      return `${header}\n${body}${tail}`;
    })
  };

  // ── 4. import_bill ──────────────────────────────────────────────────────
  const importBillTool = {
    name: "finance_import_bill",
    description: importBillDescription(),
    parameters: importBillParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "导入账单", kind: "edit", rawInput: args }),
    execute: safeExecute(async (input) => {
      const rawPath = typeof input.path === "string" ? input.path.trim() : "";
      if (rawPath === "") throw new Error("要给账单文件的路径");
      // 只读用户明确给出的那个路径，不递归、不猜。
      const bytes = await readBillFile(fsService, rawPath, cwd);
      const name = basename(rawPath);
      await store.ready?.();
      // 解析 + 规则分类一步到位（importer 的便利函数）。
      const parsed = parseBillWithCategories({ name, content: bytes }, { now: now(), rules: store.getRules() });
      let rows = Array.isArray(parsed.rows) ? parsed.rows : [];
      const rate = autoRateOf(rows);

      // 规则没命中的行，问一次 AI；失败就用规则结果，不报错。
      // 判定口径与 HTTP /import 预览共用同一个函数，避免两处漂移。
      const needsAi = needsAiOf;
      let aiFilled = 0;
      const unknown = [...new Set(rows.filter(needsAi).map((row) => String(row.merchant ?? "")))].filter((merchant) => merchant !== "");
      if (unknown.length > 0 && typeof deps.ai?.run === "function") {
        const tried = await deps.ai.run("classify", { merchants: unknown });
        if (tried.ok === true && tried.value !== null && typeof tried.value === "object") {
          rows = rows.map((row) => {
            if (!needsAi(row)) return row;
            const hit = tried.value[String(row.merchant ?? "")];
            if (hit === undefined || !CATEGORIES.includes(hit.category) || hit.category === INCOME_CATEGORY || hit.category === "其他") return row;
            aiFilled += 1;
            return { ...row, category: hit.category, purpose: PURPOSES.includes(hit.purpose) ? hit.purpose : row.purpose, confidence: "ai" };
          });
        }
      }

      const autoCount = rows.filter((row) => row.confidence === "rule" || row.confidence === "user" || row.confidence === "ai").length;
      const expense = rows.reduce((acc, row) => acc + (row.direction === "expense" ? row.amount : 0), 0);
      const income = rows.reduce((acc, row) => acc + (row.direction === "income" ? row.amount : 0), 0);
      const skipped = Number(parsed.skipped) || 0;
      const warnings = Array.isArray(parsed.warnings) ? parsed.warnings : [];

      if (rows.length === 0) {
        const reason = warnings.slice(0, 2).join("；") || "没有能识别的行";
        return `「${name}」识别成 ${parsed.format} 格式，但没能读出行：${reason}。可以让用户换一份导出再试（支付宝/微信里选「导出 CSV」）。`;
      }

      const summaryText = `「${name}」（${parsed.format}）读了 ${rows.length} 笔：支出 ${yuan(expense)}、收入 ${yuan(income)}；自动归类 ${autoCount} 笔（${pct(rate)}）${aiFilled > 0 ? `，其中 AI 补了 ${aiFilled} 笔` : ""}${skipped > 0 ? `；有 ${skipped} 行没读懂已跳过` : ""}。`;
      const previewRows = rows
        .slice(0, 5)
        .map((row) => `· ${row.date} ${oneLine(row.merchant, 20)} ${row.direction === "expense" ? "-" : "+"}${yuan(row.amount, { symbol: false })}【${row.category}】`)
        .join("\n");
      const warnText = warnings.length > 0 ? `\n提示：${warnings.slice(0, 3).join("；")}` : "";

      if (input.confirm !== true) {
        return `${summaryText}\n前几笔的样子：\n${previewRows}${warnText}\n还没有入库。确认无误后，再调一次 finance_import_bill 并传 confirm:true 就会写进账本（重复的账会自动跳过）。`;
      }

      const result = await store.importRows({ name, format: parsed.format, rows });
      const dup = Number(result.duplicates) || 0;
      const invalid = Number(result.invalid) || 0;
      return `已入库「${name}」：读了 ${rows.length} 笔，新增 ${result.added}，重复 ${dup}${invalid > 0 ? `，另有 ${invalid} 行数据不完整被跳过` : ""}，自动归类 ${autoCount} 笔${aiFilled > 0 ? `（其中 AI 补了 ${aiFilled} 笔）` : ""}。${warnText}`;
    })
  };

  // ── 5. net_worth ────────────────────────────────────────────────────────
  const netWorthTool = {
    name: "finance_net_worth",
    description: netWorthDescription(),
    parameters: netWorthParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "查看资产负债", kind: "read", rawInput: args }),
    execute: safeExecute(async () => {
      const snap = await snapshot();
      const { assets, liabilities, netWorth, netWorthTrend } = snap;
      const lines = [];
      lines.push(`净资产 ${yuan(netWorth)}（资产 ${yuan(assets.total)} － 负债 ${yuan(liabilities.total)}）。`);
      if (assets.items.length === 0 && liabilities.items.length === 0) {
        lines.push("账本里还没有资产和负债记录。可以让用户在「资产」页把活期、理财、房产、贷款填进去。");
        return lines.join("\n");
      }
      if (assets.items.length > 0) {
        lines.push(`资产按类型：${assets.byKind.map((row) => `${KIND_LABELS[row.kind] ?? row.kind} ${yuan(row.amount)}（${pct(row.share)}）`).join("、")}。`);
        lines.push(
          `明细：${assets.items
            .slice(0, 8)
            .map((item) => `${oneLine(item.name, 16)} ${yuan(item.value)}`)
            .join("、")}${assets.items.length > 8 ? ` 等 ${assets.items.length} 项` : ""}。`
        );
      }
      if (liabilities.items.length > 0) {
        lines.push(
          `负债：${liabilities.items
            .slice(0, 8)
            .map((item) => `${oneLine(item.name, 16)} 还欠 ${yuan(item.balance)}${item.monthlyPayment > 0 ? `，月供 ${yuan(item.monthlyPayment)}` : ""}${item.dueInDays !== undefined ? item.overdue ? "，已过还款日" : `，${item.dueInDays} 天后到期` : ""}`)
            .join("；")}。`
        );
      }
      const upcoming = Array.isArray(liabilities.upcoming) ? liabilities.upcoming : [];
      if (upcoming.length > 0) {
        // `upcoming` 的每一项用 `amount` 表示「这次要还多少」（analysis 里由
        // monthlyPayment 推导），不是 `monthlyPayment`——读错会全部显示 ¥0。
        const dueOf = (item) => Number(item.amount) || Number(item.monthlyPayment) || 0;
        const due = upcoming.reduce((acc, item) => acc + dueOf(item), 0);
        lines.push(`近 30 天要还 ${yuan(due)}：${upcoming.slice(0, 5).map((item) => `${oneLine(item.name, 14)} ${yuan(dueOf(item))}${item.overdue ? "（已逾期）" : `（还有 ${item.dueInDays} 天）`}`).join("、")}。`);
      }
      if (Array.isArray(netWorthTrend) && netWorthTrend.length > 1) {
        const last = netWorthTrend.slice(-2);
        const delta = last[1].netWorth - last[0].netWorth;
        lines.push(`净资产走势：最近一个月${delta >= 0 ? "增加" : "减少"} ${yuan(Math.abs(delta))}（按流水结余反推，以当前净资产为锚）。`);
      }
      return lines.join("\n");
    })
  };

  // ── 6. investments ──────────────────────────────────────────────────────
  const investmentsTool = {
    name: "finance_investments",
    description: investmentsDescription(),
    parameters: investmentsParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: "generic", title: "查看持仓盈亏", kind: "read", rawInput: args }),
    execute: safeExecute(async () => {
      const snap = await snapshot();
      const { invest } = snap;
      if (invest.items.length === 0) return "账本里还没有持仓记录。可以让用户在「投资」页填一下手里有哪些基金/股票、成本和现价。";
      const lines = [];
      const sign = invest.pnl >= 0 ? "赚了" : "亏了";
      lines.push(`持仓成本 ${yuan(invest.cost)}，市值 ${yuan(invest.value)}，${sign} ${yuan(Math.abs(invest.pnl))}（收益率 ${pct(invest.pnlRate, 1)}）。`);
      if (invest.byType.length > 0) {
        lines.push(`配置：${invest.byType.map((row) => `${row.label ?? KIND_LABELS[row.type] ?? row.type} ${pct(row.share)}`).join("、")}。`);
      }
      lines.push(
        `逐笔：${invest.items
          .slice(0, 8)
          .map(
            (item) =>
              `${oneLine(item.name, 16)}${item.code === "" ? "" : `(${item.code})`} 市值 ${yuan(item.value)}，${item.pnl >= 0 ? "+" : "-"}${yuan(Math.abs(item.pnl), { symbol: false })}（${pct(item.pnlRate, 1)}）`
          )
          .join("；")}。`
      );
      lines.push("（只陈述账本里的记录，不构成任何投资建议。）");
      return lines.join("\n");
    })
  };

  // ── 7. budget ───────────────────────────────────────────────────────────
  const budgetTool = {
    name: "finance_budget",
    description: budgetDescription(),
    parameters: budgetParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "预算与目标", kind: "edit", rawInput: args }),
    execute: safeExecute(async (input) => {
      const op = typeof input.op === "string" && input.op !== "" ? input.op : "view";
      if (op === "set_budget") {
        const category = String(input.category ?? "");
        if (!EXPENSE_CATEGORY_ENUM.includes(category)) throw new Error(`预算分类只能是：${EXPENSE_CATEGORY_ENUM.join("、")}`);
        const limitYuan = Number(input.limit);
        if (!Number.isFinite(limitYuan) || limitYuan <= 0) throw new Error("预算金额要填大于 0 的数字（单位是元）");
        const month = input.month === "default" ? "default" : isMonthText(String(input.month ?? "")) ? String(input.month) : currentMonth(now());
        await store.ready?.();
        const { budget } = await store.setBudget(month, category, Math.round(limitYuan * 100));
        const label = month === "default" ? "默认档" : month;
        return `已设置「${category}」${label}预算 ${yuan(budget.limit)}。`;
      }
      if (op === "remove_budget") {
        const category = String(input.category ?? "");
        if (!EXPENSE_CATEGORY_ENUM.includes(category)) throw new Error("要删哪一类预算？请给 category");
        const month = input.month === "default" ? "default" : isMonthText(String(input.month ?? "")) ? String(input.month) : currentMonth(now());
        await store.ready?.();
        await store.removeBudget({ month, category });
        return `已删掉「${category}」${month === "default" ? "默认档" : month}的预算。`;
      }
      if (op === "add_goal") {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (name === "") throw new Error("目标要有个名字");
        const targetYuan = Number(input.target);
        if (!Number.isFinite(targetYuan) || targetYuan <= 0) throw new Error("目标金额要填大于 0 的数字（单位是元）");
        await store.ready?.();
        const savedYuan = Number(input.saved);
        const { goal } = await store.addGoal({
          name,
          target: Math.round(targetYuan * 100),
          saved: Number.isFinite(savedYuan) && savedYuan > 0 ? Math.round(savedYuan * 100) : 0,
          deadline: isDateText(String(input.deadline ?? "")) ? String(input.deadline) : ""
        });
        return `已新建存钱目标「${goal.name}」：目标 ${yuan(goal.target)}${goal.deadline === "" ? "" : `，截止 ${goal.deadline}`}。id：${goal.id}。`;
      }
      if (op === "contribute" || op === "contribute_goal") {
        const id = typeof input.goalId === "string" ? input.goalId.trim() : "";
        if (id === "") throw new Error("要给目标 id（先 op:view 看一下目标列表）");
        const amountYuan = Number(input.amount);
        if (!Number.isFinite(amountYuan) || amountYuan === 0) throw new Error("存入金额要填非 0 的数字（单位是元）");
        await store.ready?.();
        const { goal } = await store.contributeGoal(id, Math.round(amountYuan * 100));
        return `「${goal.name}」已存入 ${yuan(Math.round(amountYuan * 100))}，现在存了 ${yuan(goal.saved)} / ${yuan(goal.target)}（${pct(goal.target > 0 ? goal.saved / goal.target : 0)}）。`;
      }

      const snap = await snapshot(input.month);
      const lines = [];
      if (snap.budgets.length === 0) {
        lines.push(`${snap.month} 还没有设预算。可以按分类设一条，例如「餐饮 2000」。`);
      } else {
        lines.push(
          `${snap.month} 预算：共 ${yuan(snap.budgetTotal.limit)}，已用 ${yuan(snap.budgetTotal.spent)}（${pct(snap.budgetTotal.used)}）。`
        );
        lines.push(
          snap.budgets
            .slice(0, 10)
            .map((row) => `${row.category} ${yuan(row.spent)}/${yuan(row.limit)}（${pct(row.used)}${row.over ? "，超了" : ""}）`)
            .join("；") + "。"
        );
      }
      if (snap.goals.length === 0) {
        lines.push("还没有存钱目标。");
      } else {
        lines.push(
          `存钱目标：${snap.goals
            .slice(0, 6)
            .map(
              (goal) =>
                `「${goal.name}」${yuan(goal.saved)}/${yuan(goal.target)}（${pct(goal.progress)}${goal.deadline === "" ? "" : `，${goal.deadline} 前`}${goal.remainingMonths > 0 && !goal.done ? `，每月需存 ${yuan(goal.monthlyNeeded)}` : ""}）[${goal.id}]`
            )
            .join("；")}。`
        );
      }
      return lines.join("\n");
    })
  };

  // ── 8. export ───────────────────────────────────────────────────────────
  const exportTool = {
    name: "finance_export",
    description: exportDescription(),
    parameters: exportParameters(),
    output: {
      schema: { type: "string" },
      render: (_args, value) => textBlock(typeof value === "string" ? value : String(value))
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ card: "generic", title: "导出账本", kind: "execute", rawInput: args }),
    execute: safeExecute(async (input) => {
      const format = input.format === "json" ? "json" : "csv";
      const month = isMonthText(String(input.month ?? "")) ? String(input.month) : "";
      const stamp = dayKey(now()).replace(/-/gu, "");
      const fileName = `${EXPORT_PREFIX}-${month === "" ? "全部" : month}-${stamp}.${format}`;
      const requested = typeof input.path === "string" ? input.path.trim() : "";
      const targetPath = requested === "" ? join(exportDir, fileName) : isAbsolute(requested) ? requested : resolvePath(exportDir, requested);
      await store.ready?.();
      const db = store.getDb();
      const content =
        format === "json"
          ? `${JSON.stringify({ version: db.version ?? 1, exportedAt: now(), db }, null, 2)}\n`
          : buildCsv(db, month);
      const saved = await writeExport(fsService, targetPath, content);
      const rows = format === "csv" ? content.split("\n").length - 1 : 0;
      return format === "csv"
        ? `已导出 CSV：${saved}\n（${month === "" ? "全部流水" : `${month} 流水`}，${rows} 行；Excel / Numbers 可以直接打开。）`
        : `已导出完整 JSON 备份：${saved}\n（含流水、资产、负债、持仓、预算、目标、规则与设置。）`;
    })
  };

  return [overviewTool, addTxnTool, queryTxnsTool, importBillTool, netWorthTool, investmentsTool, budgetTool, exportTool];
}

// ── 文件读写（优先 ctx.get("fs")，回退 node:fs） ─────────────────────────

/**
 * 读用户给出的账单文件。
 *
 * 只读这一个路径：优先走宿主 `fs` 服务（它懂沙箱与远端工作区），
 * 服务不可用或读不了时回退 `node:fs`。二进制（xlsx）必须拿字节，
 * 所以先试 `readBytes`，拿不到再 `readText`。
 * @param {object | null} fsService 宿主 fs 服务（可为 null）。
 * @param {string} path 用户给出的路径。
 * @param {string} cwd 相对路径的基准目录。
 * @returns {Promise<Uint8Array | string>} 文件内容。
 */
async function readBillFile(fsService, path, cwd) {
  const absolute = isAbsolute(path) ? path : resolvePath(cwd, path);
  if (fsService !== null && typeof fsService.resolve === "function") {
    try {
      const target = await fsService.resolve(path, { cwd });
      if (typeof fsService.readBytes === "function") {
        const bytes = await fsService.readBytes(target, undefined, MAX_BILL_BYTES);
        if (bytes !== undefined && bytes !== null) return bytes;
      }
      if (typeof fsService.readText === "function") return await fsService.readText(target);
    } catch {
      // 服务读不了就回退 node:fs，下面的报错会带出真实原因。
    }
  }
  try {
    return readFileSync(absolute);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`读不到「${path}」：${reason}。请确认路径写对了、文件还在。`);
  }
}

/**
 * 写一个导出文件。
 * @param {object | null} fsService 宿主 fs 服务（可为 null）。
 * @param {string} path 目标绝对路径。
 * @param {string} content 文本内容。
 * @returns {Promise<string>} 实际写入的路径。
 */
async function writeExport(fsService, path, content) {
  if (fsService !== null && typeof fsService.writeText === "function" && typeof fsService.resolve === "function") {
    try {
      const target = await fsService.resolve(path);
      await fsService.writeText(target, content);
      return typeof fsService.processPath === "function" ? fsService.processPath(target) : path;
    } catch {
      // 落回 node:fs
    }
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return path;
  } catch (error) {
    throw new Error(`写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── CSV 导出 ─────────────────────────────────────────────────────────────

/** CSV 单元格转义。 */
const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
};

/**
 * 把账本导出成 CSV：先流水，再空行分隔资产/负债/持仓/预算/目标几段。
 *
 * 金额按元输出（两位小数），Excel 打开即可用。
 * @param {object} db 账本。
 * @param {string} month 只导出该月流水；空串表示全部。
 * @returns {string} CSV 文本。
 */
export function buildCsv(db, month = "") {
  const yuanText = (cents) => (Math.round(Number(cents) || 0) / 100).toFixed(2);
  const lines = [];
  const txns = (Array.isArray(db.txns) ? db.txns : [])
    .filter((txn) => month === "" || monthKey(txn.date) === month)
    .slice()
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
  lines.push(["日期", "方向", "金额", "分类", "目的", "商户", "账户", "备注", "来源"].join(","));
  for (const txn of txns) {
    lines.push(
      [
        txn.date,
        txn.direction === "income" ? "收入" : "支出",
        yuanText(txn.amount),
        txn.category,
        txn.purpose,
        txn.merchant,
        txn.account,
        txn.note,
        txn.source
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const assets = Array.isArray(db.assets) ? db.assets : [];
  if (assets.length > 0) {
    lines.push("");
    lines.push(["资产", "类型", "金额", "账户", "备注"].join(","));
    for (const asset of assets) {
      lines.push([asset.name, asset.kind, yuanText(asset.value), asset.account, asset.note].map(csvCell).join(","));
    }
  }
  const liabilities = Array.isArray(db.liabilities) ? db.liabilities : [];
  if (liabilities.length > 0) {
    lines.push("");
    lines.push(["负债", "类型", "剩余本金", "月供", "还款日"].join(","));
    for (const liability of liabilities) {
      lines.push([liability.name, liability.kind, yuanText(liability.balance), yuanText(liability.monthlyPayment), String(liability.dueDay ?? "")].map(csvCell).join(","));
    }
  }
  const holdings = Array.isArray(db.holdings) ? db.holdings : [];
  if (holdings.length > 0) {
    lines.push("");
    lines.push(["持仓", "代码", "类型", "份额", "成本价", "现价"].join(","));
    for (const holding of holdings) {
      lines.push([holding.name, holding.code, holding.type, String(holding.shares ?? ""), yuanText(holding.costPrice), yuanText(holding.price)].map(csvCell).join(","));
    }
  }
  const budgets = Array.isArray(db.budgets) ? db.budgets : [];
  if (budgets.length > 0) {
    lines.push("");
    lines.push(["预算月份", "分类", "限额"].join(","));
    for (const budget of budgets) lines.push([budget.month, budget.category, yuanText(budget.limit)].map(csvCell).join(","));
  }
  const goals = Array.isArray(db.goals) ? db.goals : [];
  if (goals.length > 0) {
    lines.push("");
    lines.push(["目标", "目标金额", "已存", "截止日期"].join(","));
    for (const goal of goals) lines.push([goal.name, yuanText(goal.target), yuanText(goal.saved), goal.deadline].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

// ── 注册 ─────────────────────────────────────────────────────────────────

/**
 * 把八个工具注册到宿主的 `tools` Service 上。
 *
 * 传入的 `ctx` 必须已经 `inject: ["tools"]`。每个工具**单独** try/catch：
 * 一个注册失败（例如撞名）只记一条警告，其它七个照常可用。
 * 这里**不**自己包 `ctx.effect`：disposer 交给调用方挂在插件生命周期上。
 *
 * @param {{ tools: { register: (definition: Record<string, unknown>) => () => void } }} ctx 插件上下文。
 * @param {{ store: object, ai?: object, fs?: object | null, cwd?: string, now?: () => number, config?: object, log?: Function }} deps 依赖。
 * @returns {Array<() => void>} 已成功注册的工具 disposer。
 */
export function registerTools(ctx, deps) {
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const disposers = [];
  let definitions;
  try {
    definitions = buildToolDefinitions(deps);
  } catch (error) {
    log("理财工具定义构造失败：", error);
    return disposers;
  }
  for (const definition of definitions) {
    try {
      disposers.push(ctx.tools.register(definition));
    } catch (error) {
      log(`工具 ${definition.name} 注册失败：`, error);
    }
  }
  return disposers;
}

/**
 * 工具名 → 定义 的只读映射，测试里按名字取用。
 * @param {{ store: object, ai?: object, fs?: object | null, cwd?: string, now?: () => number, config?: object }} deps 依赖。
 * @returns {Record<string, Record<string, unknown>>} 映射。
 */
export function toolMap(deps) {
  /** @type {Record<string, Record<string, unknown>>} */
  const map = {};
  for (const definition of buildToolDefinitions(deps)) {
    map[/** @type {string} */ (definition.name)] = definition;
  }
  return map;
}

export {
  ASSET_KINDS,
  HOLDING_TYPES,
  LIABILITY_KINDS,
  monthRange,
  dateInMonth,
  textBlock
};