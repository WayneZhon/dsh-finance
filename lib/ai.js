/**
 * dsh-finance · 可选的 AI 增强。
 *
 * 面板与 agent 工具都会问 AI 两件事：
 *
 *   - `classify`：规则表没命中的商户，批量打上「分类 + 目的」；
 *   - `insight`：根据当前看板快照写 3~5 条中文洞察（**只描述现状、只给通用
 *     提示**，严禁推荐具体买卖）。
 *
 * 这里是全插件**唯一**调用模型的地方：走用户自己配置的默认模型
 * （Host `llm` 服务 + `agentDefaultModel` 的选择），没有独立端点、没有额外
 * key、不向第三方上传。凡是失败都**不抛异常**，一律返回
 * `{ ok: false, error: { code, message } }`，由调用方降级：
 *
 *   - `routes.js` 的 `POST /ai/insight` 降级成 `analysis.js` 的 `tips`，
 *     并如实标注 `source: "rules"`；
 *   - `tools.js` 的分类兜底降级成规则结果。
 *
 * 依赖全部可注入（`selection` / `streamText` / `now`），所以提示词、JSON 解析
 * 和所有失败路径都能用假模型离线测通。
 *
 * @module dsh-finance/lib/ai
 */

import { CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORY, PURPOSES } from "./domain.js";

/** 单次 AI 调用最长等待时间。 */
const DEFAULT_TIMEOUT_MS = 45_000;

/** 接受的回答上限：模型失控时不能把文件撑大。 */
const MAX_ANSWER_CHARS = 8_000;

/** 一次最多问多少个商户，避免提示词过长。 */
export const MAX_CLASSIFY_MERCHANTS = 60;

/** 洞察最多几条。 */
export const MAX_INSIGHTS = 5;

/** 洞察至少几条（不够就有几条写几条）。 */
export const MIN_INSIGHTS = 3;

/**
 * 两个任务的提示词与「答案长什么样」。
 *
 * 注意 `insight` 的 instruction 里写死了两条红线：不做投资建议、不推荐买
 * 卖。这是产品承诺（见 CONTRACT「绝不推荐具体买卖」），改这里之前先想清楚。
 */
export const TASKS = Object.freeze({
  classify: {
    instruction:
      "你是记账助手。下面每一行是一个商户名（可能带渠道前缀、门店名、订单号）。" +
      `请给每个商户判断记账分类 category 与记账目的 purpose。` +
      `category 只能是：${CATEGORIES.join("/")}（支出用前面那些，进账用「${INCOME_CATEGORY}」）。` +
      `purpose 只能是：${PURPOSES.join("/")}。` +
      "判断依据是商户/商品本身的性质，例如星巴克=餐饮/娱乐享受，地铁=交通/生活必须，药店=医疗/生活必须，房租=居家/生活必须。",
    answer: '{"商户":{"星巴克":{"category":"餐饮","purpose":"娱乐享受"},"地铁":{"category":"交通","purpose":"生活必须"}}}'
  },
  insight: {
    instruction:
      "你是用户的私人财务账本观察员，只做客观描述和通用提醒。请根据给出的理财看板快照写 3~5 条中文洞察，" +
      "每条一句话、不超过 40 字、直接可读，语气平实不夸张。" +
      "内容只允许两类：(1) 描述当前数字和结构（例如某类支出占比、结余率、应急金月数、负债压力、持仓盈亏的现状）；" +
      "(2) 给通用的小提示（例如控制某类支出、留意还款日、补充应急金）。" +
      "【硬性禁止】不得推荐或暗示买卖任何具体理财产品、股票、基金、债券、保险或房产，不得给出目标价位、" +
      "买卖时机、资产配置比例建议，不得预测市场涨跌。如果快照里缺少某类数据，就不要编造，也不要提它。",
    answer: '["本月餐饮支出占比 32%，是本月的第一大类支出。","结余率约 41%，收支结构还算稳。","建议把应急金补到 6 个月开支再考虑其他安排。"]'
  }
});

/** 所有任务共用的 system 前置说明。 */
const SYSTEM_PREAMBLE =
  "你是用户本机「个人理财工作台」插件里的助手。用户的数据全部保存在他自己的电脑上，不会有任何第三方看到。" +
  "你的输出必须严格遵守任务要求的 JSON 形状：只输出一个 JSON 值（对象或数组），不要 markdown 代码围栏，不要解释。" +
  "绝对不要推荐具体买卖、不要预测市场。";

