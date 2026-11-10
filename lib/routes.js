/**
 * dsh-finance · 面板读写的本地 HTTP 接口。
 *
 * 浏览器面板不直接碰 `finance.json`，也不直接调模型：它只跟 Host 上已经
 * 提供页面服务的这几个同源 JSON 路由打交道。**每个请求在任何字节被读之前
 * 都先过浏览器信任栅栏**——这些路由暴露的是用户全部的账本，其中一条还会
 * 花用户的模型额度。
 *
 *   GET  /dsh-finance/api/snapshot?month=YYYY-MM      整屏看板（financeSnapshot）
 *   POST /dsh-finance/api/import                       { name, content, encoding? } → 预览，不落库
 *   POST /dsh-finance/api/import/confirm               { name, rows, format } → 落库 + 新快照
 *   GET  /dsh-finance/api/txns?month=&q=&category=&limit=
 *   POST /dsh-finance/api/txns                         { op: add | update | remove }
 *   POST /dsh-finance/api/assets                       { op: add | update | remove }
 *   POST /dsh-finance/api/liabilities                  { op: add | update | remove }
 *   POST /dsh-finance/api/holdings                     { op: add | update | remove }
 *   POST /dsh-finance/api/budgets                      { op: set | remove }
 *   POST /dsh-finance/api/goals                        { op: add | update | contribute | remove }
 *   POST /dsh-finance/api/settings                     { …设置片段 }
 *   POST /dsh-finance/api/rules                        { merchant, category, purpose } → 记住一次修正
 *   GET  /dsh-finance/api/export                       整份 JSON（备份下载）
 *   POST /dsh-finance/api/import-db                    { data } → 替换整库
 *   POST /dsh-finance/api/demo                         → 空库时写入示例数据
 *   GET  /dsh-finance/api/ai/status                    AI 能不能用
 *   POST /dsh-finance/api/ai/insight                   { month } → { text, source: "ai" | "rules" }
 *   POST /dsh-finance/api/ai/retry                     忘掉缓存的 AI 失败
 *
 * 统一信封：`{ ok: true, value }` / `{ ok: false, error: { code, message } }`，
 * `content-type: application/json; charset=utf-8`，`cache-control: no-store`。
 *
 * AI 失败**从不**是致命错误：`/ai/insight` 降级成 `analysis.js` 已经算好的
 * `tips`，并如实回答 `source: "rules"`，面板据此显示一个诚实的角标。
 *
 * @module dsh-finance/lib/routes
 */

import { parseBillWithCategories } from "./importer.js";
import { classify, classifyRows, autoRateOf } from "./classify.js";
import { financeSnapshot, summarizeSnapshot } from "./analysis.js";
import { CATEGORIES, PURPOSES, currentMonth, formatCents, isMonthText } from "./domain.js";
import { needsAiOf } from "./ai.js";

/** 本插件占用的路由前缀。 */
export const ROUTE_PREFIX = "/dsh-finance/api";

/** 请求体上限：一份账单 CSV 或一段粘贴文本，16MB 足够。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** 一次导入预览最多接受多少行（防止误传超大文件把面板拖死）。 */
const MAX_IMPORT_ROWS = 20_000;

/** 流水查询默认条数。 */
const DEFAULT_TXN_LIMIT = 200;

/** 流水查询最大条数。 */
const MAX_TXN_LIMIT = 2_000;

/** 增删改允许的 `op`。 */
const MUTATE_OPS = new Set(["add", "update", "remove"]);
const BUDGET_OPS = new Set(["set", "remove"]);
const GOAL_OPS = new Set(["add", "update", "contribute", "remove"]);

// ── 信封 ─────────────────────────────────────────────────────────────────

/** 说一段 JSON，永不缓存。 */
const send = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
};

/** 成功信封。 */
const ok = (res, value) => send(res, 200, { ok: true, value });

/** 失败信封，带稳定的机器码。 */
const fail = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });

/** 读并解析一个 JSON 对象体，超限直接拒绝。 */
const readJson = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求太大了（超过 16MB）"), { code: "too_large" });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求不是合法的 JSON"), { code: "invalid_json" });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("请求体必须是一个对象"), { code: "invalid_json" });
  }
  return value;
};

/**
 * 判断一个请求能不能被处理。
 *
 * 匿名浏览器调用一律拒绝：这里全是私事。组成里有 Host `connection` 服务时
 * 以它为准（它负责 Host/Origin 栅栏与签名 cookie）；没有它（例如裸的测试
 * 环境）则只放行 loopback。
 * @param {object} ctx 插件的 Host 上下文（或带 `get` / 直接带服务的假对象）。
 * @param {import("node:http").IncomingMessage} req 请求。
 * @returns {number} 放行返回 0，否则返回要拒绝的 HTTP 状态码。
 */
export function rejectionOf(ctx, req) {
  let connection = null;
  try {
    connection = typeof ctx.get === "function" ? ctx.get("connection") : ctx.connection;
  } catch {
    connection = null;
  }
  if (connection !== null && connection !== undefined && typeof connection.requestRejection === "function") {
    const rejection = connection.requestRejection(req);
    return typeof rejection === "number" && Number.isFinite(rejection) ? rejection : 0;
  }
  // 没有 connection 服务：只让本机回环地址访问（空地址视为同进程调用）。
  const remote = req?.socket?.remoteAddress ?? "";
  if (remote === "" || remote === "::1") return 0;
  if (/^127\.\d+\.\d+\.\d+$/u.test(remote) || /^::ffff:127\.\d+\.\d+\.\d+$/u.test(remote)) return 0;
  return 403;
}

// ── 小工具 ───────────────────────────────────────────────────────────────

/** 读一个字符串字段并 trim。 */
const str = (value) => (typeof value === "string" ? value.trim() : "");

/** 读一个有限数字字段。 */
const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** 「元」→「分」；不合法返回 undefined。 */
const yuanToCents = (value) => {
  const n = num(value);
  return n === undefined ? undefined : Math.round(n * 100);
};

/**
 * 读金额：面板按「分」传，也容忍 `…Yuan` 的「元」字段。
 * @param {Record<string, unknown>} input 输入。
 * @param {string} field 字段名（`amount` / `value` / `balance` …）。
 * @returns {number | undefined} 分。
 */
const centsOf = (input, field) => {
  const direct = num(input[field]);
  if (direct !== undefined) return Math.round(direct);
  return yuanToCents(input[`${field}Yuan`]);
};

/**
 * `month` 查询参数：合法 `YYYY-MM` 就用它，否则退回当前月。
 * @param {URL} url 请求的 URL。
 * @returns {string} 月份。
 */
const monthParam = (url) => {
  const raw = str(url.searchParams.get("month"));
  return isMonthText(raw) ? raw : currentMonth();
};

/**
 * 把快照渲染成给人看的文本（AI 不可用时的降级答案）。
 *
 * 主体用 `analysis.js` 的 `summarizeSnapshot`——它自带收支三数与支出构成，
 * 比单列 tips 信息量足；后面再补上逐条 tip 的细节，让面板和模型都能读。
 * @param {object} snapshot 快照。
 * @returns {string} 文本。
 */
export function tipsToText(snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || snapshot.summary === undefined) {
    return "还没有可用的财务数据。先记几笔账，或者导入一份支付宝/微信账单。";
  }
  let head = "";
  try {
    head = summarizeSnapshot(snapshot);
  } catch {
    head = "";
  }
  const tips = Array.isArray(snapshot.tips) ? snapshot.tips : [];
  if (tips.length === 0) {
    return head === "" ? "这个月的账本还比较干净，暂时没有特别的提醒。" : head;
  }
  const icon = { good: "✅", warn: "⚠️", info: "💡" };
  const details = tips
    .slice(0, 5)
    .filter((tip) => tip !== null && typeof tip === "object")
    .map((tip) => `${icon[tip.level] ?? "•"} ${tip.title ?? ""}：${tip.detail ?? ""}`)
    .join("\n");
  // summarizeSnapshot 那句「提示：A；B。」只是标题摘要，这里换成带上细节的完整版。
  const body = head
    .split("\n")
    .filter((line) => !line.startsWith("提示："))
    .join("\n");
  return body === "" ? details : `${body}\n${details}`;
}

/**
 * 把 AI 返回的洞察列表渲染成文本（与 tips 同一套写法）。
 * @param {unknown} insights 洞察数组。
 * @param {string} month 月份。
 * @returns {string} 文本。
 */