/**
 * 这一行是否值得再问一次 AI。
 *
 * 判定要**同时**看两个条件，缺一不可：
 *
 *   - `confidence === "default"`：规则表完全没命中，落进了「其他」；
 *   - `category === "其他"`：即使规则给了 `rule`，只要结论是「其他」，
 *     对用户来说也等于没分类——ATM 取现、转账这类关键词真的命中「其他」
 *     类的行就是这种情形（`confidence: "rule"` + `category: "其他"`）。
 *
 * 只判前者会漏掉第二类；只判后者会把收入行也问一遍（收入固定是「收入」，
 * 不需要问）。收入行一律不问。
 *
 * 为什么放在这里：引擎（classify.js）保证「不被归成其他」的下限（关键词 +
 * 用户记忆），但只有调用方知道有没有可用的 AI，所以「还要不要补一轮」是 AI 策略，
 * 归本模块；routes 与 tools 共用同一个判定，避免两处漂移。
 * @param {{ direction?: string, confidence?: string, category?: string }} row 已分类的账单行。
 * @returns {boolean} 是否交给 AI 再判一次。
 */
export function needsAiOf(row) {
  if (row === null || typeof row !== "object") return false;
  if (row.direction === "income") return false;
  return row.confidence === "default" || row.category === "其他";
}

/**
 * 从模型回答里抠出第一个 JSON 值。
 *
 * 模型经常把 JSON 包在自我介绍或 ``` 围栏里，直接 `JSON.parse` 会失败一半。
 * 这里先试围栏里的内容，再从第一个 `{` 或 `[` 开始做括号配平扫描，
 * 扫描到闭合就试解析；`null` 表示「这段回答不是 JSON」。
 * @param {string} text 模型的回答。
 * @returns {unknown} 解析出来的值，或 null。
 */
export function extractJson(text) {
  const source = String(text ?? "");
  const fence = /```(?:json)?\s*([\s\S]*?)```/iu.exec(source);
  const candidates = fence === null ? [source] : [fence[1], source];
  for (const candidate of candidates) {
    const start = firstBracket(candidate);
    if (start < 0) continue;
    const open = candidate[start];
    const result = scanBalanced(candidate, start, open);
    if (result !== undefined) return result;
  }
  return null;
}

/**
 * 找到第一个 `{` 或 `[` 的位置，两者取更靠前的。
 * @param {string} text 文本。
 * @returns {number} 位置，找不到返回 -1。
 */
function firstBracket(text) {
  const object = text.indexOf("{");
  const array = text.indexOf("[");
  if (object < 0) return array;
  if (array < 0) return object;
  return Math.min(object, array);
}

/**
 * 从 `start` 开始做括号配平扫描，配平成功就试解析。
 * @param {string} text 文本。
 * @param {number} start 起始位置（必须是 `{` 或 `[`）。
 * @param {string} open 起始括号。
 * @returns {unknown} 解析结果；配平失败或解析失败返回 undefined。
 */
function scanBalanced(text, start, open) {
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 压平空白并截断，模型给的值一律不信。 */
const cleanText = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, max) : "";

/**
 * 把 `classify` 的回答整理成 `{ 商户 → { category, purpose } }`。
 *
 * 接受三种常见形状（模型三种都写得出，不能只认一种）：
 *
 *   - `{"商户":{"星巴克":{...}}}` — 任务里给的示例形状，外面包了一层 `商户`；
 *   - `{"星巴克":{...}}`         — 直接以商户名为 key；
 *   - `{"items":[{"merchant":"星巴克","category":"餐饮"}]}` — 列表式。
 *
 * 只保留认识的分类与目的，其余丢弃（模型偶尔会编一个「零食」出来）。
 * @param {unknown} raw 解析后的回答。
 * @param {string[]} asked 本次问到的商户（保持顺序）。
 * @returns {Record<string, { category: string, purpose: string }>} 可用的结果（可能为空对象）。
 */