export function insightsToText(insights, month) {
  const list = Array.isArray(insights) ? insights.filter((line) => typeof line === "string" && line.trim() !== "") : [];
  if (list.length === 0) return "";
  return `${month} 的几点观察：\n${list.map((line, index) => `${index + 1}. ${line}`).join("\n")}`;
}

// ── 快照 ─────────────────────────────────────────────────────────────────

/**
 * 取一份快照。
 * @param {object} deps `{ store, ai }`。
 * @param {string} month 月份 `YYYY-MM`。
 * @returns {Promise<object>} financeSnapshot。
 */
async function snapshotOf(deps, month) {
  await deps.store.ready();
  return financeSnapshot(deps.store.getDb(), { month, now: Date.now() });
}

// ── 导入 ─────────────────────────────────────────────────────────────────

/**
 * 预览一次导入：解析 → 规则分类 → AI 兜底那些落进「其他」的商户。
 *
 * 不落库。`encoding === "base64"` 时把 content 解成 Buffer 交给 `parseBill`
 * （xlsx 与 GBK 的 CSV 都靠这条路径）；否则按字符串原样交。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} 预览结果。
 */
async function previewImport(deps, body) {
  const name = str(body.name) || "账单文件";
  const raw = typeof body.content === "string" ? body.content : "";
  if (raw === "") throw Object.assign(new Error("没有收到文件内容"), { code: "empty-file" });
  const encoding = str(body.encoding).toLowerCase();
  const content = encoding === "base64" ? Buffer.from(raw, "base64") : raw;
  await deps.store.ready();
  // 解析 + 规则分类一步到位（importer 的便利函数，内部就是 parseBill + classifyRows）。
  const parsed = parseBillWithCategories({ name, content }, { now: Date.now(), rules: deps.store.getRules() });
  let rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  if (rows.length > MAX_IMPORT_ROWS) rows = rows.slice(0, MAX_IMPORT_ROWS);

  // 规则没命中的行，交给 AI 再试一轮。
  const needsAi = needsAiOf;
  const unknown = [...new Set(rows.filter(needsAi).map((row) => str(row.merchant)))].filter((merchant) => merchant !== "");
  let aiFilled = 0;
  /** @type {{ ok: boolean, error?: { code: string, message: string } } | null} */
  let aiOutcome = null;
  if (unknown.length > 0 && typeof deps.ai?.run === "function") {
    const result = await deps.ai.run("classify", { merchants: unknown });
    aiOutcome = result.ok === true ? { ok: true } : { ok: false, error: result.error };
    if (result.ok === true && result.value !== null && typeof result.value === "object") {
      /** @type {Record<string, { category?: string, purpose?: string }>} */
      const map = result.value;
      rows = rows.map((row) => {
        if (!needsAi(row)) return row;
        const hit = map[str(row.merchant)];
        if (hit === undefined || !CATEGORIES.includes(hit.category) || hit.category === "收入" || hit.category === "其他") return row;
        aiFilled += 1;
        return {
          ...row,
          category: hit.category,
          purpose: PURPOSES.includes(hit.purpose) ? hit.purpose : row.purpose,
          confidence: "ai"
        };
      });
    }
  }

  return {
    import: { name, format: parsed.format, at: Date.now() },
    format: parsed.format,
    columns: parsed.columns,
    rows,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    skipped: Number(parsed.skipped) || 0,
    autoRate: autoRateOf(rows),
    counts: {
      total: rows.length,
      expense: rows.filter((row) => row.direction === "expense").length,
      income: rows.filter((row) => row.direction === "income").length,
      auto: rows.filter((row) => row.confidence === "rule" || row.confidence === "user" || row.confidence === "ai").length,
      aiFilled
    },
    ai: aiOutcome,
    preview: true
  };
}

/**
 * 确认入库：把（可能被用户改过分类的）行写进账本。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ added, duplicates, importId, snapshot }`。
 */
async function confirmImport(deps, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length === 0) throw Object.assign(new Error("没有要导入的行"), { code: "empty-rows" });
  if (rows.length > MAX_IMPORT_ROWS) throw Object.assign(new Error(`一次最多导入 ${MAX_IMPORT_ROWS} 行`), { code: "too-many-rows" });
  const name = str(body.name) || "账单文件";
  const format = str(body.format);
  const month = isMonthText(str(body.month)) ? str(body.month) : currentMonth();
  // 面板可能把用户手改过的分类一起传回来；没给分类的行在这里过一次规则
  // （含用户修正记忆），否则 store 只能兜到「其他」。
  await deps.store.ready();
  const rules = deps.store.getRules();
  const prepared = classifyRows(
    rows.map((row) => {
      /** @type {Record<string, unknown>} */
      const clean = {
        date: str(row?.date),
        amount: Math.abs(Math.round(Number(row?.amount) || 0)),
        direction: row?.direction === "income" ? "income" : "expense",
        category: str(row?.category),
        purpose: str(row?.purpose),
        account: str(row?.account),
        merchant: str(row?.merchant),
        note: str(row?.note),
        money: row?.money === true
      };
      const dedupeKey = str(row?.dedupeKey);
      if (dedupeKey !== "") clean.dedupeKey = dedupeKey;
      return clean;
    }),
    rules
  );
  const result = await deps.store.importRows({ name, format, rows: prepared });
  return {
    added: Number(result.added) || 0,
    duplicates: Number(result.duplicates) || 0,
    invalid: Number(result.invalid) || 0,
    importId: str(result.importId),
    snapshot: await snapshotOf(deps, month)
  };
}

// ── 流水 ─────────────────────────────────────────────────────────────────

/**
 * 查流水：按月份 / 关键词 / 分类 / 方向过滤，按日期倒序。
 * @param {object} deps `{ store, ai }`。
 * @param {URL} url 请求 URL。
 * @returns {Promise<object>} `{ txns, total, limit, month }`。
 */
async function queryTxns(deps, url) {
  const month = str(url.searchParams.get("month"));
  const q = str(url.searchParams.get("q"));
  const category = str(url.searchParams.get("category"));
  const direction = str(url.searchParams.get("direction"));
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), MAX_TXN_LIMIT) : DEFAULT_TXN_LIMIT;
  await deps.store.ready();
  const result = deps.store.listTxns({
    ...(isMonthText(month) ? { month } : {}),
    ...(q === "" ? {} : { q }),
    ...(category === "" ? {} : { category }),
    ...(direction === "expense" || direction === "income" ? { direction } : {}),
    limit
  });
  return { txns: result.txns, total: result.total, limit, month: isMonthText(month) ? month : null };
}

/**
 * 新建 / 修改 / 删除一条流水。
 *
 * `add` 时没给分类就用规则猜（用户修正记忆优先）；`update` 改了分类时
 * store 会自动把这次修正写进 `rules`，下次同类商户直接命中。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ txn, removed, duplicates?, snapshot }`。
 */
async function mutateTxn(deps, body) {
  const op = str(body.op);
  if (!MUTATE_OPS.has(op)) throw badOp(op);
  const month = isMonthText(str(body.month)) ? str(body.month) : currentMonth();
  if (op === "remove") {
    const id = str(body.id) || str(body.txn?.id);
    if (id === "") throw badRequest("缺少流水 id");
    const { removed } = await deps.store.removeTxn(id);
    return { txn: null, removed, snapshot: await snapshotOf(deps, month) };
  }
  const input = body.txn !== null && typeof body.txn === "object" ? /** @type {Record<string, unknown>} */ (body.txn) : body;
  const patch = txnPatchOf(input);
  if (op === "update") {
    const id = str(input.id) || str(body.id);
    if (id === "") throw badRequest("缺少流水 id");
    if (Object.keys(patch).length === 0) throw badRequest("没有要改的字段");
    const { txn } = await deps.store.updateTxn(id, patch);
    return { txn, removed: null, snapshot: await snapshotOf(deps, month) };
  }
  if (patch.amount === undefined || patch.amount <= 0) throw badRequest("金额必须大于 0");
  if (patch.date === undefined) throw badRequest("日期不能为空（YYYY-MM-DD）");
  const direction = patch.direction ?? "expense";
  const guessed = classify(
    { merchant: str(patch.merchant), note: str(patch.note), category: str(patch.category), direction, amount: patch.amount },
    deps.store.getRules()
  );
  const category = str(patch.category) !== "" ? str(patch.category) : guessed.category;
  const purpose = direction === "income" ? "" : str(patch.purpose) || guessed.purpose;
  const { txn } = await deps.store.addTxn({ ...patch, category, purpose });
  return { txn, removed: null, snapshot: await snapshotOf(deps, month) };
}