export function coerceClassifyAnswer(raw, asked) {
  const out = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  /** @type {Record<string, unknown>} */
  const outer = raw;
  // 展开成一个「商户名 → 记录」的查找表。
  /** @type {Map<string, unknown>} */
  const table = new Map();
  const remember = (name, value) => {
    if (typeof name !== "string" || name.trim() === "") return;
    table.set(name.trim().toLowerCase(), value);
  };
  for (const [name, value] of Object.entries(outer)) {
    if (name === "商户" || name === "merchants" || name === "result" || name === "data") {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [inner, record] of Object.entries(value)) remember(inner, record);
      }
      continue;
    }
    if (name === "items" && Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && typeof entry === "object") {
          /** @type {Record<string, unknown>} */
          const row = entry;
          remember(String(row.merchant ?? row.name ?? row["商户"] ?? ""), row);
        }
      }
      continue;
    }
    remember(name, value);
  }
  for (const merchant of asked) {
    const hit = table.get(merchant.trim().toLowerCase());
    if (hit === null || typeof hit !== "object") continue;
    /** @type {Record<string, unknown>} */
    const record = hit;
    const category = CATEGORIES.includes(record.category) ? String(record.category) : "";
    if (category === "" || category === INCOME_CATEGORY) continue;
    if (!EXPENSE_CATEGORIES.includes(category)) continue;
    const purpose = PURPOSES.includes(record.purpose) ? String(record.purpose) : "";
    out[merchant.trim()] = { category, purpose };
  }
  return out;
}

/**
 * 把 `insight` 的回答整理成字符串数组。
 *
 * 接受 `["…","…"]`、`{"insights":[…]}`、`{"text":"1. …\n2. …"}` 三种常见形状，
 * 统一压成 3~5 条；带序号前缀的会被去掉。
 * @param {unknown} raw 解析后的回答。
 * @returns {string[]} 洞察文本（可能为空数组）。
 */
export function coerceInsightAnswer(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw !== null && typeof raw === "object") {
    /** @type {Record<string, unknown>} */
    const record = raw;
    if (Array.isArray(record.insights)) list = record.insights;
    else if (Array.isArray(record.items)) list = record.items;
    else if (typeof record.text === "string") list = record.text.split(/\n+/u);
    else if (typeof record.insight === "string") list = [record.insight];
  } else if (typeof raw === "string") {
    list = raw.split(/\n+/gu);
  }
  const cleaned = [];
  const seen = new Set();
  for (const entry of list) {
    let text = cleanText(entry, 200);
    if (text === "") continue;
    text = text.replace(/^\s*(?:[-*•]|\d+[.、)）]|第[一二三四五六]条)\s*/u, "").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    cleaned.push(text);
    if (cleaned.length >= MAX_INSIGHTS) break;
  }
  return cleaned;
}

/**
 * 把看板快照压成一段给模型看的紧凑摘要（分单位已转成元，方便模型读）。
 *
 * @param {object} snapshot `analysis.js` 的 financeSnapshot 结果。
 * @param {(cents: number) => string} money 金额格式化函数。
 * @returns {string} 多行文本。
 */