/**
 * 把请求体里认识的流水字段收成一个补丁。
 * @param {Record<string, unknown>} input 输入。
 * @returns {Record<string, unknown>} 补丁。
 */
function txnPatchOf(input) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  const date = str(input.date);
  if (date !== "") patch.date = date;
  const cents = centsOf(input, "amount");
  if (cents !== undefined) patch.amount = Math.abs(cents);
  if (input.direction === "income" || input.direction === "expense") patch.direction = input.direction;
  if (typeof input.category === "string" && input.category.trim() !== "") patch.category = input.category.trim();
  if (typeof input.purpose === "string") patch.purpose = input.purpose.trim();
  if (typeof input.account === "string") patch.account = input.account.trim();
  if (typeof input.merchant === "string") patch.merchant = input.merchant.trim();
  if (typeof input.note === "string") patch.note = input.note;
  if (typeof input.money === "boolean") patch.money = input.money;
  if (input.allowDuplicate === true) patch.allowDuplicate = true;
  return patch;
}

// ── 资产 / 负债 / 持仓 ───────────────────────────────────────────────────

/** 资源类型 → store 的方法前后缀。 */
const ENTITY = Object.freeze({
  asset: { add: "addAsset", update: "updateAsset", remove: "removeAsset", key: "asset" },
  liability: { add: "addLiability", update: "updateLiability", remove: "removeLiability", key: "liability" },
  holding: { add: "addHolding", update: "updateHolding", remove: "removeHolding", key: "holding" }
});

/**
 * 资产的增删改。
 * @param {object} deps `{ store, ai }`。
 * @param {"asset" | "liability" | "holding"} kind 资源类型。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ item, removed, snapshot }`。
 */
async function mutateEntity(deps, kind, body) {
  const op = str(body.op);
  if (!MUTATE_OPS.has(op)) throw badOp(op);
  const meta = ENTITY[kind];
  const month = isMonthText(str(body.month)) ? str(body.month) : currentMonth();
  const input = body[kind] !== null && typeof body[kind] === "object" ? /** @type {Record<string, unknown>} */ (body[kind]) : body;
  if (op === "remove") {
    const id = str(input.id) || str(body.id);
    if (id === "") throw badRequest("缺少 id");
    const { removed } = await deps.store[meta.remove](id);
    return { item: null, removed, snapshot: await snapshotOf(deps, month) };
  }
  const patch = entityPatchOf(kind, input);
  if (op === "update") {
    const id = str(input.id) || str(body.id);
    if (id === "") throw badRequest("缺少 id");
    if (Object.keys(patch).length === 0) throw badRequest("没有要改的字段");
    const result = await deps.store[meta.update](id, patch);
    return { item: result[meta.key], removed: null, snapshot: await snapshotOf(deps, month) };
  }
  const result = await deps.store[meta.add](patch);
  return { item: result[meta.key], removed: null, snapshot: await snapshotOf(deps, month) };
}

/**
 * 资产 / 负债 / 持仓字段归一化。金额字段接受「分」（`value`）也接受「元」（`valueYuan`）。
 * @param {"asset" | "liability" | "holding"} kind 类型。
 * @param {Record<string, unknown>} input 输入。
 * @returns {Record<string, unknown>} 补丁。
 */
function entityPatchOf(kind, input) {
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (typeof input.name === "string") patch.name = input.name.trim();
  if (typeof input.note === "string") patch.note = input.note;
  if (typeof input.account === "string") patch.account = input.account.trim();
  if (kind === "asset") {
    if (typeof input.kind === "string" && input.kind.trim() !== "") patch.kind = input.kind.trim();
    const value = centsOf(input, "value");
    if (value !== undefined) patch.value = value;
  }
  if (kind === "liability") {
    if (typeof input.kind === "string" && input.kind.trim() !== "") patch.kind = input.kind.trim();
    const balance = centsOf(input, "balance");
    if (balance !== undefined) patch.balance = balance;
    const monthly = centsOf(input, "monthlyPayment");
    if (monthly !== undefined) patch.monthlyPayment = monthly;
    const dueDay = num(input.dueDay);
    if (dueDay !== undefined) patch.dueDay = dueDay;
  }
  if (kind === "holding") {
    const type = str(input.type) || str(input.kind);
    if (type !== "") patch.type = type;
    if (typeof input.code === "string") patch.code = input.code.trim();
    const shares = num(input.shares);
    if (shares !== undefined) patch.shares = shares;
    const cost = centsOf(input, "costPrice");
    if (cost !== undefined) patch.costPrice = cost;
    const price = centsOf(input, "price");
    if (price !== undefined) patch.price = price;
  }
  return patch;
}