export function snapshotDigest(snapshot, money) {
  if (snapshot === null || typeof snapshot !== "object") return "";
  /** @type {Record<string, any>} */
  const view = snapshot;
  const lines = [];
  const summary = view.summary ?? {};
  lines.push(`月份：${view.month ?? "未知"}`);
  lines.push(
    `本月收入 ${money(summary.income ?? 0)}，支出 ${money(summary.expense ?? 0)}，结余 ${money(summary.balance ?? 0)}，共 ${summary.txnCount ?? 0} 笔`
  );
  if (Number.isFinite(summary.autoRate)) lines.push(`自动归类率 ${Math.round(Number(summary.autoRate) * 100)}%`);
  const categories = Array.isArray(view.byCategory) ? view.byCategory.slice(0, 6) : [];
  if (categories.length > 0) {
    lines.push(
      `支出分类：${categories
        .map((row) => `${row.category} ${money(row.amount)}（${Math.round((row.share ?? 0) * 100)}%）`)
        .join("、")}`
    );
  }
  const purposes = Array.isArray(view.byPurpose) ? view.byPurpose.slice(0, 5) : [];
  if (purposes.length > 0) {
    lines.push(`支出目的：${purposes.map((row) => `${row.purpose} ${Math.round((row.share ?? 0) * 100)}%`).join("、")}`);
  }
  const trend = Array.isArray(view.trend) ? view.trend.slice(-3) : [];
  if (trend.length > 0) {
    lines.push(`最近几个月：${trend.map((row) => `${row.month} 收入 ${money(row.income)} 支出 ${money(row.expense)}`).join("；")}`);
  }
  const assets = view.assets ?? {};
  const liabilities = view.liabilities ?? {};
  lines.push(
    `资产合计 ${money(assets.total ?? 0)}，负债合计 ${money(liabilities.total ?? 0)}，净资产 ${money(view.netWorth ?? 0)}`
  );
  const upcoming = Array.isArray(liabilities.upcoming) ? liabilities.upcoming.slice(0, 3) : [];
  if (upcoming.length > 0) {
    lines.push(`近 30 天要还：${upcoming.map((row) => `${row.name ?? "还款"} ${money(row.monthlyPayment ?? 0)}`).join("、")}`);
  }
  const invest = view.invest ?? {};
  if ((invest.value ?? 0) > 0 || (invest.cost ?? 0) > 0) {
    const rate = Number.isFinite(invest.pnlRate) ? `，收益率 ${(invest.pnlRate * 100).toFixed(1)}%` : "";
    lines.push(`持仓成本 ${money(invest.cost ?? 0)}，市值 ${money(invest.value ?? 0)}，盈亏 ${money(invest.pnl ?? 0)}${rate}`);
  }
  const budgetTotal = view.budgetTotal ?? {};
  if ((budgetTotal.limit ?? 0) > 0) {
    lines.push(
      `本月预算 ${money(budgetTotal.limit)}，已用 ${money(budgetTotal.spent)}（${Math.round((budgetTotal.used ?? 0) * 100)}%）`
    );
  }
  const goals = Array.isArray(view.goals) ? view.goals : [];
  if (goals.length > 0) {
    lines.push(`存钱目标：${goals.slice(0, 3).map((goal) => `${goal.name} 已完成 ${Math.round((goal.progress ?? 0) * 100)}%`).join("、")}`);
  }
  return lines.join("\n");
}

/**
 * 建一个 AI 桥。
 *
 * @param {object} deps 依赖（全部可注入，便于测试）。
 * @param {() => ({ provider: string, model: string, reasoningEffort?: string } | null)} deps.selection 读用户默认模型。
 * @param {(request: { system: string, user: string, signal: AbortSignal }) => Promise<string>} deps.streamText 一次模型调用，返回全文。
 * @param {number} [deps.timeoutMs] 单次调用超时。
 * @param {() => number} [deps.now] 时钟。
 * @returns {{ status(): object, run(task: string, input: object): Promise<object>, reset(): void, digest(snapshot: object, money: Function): string }} 桥。
 */
export function createAiBridge(deps) {
  const timeoutMs = Number.isFinite(deps.timeoutMs) && deps.timeoutMs > 0 ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  /** 上次失败的原因；缓存起来，避免面板每次刷新都重新等一次超时。 */
  let lastFailure = null;

  /**
   * AI 现在能不能用、用哪个模型。
   * @returns {{ available: boolean, model: string | null, reason?: string, hint?: string }} 状态。
   */
  const status = () => {
    let selection = null;
    try {
      selection = deps.selection();
    } catch {
      selection = null;
    }
    if (
      selection === null ||
      selection === undefined ||
      typeof selection.provider !== "string" ||
      typeof selection.model !== "string" ||
      selection.provider === "" ||
      selection.model === ""
    ) {
      return { available: false, model: null, reason: "no-model", hint: "先在「设置 → 模型」里选一个默认模型，AI 洞察才会工作。" };
    }
    const model = `${selection.provider}/${selection.model}`;
    if (lastFailure !== null) {
      return { available: false, model, reason: lastFailure.code, hint: lastFailure.hint };
    }
    return { available: true, model };
  };

  /**
   * 跑一个任务。**永不抛异常**：失败一律 `{ ok: false, error }`，调用方自己降级。
   *
   * @param {"classify" | "insight"} task 任务名。
   * @param {{ merchants?: string[], snapshot?: object, money?: (cents: number) => string }} input 任务输入。
   * @returns {Promise<{ ok: true, value: unknown, model: string } | { ok: false, error: { code: string, message: string } }>} 结果。
   */
  const run = async (task, input = {}) => {
    const spec = TASKS[task];
    if (spec === undefined) return { ok: false, error: { code: "bad-task", message: `未知的 AI 任务 ${String(task)}` } };
    let selection = null;
    try {
      selection = deps.selection();
    } catch (error) {
      return { ok: false, error: { code: "selection-error", message: error instanceof Error ? error.message : String(error) } };
    }
    if (selection === null || selection === undefined || typeof selection.provider !== "string" || typeof selection.model !== "string") {
      return { ok: false, error: { code: "no-model", message: "还没有选择默认模型" } };
    }
    const model = `${selection.provider}/${selection.model}`;
    const body = task === "classify" ? classifyBody(input) : insightBody(input);
    if (body === "") {
      return { ok: false, error: { code: "empty-input", message: task === "classify" ? "没有需要 AI 判断的商户" : "没有可分析的数据" } };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const user = `${spec.instruction}\n\n${body}\n\n只返回 JSON，形如：${spec.answer}`;
      const answer = await deps.streamText({ system: SYSTEM_PREAMBLE, user, signal: controller.signal });
      const text = String(answer ?? "").trim().slice(0, MAX_ANSWER_CHARS);
      if (text === "") throw Object.assign(new Error("模型没有返回内容"), { code: "empty-answer" });
      const parsed = extractJson(text);
      if (task === "classify") {
        const asked = Array.isArray(input.merchants) ? input.merchants.slice(0, MAX_CLASSIFY_MERCHANTS) : [];
        const map = coerceClassifyAnswer(parsed, asked);
        if (Object.keys(map).length === 0) {
          return { ok: false, error: { code: "bad-answer", message: "模型返回的分类结果不可用，已改用规则分类" } };
        }
        lastFailure = null;
        return { ok: true, value: map, model };
      }
      const insights = coerceInsightAnswer(parsed ?? (typeof text === "string" ? text : ""));
      if (insights.length === 0) {
        return { ok: false, error: { code: "bad-answer", message: "模型返回的洞察不可用，已改用规则提示" } };
      }
      lastFailure = null;
      return { ok: true, value: { insights }, model };
    } catch (error) {
      const aborted = controller.signal.aborted;
      lastFailure = {
        code: aborted ? "timeout" : "model-error",
        hint: aborted
          ? "模型这次回得太慢，AI 洞察暂时关掉了，稍后可以在面板里重试。"
          : "模型调用失败，AI 洞察暂时关掉了，稍后可以在面板里重试。",
        message: error instanceof Error ? error.message : String(error)
      };
      return { ok: false, error: { code: lastFailure.code, message: lastFailure.message } };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    status,
    run,
    /** 忘掉缓存的失败——面板上的「重试」按钮调它。 */
    reset() {
      lastFailure = null;
    },
    /** 暴露给工具/路由的快照压缩，测试也用。 */
    digest: snapshotDigest,
    taskSpec: (task) => TASKS[task],
    now
  };
}

/**
 * `classify` 的输入体：一行一个商户。
 * @param {{ merchants?: unknown }} input 任务输入。
 * @returns {string} 文本。
 */
function classifyBody(input) {
  const merchants = Array.isArray(input.merchants)
    ? input.merchants.map((merchant) => cleanText(merchant, 80)).filter((merchant) => merchant !== "")
    : [];
  const unique = [...new Set(merchants)].slice(0, MAX_CLASSIFY_MERCHANTS);
  if (unique.length === 0) return "";
  return `商户列表：\n${unique.map((merchant) => `- ${merchant}`).join("\n")}`;
}

/**
 * `insight` 的输入体：快照摘要。
 * @param {{ snapshot?: object, money?: (cents: number) => string }} input 任务输入。
 * @returns {string} 文本。
 */
function insightBody(input) {
  const money = typeof input.money === "function" ? input.money : (cents) => `${Math.round(Number(cents) || 0) / 100} 元`;
  const digest = snapshotDigest(input.snapshot, money);
  return digest === "" ? "" : `理财看板快照：\n${digest}`;
}