// ── 预算 / 目标 / 设置 ───────────────────────────────────────────────────

/**
 * 预算的设置 / 删除。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ budget, removed, snapshot }`。
 */
async function mutateBudget(deps, body) {
  const op = str(body.op);
  if (!BUDGET_OPS.has(op)) throw badOp(op);
  const rawMonth = str(body.month);
  const month = rawMonth === "default" ? "default" : isMonthText(rawMonth) ? rawMonth : currentMonth();
  const category = str(body.category);
  if (category === "" || !CATEGORIES.includes(category) || category === "收入") {
    throw badRequest(`预算分类只能是：${CATEGORIES.filter((item) => item !== "收入").join("、")}`);
  }
  const snapMonth = month === "default" ? currentMonth() : month;
  if (op === "remove") {
    const { removed } = await deps.store.removeBudget({ month, category });
    return { budget: null, removed, snapshot: await snapshotOf(deps, snapMonth) };
  }
  const limit = centsOf(body, "limit");
  if (limit === undefined || limit <= 0) throw badRequest("预算金额必须大于 0");
  const { budget } = await deps.store.setBudget(month, category, limit);
  return { budget, removed: null, snapshot: await snapshotOf(deps, snapMonth) };
}

/**
 * 存钱目标：新建 / 修改 / 追加 / 删除。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ goal, removed, snapshot }`。
 */
async function mutateGoal(deps, body) {
  const op = str(body.op);
  if (!GOAL_OPS.has(op)) throw badOp(op);
  const month = isMonthText(str(body.month)) ? str(body.month) : currentMonth();
  const input = body.goal !== null && typeof body.goal === "object" ? /** @type {Record<string, unknown>} */ (body.goal) : body;
  const id = str(input.id) || str(body.id);
  if (op === "remove") {
    if (id === "") throw badRequest("缺少目标 id");
    const { removed } = await deps.store.removeGoal(id);
    return { goal: null, removed, snapshot: await snapshotOf(deps, month) };
  }
  if (op === "contribute") {
    if (id === "") throw badRequest("缺少目标 id");
    const amount = centsOf(body, "amount") ?? centsOf(input, "amount");
    if (amount === undefined || amount === 0) throw badRequest("存入金额不能为 0");
    const { goal } = await deps.store.contributeGoal(id, amount);
    return { goal, removed: null, snapshot: await snapshotOf(deps, month) };
  }
  /** @type {Record<string, unknown>} */
  const patch = {};
  if (typeof input.name === "string") patch.name = input.name.trim();
  if (typeof input.note === "string") patch.note = input.note;
  if (typeof input.deadline === "string") patch.deadline = input.deadline.trim();
  const target = centsOf(input, "target");
  if (target !== undefined) patch.target = target;
  const saved = centsOf(input, "saved");
  if (saved !== undefined) patch.saved = saved;
  if (op === "update") {
    if (id === "") throw badRequest("缺少目标 id");
    if (Object.keys(patch).length === 0) throw badRequest("没有要改的字段");
    const { goal } = await deps.store.updateGoal(id, patch);
    return { goal, removed: null, snapshot: await snapshotOf(deps, month) };
  }
  if (str(input.name) === "") throw badRequest("目标要有名字");
  if (patch.target === undefined || patch.target <= 0) throw badRequest("目标金额必须大于 0");
  const { goal } = await deps.store.addGoal(patch);
  return { goal, removed: null, snapshot: await snapshotOf(deps, month) };
}

/**
 * 改设置（货币、应急金月数等）。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ settings, snapshot }`。
 */
async function updateSettings(deps, body) {
  const patch = body.settings !== null && typeof body.settings === "object" ? body.settings : body;
  const { settings } = await deps.store.updateSettings(patch);
  return { settings, snapshot: await snapshotOf(deps, isMonthText(str(body.month)) ? str(body.month) : currentMonth()) };
}

/**
 * 记住一条商户修正：`rules[归一化商户] = { category, purpose }`。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body 请求体。
 * @returns {Promise<object>} `{ rule, rules, snapshot }`。
 */
async function rememberRule(deps, body) {
  const merchant = str(body.merchant);
  const category = str(body.category);
  if (merchant === "") throw badRequest("缺少商户名");
  if (!CATEGORIES.includes(category) || category === "收入") {
    throw badRequest(`分类只能是：${CATEGORIES.filter((item) => item !== "收入").join("、")}`);
  }
  const purpose = PURPOSES.includes(str(body.purpose)) ? str(body.purpose) : "";
  const { rule } = await deps.store.rememberRule(merchant, { category, purpose });
  return { rule, rules: deps.store.getRules(), snapshot: await snapshotOf(deps, isMonthText(str(body.month)) ? str(body.month) : currentMonth()) };
}

// ── AI ───────────────────────────────────────────────────────────────────

/**
 * AI 洞察：优先 AI，失败降级成规则 tips。
 *
 * 两种情况都返回 200，靠 `source` 区分；面板不需要区分「失败」和「成功」。
 * @param {object} deps `{ store, ai }`。
 * @param {Record<string, unknown>} body `{ month }`。
 * @returns {Promise<object>} `{ month, text, source, insights?, model?, tips, error? }`。
 */
async function aiInsight(deps, body) {
  const month = isMonthText(str(body.month)) ? str(body.month) : currentMonth();
  const snapshot = await snapshotOf(deps, month);
  const tips = Array.isArray(snapshot.tips) ? snapshot.tips : [];
  if (typeof deps.ai?.run !== "function") {
    return {
      month,
      text: tipsToText(snapshot),
      source: "rules",
      tips,
      error: { code: "no-ai", message: "这个 Harness 里没有可用的 AI 服务" }
    };
  }
  const result = await deps.ai.run("insight", {
    snapshot,
    money: (cents) => formatCents(cents, { symbol: false, group: true })
  });
  if (result.ok === true) {
    const insights = Array.isArray(result.value?.insights) ? result.value.insights : [];
    const text = insightsToText(insights, month);
    if (text !== "") return { month, text, source: "ai", insights, model: result.model, tips };
  }
  return {
    month,
    text: tipsToText(snapshot),
    source: "rules",
    tips,
    error: result.ok === true ? { code: "empty-answer", message: "AI 返回为空，已改用规则提示" } : result.error
  };
}

// ── 错误 ─────────────────────────────────────────────────────────────────

/** 造一个「不认识的 op」错误。 */
const badOp = (op) => Object.assign(new Error(`不认识的 op：${op === "" ? "(空)" : op}`), { code: "bad_op", status: 400 });

/** 造一个 400 请求错误。 */
const badRequest = (message) => Object.assign(new Error(message), { code: "bad_request", status: 400 });

// ── 注册 ─────────────────────────────────────────────────────────────────

/**
 * 注册全部路由。
 *
 * @param {{ webServer: { register(route: object): () => void }, get?: Function }} webCtx 带 webServer 的上下文。
 * @param {{ store: object, ai: object }} deps 依赖。
 * @returns {() => void} 移除路由的 disposer。
 */
export function registerRoutes(webCtx, deps) {
  const handler = async (req, res) => {
    const rejection = rejectionOf(webCtx, req);
    if (rejection !== 0) {
      fail(res, rejection, rejection === 401 ? "unauthorized" : "forbidden", "这个请求不是从 Harness 页面发来的");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      // ── 看板 ────────────────────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/snapshot` && method === "GET") {
        ok(res, await snapshotOf(deps, monthParam(url)));
        return;
      }
      // ── 导入 ────────────────────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/import` && method === "POST") {
        ok(res, await previewImport(deps, await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/import/confirm` && method === "POST") {
        ok(res, await confirmImport(deps, await readJson(req)));
        return;
      }
      // ── 流水 ────────────────────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/txns` && method === "GET") {
        ok(res, await queryTxns(deps, url));
        return;
      }
      if (path === `${ROUTE_PREFIX}/txns` && method === "POST") {
        ok(res, await mutateTxn(deps, await readJson(req)));
        return;
      }
      // ── 资产 / 负债 / 持仓 ──────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/assets` && method === "POST") {
        ok(res, await mutateEntity(deps, "asset", await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/liabilities` && method === "POST") {
        ok(res, await mutateEntity(deps, "liability", await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/holdings` && method === "POST") {
        ok(res, await mutateEntity(deps, "holding", await readJson(req)));
        return;
      }
      // ── 预算 / 目标 / 设置 / 规则 ───────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/budgets` && method === "POST") {
        ok(res, await mutateBudget(deps, await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/goals` && method === "POST") {
        ok(res, await mutateGoal(deps, await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/settings` && method === "POST") {
        ok(res, await updateSettings(deps, await readJson(req)));
        return;
      }
      if (path === `${ROUTE_PREFIX}/rules` && method === "POST") {
        ok(res, await rememberRule(deps, await readJson(req)));
        return;
      }
      // ── 备份 / 恢复 / 示例 ──────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/export` && method === "GET") {
        await deps.store.ready();
        const db = deps.store.getDb();
        ok(res, { version: db?.version ?? 1, exportedAt: Date.now(), db });
        return;
      }
      if (path === `${ROUTE_PREFIX}/import-db` && method === "POST") {
        const body = await readJson(req);
        const data = body.data !== null && typeof body.data === "object" ? body.data : null;
        if (data === null) throw badRequest("缺少要恢复的账本数据");
        await deps.store.replaceDb(data);
        ok(res, { restored: true, snapshot: await snapshotOf(deps, monthParam(url)) });
        return;
      }
      if (path === `${ROUTE_PREFIX}/demo` && method === "POST") {
        const body = await readJson(req);
        await deps.store.seedDemo(Date.now());
        ok(res, { demo: true, snapshot: await snapshotOf(deps, isMonthText(str(body.month)) ? str(body.month) : currentMonth()) });
        return;
      }
      // 清空演示账本，换成用户自己的数据（清空后不会再自动铺演示数据）。
      if (path === `${ROUTE_PREFIX}/demo` && method === "DELETE") {
        const body = await readJson(req);
        await deps.store.resetToEmpty();
        ok(res, { demo: false, snapshot: await snapshotOf(deps, isMonthText(str(body.month)) ? str(body.month) : currentMonth()) });
        return;
      }
      // ── AI ──────────────────────────────────────────────────────────────
      if (path === `${ROUTE_PREFIX}/ai/status` && method === "GET") {
        ok(res, aiStatusOf(deps));
        return;
      }
      if (path === `${ROUTE_PREFIX}/ai/retry` && method === "POST") {
        if (typeof deps.ai?.reset === "function") deps.ai.reset();
        ok(res, aiStatusOf(deps));
        return;
      }
      if (path === `${ROUTE_PREFIX}/ai/insight` && method === "POST") {
        ok(res, await aiInsight(deps, await readJson(req)));
        return;
      }
      fail(res, 404, "not-found", "没有这个接口");
    } catch (error) {
      const code = error?.code;
      const status = error?.status;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "too_large") {
        fail(res, 413, "too_large", message);
        return;
      }
      if (code === "invalid_json" || code === "empty-file" || code === "empty_file" || status === 400) {
        fail(res, 400, code ?? "bad_request", message);
        return;
      }
      // store 的业务错误（找不到 / 重复 / 校验不过）都是中文人话，转 400 让面板直接显示。
      if (message.startsWith("找不到") || message.startsWith("这笔账") || message.startsWith("已经有") || message.startsWith("请") || message.startsWith("金额")) {
        fail(res, 400, "bad_request", message);
        return;
      }
      console.warn("[dsh-finance] route failed:", error);
      fail(res, 500, "internal", message === "" ? "账本操作失败" : message);
    }
  };

  return webCtx.webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler });
}

/**
 * AI 状态：桥没有的时候也要给面板一个诚实的答案。
 * @param {object} deps `{ store, ai }`。
 * @returns {object} `{ available, model, reason?, hint? }`。
 */
function aiStatusOf(deps) {
  if (typeof deps.ai?.status !== "function") return { available: false, model: null, reason: "no-ai", hint: "这个 Harness 里没有 AI 服务。" };
  try {
    return deps.ai.status();
  } catch (error) {
    return { available: false, model: null, reason: "error", hint: error instanceof Error ? error.message : String(error) };
  }
}