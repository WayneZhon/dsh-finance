// @wayne/dsh-finance — browser half (client plugin bundle).
//
// Loaded by the shell's client module table and executed through the vendored
// cordis Loader's lazy-CJS mechanism (`window.__ModuleLoader__.load`). Only the
// two platform seeds are required (`react`, `react/jsx-runtime`) and they are
// required lazily inside try blocks: a factory that throws takes the whole
// shell down, so a missing seed degrades this plugin to an invisible no-op.
//
// Surfaces:
//   main               the personal finance cockpit: header with the month
//                      switcher, three headline numbers, four tabs (cash flow,
//                      assets, investments, planning) and the import wizard
//   sidebar.panellist  the sidebar row that opens the cockpit
//
// Every read and write goes through the Host half's HTTP routes under
// `/dsh-finance/api`; this module never calls a model and never touches the
// ledger file. Amounts travel in **fen** (integers) and are divided by 100 for
// display. The only persisted browser-side state is the last selected month.
//
// Visual language: an "ink on paper" cockpit in the spirit of a printed
// financial report — tabular numbers, hairline rules, one warm accent, and
// pure-SVG charts that draw themselves in on mount. Structure is `--dsw-*`
// tokens so both shell themes work; the categorical palette is this plugin's
// own, tuned for light and dark.

window.__ModuleLoader__.load({
  id: "@wayne/dsh-finance",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ── platform seeds ────────────────────────────────────────────────────
    const seedProbe = { lastError: null };
    const requireSeed = (name) => {
      try {
        return require(name);
      } catch (error) {
        seedProbe.lastError = error;
        return null;
      }
    };
    const react = requireSeed("react");
    const jsxRuntime = requireSeed("react/jsx-runtime");
    if (react === null || jsxRuntime === null || typeof react.useSyncExternalStore !== "function") {
      try {
        console.warn("[@wayne/dsh-finance] React seed unavailable — plugin disabled:", seedProbe.lastError && seedProbe.lastError.message);
      } catch {}
      exports.apply = () => {};
      exports.inject = [];
      return module.exports;
    }
    const jsx = typeof jsxRuntime.jsx === "function" ? (type, props, key) => (key === undefined ? jsxRuntime.jsx(type, props) : jsxRuntime.jsx(type, props, key)) : (type, props) => react.createElement(type, props);
    const jsxs = typeof jsxRuntime.jsxs === "function" ? (type, props, key) => (key === undefined ? jsxRuntime.jsxs(type, props) : jsxRuntime.jsxs(type, props, key)) : jsx;

    // ── constants ─────────────────────────────────────────────────────────
    /**
     * Client plugin id; must equal the package name.
     *
     * A scoped name contains `/` and `@`, which are legal here (it is only a
     * module-table key) but not usable inside a DOM `id` or an SVG `url(#…)`
     * reference — so anything that reaches the document uses `DOM_ID` instead.
     */
    const PLUGIN_ID = "@wayne/dsh-finance";
    /** Filesystem- and selector-safe id for DOM ids, `data-*` and SVG references. */
    const DOM_ID = PLUGIN_ID.replace(/^@/u, "").replace(/\//gu, "-");
    /** Main-panel key opened by the sidebar row. */
    const PANEL_ID = "finance-panel";
    /** Locale namespace for every visible string. */
    const NS = "financeWorkspace";
    /** Stylesheet element id (and its disposal handle). */
    const STYLE_ID = `${DOM_ID}/styles`;
    /** API root. */
    const API_BASE = "/dsh-finance/api";
    /** The four tabs, in display order. */
    const TABS = Object.freeze(["board", "flow", "assets", "invest", "plan"]);
    /** Expense categories (CONTRACT: shared with the Host). */
    const CATEGORIES = Object.freeze(["餐饮", "交通", "购物", "居家", "家庭", "医疗", "教育", "娱乐", "通讯", "人情往来", "保险", "还贷", "投资", "其他"]);
    /** Income is always this one category. */
    const INCOME_CATEGORY = "收入";
    /** Directions. */
    const DIRECTIONS = Object.freeze(["expense", "income"]);
    /** Purposes (CONTRACT). */
    const PURPOSES = Object.freeze(["生活必须", "娱乐享受", "未来保障", "人情社交", "自我实现"]);
    /** Asset kinds (CONTRACT). */
    const ASSET_KINDS = Object.freeze(["cash", "investment", "property", "other"]);
    /** Liability kinds (CONTRACT). */
    const LIABILITY_KINDS = Object.freeze(["mortgage", "car", "credit", "consumer", "other"]);
    /** Holding types (CONTRACT). */
    const HOLDING_TYPES = Object.freeze(["fund", "stock", "bond", "other"]);
    /** How many rows the import preview shows. */
    const PREVIEW_ROWS = 30;
    /** How many months `GET /txns` asks for at once. */
    const TXN_PAGE = 500;
    /** A toast stays up this long. */
    const TOAST_MS = 3200;
    /** Days ahead that count as "a payment is coming up". */
    const DUE_SOON_DAYS = 7;

    /**
     * Categorical chart palette, in reading order. Eight hues, chosen for a
     * printed-report feel and for passing a greyscale check (each pair that
     * sits next to each other differs by lightness as well as hue).
     */
    const PALETTE = Object.freeze([
      { light: "#B4763C", dark: "#D79A5E" },
      { light: "#3E6E8E", dark: "#79A9C6" },
      { light: "#7A8A5C", dark: "#A6B584" },
      { light: "#9C5B76", dark: "#C98AA3" },
      { light: "#5F6C8C", dark: "#8E9BC0" },
      { light: "#A8863A", dark: "#CDAE69" },
      { light: "#4F8A7B", dark: "#7EBFAE" },
      { light: "#8A6A4F", dark: "#B49174" }
    ]);

    // ── small pure helpers ────────────────────────────────────────────────
    const pad2 = (value) => String(value).padStart(2, "0");

    /**
     * 一句话记账的解析器：「35 咖啡」「昨晚打车 42」「发工资 28600」。
     *
     * 面板上最高频的动作不该是填表。这里从一句话里认出：金额、方向
     * （收到/工资/进账 → 收入）、日期（今天/昨天/前天/`11-05`/`11月5日`）、
     * 以及剩下的商户文字。分类交给 Host 的规则引擎，面板只做即时提示。
     *
     * 认不出金额时返回 null，界面给出提示，而不是记一笔错账。
     *
     * @param {string} text 用户输入
     * @param {Date} [now] 当前时间（测试注入）
     * @returns {{ amount: number, direction: string, date: string, merchant: string } | null}
     */
    const parseQuickEntry = (text, now = new Date()) => {
      let rest = String(text ?? "").trim();
      if (rest === "") return null;
      // 方向先认，再把词摘掉，免得「发工资 28600」把「工资」混进商户名。
      let direction = "expense";
      if (/(收到|收入|进账|到账|发工资|工资|报销|返现)/u.test(rest)) direction = "income";
      // 日期词从今天倒推。
      let date = dayKey(now);
      const dayShift = (days) => {
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
        return dayKey(next);
      };
      const words = [
        [/大前天|前三晚/u, -3],
        [/前天|前晚/u, -2],
        [/昨天|昨日|昨晚/u, -1],
        [/今天|今日/u, 0]
      ];
      for (const [pattern, shift] of words) {
        if (pattern.test(rest)) {
          date = dayShift(shift);
          rest = rest.replace(pattern, " ");
          break;
        }
      }
      // `11-05` / `11/5` / `11月5日`（按今年算，晚于今天就当去年）
      const monthDay = /(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/u.exec(rest);
      if (monthDay !== null) {
        const month = Number(monthDay[1]);
        const day = Number(monthDay[2]);
        if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          const candidate = new Date(now.getFullYear(), month - 1, day);
          if (candidate.getTime() > now.getTime()) candidate.setFullYear(now.getFullYear() - 1);
          date = dayKey(candidate);
          rest = `${rest.slice(0, monthDay.index)} ${rest.slice(monthDay.index + monthDay[0].length)}`;
        }
      }
      // 金额：带钱单位/小数点的优先，其次第一个数字。
      const money = /(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块|块钱)?/iu.exec(rest);
      if (money === null) return null;
      const amount = Math.round(Number(money[1]) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) return null;
      rest = `${rest.slice(0, money.index)} ${rest.slice(money.index + money[0].length)}`;
      // 剩下的就是商户；去掉虚词。注意别把方向词本身也删光——「发工资 28600」
      // 的商户就该是「工资」，删掉它就变成一笔没有名字的收入。
      const merchant = rest
        .replace(/(收到|收入|进账|到账|花了|用了|买了|支付|付款)/gu, " ")
        .replace(/[，,。.！!？?、；;:：\s]+/gu, " ")
        .trim();
      if (merchant === "") {
        return direction === "income" ? { amount, direction, date, merchant: "收入" } : null;
      }
      return { amount, direction, date, merchant };
    };
    /** `YYYY-MM` for a local date. */
    const monthKey = (date = new Date()) => `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}`;
    /** `YYYY-MM-DD` for a local date. */
    const dayKey = (date = new Date()) => `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    /** Parse `YYYY-MM` into `{ year, month }` or null. */
    const parseMonth = (key) => {
      const match = /^(\d{4})-(\d{2})$/u.exec(String(key ?? ""));
      if (match === null) return null;
      const year = Number(match[1]);
      const month = Number(match[2]);
      if (month < 1 || month > 12) return null;
      return { year, month };
    };
    /** Move a `YYYY-MM` month key by `delta` months. */
    const shiftMonth = (key, delta) => {
      const parsed = parseMonth(key) ?? parseMonth(monthKey());
      const date = new Date(parsed.year, parsed.month - 1 + delta, 1);
      return monthKey(date);
    };
    /** Difference in whole months from `a` to `b` (b − a). */
    const monthsBetween = (a, b) => {
      const from = parseMonth(a);
      const to = parseMonth(b);
      if (from === null || to === null) return 0;
      return (to.year - from.year) * 12 + (to.month - from.month);
    };
    /** A finite number or `fallback`. */
    const num = (value, fallback = 0) => {
      const number = typeof value === "number" ? value : Number(value);
      return Number.isFinite(number) ? number : fallback;
    };
    /** An integer fen value from anything the Host may send. */
    const fen = (value) => Math.round(num(value, 0));
    /** Clamp. */
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    /** Message of an unknown error. */
    const messageOf = (error) => (error instanceof Error ? error.message : String(error));
    /** First non-empty string among the arguments. */
    const firstText = (...values) => {
      for (const value of values) if (typeof value === "string" && value !== "") return value;
      return "";
    };

    // ── number formatting ─────────────────────────────────────────────────
    /** Group thousands with a thin separator: 1234567 → "1,234,567". */
    const groupDigits = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
    /**
     * A fen amount as a plain yuan string: `¥1,234.56`, negative keeps its
     * minus in front of the sign. `decimals: 0` rounds to whole yuan.
     * @param {number} value fen.
     * @param {{ decimals?: 0 | 2, sign?: boolean }} [options] `sign: true` adds
     *   an explicit `+` for positive values (profit, deltas).
     * @returns {string} display text.
     */
    const money = (value, options = {}) => {
      const amount = fen(value);
      const decimals = options.decimals === 0 ? 0 : 2;
      const negative = amount < 0;
      const abs = Math.abs(amount);
      const yuan = decimals === 0 ? Math.round(abs / 100) : Math.floor(abs / 100);
      const cents = decimals === 0 ? 0 : abs % 100;
      const head = `${negative ? "-" : options.sign === true && abs > 0 ? "+" : ""}¥${groupDigits(String(yuan))}`;
      return decimals === 0 ? head : `${head}.${pad2(cents)}`;
    };
    /**
     * The headline-number form: above ¥10,000 it switches to `¥1.23万` so a
     * seven-digit number still fits a 36px card. `decimals` controls the tail.
     * @param {number} value fen.
     * @param {{ compact?: boolean, sign?: boolean }} [options] compact: false
     *   always prints the full amount.
     * @returns {{ text: string, unit: "" | "wan" }} the number and its unit,
     *   so the unit can be rendered at a smaller size.
     */
    const bigMoney = (value, options = {}) => {
      const amount = fen(value);
      const negative = amount < 0;
      const abs = Math.abs(amount);
      const prefix = `${negative ? "-" : options.sign === true && abs > 0 ? "+" : ""}¥`;
      if (options.compact === false || abs < 1_000_000) {
        return { text: `${prefix}${groupDigits(String(Math.floor(abs / 100)))}.${pad2(abs % 100)}`, unit: "" };
      }
      const wan = abs / 1_000_000;
      // A headline card has room for four characters after the sign, so 12.6万
      // is the widest form: one decimal from 10万 up, two below, none past 100万.
      const digits = wan >= 100 ? 0 : wan >= 10 ? 1 : 2;
      return { text: `${prefix}${wan.toFixed(digits)}`, unit: "wan" };
    };
    /** A ratio (0.1234) as `12.34%`, signed when asked. */
    const percent = (ratio, options = {}) => {
      const value = num(ratio, 0) * 100;
      const decimals = Math.abs(value) >= 100 ? 0 : 2;
      const text = `${Math.abs(value).toFixed(decimals)}%`;
      if (value < 0) return `-${text}`;
      if (options.sign === true && value > 0) return `+${text}`;
      return text;
    };
    /** A share (0.5) rounded to whole percent, for chart labels. */
    const sharePercent = (ratio) => `${String(Math.round(num(ratio, 0) * 100))}%`;
    /** `2026-11-03` → `11-03` (the year is already in the header). */
    const shortDate = (value) => {
      const text = String(value ?? "");
      return text.length >= 10 ? text.slice(5) : text;
    };
    /** `2026-11` → `11月` for the trend axis. */
    const shortMonth = (value) => {
      const parsed = parseMonth(value);
      return parsed === null ? String(value ?? "") : `${String(parsed.month)}月`;
    };
    /**
     * 坐标轴上的月份标签：**跨年时带上年份**。
     *
     * 只写「11月 12月 1月 2月」会让人以为是倒序（11→12→1 看着像回去了），
     * 其实是跨年了。所以当年份与前一个不同时，在标签前标出年份的后两位。
     *
     * @param {Array<{ month: string }>} rows 按月升序的数据
     * @returns {string[]} 与 `rows` 等长的标签
     */
    const monthAxisLabels = (rows) => {
      let previousYear = null;
      return rows.map((row) => {
        const parsed = parseMonth(row.month);
        if (parsed === null) return String(row.month ?? "");
        const year = String(parsed.year);
        // 只在「年份发生切换的那一根」标年份，其余只写月份，避免 12 根标签挤成一团
        const label = previousYear !== null && previousYear !== year
          ? `${String(parsed.month)}月\n${year.slice(2)}年`
          : `${String(parsed.month)}月`;
        previousYear = year;
        return label;
      });
    };
    /** An input value (`"1234.5"`) as fen, or null when it is not a number. */
    const parseYuan = (text) => {
      const cleaned = String(text ?? "").replace(/[¥￥,\s]/gu, "");
      if (cleaned === "" || !/^-?\d*\.?\d{0,2}$/u.test(cleaned)) return null;
      const value = Number(cleaned);
      return Number.isFinite(value) ? Math.round(value * 100) : null;
    };
    /** Fen as a plain editable yuan string (`1234.50` → `"1234.5"`). */
    const yuanInput = (value) => {
      const amount = fen(value);
      const text = (Math.abs(amount) / 100).toFixed(2);
      return text.replace(/\.?0+$/u, "") === "" ? "0" : text.replace(/\.?0+$/u, "");
    };

    // ── API client ────────────────────────────────────────────────────────
    const apiFetch = () => {
      const target = typeof window !== "undefined" && typeof window.fetch === "function" ? window : typeof fetch === "function" ? { fetch } : null;
      return target === null ? null : target.fetch.bind(target);
    };
    /** Unwrap `{ ok, value }` or throw a user-facing Error. */
    const readEnvelope = async (response) => {
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (body !== null && typeof body === "object" && body.ok === true) return body.value === undefined ? {} : body.value;
      if (body !== null && typeof body === "object" && body.ok === false && body.error !== null && typeof body.error === "object") {
        throw new Error(typeof body.error.message === "string" && body.error.message !== "" ? body.error.message : `HTTP ${String(response?.status ?? "")}`);
      }
      throw new Error(`HTTP ${String(response !== null && response !== undefined && response.status !== undefined ? response.status : "?")}`);
    };
    const postJson = async (path, payload) => {
      const fetcher = apiFetch();
      if (fetcher === null) throw new Error(translate("error.offline"));
      const response = await fetcher(`${API_BASE}${path}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
      return readEnvelope(response);
    };
    /**
     * A `DELETE` that still carries a small JSON body (the month the caller wants
     * back in the response snapshot).
     */
    const delJson = async (path, payload) => {
      const fetcher = apiFetch();
      if (fetcher === null) throw new Error(translate("error.offline"));
      const response = await fetcher(`${API_BASE}${path}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload ?? {})
      });
      return readEnvelope(response);
    };
    const getJson = async (path) => {
      const fetcher = apiFetch();
      if (fetcher === null) throw new Error(translate("error.offline"));
      const response = await fetcher(`${API_BASE}${path}`, {
        method: "GET",
        credentials: "same-origin",
        headers: { "content-type": "application/json" }
      });
      return readEnvelope(response);
    };
    /** Ask for one month's snapshot. */
    const fetchSnapshot = (month) => getJson(`/snapshot?month=${encodeURIComponent(month)}`);
    /** Ask for transactions, optionally filtered by month / query / category. */
    const fetchTxns = async (query = {}) => {
      const params = new URLSearchParams();
      if (typeof query.month === "string" && query.month !== "") params.set("month", query.month);
      if (typeof query.q === "string" && query.q !== "") params.set("q", query.q);
      if (typeof query.category === "string" && query.category !== "") params.set("category", query.category);
      params.set("limit", String(query.limit ?? TXN_PAGE));
      const value = await getJson(`/txns?${params.toString()}`);
      const txns = Array.isArray(value?.txns) ? value.txns.map(normalizeTxn).filter((txn) => txn !== null) : [];
      return { txns, total: num(value?.total, txns.length) };
    };

    // ── normalization ─────────────────────────────────────────────────────
    /** One transaction, coerced to the shape the table renders. */
    const normalizeTxn = (raw) => {
      if (raw === null || typeof raw !== "object") return null;
      const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : "";
      if (id === "") return null;
      const direction = raw.direction === "income" ? "income" : "expense";
      return {
        id,
        date: typeof raw.date === "string" ? raw.date : "",
        amount: Math.abs(fen(raw.amount)),
        direction,
        category: typeof raw.category === "string" && raw.category !== "" ? raw.category : direction === "income" ? INCOME_CATEGORY : "其他",
        purpose: typeof raw.purpose === "string" ? raw.purpose : "",
        account: typeof raw.account === "string" ? raw.account : "",
        merchant: typeof raw.merchant === "string" ? raw.merchant : "",
        note: typeof raw.note === "string" ? raw.note : "",
        source: raw.source === "manual" || raw.source === "agent" ? raw.source : "import",
        money: raw.money === true,
        // 支付渠道与精确时间：用于在流水上标注「这笔走的哪张卡」，
        // 也是跨账单去重的依据（Host 已经做完去重，这里只用于展示）。
        time: typeof raw.time === "string" ? raw.time : "",
        channel: typeof raw.channel === "string" ? raw.channel : "",
        channelKind: typeof raw.channelKind === "string" ? raw.channelKind : "",
        channelLabel: typeof raw.channelLabel === "string" ? raw.channelLabel : ""
      };
    };
    /** `[{category, amount, share, count}]`. */
    const normalizeCategories = (list) =>
      Array.isArray(list)
        ? list
            .filter((row) => row !== null && typeof row === "object")
            .map((row) => ({ category: String(row.category ?? "其他"), amount: Math.abs(fen(row.amount)), share: clamp(num(row.share, 0), 0, 1), count: num(row.count, 0) }))
            .filter((row) => row.amount > 0)
        : [];
    /** Six months of `{ month, income, expense, balance }`. */
    const normalizeTrend = (list) =>
      Array.isArray(list)
        ? list
            .filter((row) => row !== null && typeof row === "object")
            .map((row) => ({ month: String(row.month ?? ""), income: fen(row.income), expense: fen(row.expense), balance: fen(row.balance) }))
        : [];
    /** Assets: totals, composition and rows. */
    const normalizeAssets = (raw) => {
      const record = raw !== null && typeof raw === "object" ? raw : {};
      const items = Array.isArray(record.items)
        ? record.items
            .filter((item) => item !== null && typeof item === "object")
            .map((item) => ({
              id: String(item.id ?? ""),
              name: String(item.name ?? ""),
              kind: ASSET_KINDS.includes(item.kind) ? item.kind : "other",
              value: fen(item.value),
              account: typeof item.account === "string" ? item.account : "",
              note: typeof item.note === "string" ? item.note : ""
            }))
            .filter((item) => item.id !== "")
        : [];
      const byKind = Array.isArray(record.byKind)
        ? record.byKind
            .filter((row) => row !== null && typeof row === "object")
            .map((row) => ({ kind: ASSET_KINDS.includes(row.kind) ? row.kind : "other", amount: fen(row.amount), share: clamp(num(row.share, 0), 0, 1) }))
            .filter((row) => row.amount > 0)
        : [];
      const total = record.total === undefined ? items.reduce((sum, item) => sum + item.value, 0) : fen(record.total);
      return { total, byKind, items };
    };
    /** Liabilities: totals, rows and upcoming payments. */
    const normalizeLiabilities = (raw) => {
      const record = raw !== null && typeof raw === "object" ? raw : {};
      const items = Array.isArray(record.items)
        ? record.items
            .filter((item) => item !== null && typeof item === "object")
            .map((item) => ({
              id: String(item.id ?? ""),
              name: String(item.name ?? ""),
              kind: LIABILITY_KINDS.includes(item.kind) ? item.kind : "other",
              balance: fen(item.balance),
              monthlyPayment: fen(item.monthlyPayment),
              dueDay: clamp(Math.round(num(item.dueDay, 0)), 0, 31),
              dueInDays: item.dueInDays === undefined ? null : num(item.dueInDays, 0),
              overdue: item.overdue === true,
              note: typeof item.note === "string" ? item.note : ""
            }))
            .filter((item) => item.id !== "")
        : [];
      const total = record.total === undefined ? items.reduce((sum, item) => sum + item.balance, 0) : fen(record.total);
      const upcoming = Array.isArray(record.upcoming) ? record.upcoming.map((entry) => ({ id: String(entry?.id ?? ""), name: String(entry?.name ?? ""), dueInDays: num(entry?.dueInDays, 0), amount: fen(entry?.amount ?? entry?.monthlyPayment) })) : [];
      return { total, items, upcoming };
    };
    /** Holdings and their aggregate. */
    const normalizeInvest = (raw) => {
      const record = raw !== null && typeof raw === "object" ? raw : {};
      const items = Array.isArray(record.items)
        ? record.items
            .filter((item) => item !== null && typeof item === "object")
            .map((item) => {
              const shares = num(item.shares, 0);
              const costPrice = fen(item.costPrice);
              const price = fen(item.price);
              const cost = item.cost === undefined ? Math.round(costPrice * shares) : fen(item.cost);
              const value = item.value === undefined ? Math.round(price * shares) : fen(item.value);
              return {
                id: String(item.id ?? ""),
                name: String(item.name ?? ""),
                code: typeof item.code === "string" ? item.code : "",
                type: HOLDING_TYPES.includes(item.type) ? item.type : "other",
                shares,
                costPrice,
                price,
                cost,
                value,
                pnl: item.pnl === undefined ? value - cost : fen(item.pnl),
                pnlRate: item.pnlRate === undefined ? (cost > 0 ? (value - cost) / cost : 0) : num(item.pnlRate, 0),
                note: typeof item.note === "string" ? item.note : ""
              };
            })
            .filter((item) => item.id !== "")
        : [];
      const byType = Array.isArray(record.byType)
        ? record.byType
            .filter((row) => row !== null && typeof row === "object")
            .map((row) => ({ type: HOLDING_TYPES.includes(row.type) ? row.type : "other", value: fen(row.value), share: clamp(num(row.share, 0), 0, 1) }))
            .filter((row) => row.value > 0)
        : [];
      const cost = record.cost === undefined ? items.reduce((sum, item) => sum + item.cost, 0) : fen(record.cost);
      const value = record.value === undefined ? items.reduce((sum, item) => sum + item.value, 0) : fen(record.value);
      return {
        cost,
        value,
        pnl: record.pnl === undefined ? value - cost : fen(record.pnl),
        pnlRate: record.pnlRate === undefined ? (cost > 0 ? (value - cost) / cost : 0) : num(record.pnlRate, 0),
        byType,
        items
      };
    };
    /** Budget rows and their total. */
    const normalizeBudgets = (list, totalRaw) => {
      const rows = Array.isArray(list)
        ? list
            .filter((row) => row !== null && typeof row === "object")
            .map((row) => {
              const limit = fen(row.limit);
              const spent = fen(row.spent);
              return { category: String(row.category ?? ""), limit, spent, used: clamp(num(row.used, limit > 0 ? spent / limit : 0), 0, 9), over: row.over === true || (limit > 0 && spent > limit) };
            })
            .filter((row) => row.category !== "")
        : [];
      const total = totalRaw !== null && typeof totalRaw === "object" ? { limit: fen(totalRaw.limit), spent: fen(totalRaw.spent), used: clamp(num(totalRaw.used, 0), 0, 9) } : { limit: rows.reduce((sum, row) => sum + row.limit, 0), spent: rows.reduce((sum, row) => sum + row.spent, 0), used: 0 };
      return { rows, total };
    };
    /** Savings goals. */
    const normalizeGoals = (list) =>
      Array.isArray(list)
        ? list
            .filter((goal) => goal !== null && typeof goal === "object")
            .map((goal) => ({
              id: String(goal.id ?? ""),
              name: String(goal.name ?? ""),
              target: fen(goal.target),
              saved: fen(goal.saved),
              deadline: typeof goal.deadline === "string" ? goal.deadline : "",
              progress: clamp(num(goal.progress, 0), 0, 1),
              remainingMonths: Math.max(0, num(goal.remainingMonths, 0)),
              monthlyNeeded: fen(goal.monthlyNeeded)
            }))
            .filter((goal) => goal.id !== "")
        : [];
    /** The advisory tips. */
    const normalizeTips = (list) =>
      Array.isArray(list)
        ? list
            .filter((tip) => tip !== null && typeof tip === "object")
            .map((tip) => ({ level: tip.level === "warn" ? "warn" : tip.level === "good" ? "good" : "info", title: String(tip.title ?? ""), detail: String(tip.detail ?? "") }))
        : [];
    /** The whole snapshot. Every field is optional on the Host side. */
    const normalizeSnapshot = (raw) => {
      const record = raw !== null && typeof raw === "object" ? raw : {};
      const summary = record.summary !== null && typeof record.summary === "object" ? record.summary : {};
      const income = fen(summary.income);
      const expense = fen(summary.expense);
      const categories = normalizeCategories(record.byCategory);
      const budgets = normalizeBudgets(record.budgets, record.budgetTotal);
      return {
        month: typeof record.month === "string" && record.month !== "" ? record.month : monthKey(),
        summary: {
          income,
          expense,
          balance: summary.balance === undefined ? income - expense : fen(summary.balance),
          txnCount: num(summary.txnCount, 0),
          autoClassified: num(summary.autoClassified, 0),
          autoRate: num(summary.autoRate, 0),
          // 收支口径：有多少笔被判定为转账/还款没算进收支，多少笔大额待确认
          excludedCount: num(summary.excludedCount, 0),
          excludedIncome: fen(summary.excludedIncome),
          excludedExpense: fen(summary.excludedExpense),
          reviewCount: num(summary.reviewCount, 0)
        },
        byCategory: categories,
        byPurpose: Array.isArray(record.byPurpose) ? record.byPurpose.filter((row) => row !== null && typeof row === "object").map((row) => ({ purpose: String(row.purpose ?? ""), amount: fen(row.amount), share: num(row.share, 0) })) : [],
        trend: normalizeTrend(record.trend),
        topExpenses: Array.isArray(record.topExpenses) ? record.topExpenses.filter((row) => row !== null && typeof row === "object").map((row) => ({ id: String(row.id ?? ""), date: String(row.date ?? ""), merchant: String(row.merchant ?? ""), amount: fen(row.amount), category: String(row.category ?? "") })) : [],
        assets: normalizeAssets(record.assets),
        liabilities: normalizeLiabilities(record.liabilities),
        netWorth: record.netWorth === undefined ? 0 : fen(record.netWorth),
        netWorthTrend: Array.isArray(record.netWorthTrend) ? record.netWorthTrend.filter((row) => row !== null && typeof row === "object").map((row) => ({ month: String(row.month ?? ""), netWorth: fen(row.netWorth) })) : [],
        invest: normalizeInvest(record.invest),
        budgets: budgets.rows,
        budgetTotal: budgets.total,
        goals: normalizeGoals(record.goals),
        tips: normalizeTips(record.tips),
        monthsAvailable: Array.isArray(record.monthsAvailable) ? record.monthsAvailable.filter((key) => typeof key === "string") : [],
        // `settings.demo` 决定面板顶部的「这是演示账本」提示条；缺字段一律当假，
        // 免得在用户自己的真实账本上冒出一条莫名其妙的提示。
        // 年度汇总：总看板的大数靠它，缺字段时给一个安全的零值
        yearly: (() => {
          const y = record.yearly !== null && typeof record.yearly === "object" ? record.yearly : {};
          return {
            year: typeof y.year === "string" && y.year !== "" ? y.year : String(new Date().getFullYear()),
            income: fen(y.income),
            expense: fen(y.expense),
            balance: y.balance === undefined ? fen(y.income) - fen(y.expense) : fen(y.balance),
            months: num(y.months, 0),
            avgExpense: fen(y.avgExpense),
            avgIncome: fen(y.avgIncome),
            txnCount: num(y.txnCount, 0)
          };
        })(),
        // 数据完整性提醒：收支不成比例时要说清楚，别让用户以为花超了
        dataNotes: Array.isArray(record.dataNotes)
          ? record.dataNotes
              .filter((note) => note !== null && typeof note === "object")
              .map((note) => ({ level: note.level === "warn" ? "warn" : "info", title: String(note.title ?? ""), detail: String(note.detail ?? "") }))
          : [],
        settings: {
          currency: typeof record.settings?.currency === "string" ? record.settings.currency : "CNY",
          emergencyMonths: num(record.settings?.emergencyMonths, 6),
          demo: record.settings?.demo === true
        }
      };
    };
    /** An empty snapshot, used while loading and after a cache reset. */
    const emptySnapshot = (month = monthKey()) => normalizeSnapshot({ month });
    /** Whether a snapshot has anything worth showing. */
    const isBlank = (snapshot) => {
      if (snapshot === null) return true;
      const s = snapshot.summary ?? {};
      const count = (list) => (Array.isArray(list) ? list.length : 0);
      return (
        num(s.txnCount, 0) === 0 &&
        num(s.income, 0) === 0 &&
        num(s.expense, 0) === 0 &&
        count(snapshot.assets?.items) === 0 &&
        count(snapshot.liabilities?.items) === 0 &&
        count(snapshot.invest?.items) === 0 &&
        count(snapshot.goals) === 0 &&
        count(snapshot.monthsAvailable) === 0
      );
    };

    // ── locale ────────────────────────────────────────────────────────────
    let translate = (key) => key;
    const interpolate = (text, params) => {
      if (params === undefined || params === null) return String(text);
      return String(text).replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
    };
    /** Install the bound translator, falling back to the Chinese dictionary. */
    const setTranslator = (bound) => {
      translate = (key, params) => {
        let text = "";
        try {
          text = typeof bound === "function" ? bound(key, params) : "";
        } catch {
          text = "";
        }
        if (typeof text !== "string" || text === "" || text === key) text = DICT_ZH[key] ?? key;
        return interpolate(text, params);
      };
    };
    /** Small helper bound at module scope so non-component code can translate. */
    const t = (key, params) => translate(key, params);

    // ── chart colour helpers ──────────────────────────────────────────────
    /** Palette entry for a category, by its stable index (not by rank). */
    const colorIndexOf = (category) => {
      const index = CATEGORIES.indexOf(category);
      return index < 0 ? PALETTE.length - 1 : index % PALETTE.length;
    };
    /** CSS variable reference for a palette slot; both themes are declared. */
    const colorVar = (index) => `var(--dshfw-c${String(((index % PALETTE.length) + PALETTE.length) % PALETTE.length)})`;
    /** Palette slot for a kind list position (`cash`, `investment`, …). */
    const kindColorVar = (list, kind) => {
      const index = list.indexOf(kind);
      return colorVar(index < 0 ? list.length : index);
    };

    // ── app store (plain external store; no context plumbing needed) ──────
    /** @typedef {"idle" | "loading" | "ready" | "error"} LoadPhase */
    let toastSeq = 0;
    const appStore = {
      listeners: new Set(),
      state: {
        /** Selected month, `YYYY-MM`. */
        month: monthKey(),
        /** The month before the user pressed the demo button, so it can jump back. */
        monthTouched: false,
        /** @type {LoadPhase} */
        phase: "idle",
        error: null,
        /** @type {ReturnType<typeof emptySnapshot> | null} */
        snapshot: null,
        /** Raw transactions of the selected month. */
        txns: [],
        /** Whether the previous load already had data (drives the skeleton). */
        everLoaded: false,
        tab: "board",
        /** Active category filter, shared by the donut legend and the table. */
        filterCategory: "",
        /** Live search text. */
        query: "",
        /** Row whose inline editor is open. */
        openTxnId: "",
        /** @type {null | { mode: "txn" | "asset" | "liability" | "holding" | "goal" | "budget" | "contribute", record?: object }} */
        editor: null,
        /** @type {null | { step: "file" | "preview" | "done", busy: boolean, file: string, format: string, rows: object[], added: number, duplicates: number, autoRate: number, warnings: string[], failure: string }} */
        wizard: null,
        /** @type {null | { month: string, text: string, source: "ai" | "rules", busy: boolean, failure: string }} */
        insight: null,
        toast: null,
        /** A second counter bump so an identical toast still re-announces. */
        revisions: {},
        demoBusy: false
      },
      getSnapshot() {
        return appStore.state;
      },
      subscribe(listener) {
        appStore.listeners.add(listener);
        return () => appStore.listeners.delete(listener);
      }
    };
    /** Apply a partial state change and notify React once. */
    const setState = (patch) => {
      appStore.state = { ...appStore.state, ...patch };
      for (const listener of [...appStore.listeners]) {
        try {
          listener();
        } catch {}
      }
    };
    /** Read the current state without subscribing. */
    const stateOf = () => appStore.state;
    /** Hook: the whole app state. */
    const useApp = () => react.useSyncExternalStore(appStore.subscribe, appStore.getSnapshot);

    // ── toasts ────────────────────────────────────────────────────────────
    let toastTimer = null;
    /** Show one line of feedback at the bottom of the panel. */
    const notify = (message) => {
      toastSeq += 1;
      setState({ toast: { id: toastSeq, message } });
      if (toastTimer !== null) {
        try {
          window.clearTimeout(toastTimer);
        } catch {}
      }
      try {
        toastTimer = window.setTimeout(() => {
          toastTimer = null;
          if (appStore.state.toast?.id === toastSeq) setState({ toast: null });
        }, TOAST_MS);
      } catch {
        toastTimer = null;
      }
    };
    /** Report a failed action as a toast with the Host's message. */
    const complain = (error) => notify(translate("error.action", { message: messageOf(error) }));

    // ── loading ───────────────────────────────────────────────────────────
    /**
     * Load one month: snapshot (all four tabs) and the month's transactions
     * (the table, plus a client-side search). A failure keeps any data already
     * on screen and surfaces a retry banner instead of a blank page.
     * @param {string} month `YYYY-MM`.
     * @param {{ quiet?: boolean }} [options] quiet skips the loading skeleton
     *   (used after a write, when the page is already painted).
     */
    const loadMonth = async (month, options = {}) => {
      const request = { month };
      loadToken.current = request;
      const first = appStore.state.snapshot === null;
      if (!options.quiet) setState({ phase: "loading", error: null, month });
      try {
        const [snapshotRaw, txnPage] = await Promise.all([fetchSnapshot(month), fetchTxns({ month, limit: TXN_PAGE })]);
        if (loadToken.current !== request) return;
        setState({
          month,
          snapshot: normalizeSnapshot(snapshotRaw),
          txns: txnPage.txns,
          phase: "ready",
          everLoaded: true,
          error: null,
          // A filter that no longer exists in this month is cleared, not kept
          // silently applied to an empty list.
          filterCategory: ""
        });
        // 第一次打开、而且「这个月才过了几天」时，自动落到最近一个有完整
        // 数据的月份：当月只有 3 天流水，饼图讲不出故事。用户一旦自己翻过
        // 月份（monthTouched）就不再替她做主。
        if (first && options.autoMonth !== false && !appStore.state.monthTouched) {
          const picked = landingMonthOf(snapshotRaw);
          if (picked !== null && picked !== month) {
            void loadMonth(picked, { quiet: false, autoMonth: false });
            return;
          }
        }
        if (first) void refreshInsight(snapshotRaw);
      } catch (error) {
        if (loadToken.current !== request) return;
        setState({ phase: appStore.state.snapshot === null ? "error" : "ready", error: messageOf(error) });
      }
    };
    /** Guards against a slow response overwriting a newer month. */
    const loadToken = { current: null };

    /**
     * 决定「第一次打开时先落在哪个月」。
     *
     * 当月才过了几天时，用当月数据打开面板会让人误以为账本很单薄（结余被
     * 房租拉成大负数、饼图只有两三类）。这时转到最近一个有像样数据的月份，
     * 第一眼看到的是完整的一个月。只有当月确实太薄（< 10 笔）且上月有数据
     * 时才转，其余情况一律留在当月。
     *
     * @param {object} snapshotRaw 刚取到的当月快照
     * @returns {string | null} 要改去的月份，`null` 表示不转
     */
    const landingMonthOf = (snapshotRaw) => {
      const count = num(snapshotRaw?.summary?.txnCount, 0);
      if (count >= 10) return null;
      const previous = shiftMonth(monthKey(), -1);
      const available = Array.isArray(snapshotRaw?.monthsAvailable) ? snapshotRaw.monthsAvailable : [];
      if (available.length === 0) return null;
      if (!available.includes(previous)) return null;
      return previous;
    };
    /** Reload the current month after a write, then refresh the ledger view. */
    const reload = async () => {
      const month = appStore.state.month;
      try {
        const [snapshotRaw, txnPage] = await Promise.all([fetchSnapshot(month), fetchTxns({ month, limit: TXN_PAGE })]);
        setState({ snapshot: normalizeSnapshot(snapshotRaw), txns: txnPage.txns, phase: "ready", everLoaded: true, error: null });
      } catch (error) {
        complain(error);
      }
    };
    /** Switch months (the header arrows and "back to this month"). */
    const goMonth = (month) => {
      if (parseMonth(month) === null || month === appStore.state.month) return;
      setState({ filterCategory: "", query: "", openTxnId: "", insight: null, monthTouched: true });
      void loadMonth(month);
    };

    // ── writes: transactions ──────────────────────────────────────────────
    /** `POST /txns` with an op, then adopt the fresh snapshot the Host returns. */
    const writeTxn = async (payload) => {
      const value = await postJson("/txns", payload);
      if (value !== null && typeof value === "object" && value.snapshot !== undefined) setState({ snapshot: normalizeSnapshot(value.snapshot) });
      await reload();
      return value;
    };
    /** Save the inline editor's payload. */
    const saveTxn = async (form) => {
      const payload = form.id === "" ? { op: "add", ...form.fields } : { op: "update", id: form.id, ...form.fields };
      try {
        await writeTxn(payload);
        setState({ editor: null, openTxnId: "", toast: null });
        notify(translate(form.id === "" ? "toast.added" : "toast.saved"));
        return true;
      } catch (error) {
        complain(error);
        return false;
      }
    };
    /** Delete one transaction. */
    const removeTxn = async (id) => {
      try {
        await writeTxn({ op: "remove", id });
        notify(translate("toast.removed"));
      } catch (error) {
        complain(error);
      }
    };

    // ── writes: assets / liabilities / holdings / budgets / goals ─────────
    /** One generic write that adopts the returned snapshot. */
    const writeSimple = async (path, payload, successKey) => {
      try {
        const value = await postJson(path, payload);
        if (value !== null && typeof value === "object" && value.snapshot !== undefined) setState({ snapshot: normalizeSnapshot(value.snapshot) });
        await reload();
        if (successKey !== undefined) notify(translate(successKey));
        setState({ editor: null });
        return true;
      } catch (error) {
        complain(error);
        return false;
      }
    };

    // ── AI insight ────────────────────────────────────────────────────────
    /** Fetch the month's written read (`POST /ai/insight`, rules fall back in Host). */
    const refreshInsight = async (snapshotRaw) => {
      const month = typeof snapshotRaw?.month === "string" ? snapshotRaw.month : appStore.state.month;
      const previous = appStore.state.insight;
      setState({ insight: { month, text: previous?.month === month ? previous.text : "", source: "rules", busy: true, failure: "" } });
      try {
        const value = await postJson("/ai/insight", { month });
        const text = typeof value?.text === "string" ? value.text : "";
        // `error` is informational here: the Host already fell back to rules,
        // so the text is still shown and the badge says which engine wrote it.
        setState({ insight: { month, text, source: value?.source === "ai" ? "ai" : "rules", busy: false, failure: "" } });
      } catch (error) {
        setState({ insight: { month, text: "", source: "rules", busy: false, failure: messageOf(error) } });
      }
    };

    // ── import wizard ─────────────────────────────────────────────────────
    /** Read a File as base64 so the Host can decode GBK as UTF-8 fails. */
    const readBase64 = (file) =>
      new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : "";
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : "");
        };
        reader.onerror = () => reject(new Error(translate("error.import", { message: translate("error.generic") })));
        reader.readAsDataURL(file);
      });
    /** Read a File as plain text (the fallback when base64 is refused). */
    const readText = (file) =>
      new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => reject(new Error(translate("error.import", { message: translate("error.generic") })));
        reader.readAsText(file);
      });
    /**
     * The contract's dedupe fingerprint: date|direction|merchant|amount with
     * whitespace, punctuation and case normalised. The Host owns the write-side
     * key; the panel only needs the same idea to warn about repeats in the
     * preview, so both sides agree to within the same normalisation family.
     */
    const dedupeKeyOf = (row) => {
      const merchant = String(row?.merchant ?? "")
        .toLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, "");
      return `${String(row?.date ?? "")}|${row?.direction === "income" ? "income" : "expense"}|${merchant}|${String(Math.abs(fen(row?.amount)))}`;
    };
    /** Normalize one preview row from `POST /import`. */
    const normalizePreviewRow = (raw, index) => ({
      key: `${String(index)}-${String(raw?.dedupeKey ?? raw?.merchant ?? "")}`,
      date: String(raw?.date ?? ""),
      amount: Math.abs(fen(raw?.amount)),
      direction: raw?.direction === "income" ? "income" : "expense",
      merchant: String(raw?.merchant ?? ""),
      account: String(raw?.account ?? ""),
      note: String(raw?.note ?? ""),
      category: typeof raw?.category === "string" && raw.category !== "" ? raw.category : raw?.direction === "income" ? INCOME_CATEGORY : "其他",
      purpose: typeof raw?.purpose === "string" ? raw.purpose : "",
      confidence: String(raw?.confidence ?? "default"),
      duplicate: raw?.duplicate === true || (Array.isArray(raw?.duplicates) && raw.duplicates.length > 0),
      raw: raw?.raw !== null && typeof raw?.raw === "object" ? raw.raw : {}
    });
    /** Open the wizard on its first step. */
    const openWizard = () => {
      setState({ wizard: { step: "file", busy: false, file: "", format: "", rows: [], added: 0, duplicates: 0, autoRate: 0, warnings: [], failure: "" } });
    };
    const closeWizard = () => setState({ wizard: null });
    /**
     * Send one file (or pasted text) to `POST /import` and hold the preview.
     * The bytes go up as base64: the Host owns decoding (UTF-8 first, then
     * GB18030) and the column detection; the panel only displays the rows.
     * @param {{ name: string, base64?: string, text?: string }} source the upload.
     */
    const parseImport = async (source) => {
      setState({ wizard: { ...appStore.state.wizard, step: "file", busy: true, failure: "", file: source.name } });
      try {
        const payload = source.base64 !== undefined ? { name: source.name, content: source.base64, encoding: "base64" } : { name: source.name, content: source.text ?? "", encoding: "utf8" };
        const value = await postJson("/import", payload);
        const rowsRaw = Array.isArray(value?.rows) ? value.rows : Array.isArray(value?.preview?.rows) ? value.preview.rows : [];
        let rows = rowsRaw.map(normalizePreviewRow);
        const warnings = Array.isArray(value?.warnings) ? value.warnings.map((w) => String(w)) : Array.isArray(value?.preview?.warnings) ? value.preview.warnings.map((w) => String(w)) : [];
        // The Host may already flag repeats; when it does not (or when this is
        // the first import) the panel marks them against the ledger and the
        // rest of the file, so the count a user reads is the count the confirm
        // step will report.
        const seen = new Set(appStore.state.txns.map(dedupeKeyOf));
        let flagged = 0;
        const marked = rows.map((row) => {
          const key = dedupeKeyOf(row);
          const duplicate = row.duplicate || seen.has(key);
          seen.add(key);
          if (duplicate) flagged += 1;
          return row.duplicate === duplicate ? row : { ...row, duplicate };
        });
        rows = marked;
        const duplicates = num(value?.preview?.duplicates ?? value?.counts?.duplicates ?? value?.duplicates, flagged);
        setState({
          wizard: {
            step: rows.length === 0 ? "file" : "preview",
            busy: false,
            file: typeof value?.import?.file === "string" ? value.import.file : source.name,
            format: typeof value?.format === "string" ? value.format : typeof value?.import?.format === "string" ? value.import.format : "",
            rows,
            added: 0,
            duplicates,
            auto: num(value?.counts?.auto, rows.filter((row) => row.confidence !== "default").length),
            autoRate: num(value?.autoRate, 0),
            warnings,
            failure: rows.length === 0 ? translate("import.empty") : ""
          }
        });
      } catch (error) {
        setState({ wizard: { ...appStore.state.wizard, step: "file", busy: false, failure: translate("error.import", { message: messageOf(error) }) } });
      }
    };
    /** Read one picked/dropped file and hand its bytes to the Host. */
    const importFile = async (file) => {
      if (file === null || file === undefined) return;
      const name = typeof file.name === "string" && file.name !== "" ? file.name : "bill.csv";
      try {
        const base64 = await readBase64(file);
        await parseImport({ name, base64 });
      } catch (error) {
        try {
          const text = await readText(file);
          await parseImport({ name, text });
        } catch (second) {
          setState({ wizard: { ...appStore.state.wizard, busy: false, failure: translate("error.import", { message: messageOf(second) }) } });
        }
      }
    };
    /** Change one preview row's category (the only edit the wizard offers). */
    const setPreviewCategory = (key, category) => {
      const wizard = appStore.state.wizard;
      if (wizard === null) return;
      setState({ wizard: { ...wizard, rows: wizard.rows.map((row) => (row.key === key ? { ...row, category, confidence: "user" } : row)) } });
    };
    /** Commit the preview through `POST /import/confirm`, then refresh. */
    const confirmImport = async () => {
      const wizard = appStore.state.wizard;
      if (wizard === null || wizard.rows.length === 0) return;
      setState({ wizard: { ...wizard, busy: true, failure: "" } });
      const rows = wizard.rows.map((row) => ({
        date: row.date,
        amount: row.amount,
        direction: row.direction,
        merchant: row.merchant,
        account: row.account,
        note: row.note,
        category: row.category,
        purpose: row.purpose,
        raw: row.raw
      }));
      try {
        const value = await postJson("/import/confirm", { name: wizard.file, format: wizard.format, rows });
        const added = num(value?.added, 0);
        const duplicates = num(value?.duplicates, 0);
        setState({ wizard: { ...appStore.state.wizard, step: "done", busy: false, added, duplicates } });
        if (value?.snapshot !== undefined) setState({ snapshot: normalizeSnapshot(value.snapshot) });
        await reload();
        notify(translate("import.resultAdded", { n: String(added) }));
      } catch (error) {
        setState({ wizard: { ...appStore.state.wizard, busy: false, failure: translate("error.import", { message: messageOf(error) }) } });
      }
    };

    // ── demo data & export ────────────────────────────────────────────────
    /** Write the sample ledger (`POST /demo`) and open this month. */
    const loadDemo = async () => {
      setState({ demoBusy: true });
      try {
        await postJson("/demo", {});
        notify(translate("toast.demoLoaded"));
        await loadMonth(monthKey());
      } catch (error) {
        notify(translate("empty.error", { message: messageOf(error) }));
      } finally {
        setState({ demoBusy: false });
      }
    };
    /** Download the whole ledger as one JSON file (`GET /export`). */
    const exportBackup = async () => {
      try {
        const value = await getJson("/export");
        const text = JSON.stringify(value, null, 2);
        const blob = new window.Blob([text], { type: "application/json" });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `dsh-finance-${String(dayKey())}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        try {
          window.setTimeout(() => window.URL.revokeObjectURL(url), 4000);
        } catch {}
        notify(translate("toast.exported"));
      } catch (error) {
        complain(error);
      }
    };

    // ── SVG chart primitives ──────────────────────────────────────────────
    /**
     * A donut built from one stroked circle per slice. Each slice grows in from
     * zero with `stroke-dasharray` (0.9s), slices starting slightly after one
     * another, so the ring reads as being drawn. Slices carry their palette
     * slot and an optional click (the legend and the ring filter the table).
     */
    function Donut({ slices, size = 168, thickness = 22, center, label, onSelect, selected = "" }) {
      const radius = (size - thickness) / 2;
      const circumference = 2 * Math.PI * radius;
      const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
      let offset = 0;
      const arcs = [];
      slices.forEach((slice, index) => {
        const portion = total > 0 ? Math.max(0, slice.value) / total : 0;
        if (portion <= 0) return;
        const length = Math.max(0, portion * circumference - (slices.length > 1 ? 2 : 0));
        arcs.push({
          key: slice.key,
          label: slice.label,
          color: slice.color,
          dash: `${String(length)} ${String(circumference)}`,
          offset: -offset,
          delay: index * 90,
          dim: selected !== "" && selected !== slice.key,
          clickable: typeof onSelect === "function",
          onClick: () => onSelect?.(slice.key)
        });
        offset += portion * circumference;
      });
      const centre =
        total === 0
          ? null
          : jsx("g", {
              children: [
                jsx("text", { x: size / 2, y: size / 2 - 2, className: "dshfw-donut__value", textAnchor: "middle", children: center?.value ?? "" }),
                jsx("text", { x: size / 2, y: size / 2 + 16, className: "dshfw-donut__caption", textAnchor: "middle", children: center?.caption ?? "" })
              ]
            });
      return jsx("div", {
        className: "dshfw-donut",
        style: { width: `${String(size)}px` },
        children: [
          jsx("svg", {
            viewBox: `0 0 ${String(size)} ${String(size)}`,
            width: size,
            height: size,
            className: "dshfw-donut__svg",
            role: "img",
            "aria-label": label ?? "",
            children: [
              jsx("circle", { cx: size / 2, cy: size / 2, r: radius, fill: "none", strokeWidth: thickness, className: "dshfw-donut__track" }),
              ...arcs.map((arc) =>
                jsx("circle", {
                  key: arc.key,
                  cx: size / 2,
                  cy: size / 2,
                  r: radius,
                  fill: "none",
                  stroke: arc.color,
                  strokeWidth: thickness,
                  strokeDasharray: arc.dash,
                  strokeDashoffset: arc.offset,
                  className: `dshfw-donut__arc${arc.dim ? " is-dim" : ""}${arc.clickable ? " is-clickable" : ""}`,
                  style: { animationDelay: `${String(arc.delay)}ms` },
                  onClick: arc.clickable
                    ? (event) => {
                        event?.stopPropagation?.();
                        arc.onClick();
                      }
                    : undefined,
                  role: arc.clickable ? "button" : undefined,
                  tabIndex: arc.clickable ? 0 : undefined,
                  "aria-label": arc.clickable ? arc.label : undefined,
                  "data-key": arc.key
                })
              ),
              centre
            ]
          }),
          total === 0 ? jsx("span", { className: "dshfw-donut__empty", children: t("chart.noData") }) : null
        ]
      });
    }

    /**
     * A sparkline-style line chart with an area wash under it. The stroke draws
     * itself with `stroke-dashoffset` (1.1s). Points are evenly spaced; the
     * y-axis is padded so a flat series does not sit on the baseline.
     * @param {{ points: { label: string, value: number }[], height?: number, color?: string, fill?: boolean, zeroLine?: boolean, format?: (n: number) => string, id?: string }} props chart props.
     */
    function LineChart({ points, height = 132, color = "var(--dshfw-accent)", fill = true, zeroLine = false, format, id = "line" }) {
      const width = 320;
      const paddingY = 14;
      const list = Array.isArray(points) ? points : [];
      const values = list.map((point) => num(point.value, 0));
      const min = Math.min(0, ...values);
      const max = Math.max(0, ...values);
      const span = max - min === 0 ? Math.max(1, Math.abs(max)) : max - min;
      const top = max + span * 0.12;
      const bottom = min - span * 0.12;
      const xOf = (index) => (list.length <= 1 ? width / 2 : (index / (list.length - 1)) * width);
      const yOf = (value) => paddingY + (1 - (value - bottom) / (top - bottom)) * (height - paddingY * 2);
      const coords = list.map((point, index) => [xOf(index), yOf(num(point.value, 0))]);
      const line = coords.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
      const area = coords.length === 0 ? "" : `${line} L${String(width)} ${String(height)} L0 ${String(height)} Z`;
      const zeroY = yOf(0);
      const gradientId = `${DOM_ID}-${id}-fill`;
      const formatting = typeof format === "function" ? format : (value) => money(value, { decimals: 0 });
      return jsxs("svg", {
        viewBox: `0 0 ${String(width)} ${String(height)}`,
        className: "dshfw-line",
        preserveAspectRatio: "none",
        role: "img",
        children: [
          jsxs("defs", {
            children: [
              jsx("linearGradient", { id: gradientId, x1: "0", y1: "0", x2: "0", y2: "1", children: [jsx("stop", { offset: "0%", style: { stopColor: color, stopOpacity: 0.26 }, children: "a" }), jsx("stop", { offset: "100%", style: { stopColor: color, stopOpacity: 0 }, children: "b" })] })
            ]
          }),
          zeroLine ? jsx("line", { x1: 0, y1: zeroY, x2: width, y2: zeroY, className: "dshfw-line__zero" }) : null,
          fill && area !== "" ? jsx("path", { d: area, fill: `url(#${gradientId})`, stroke: "none", className: "dshfw-line__area" }) : null,
          jsx("path", { d: line, fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", className: "dshfw-line__path", pathLength: 1, style: { strokeDasharray: 1, strokeDashoffset: 0 } }),
          ...coords.map(([x, y], index) => jsx("circle", { cx: x, cy: y, r: 2.4, className: "dshfw-line__dot", style: { animationDelay: `${String(400 + index * 60)}ms` }, key: `dot-${String(index)}` }))
        ]
      });
    }

    /** Axis labels under a line chart. */
    function AxisLabels({ points, items = [] }) {
      return jsx("div", {
        className: "dshfw-axis",
        style: { gridTemplateColumns: `repeat(${String(Math.max(1, items.length || points?.length || 1))},minmax(0,1fr))` },
        children: (items.length > 0 ? items : (points ?? []).map((point) => point.label)).map((label, index) => jsx("span", { key: `${String(index)}-${String(label)}`, children: label }))
      });
    }

    /**
     * One spending category as a two-tone bar: the budget track stays grey,
     * the actual spend fills it, and anything past the limit runs past the
     * right edge in a striped over-spend colour. A category with no budget
     * shows a plain bar scaled against the largest spend on this page.
     */
    function BudgetBar({ budget, scale }) {
      const limit = Math.max(0, budget.limit);
      const spent = Math.max(0, budget.spent);
      const track = limit > 0 ? limit : Math.max(scale, 1);
      const ratio = track > 0 ? spent / track : 0;
      const inside = clamp(ratio, 0, 1);
      const over = limit > 0 ? clamp((spent - limit) / track, 0, 0.6) : 0;
      const overPercent = limit > 0 && spent > limit ? Math.round(((spent - limit) / limit) * 100) : 0;
      const label = limit > 0 ? (spent > limit ? t("plan.over", { n: String(overPercent) }) : t("plan.left", { amount: money(limit - spent, { decimals: 0 }) })) : t("plan.noBudget");
      return jsx("div", {
        className: `dshfw-budget${budget.over ? " is-over" : ""}`,
        children: [
          jsx("span", { className: "dshfw-budget__name", children: budget.category }),
          jsx("span", {
            className: "dshfw-budget__track",
            children: [
              jsx("span", { className: "dshfw-budget__fill", style: { width: `${String(inside * 100)}%`, animationDelay: "0ms" } }),
              over > 0 ? jsx("span", { className: "dshfw-budget__over", style: { width: `${String(Math.min(40, over * 100))}%` } }) : null
            ]
          }),
          jsx("span", {
            className: "dshfw-budget__num",
            children: [
              jsx("b", { className: "dshfw-num", children: money(spent, { decimals: 0 }) }),
              jsx("span", { className: "dshfw-budget__slash", children: " / " }),
              jsx("span", { className: "dshfw-num", children: limit > 0 ? money(limit, { decimals: 0 }) : "—" }),
              jsx("span", { className: "dshfw-budget__label", children: ` · ${label}` })
            ]
          })
        ]
      });
    }

    /** A thin progress bar for goals. */
    function Progress({ ratio, tone = "accent" }) {
      const width = clamp(num(ratio, 0), 0, 1) * 100;
      return jsx("span", {
        className: `dshfw-progress dshfw-progress--${tone}`,
        children: jsx("span", { className: "dshfw-progress__fill", style: { width: `${String(width)}%` } })
      });
    }

    // ── glyphs ────────────────────────────────────────────────────────────
    const glyph = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" };
    const IconChevronLeft = ({ size = 16 }) => jsx("svg", { ...glyph, width: size, height: size, strokeWidth: 1.8, children: jsx("path", { d: "M14.5 5.5 8 12l6.5 6.5" }) });
    const IconChevronRight = ({ size = 16 }) => jsx("svg", { ...glyph, width: size, height: size, strokeWidth: 1.8, children: jsx("path", { d: "M9.5 5.5 16 12l-6.5 6.5" }) });
    const IconUpload = ({ size = 16 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("path", { d: "M12 15.5V5m0 0L8 9m4-4 4 4" }), jsx("path", { d: "M4.5 15v2.6c0 .9.7 1.6 1.6 1.6h11.8c.9 0 1.6-.7 1.6-1.6V15" })] });
    const IconMore = ({ size = 16 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.8, children: [jsx("circle", { cx: 5.5, cy: 12, r: 1.2 }), jsx("circle", { cx: 12, cy: 12, r: 1.2 }), jsx("circle", { cx: 18.5, cy: 12, r: 1.2 })] });
    const IconPlus = ({ size = 16 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.9, children: [jsx("path", { d: "M12 5.5v13M5.5 12h13" })] });
    const IconClose = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.9, children: [jsx("path", { d: "M6 6l12 12M18 6 6 18" })] });
    const IconTrash = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("path", { d: "M5 7h14M10 7V5.2c0-.7.5-1.2 1.2-1.2h1.6c.7 0 1.2.5 1.2 1.2V7" }), jsx("path", { d: "M6.8 7.4l.8 11.2c0 .8.6 1.4 1.4 1.4h6c.8 0 1.4-.6 1.4-1.4l.8-11.2" })] });
    const IconCheck = ({ size = 15 }) => jsx("svg", { ...glyph, width: size, height: size, strokeWidth: 2.1, children: jsx("path", { d: "M5.5 12.5 10 17l8.5-9.5" }) });
    const IconSearch = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("circle", { cx: 11, cy: 11, r: 6 }), jsx("path", { d: "M15.6 15.6 20 20" })] });
    const IconInfo = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("circle", { cx: 12, cy: 12, r: 8 }), jsx("path", { d: "M12 11v5.5M12 8.1v.2" })] });
    const IconWarn = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("path", { d: "M12 4.2 3.6 18.6c-.3.6.1 1.4.9 1.4h15c.8 0 1.2-.8.9-1.4L12 4.2z" }), jsx("path", { d: "M12 9.6v4.2M12 16.8v.2" })] });
    const IconGood = ({ size = 15 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.7, children: [jsx("circle", { cx: 12, cy: 12, r: 8 }), jsx("path", { d: "M8.4 12.3 11 15l4.6-5.4" })] });
    const IconSpark = ({ size = 14 }) => jsx("svg", { ...glyph, width: size, height: size, strokeWidth: 1.5, children: jsx("path", { d: "M12 3.6c.8 4.2 2.4 5.7 6.6 6.4-4.2.8-5.8 2.3-6.6 6.5-.8-4.2-2.4-5.7-6.6-6.5 4.2-.7 5.8-2.2 6.6-6.4z" }) });
    const IconWallet = ({ size = 18 }) => jsxs("svg", { ...glyph, width: size, height: size, strokeWidth: 1.6, children: [jsx("path", { d: "M4 8.2c0-1.2 1-2.2 2.2-2.2h11.6c1.2 0 2.2 1 2.2 2.2v8.6c0 1.2-1 2.2-2.2 2.2H6.2C5 19 4 18 4 16.8V8.2z" }), jsx("path", { d: "M4 9.4h13.2c1.5 0 2.8 1.2 2.8 2.7s-1.3 2.7-2.8 2.7H4" }), jsx("path", { d: "M16.2 11.6v.1" })] });

    // ── UI atoms ──────────────────────────────────────────────────────────
    /** A text/button pressed-style control. */
    function Button({ tone = "ghost", size = "md", onClick, disabled = false, label, title, children, icon, ...rest }) {
      return jsxs("button", {
        type: "button",
        className: `dshfw-btn dshfw-btn--${tone} dshfw-btn--${size}`,
        onClick: disabled ? undefined : onClick,
        disabled,
        "aria-label": label,
        title: title ?? label,
        ...rest,
        children: [icon ?? null, children === undefined || children === null ? null : jsx("span", { className: "dshfw-btn__text", children: children })]
      });
    }
    /** An icon-only square control. */
    function IconButton({ onClick, label, disabled = false, children, tone = "" }) {
      return jsx("button", {
        type: "button",
        className: `dshfw-iconbtn${tone === "" ? "" : ` dshfw-iconbtn--${tone}`}`,
        onClick: disabled ? undefined : onClick,
        disabled,
        "aria-label": label,
        title: label,
        children
      });
    }
    /** A small pill. */
    function Chip({ children, tone = "", onClick, active = false, title }) {
      const element = onClick === undefined ? "span" : "button";
      return jsx(element, {
        className: `dshfw-chip${tone === "" ? "" : ` dshfw-chip--${tone}`}${active ? " is-active" : ""}`,
        onClick,
        type: onClick === undefined ? undefined : "button",
        title,
        children
      });
    }
    /** A labelled control row for the forms. */
    function Field({ label, children, hint, wide = false }) {
      return jsxs("label", {
        className: `dshfw-field${wide ? " dshfw-field--wide" : ""}`,
        children: [jsx("span", { className: "dshfw-field__label", children: label }), children, hint === undefined ? null : jsx("span", { className: "dshfw-field__hint", children: hint })]
      });
    }
    /** A text input wired to a form's setter. */
    function TextInput({ label, value, onChange, placeholder, type = "text", ariaLabel, inputMode }) {
      return jsx("input", {
        className: "dshfw-input",
        type,
        inputMode,
        value: value ?? "",
        placeholder,
        "aria-label": ariaLabel ?? label,
        onChange: (event) => onChange(event?.target?.value ?? "")
      });
    }
    /** A `<select>` wired to a form's setter. */
    function Select({ label, value, onChange, options }) {
      return jsx("select", {
        className: "dshfw-select",
        value: value ?? "",
        "aria-label": label,
        onChange: (event) => onChange(event?.target?.value ?? ""),
        children: options.map((option) => jsx("option", { value: option.value, children: option.label }))
      });
    }
    /** A centred dialog. Click on the scrim or Escape closes it. */
    function Dialog({ label, onClose, children, wide = false, footer }) {
      react.useEffect(() => {
        const onKey = (event) => {
          if (event?.key === "Escape" && typeof onClose === "function") onClose();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, []);
      return jsx("div", {
        className: "dshfw-scrim",
        onMouseDown: (event) => {
          if (event?.target === event?.currentTarget && typeof onClose === "function") onClose();
        },
        children: jsxs("div", {
          className: `dshfw-dialog${wide ? " dshfw-dialog--wide" : ""}`,
          role: "dialog",
          "aria-modal": "true",
          "aria-label": label,
          children: [children, footer === undefined ? null : jsx("div", { className: "dshfw-dialog__foot", children: footer })]
        })
      });
    }
    /** A titled card used by every tab. */
    function Card({ title, sub, actions, children, className = "", tone = "" }) {
      return jsxs("section", {
        className: `dshfw-card${tone === "" ? "" : ` dshfw-card--${tone}`}${className === "" ? "" : ` ${className}`}`,
        children: [
          title === undefined
            ? null
            : jsxs("header", {
                className: "dshfw-card__head",
                children: [
                  jsxs("div", {
                    className: "dshfw-card__heading",
                    children: [jsx("h3", { className: "dshfw-card__title", children: title }), sub === undefined ? null : jsx("p", { className: "dshfw-card__sub", children: sub })]
                  }),
                  actions === undefined ? null : jsxs("div", { ...{ className: "dshfw-card__actions" }, children: actions })
                ]
              }),
          children
        ]
      });
    }
    /** One headline figure: a label, a big tabular number and a footnote. */
    function BigStat({ label, value, footnote, tone = "", sign = false, compact = true, testId }) {
      const formatted = bigMoney(value, { compact, sign });
      return jsxs("div", {
        className: `dshfw-stat${tone === "" ? "" : ` dshfw-stat--${tone}`}`,
        "data-testid": testId,
        children: [
          jsxs("span", { ...{ className: "dshfw-stat__label" }, children: label }),
          jsxs("span", {
            className: "dshfw-stat__value dshfw-num",
            children: [
              jsxs("span", { ...{ className: "dshfw-stat__amount" }, children: formatted.text }),
              formatted.unit === "" ? null : jsxs("span", { ...{ className: "dshfw-stat__unit" }, children: t("stat.wan") })
            ]
          }),
          footnote === undefined ? null : jsxs("span", { ...{ className: "dshfw-stat__foot" }, children: footnote })
        ]
      });
    }
    /** A label and a small tabular value, stacked: the axis annotations. */
    function Metric({ label, value, tone = "" }) {
      return jsxs("div", {
        className: `dshfw-metric${tone === "" ? "" : ` dshfw-metric--${tone}`}`,
        children: [jsx("span", { className: "dshfw-metric__label", children: label }), jsx("span", { className: "dshfw-metric__value dshfw-num", children: value })]
      });
    }
    /** Skeleton blocks: real geometry, no text, shimmer off with reduced motion. */
    function Skeleton({ lines = 4 }) {
      const rows = Array.from({ length: Math.max(0, lines - 2) }, (_, index) =>
        jsx("div", { key: `line-${String(index)}`, className: "dshfw-sk dshfw-sk--line", style: { width: `${String(70 + ((index * 7) % 25))}%` } })
      );
      return jsx("div", {
        className: "dshfw-skeleton",
        "aria-busy": "true",
        "aria-label": t("loading"),
        children: [
          jsx("div", { className: "dshfw-sk dshfw-sk--title" }),
          jsx("div", {
            className: "dshfw-sk__row",
            children: [jsx("div", { className: "dshfw-sk dshfw-sk--stat" }), jsx("div", { className: "dshfw-sk dshfw-sk--stat" }), jsx("div", { className: "dshfw-sk dshfw-sk--stat" })]
          }),
          jsx("div", {
            className: "dshfw-sk__row",
            children: [jsx("div", { className: "dshfw-sk dshfw-sk--panel" }), jsx("div", { className: "dshfw-sk dshfw-sk--panel" })]
          }),
          ...rows
        ]
      });
    }

    // ── derived views ─────────────────────────────────────────────────────
    /** Expense slices in the donut's order, with their stable palette slot. */
    const donutSlices = (snapshot) => snapshot.byCategory.map((row) => ({ key: row.category, label: row.category, value: row.amount, color: colorVar(colorIndexOf(row.category)) }));
    /** Filter and search client-side: the month's transactions are already here. */
    const visibleTxns = (txns, query, category) => {
      const text = String(query ?? "").trim().toLowerCase();
      return txns.filter((txn) => {
        if (category !== "" && txn.category !== category) return false;
        if (text === "") return true;
        const haystack = `${txn.merchant} ${txn.note} ${txn.category} ${txn.account}`.toLowerCase();
        return haystack.includes(text);
      });
    };
    /** The two-tone share bar used for composition lists. */
    function Composition({ slices, onSelect, selected }) {
      return jsx("ul", {
        className: "dshfw-comp",
        children: slices.map((slice) =>
          jsx("li", {
            key: slice.key,
            className: `dshfw-comp__row${selected === slice.key ? " is-selected" : ""}`,
            onClick: onSelect === undefined ? undefined : () => onSelect(slice.key),
            children: [
              jsx("span", { className: "dshfw-comp__dot", style: { background: slice.color } }),
              jsx("span", { className: "dshfw-comp__name", children: slice.label }),
              jsx("span", {
                className: "dshfw-comp__bar",
                children: jsx("span", { className: "dshfw-comp__fill", style: { width: `${String(clamp(num(slice.share, 0), 0, 1) * 100)}%`, background: slice.color } })
              }),
              jsx("span", { className: "dshfw-comp__value dshfw-num", children: slice.text ?? money(slice.value, { decimals: 0 }) }),
              jsx("span", { className: "dshfw-comp__share dshfw-num", children: sharePercent(slice.share) })
            ]
          })
        )
      });
    }

    // ── header ────────────────────────────────────────────────────────────
    /** `‹ 2026 年 11 月 ›` plus a jump-back chip, and the two header actions. */
    function MonthSwitch({ month, onPick, isCurrent }) {
      const parsed = parseMonth(month) ?? parseMonth(monthKey());
      const label = t("month.label", { year: String(parsed.year), month: String(parsed.month) });
      return jsxs("div", {
        className: "dshfw-month",
        children: [
          jsxs("div", {
            className: "dshfw-month__switch",
            children: [
              jsx(IconButton, { onClick: () => onPick(shiftMonth(month, -1)), label: t("month.prev"), children: jsx(IconChevronLeft, {}) }),
              jsxs("span", { ...{ className: "dshfw-month__label dshfw-num", "aria-live": "polite" }, children: label }),
              jsx(IconButton, { onClick: () => onPick(shiftMonth(month, 1)), label: t("month.next"), children: jsx(IconChevronRight, {}) })
            ]
          }),
          isCurrent ? null : jsx("button", { type: "button", className: "dshfw-month__today", onClick: () => onPick(monthKey()), children: t("month.today") })
        ]
      });
    }

    /** The sticky top bar: identity, month, actions. */
    function Header() {
      const state = useApp();
      const [menu, setMenu] = react.useState(false);
      const menuRef = react.useRef(null);
      react.useEffect(() => {
        if (!menu) return undefined;
        const onDown = (event) => {
          if (menuRef.current !== null && event?.target !== undefined && !menuRef.current.contains?.(event.target)) setMenu(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
      }, [menu]);
      return jsx("header", {
        className: "dshfw-header",
        children: [
          jsx("div", {
            className: "dshfw-brand",
            children: [
              jsx("span", { className: "dshfw-brand__mark", children: jsx(IconWallet, { size: 18 }) }),
              jsx("div", {
                className: "dshfw-brand__text",
                children: [jsx("h1", { className: "dshfw-brand__title", children: t("page.title") }), jsx("p", { className: "dshfw-brand__sub", children: t("page.sub") })]
              })
            ]
          }),
          jsx(MonthSwitch, { month: state.month, onPick: (next) => goMonth(next), isCurrent: state.month === monthKey() }),
          jsx("div", {
            className: "dshfw-header__actions",
            children: [
              jsx(Button, { tone: "primary", size: "md", onClick: openWizard, label: t("action.import"), icon: jsx(IconUpload, { size: 15 }), children: t("action.import") }),
              jsx("div", {
                className: "dshfw-menu",
                ref: menuRef,
                children: [
                  jsx(IconButton, { onClick: () => setMenu((open) => !open), label: t("action.more"), children: jsx(IconMore, {}) }),
                  menu
                    ? jsx("div", {
                        className: "dshfw-menu__pop",
                        role: "menu",
                        children: [
                          jsx("button", { type: "button", role: "menuitem", className: "dshfw-menu__item", onClick: () => { setMenu(false); void exportBackup(); }, children: t("action.export") }),
                          jsx("button", { type: "button", role: "menuitem", className: "dshfw-menu__item", onClick: () => { setMenu(false); void loadDemo(); }, children: t("action.demo") })
                        ]
                      })
                    : null
                ]
              })
            ]
          })
        ]
      });
    }

    /** Three big numbers plus the small print beside them. */
    function StatStrip({ snapshot }) {
      const s = snapshot.summary;
      const negative = s.balance < 0;
      return jsxs("section", {
        className: "dshfw-strip",
        "aria-label": t("page.title"),
        children: [
          jsx(BigStat, { testId: "stat-income", label: t("stat.income"), value: s.income, tone: "income" }),
          jsx(BigStat, { testId: "stat-expense", label: t("stat.expense"), value: s.expense }),
          jsx(BigStat, { testId: "stat-balance", label: t("stat.balance"), value: s.balance, tone: negative ? "negative" : "positive", sign: !negative, footnote: negative ? t("stat.deficit") : undefined }),
          jsxs("div", {
            className: "dshfw-strip__aside",
            children: [
              jsx(Metric, { label: t("stat.netWorth"), value: money(snapshot.netWorth, { decimals: 0 }) }),
              jsx(Metric, { label: t("stat.count", { n: String(s.txnCount) }), value: "" }),
              // 收支口径说明：转账/还款不进收支大数，但用户必须知道它们在哪，
              // 否则会以为「我明明转了 2 万，支出怎么没变」。
              s.excludedCount > 0
                ? jsx("p", {
                    className: "dshfw-strip__excluded",
                    children: t("stat.excluded", {
                      n: String(s.excludedCount),
                      amount: money(s.excludedExpense + s.excludedIncome, { decimals: 0 })
                    })
                  })
                : null,
              s.reviewCount > 0
                ? jsx("p", {
                    className: "dshfw-strip__review",
                    children: t("stat.review", { n: String(s.reviewCount) })
                  })
                : null
            ]
          })
        ]
      });
    }

    /** The four tabs with a sliding underline. */
    function TabBar({ tab, onPick }) {
      const index = Math.max(0, TABS.indexOf(tab));
      return jsx("div", {
        className: "dshfw-tabs",
        role: "tablist",
        children: jsx("div", {
          className: "dshfw-tabs__track",
          style: { "--tab-count": String(TABS.length) },
          children: [
            TABS.map((key) =>
              jsx("button", {
                key,
                type: "button",
                role: "tab",
                "aria-selected": tab === key,
                className: `dshfw-tabs__tab${tab === key ? " is-active" : ""}`,
                onClick: () => onPick(key),
                "data-tab": key,
                children: t(`tab.${key}`)
              })
            ),
            jsx("span", { className: "dshfw-tabs__ink", style: { transform: `translateX(${String(index * 100)}%)`, width: `${String(100 / TABS.length)}%` } })
          ]
        })
      });
    }

    // ── cash flow tab ─────────────────────────────────────────────────────
    /** The expense donut plus its clickable legend. */
    function FlowOverview({ snapshot, filter, onFilter }) {
      const slices = donutSlices(snapshot);
      const total = snapshot.summary.expense;
      return jsxs("div", {
        className: "dshfw-flow__overview",
        children: [
          jsx(Card, {
            title: t("flow.donut"),
            sub: t("flow.legendHint"),
            tone: "chart",
            children: jsx("div", {
              className: "dshfw-donut__wrap",
              children: jsx(Donut, {
                slices,
                label: t("flow.donut"),
                center: { value: bigMoney(total).unit === "" ? money(total, { decimals: 0 }) : `${bigMoney(total).text}${t("stat.wan")}`, caption: t("flow.donutCenter") },
                onSelect: (key) => onFilter(filter === key ? "" : key),
                selected: filter
              })
            })
          }),
          jsx(Card, {
            title: t("flow.donut"),
            className: "dshfw-flow__legendcard",
            children: jsx(Composition, {
              slices: snapshot.byCategory.map((row) => ({ key: row.category, label: row.category, value: row.amount, share: row.share, color: colorVar(colorIndexOf(row.category)) })),
              onSelect: (key) => onFilter(filter === key ? "" : key),
              selected: filter
            })
          })
        ]
      });
    }

    /** Six months of income and spending as two overlaid lines. */
    /**
     * 12 个月的收支双柱图。
     *
     * 折线适合看「方向」，柱状适合看「多少」——用户问「每个月花了多少」时，
     * 柱子的高低比折线的斜率直观得多。柱子从底部长出，每根错开 40ms，
     * `prefers-reduced-motion` 下由全局规则关掉。
     */
    function MonthlyBars({ rows, current }) {
      const max = Math.max(1, ...rows.map((row) => Math.max(row.income, row.expense)));
      const labels = monthAxisLabels(rows);
      return jsxs("div", {
        className: "dshfw-bars",
        children: [
          jsxs("div", {
            className: "dshfw-bars__legend",
            children: [
              jsxs("span", { className: "dshfw-key", children: [jsx("i", { className: "dshfw-key__dot dshfw-key__dot--expense" }), t("flow.expense")] }),
              jsxs("span", { className: "dshfw-key", children: [jsx("i", { className: "dshfw-key__dot dshfw-key__dot--income" }), t("flow.income")] })
            ]
          }),
          jsx("div", {
            className: "dshfw-bars__plot",
            children: rows.map((row, index) =>
              jsx("div", {
                key: row.month,
                className: `dshfw-bars__col${row.month === current ? " is-current" : ""}`,
                title: `${row.month} ${t("flow.income")} ${money(row.income, { decimals: 0 })} / ${t("flow.expense")} ${money(row.expense, { decimals: 0 })}`,
                children: [
                  jsxs("div", {
                    className: "dshfw-bars__pair",
                    children: [
                      row.expense > 0
                        ? jsx("span", {
                            className: "dshfw-bars__bar dshfw-bars__bar--expense",
                            style: { height: `${String(Math.max(1, (row.expense / max) * 100))}%`, animationDelay: `${String(index * 40)}ms` }
                          })
                        : null,
                      row.income > 0
                        ? jsx("span", {
                            className: "dshfw-bars__bar dshfw-bars__bar--income",
                            style: { height: `${String(Math.max(1, (row.income / max) * 100))}%`, animationDelay: `${String(index * 40 + 20)}ms` }
                          })
                        : null
                    ]
                  }),
                  jsx("span", { className: "dshfw-bars__label", children: labels[index] })
                ]
              })
            )
          })
        ]
      });
    }

    /**
     * 每月结余：正数向上、负数向下，共用一条零轴。
     *
     * 「哪几个月是入不敷出的」用这张图一眼就能看出来。
     */
    function BalanceBars({ rows, current }) {
      const values = rows.map((row) => row.balance);
      const top = Math.max(1, ...values);
      const bottom = Math.min(0, ...values);
      const span = top - bottom || 1;
      // 零轴的位置（从顶部量）：全是正数时贴底，有负数时按比例上移
      const zero = (top / span) * 100;
      return jsxs("div", {
        className: "dshfw-balbars",
        children: [
          jsx("div", {
            className: "dshfw-balbars__plot",
            children: [
              jsx("span", { className: "dshfw-balbars__axis", style: { top: `${String(zero)}%` }, "aria-hidden": "true" }),
              jsx("div", {
                className: "dshfw-balbars__cols",
                children: rows.map((row, index) => {
                  const positive = row.balance >= 0;
                  // 柱高按「占全幅的比例」算；正柱从零轴往上长，负柱从零轴往下长
                  const height = (Math.abs(row.balance) / span) * 100;
                  const style = positive
                    ? { height: `${String(height)}%`, bottom: `${String(100 - zero)}%` }
                    : { height: `${String(height)}%`, top: `${String(zero)}%` };
                  return jsx("div", {
                    key: row.month,
                    className: `dshfw-balbars__col${row.month === current ? " is-current" : ""}`,
                    title: `${row.month} ${t("stat.balance")} ${money(row.balance, { decimals: 0, sign: true })}`,
                    children: row.balance === 0
                      ? null
                      : jsx("span", {
                          className: `dshfw-balbars__bar ${positive ? "is-positive" : "is-negative"}`,
                          style: { ...style, animationDelay: `${String(index * 40)}ms` }
                        })
                  });
                })
              })
            ]
          }),
          jsx(AxisLabels, { items: monthAxisLabels(rows) })
        ]
      });
    }

    function FlowTrend({ snapshot }) {
      // 12 个月的双柱图：柱子比折线更能回答「每个月花了多少」。
      const rows = Array.isArray(snapshot.trend) ? snapshot.trend : [];
      const hasData = rows.some((row) => row.income !== 0 || row.expense !== 0);
      return jsxs("div", {
        className: "dshfw-trend",
        children: [
          hasData ? jsx(MonthlyBars, { rows, current: snapshot.month }) : jsxs("p", { className: "dshfw-muted", children: t("chart.noData") }),
          jsx(AxisNote, { snapshot })
        ]
      });
    }

    /** 「今年一共花了多少」——挂在趋势图下面的一行小字，不占版面。 */
    function AxisNote({ snapshot }) {
      const yearly = snapshot.yearly;
      if (yearly === null || yearly === undefined || !(yearly.txnCount > 0)) return null;
      return jsx("p", {
        className: "dshfw-trend__yearly",
        children: t("year.summary", {
          year: String(yearly.year),
          expense: money(yearly.expense, { decimals: 0 }),
          income: money(yearly.income, { decimals: 0 }),
          months: String(yearly.months)
        })
      });
    }

    /** The five largest expenses this month. */
    function TopExpenses({ snapshot, onPick }) {
      const rows = snapshot.topExpenses;
      if (rows.length === 0) return jsx("p", { className: "dshfw-muted", children: t("flow.topEmpty") });
      const max = Math.max(...rows.map((row) => row.amount), 1);
      return jsx("ol", {
        className: "dshfw-top",
        children: rows.map((row, index) =>
          jsx("li", {
            key: `${String(row.id)}-${String(index)}`,
            className: "dshfw-top__row",
            onClick: () => onPick(row.category),
            children: [
              jsx("span", { className: "dshfw-top__rank dshfw-num", children: String(index + 1) }),
              jsx("span", {
                className: "dshfw-top__main",
                children: [
                  jsx("span", { className: "dshfw-top__name", children: row.merchant || row.category }),
                  jsx("span", {
                    className: "dshfw-top__meta",
                    children: [
                      jsx("i", { className: "dshfw-dot", style: { background: colorVar(colorIndexOf(row.category)) } }),
                      row.category,
                      " · ",
                      shortDate(row.date)
                    ]
                  }),
                  jsx("span", {
                    className: "dshfw-top__bar",
                    children: jsx("span", { className: "dshfw-top__fill", style: { width: `${String((row.amount / max) * 100)}%`, background: colorVar(colorIndexOf(row.category)) } })
                  })
                ]
              }),
              jsx("span", { className: "dshfw-top__amount dshfw-num", children: money(row.amount) })
            ]
          })
        )
      });
    }

    /** The transaction row's inline editor (an expense or an income entry). */
    function TxnEditor({ record, onDone }) {
      const isNew = record === null || record === undefined;
      const [date, setDate] = react.useState(isNew ? `${String(stateOf().month)}-${pad2(new Date().getDate())}` : record.date);
      const [amount, setAmount] = react.useState(isNew ? "" : yuanInput(record.amount));
      const [direction, setDirection] = react.useState(isNew ? "expense" : record.direction);
      const [category, setCategory] = react.useState(isNew ? "餐饮" : record.category);
      const [merchant, setMerchant] = react.useState(isNew ? "" : record.merchant);
      const [account, setAccount] = react.useState(isNew ? "" : record.account);
      const [note, setNote] = react.useState(isNew ? "" : record.note);
      const [busy, setBusy] = react.useState(false);
      const categories = direction === "income" ? [INCOME_CATEGORY] : [...CATEGORIES];
      const submit = async () => {
        const cents = parseYuan(amount);
        if (cents === null) {
          complain(new Error(t("flow.amount")));
          return;
        }
        setBusy(true);
        const fields = {
          date: date.trim(),
          amount: Math.abs(cents),
          direction,
          category: direction === "income" ? INCOME_CATEGORY : category,
          purpose: isNew ? "" : record.purpose,
          merchant: merchant.trim(),
          account: account.trim(),
          note: note.trim()
        };
        const result = await saveTxn({ id: isNew ? "" : record.id, fields });
        setBusy(false);
        if (result) onDone?.();
      };
      return jsxs("div", {
        className: "dshfw-form dshfw-form--txn",
        children: [
          jsxs("div", {
            className: "dshfw-seg",
            role: "group",
            "aria-label": t("flow.direction"),
            children: DIRECTIONS.map((key) =>
              jsx(
                "button",
                { key,
                  type: "button",
                  className: `dshfw-seg__item${direction === key ? " is-active" : ""}`,
                  "aria-pressed": direction === key,
                  onClick: () => {
                    setDirection(key);
                    setCategory(key === "income" ? INCOME_CATEGORY : "餐饮");
                  },
                  children: t(`flow.direction${key === "income" ? "Income" : "Expense"}`), children: key })
            )
          }),
          jsx(Field, { label: t("flow.amount"), children: jsx(TextInput, { label: t("flow.amount"), value: amount, onChange: setAmount, inputMode: "decimal", placeholder: "0.00" }) }),
          jsx(Field, { label: t("flow.date"), children: jsx(TextInput, { label: t("flow.date"), value: date, onChange: setDate, placeholder: "2026-11-03" }) }),
          jsx(Field, { label: t("flow.colCategory"), children: jsx(Select, { label: t("flow.colCategory"), value: category, onChange: setCategory, options: categories.map((value) => ({ value, label: value })) }) }),
          jsx(Field, { label: t("flow.merchant"), children: jsx(TextInput, { label: t("flow.merchant"), value: merchant, onChange: setMerchant }) }),
          jsx(Field, { label: t("flow.account"), children: jsx(TextInput, { label: t("flow.account"), value: account, onChange: setAccount }) }),
          jsx(Field, { label: t("flow.note"), children: jsx(TextInput, { label: t("flow.note"), value: note, onChange: setNote }) }),
          jsxs("div", {
            className: "dshfw-form__foot",
            children: [
              jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") }),
              jsx(Button, { tone: "ghost", onClick: () => onDone?.(), children: t("action.cancel") })
            ]
          })
        ]
      });
    }

    /** Wrap each occurrence of `needle` in a `<mark>`. */
    const highlight = (value, needle) => {
      const text = String(value ?? "");
      const lower = text.toLowerCase();
      const index = lower.indexOf(needle);
      if (needle === "" || index < 0) return text;
      return [text.slice(0, index), jsx("mark", { className: "dshfw-mark", children: text.slice(index, index + needle.length) }), text.slice(index + needle.length)];
    };

    /** One transaction table row; expands into its editor. */
    function TxnRow({ txn, open, onToggle, onRemove, query }) {
      const text = String(query ?? "").trim().toLowerCase();
      const hit = (value) => (text === "" ? value : highlight(value, text));
      const mainRow = jsx("tr", {
        className: "dshfw-row__main",
        onClick: () => onToggle(txn.id),
        tabIndex: 0,
        children: [
          jsx("td", { className: "dshfw-num dshfw-row__date", children: txn.date }),
          jsx("td", {
            className: "dshfw-row__merchant",
            children: jsx("span", {
              className: "dshfw-row__merchantInner",
              children: [
                jsx("span", { className: "dshfw-row__name", children: hit(txn.merchant || txn.note || txn.category) }),
                txn.source === "import" ? null : jsx("span", { className: "dshfw-src", children: t(`flow.source.${txn.source}`) }),
                txn.note !== "" && txn.merchant !== "" ? jsx("span", { className: "dshfw-row__note", children: hit(txn.note) }) : null
              ]
            })
          }),
          jsx("td", {
            children: jsx("span", {
              className: "dshfw-cat",
              children: [jsx("i", { className: "dshfw-dot", style: { background: colorVar(colorIndexOf(txn.category)) } }), txn.category]
            })
          }),
          // 账户列优先显示识别出的渠道（「招商银行信用卡(5678)」比空白更有用）
          jsx("td", { className: "dshfw-row__account", title: txn.account || txn.channelLabel, children: txn.channelLabel || txn.account || "—" }),
          jsx("td", {
            className: `dshfw-row__amount dshfw-num${txn.direction === "income" ? " is-income" : ""}`,
            children: `${txn.direction === "income" ? "+" : "−"}${money(txn.amount)}`
          }),
          jsx("td", {
            className: "dshfw-row__tools",
            children: jsx("span", {
              className: "dshfw-row__toolsInner",
              children: [
                jsx(IconButton, {
                  label: open ? t("flow.collapse") : t("action.edit"),
                  onClick: (event) => {
                    event?.stopPropagation?.();
                    onToggle(txn.id);
                  },
                  children: jsx(IconChevronRight, { size: 14 })
                }),
                jsx(IconButton, {
                  label: t("action.remove"),
                  tone: "danger",
                  onClick: (event) => {
                    event?.stopPropagation?.();
                    onRemove(txn.id);
                  },
                  children: jsx(IconTrash, { size: 14 })
                })
              ]
            })
          })
        ]
      });
      const expand = open
        ? jsx("tr", {
            className: "dshfw-row__expand",
            children: jsx("td", {
              colSpan: 6,
              children: jsx("div", {
                className: "dshfw-row__editor",
                children: [jsx("h4", { className: "dshfw-row__editing", children: t("flow.editTitle") }), jsx(TxnEditor, { record: txn, onDone: () => onToggle("") })]
              })
            })
          })
        : null;
      return jsx("tbody", { className: `dshfw-row${open ? " is-open" : ""}`, children: [mainRow, expand] });
    }

    /** The searchable, filterable transaction table and the "add one" form. */
    function FlowList({ snapshot }) {
      // Reads the store itself: a save triggers its own re-read, and the rows
      // must come from the newest state, not from whatever the parent had.
      const state = useApp();
      const [adding, setAdding] = react.useState(false);
      const rows = visibleTxns(state.txns, state.query, state.filterCategory);
      const filtered = state.query.trim() !== "" || state.filterCategory !== "";
      const total = rows.reduce((sum, txn) => sum + (txn.direction === "income" ? txn.amount : -txn.amount), 0);
      const toggle = (id) => setState({ openTxnId: state.openTxnId === id ? "" : id });
      const otherCategories = CATEGORIES.filter((category) => !snapshot.byCategory.some((row) => row.category === category));
      return jsx(Card, {
        title: t("flow.list"),
        sub: t("flow.monthTotal", { n: String(rows.length), amount: money(Math.abs(total)) }),
        tone: "table",
        actions: jsx("div", {
          className: "dshfw-toolbar",
          children: [
            jsx("span", {
              className: "dshfw-search",
              children: [
                jsx(IconSearch, { size: 14 }),
                jsx("input", {
                  className: "dshfw-search__input",
                  type: "search",
                  value: state.query,
                  placeholder: t("flow.search"),
                  "aria-label": t("flow.search"),
                  onChange: (event) => setState({ query: event?.target?.value ?? "" })
                })
              ]
            }),
            jsx(Select, {
              label: t("flow.filter"),
              value: state.filterCategory,
              onChange: (value) => setState({ filterCategory: value }),
              options: [{ value: "", label: t("flow.filterAll") }, ...snapshot.byCategory.map((row) => ({ value: row.category, label: row.category })), ...otherCategories.map((category) => ({ value: category, label: category }))]
            }),
            filtered ? jsx(Button, { tone: "ghost", size: "sm", label: t("flow.clear"), onClick: () => setState({ filterCategory: "", query: "" }), children: t("flow.clear") }) : null
          ]
        }),
        children: [
          filtered
            ? jsx("div", {
                className: "dshfw-filterbar",
                children: [
                  jsx("span", { className: "dshfw-chip is-active", children: [t("flow.filter"), "：", state.filterCategory || t("flow.filterAll")] }),
                  state.query.trim() === "" ? null : jsx("span", { className: "dshfw-chip", children: state.query }),
                  jsx("span", { className: "dshfw-filterbar__count dshfw-num", children: `${String(rows.length)} / ${String(state.txns.length)}` })
                ]
              })
            : null,
          rows.length === 0
            ? jsx("p", { className: "dshfw-empty__line", children: filtered ? t("flow.emptyFiltered") : t("flow.empty") })
            : jsx("table", {
                className: "dshfw-table",
                children: [
                  jsx("thead", {
                    children: jsx("tr", {
                      children: [t("flow.colDate"), t("flow.colMerchant"), t("flow.colCategory"), t("flow.colAccount"), t("flow.colAmount"), ""].map((label, index) =>
                        jsx("th", { key: `${String(index)}-${label}`, scope: "col", className: index === 4 ? "dshfw-num" : "", children: label })
                      )
                    })
                  }),
                  rows.map((txn) => jsx(TxnRow, { txn, open: state.openTxnId === txn.id, onToggle: toggle, onRemove: removeTxn, query: state.query }, txn.id))
                ]
              }),
          adding
            ? jsx("div", {
                className: "dshfw-addsheet",
                children: [jsx("h4", { className: "dshfw-row__editing", children: t("flow.addTitle") }), jsx(TxnEditor, { record: null, onDone: () => { setAdding(false); setState({ openTxnId: "", editor: null }); } })]
              })
            : jsx("div", {
                className: "dshfw-listfoot",
                children: jsx(Button, { tone: "outline", icon: jsx(IconPlus, { size: 14 }), onClick: () => setAdding(true), label: t("action.add"), children: t("action.add") })
              })
        ]
      });
    }

    // ── assets tab ────────────────────────────────────────────────────────
    /** Asset or liability editor (one dialog, two record kinds). */
    function AssetForm({ kind, record, onDone }) {
      const isAsset = kind === "asset";
      const isNew = record === null || record === undefined;
      const [name, setName] = react.useState(record?.name ?? "");
      const [which, setWhich] = react.useState(record?.kind ?? (isAsset ? "cash" : "mortgage"));
      const [value, setValue] = react.useState(isNew ? "" : yuanInput(isAsset ? record.value : record.balance));
      const [monthly, setMonthly] = react.useState(isNew ? "" : yuanInput(record.monthlyPayment ?? 0));
      const [dueDay, setDueDay] = react.useState(isNew ? "15" : String(record.dueDay ?? 15));
      const [busy, setBusy] = react.useState(false);
      const kinds = isAsset ? ASSET_KINDS : LIABILITY_KINDS;
      const submit = async () => {
        const cents = parseYuan(value);
        if (cents === null || name.trim() === "") {
          complain(new Error(isAsset ? t("assets.value") : t("assets.balance")));
          return;
        }
        setBusy(true);
        const op = isNew ? "add" : "update";
        const payload = isAsset
          ? { op, ...(isNew ? {} : { id: record.id }), name: name.trim(), kind: which, value: Math.abs(cents) }
          : { op, ...(isNew ? {} : { id: record.id }), name: name.trim(), kind: which, balance: Math.abs(cents), monthlyPayment: Math.abs(parseYuan(monthly) ?? 0), dueDay: clamp(Math.round(Number(dueDay) || 1), 1, 31) };
        try {
          const saved = await writeSimple(isAsset ? "/assets" : "/liabilities", payload, "toast.saved");
          if (saved) onDone?.();
        } finally {
          setBusy(false);
        }
      };
      const title = isNew ? (isAsset ? t("assets.addAsset") : t("assets.addLiability")) : isAsset ? t("assets.editAsset") : t("assets.editLiability");
      return jsx(Dialog, {
        label: title,
        onClose: onDone,
        children: [
          jsx("h3", { className: "dshfw-dialog__title", children: title }),
          jsx("div", {
            className: "dshfw-form",
            children: [
              jsx(Field, { label: t("assets.name"), children: jsx(TextInput, { label: t("assets.name"), value: name, onChange: setName }) }),
              jsx(Field, {
                label: t("assets.kind"),
                children: jsx(Select, {
                  label: t("assets.kind"),
                  value: which,
                  onChange: setWhich,
                  options: kinds.map((key) => ({ value: key, label: isAsset ? t(`assets.kind.${key}`) : t(`assets.liabilityKind.${key}`) }))
                })
              }),
              jsx(Field, {
                label: isAsset ? t("assets.value") : t("assets.balance"),
                children: jsx(TextInput, { label: isAsset ? t("assets.value") : t("assets.balance"), value, onChange: setValue, inputMode: "decimal", placeholder: "0.00" })
              }),
              isAsset ? null : jsx(Field, { label: t("assets.monthlyPayment"), children: jsx(TextInput, { label: t("assets.monthlyPayment"), value: monthly, onChange: setMonthly, inputMode: "decimal", placeholder: "0.00" }) }),
              isAsset ? null : jsx(Field, { label: t("assets.dueDay"), children: jsx(TextInput, { label: t("assets.dueDay"), value: dueDay, onChange: setDueDay, inputMode: "numeric" }) })
            ]
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [jsx(Button, { tone: "ghost", onClick: onDone, children: t("action.cancel") }), jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") })]
          })
        ]
      });
    }

    /** Net worth, composition, trend, then the two lists. */
    function AssetsPage({ snapshot }) {
      const [form, setForm] = react.useState(null);
      const assets = snapshot.assets;
      const liabilities = snapshot.liabilities;
      const debtRatio = assets.total + liabilities.total > 0 ? liabilities.total / (assets.total + liabilities.total) : 0;
      const trend = snapshot.netWorthTrend;
      const removeAsset = (id) => void writeSimple("/assets", { op: "remove", id }, "toast.removed");
      const removeLiability = (id) => void writeSimple("/liabilities", { op: "remove", id }, "toast.removed");
      return [
        jsx(Card, {
          tone: "hero",
          children: jsx("div", {
            className: "dshfw-hero",
            children: [
              jsx(StatMini, { label: t("assets.total"), value: money(assets.total, { decimals: 0 }), tone: "positive" }),
              jsx(BigStat, { label: t("assets.netWorth"), value: snapshot.netWorth, tone: snapshot.netWorth < 0 ? "negative" : "default", compact: false, testId: "assets-networth" }),
              jsx(StatMini, { label: t("assets.liability"), value: money(liabilities.total, { decimals: 0 }), tone: "negative", foot: t("assets.debtRatio", { n: String(Math.round(debtRatio * 100)) }) })
            ]
          })
        }),
        jsx("div", {
          className: "dshfw-grid dshfw-grid--2",
          children: [
            jsx(Card, {
              title: t("assets.composition"),
              tone: "chart",
              children: jsx("div", {
                className: "dshfw-donut__wrap",
                children: jsx(Donut, {
                  slices: assets.byKind.map((row) => ({ key: row.kind, label: t(`assets.kind.${row.kind}`), value: row.amount, color: kindColorVar(ASSET_KINDS, row.kind) })),
                  center: { value: money(assets.total, { decimals: 0 }), caption: t("assets.total") },
                  label: t("assets.composition")
                })
              })
            }),
            jsx(Card, {
              title: t("assets.trend"),
              className: "dshfw-card--trend",
              children: [
                jsx("div", { className: "dshfw-trend__plot", children: jsx(LineChart, { points: trend.map((row) => ({ label: shortMonth(row.month), value: row.netWorth })), color: "var(--dshfw-accent)", id: "networth", height: 148 }) }),
                jsx(AxisLabels, { items: trend.map((row) => shortMonth(row.month)) })
              ]
            }),
            jsx(Card, {
              title: t("assets.list"),
              sub: money(assets.total, { decimals: 0 }),
              actions: jsx(Button, { tone: "outline", size: "sm", icon: jsx(IconPlus, { size: 13 }), onClick: () => setForm({ kind: "asset", record: null }), label: t("assets.addAsset"), children: t("assets.addAsset") }),
              children:
                assets.items.length === 0
                  ? jsx("p", { className: "dshfw-empty__line", children: t("assets.empty") })
                  : jsx("ul", {
                      className: "dshfw-plain",
                      children: assets.items.map((item) =>
                        jsx("li", {
                          key: item.id,
                          className: "dshfw-plain__row",
                          children: [
                            jsx("i", { className: "dshfw-dot", style: { background: kindColorVar(ASSET_KINDS, item.kind) } }),
                            jsx("span", {
                              className: "dshfw-plain__main",
                              children: [jsx("b", { className: "dshfw-plain__name", children: item.name }), jsx("span", { className: "dshfw-plain__meta", children: t(`assets.kind.${item.kind}`) })]
                            }),
                            jsx("span", { className: "dshfw-plain__value dshfw-num", children: money(item.value) }),
                            jsx("span", {
                              className: "dshfw-plain__tools",
                              children: [
                                jsx(IconButton, { label: t("action.edit"), onClick: () => setForm({ kind: "asset", record: item }), children: jsx(IconChevronRight, { size: 13 }) }),
                                jsx(IconButton, { label: t("action.remove"), tone: "danger", onClick: () => removeAsset(item.id), children: jsx(IconTrash, { size: 13 }) })
                              ]
                            })
                          ]
                        })
                      )
                    })
            }),
            jsx(Card, {
              title: t("assets.liabilities"),
              sub: money(liabilities.total, { decimals: 0 }),
              actions: jsx(Button, { tone: "outline", size: "sm", icon: jsx(IconPlus, { size: 13 }), onClick: () => setForm({ kind: "liability", record: null }), label: t("assets.addLiability"), children: t("assets.addLiability") }),
              children:
                liabilities.items.length === 0
                  ? jsx("p", { className: "dshfw-empty__line", children: t("assets.emptyLiabilities") })
                  : jsx("ul", {
                      className: "dshfw-plain",
                      children: liabilities.items.map((item) => {
                        const soon = item.dueInDays !== null && item.dueInDays >= 0 && item.dueInDays <= DUE_SOON_DAYS;
                        const label = item.overdue ? t("assets.overdue") : item.dueInDays === 0 ? t("assets.dueToday") : item.dueInDays !== null ? t("assets.dueSoon", { n: String(item.dueInDays) }) : "";
                        return jsx("li", {
                          key: item.id,
                          className: `dshfw-plain__row${soon || item.overdue ? " is-due" : ""}`,
                          children: [
                            jsx("i", { className: "dshfw-dot dshfw-dot--liab" }),
                            jsx("span", {
                              className: "dshfw-plain__main",
                              children: [
                                jsx("b", { className: "dshfw-plain__name", children: item.name }),
                                jsx("span", {
                                  className: "dshfw-plain__meta",
                                  children: [t(`assets.liabilityKind.${item.kind}`), item.dueDay > 0 ? ` · ${t("assets.due", { day: String(item.dueDay) })}` : "", label === "" ? null : jsx("em", { className: "dshfw-due", children: ` ${label}` })]
                                })
                              ]
                            }),
                            jsx("span", {
                              className: "dshfw-plain__valueCol",
                              children: [
                                jsx("span", { className: "dshfw-plain__value dshfw-num", children: money(item.balance) }),
                                item.monthlyPayment > 0 ? jsx("span", { className: "dshfw-plain__sub dshfw-num", children: `${t("assets.monthly")} ${money(item.monthlyPayment, { decimals: 0 })}` }) : null
                              ]
                            }),
                            jsx("span", {
                              className: "dshfw-plain__tools",
                              children: [
                                jsx(IconButton, { label: t("action.edit"), onClick: () => setForm({ kind: "liability", record: item }), children: jsx(IconChevronRight, { size: 13 }) }),
                                jsx(IconButton, { label: t("action.remove"), tone: "danger", onClick: () => removeLiability(item.id), children: jsx(IconTrash, { size: 13 }) })
                              ]
                            })
                          ]
                        });
                      })
                    })
            })
          ]
        }),
        form === null ? null : jsx(AssetForm, { kind: form.kind, record: form.record, onDone: () => setForm(null) })
      ];
    }
    /** A small figure that flanks the hero number. */
    function StatMini({ label, value, tone = "", foot }) {
      return jsx("div", {
        className: `dshfw-mini${tone === "" ? "" : ` dshfw-mini--${tone}`}`,
        children: [jsx("span", { className: "dshfw-mini__label", children: label }), jsx("span", { className: "dshfw-mini__value dshfw-num", children: value }), foot === undefined ? null : jsx("span", { className: "dshfw-mini__foot", children: foot })]
      });
    }

    // ── investments tab ───────────────────────────────────────────────────
    /**
     * A signed money figure with an arrow glyph. Rise is red and fall is green,
     * following the A-share convention — the arrow and the explicit sign make
     * the meaning readable without relying on colour.
     */
    function Delta({ value, rate, size = "md" }) {
      const up = value > 0;
      const flat = value === 0;
      const tone = flat ? "flat" : up ? "up" : "down";
      return jsx("span", {
        className: `dshfw-delta dshfw-delta--${tone} dshfw-delta--${size} dshfw-num`,
        children: [
          jsx("span", { className: "dshfw-delta__arrow", "aria-hidden": "true", children: flat ? "→" : up ? "↑" : "↓" }),
          jsx("span", { className: "dshfw-delta__value", children: money(value, { sign: true }) }),
          rate === undefined ? null : jsx("span", { className: "dshfw-delta__rate", children: percent(rate, { sign: true }) })
        ]
      });
    }

    /** Holding editor. */
    function HoldingForm({ record, onDone }) {
      const isNew = record === null || record === undefined;
      const [name, setName] = react.useState(record?.name ?? "");
      const [code, setCode] = react.useState(record?.code ?? "");
      const [type, setType] = react.useState(record?.type ?? "fund");
      const [shares, setShares] = react.useState(isNew ? "" : String(record.shares));
      const [costPrice, setCostPrice] = react.useState(isNew ? "" : yuanInput(record.costPrice));
      const [price, setPrice] = react.useState(isNew ? "" : yuanInput(record.price));
      const [busy, setBusy] = react.useState(false);
      const submit = async () => {
        const parsedShares = Number(String(shares).replace(/,/gu, ""));
        const parsedCost = parseYuan(costPrice);
        const parsedPrice = parseYuan(price);
        if (name.trim() === "" || !Number.isFinite(parsedShares) || parsedCost === null || parsedPrice === null) {
          complain(new Error(t("invest.colShares")));
          return;
        }
        setBusy(true);
        const op = isNew ? "add" : "update";
        try {
          const saved = await writeSimple("/holdings", { op, ...(isNew ? {} : { id: record.id }), name: name.trim(), code: code.trim(), type, shares: parsedShares, costPrice: parsedCost, price: parsedPrice }, "toast.saved");
          if (saved) onDone?.();
        } finally {
          setBusy(false);
        }
      };
      const title = isNew ? t("invest.add") : t("invest.editHolding");
      return jsx(Dialog, {
        label: title,
        onClose: onDone,
        children: [
          jsx("h3", { className: "dshfw-dialog__title", children: title }),
          jsx("div", {
            className: "dshfw-form",
            children: [
              jsx(Field, { label: t("invest.name"), children: jsx(TextInput, { label: t("invest.name"), value: name, onChange: setName }) }),
              jsx(Field, { label: t("invest.code"), children: jsx(TextInput, { label: t("invest.code"), value: code, onChange: setCode }) }),
              jsx(Field, { label: t("assets.kind"), children: jsx(Select, { label: t("assets.kind"), value: type, onChange: setType, options: HOLDING_TYPES.map((key) => ({ value: key, label: t(`invest.type.${key}`) })) }) }),
              jsx(Field, { label: t("invest.shares"), children: jsx(TextInput, { label: t("invest.shares"), value: shares, onChange: setShares, inputMode: "decimal" }) }),
              jsx(Field, { label: t("invest.costPrice"), children: jsx(TextInput, { label: t("invest.costPrice"), value: costPrice, onChange: setCostPrice, inputMode: "decimal", placeholder: "0.00" }) }),
              jsx(Field, { label: t("invest.price"), children: jsx(TextInput, { label: t("invest.price"), value: price, onChange: setPrice, inputMode: "decimal", placeholder: "0.00" }) })
            ]
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [jsx(Button, { tone: "ghost", onClick: onDone, children: t("action.cancel") }), jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") })]
          })
        ]
      });
    }

    /** Profit/loss hero, allocation ring and the holdings table. */
    function InvestPage({ snapshot }) {
      const [form, setForm] = react.useState(undefined);
      const invest = snapshot.invest;
      const slices = invest.byType.map((row) => ({ key: row.type, label: t(`invest.type.${row.type}`), value: row.value, share: row.share, color: kindColorVar(HOLDING_TYPES, row.type) }));
      return [
        jsx(Card, {
          tone: "hero",
          children: jsx("div", {
            className: "dshfw-hero dshfw-hero--invest",
            children: [
              jsx("div", {
                className: "dshfw-hero__figure",
                children: [
                  jsx("span", { className: "dshfw-stat__label", children: t("invest.pnl") }),
                  jsx(Delta, { value: invest.pnl, size: "xl" }),
                  jsx("span", {
                    className: "dshfw-hero__foot",
                    children: [jsx("span", { className: "dshfw-key dshfw-key--up", children: `${money(invest.value, { decimals: 0 })} ${t("invest.value")}` }), jsx("span", { className: "dshfw-muted", children: "/" }), jsx("span", { className: "dshfw-muted", children: `${money(invest.cost, { decimals: 0 })} ${t("invest.cost")}` })]
                  })
                ]
              }),
              jsx("div", {
                className: "dshfw-hero__side",
                children: [jsx(StatMini, { label: t("invest.return"), value: percent(invest.pnlRate, { sign: true }), tone: invest.pnl >= 0 ? "up" : "down" }), jsx(StatMini, { label: t("invest.value"), value: money(invest.value, { decimals: 0 }) })]
              })
            ]
          })
        }),
        jsx("div", {
          className: "dshfw-grid dshfw-grid--2",
          children: [
            jsx(Card, {
              title: t("invest.allocation"),
              tone: "chart",
              children: jsx("div", {
                className: "dshfw-donut__wrap",
                children: jsx(Donut, { slices, center: { value: money(invest.value, { decimals: 0 }), caption: t("invest.value") }, label: t("invest.allocation") })
              })
            }),
            jsx(Card, { title: t("invest.allocation"), children: jsx(Composition, { slices }) }),
            jsx(Card, {
              title: t("invest.holdings"),
              tone: "table",
              className: "dshfw-span2",
              actions: jsx(Button, { tone: "outline", size: "sm", icon: jsx(IconPlus, { size: 13 }), onClick: () => setForm(null), label: t("invest.add"), children: t("invest.add") }),
              children:
                invest.items.length === 0
                  ? jsx("p", { className: "dshfw-empty__line", children: t("invest.empty") })
                  : jsx("table", {
                      className: "dshfw-table dshfw-table--invest",
                      children: [
                        jsx("thead", {
                          children: jsx("tr", {
                            children: [t("invest.colName"), t("invest.colShares"), t("invest.colCost"), t("invest.colPrice"), t("invest.colPnl"), t("invest.colRate"), ""].map((label, index) =>
                              jsx("th", { key: `${String(index)}-${label}`, scope: "col", className: index >= 1 && index <= 5 ? "dshfw-num" : "", children: label })
                            )
                          })
                        }),
                        jsx("tbody", {
                          children: invest.items.map((item) => {
                            const ratio = clamp(item.pnlRate, -1, 1);
                            const tone = item.pnl > 0 ? " is-up" : item.pnl < 0 ? " is-down" : "";
                            return jsx("tr", {
                              className: `dshfw-row__main${tone}`,
                              children: [
                                jsx("td", {
                                  className: "dshfw-row__merchant",
                                  children: jsx("span", {
                                    className: "dshfw-row__merchantInner",
                                    children: [
                                      jsx("span", { className: "dshfw-row__name", children: item.name }),
                                      jsx("span", {
                                        className: "dshfw-plain__meta",
                                        children: [jsx("i", { className: "dshfw-dot", style: { background: kindColorVar(HOLDING_TYPES, item.type) } }), t(`invest.type.${item.type}`), item.code === "" ? "" : ` · ${item.code}`]
                                      }),
                                      jsx("span", {
                                        className: "dshfw-pnlbar",
                                        children: [jsx("span", { className: "dshfw-pnlbar__base" }), jsx("span", { className: `dshfw-pnlbar__fill${item.pnl < 0 ? " is-down" : ""}`, style: { width: `${String(Math.abs(ratio) * 50)}%` } })]
                                      })
                                    ]
                                  })
                                }),
                                jsx("td", { className: "dshfw-num", children: String(item.shares) }),
                                jsx("td", { className: "dshfw-num", children: money(item.cost) }),
                                jsx("td", { className: "dshfw-num", children: money(item.price) }),
                                jsx("td", { className: `dshfw-num${tone}`, children: money(item.pnl, { sign: true }) }),
                                jsx("td", { className: `dshfw-num${tone}`, children: `${item.pnl > 0 ? "↑" : item.pnl < 0 ? "↓" : ""}${percent(item.pnlRate, { sign: true })}` }),
                                jsx("td", {
                                  className: "dshfw-row__tools",
                                  children: [
                                    jsx(IconButton, { label: t("action.edit"), onClick: () => setForm(item), children: jsx(IconChevronRight, { size: 13 }) }),
                                    jsx(IconButton, { label: t("action.remove"), tone: "danger", onClick: () => void writeSimple("/holdings", { op: "remove", id: item.id }, "toast.removed"), children: jsx(IconTrash, { size: 13 }) })
                                  ]
                                })
                              ]
                            });
                          })
                        })
                      ]
                    })
            })
          ]
        }),
        form === undefined ? null : jsx(HoldingForm, { record: form, onDone: () => setForm(undefined) })
      ];
    }

    // ── planning tab ──────────────────────────────────────────────────────
    /** Budget editor: one category's cap for the selected month. */
    function BudgetForm({ snapshot, record, onDone }) {
      const [category, setCategory] = react.useState(record?.category ?? "餐饮");
      const [limit, setLimit] = react.useState(record === null || record === undefined ? "" : yuanInput(record.limit));
      const [busy, setBusy] = react.useState(false);
      const options = [...new Set([...snapshot.budgets.map((row) => row.category), ...CATEGORIES])];
      const submit = async () => {
        const cents = parseYuan(limit);
        if (cents === null) {
          complain(new Error(t("plan.limit")));
          return;
        }
        setBusy(true);
        try {
          const saved = await writeSimple("/budgets", { op: "set", month: stateOf().month, category, limit: Math.abs(cents) }, "toast.budgetSet");
          if (saved) onDone?.();
        } finally {
          setBusy(false);
        }
      };
      return jsx(Dialog, {
        label: t("plan.editBudget"),
        onClose: onDone,
        children: [
          jsx("h3", { className: "dshfw-dialog__title", children: t("plan.editBudget") }),
          jsx("div", {
            className: "dshfw-form",
            children: [
              jsx(Field, { label: t("flow.colCategory"), children: jsx(Select, { label: t("flow.colCategory"), value: category, onChange: setCategory, options: options.map((value) => ({ value, label: value })) }) }),
              jsx(Field, { label: t("plan.limit"), children: jsx(TextInput, { label: t("plan.limit"), value: limit, onChange: setLimit, inputMode: "decimal", placeholder: "0.00" }) })
            ]
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [jsx(Button, { tone: "ghost", onClick: onDone, children: t("action.cancel") }), jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") })]
          })
        ]
      });
    }

    /** Savings-goal editor (create and edit share one form). */
    function GoalForm({ record, onDone }) {
      const isNew = record === null || record === undefined;
      const [name, setName] = react.useState(record?.name ?? "");
      const [target, setTarget] = react.useState(isNew ? "" : yuanInput(record.target));
      const [saved, setSaved] = react.useState(isNew ? "" : yuanInput(record.saved));
      const [deadline, setDeadline] = react.useState(record?.deadline ?? "");
      const [busy, setBusy] = react.useState(false);
      const submit = async () => {
        const targetCents = parseYuan(target);
        const savedCents = parseYuan(saved);
        if (name.trim() === "" || targetCents === null || savedCents === null) {
          complain(new Error(t("plan.goalTarget")));
          return;
        }
        setBusy(true);
        const op = isNew ? "add" : "update";
        try {
          const done = await writeSimple("/goals", { op, ...(isNew ? {} : { id: record.id }), name: name.trim(), target: Math.abs(targetCents), saved: Math.abs(savedCents), deadline: deadline.trim() }, "toast.goalSaved");
          if (done) onDone?.();
        } finally {
          setBusy(false);
        }
      };
      const title = isNew ? t("plan.addGoal") : t("plan.editGoal");
      return jsx(Dialog, {
        label: title,
        onClose: onDone,
        children: [
          jsx("h3", { className: "dshfw-dialog__title", children: title }),
          jsx("div", {
            className: "dshfw-form",
            children: [
              jsx(Field, { label: t("plan.goalName"), children: jsx(TextInput, { label: t("plan.goalName"), value: name, onChange: setName }) }),
              jsx(Field, { label: t("plan.goalTarget"), children: jsx(TextInput, { label: t("plan.goalTarget"), value: target, onChange: setTarget, inputMode: "decimal", placeholder: "0.00" }) }),
              jsx(Field, { label: t("plan.goalSaved"), children: jsx(TextInput, { label: t("plan.goalSaved"), value: saved, onChange: setSaved, inputMode: "decimal", placeholder: "0.00" }) }),
              jsx(Field, { label: t("plan.goalDeadline"), children: jsx(TextInput, { label: t("plan.goalDeadline"), value: deadline, onChange: setDeadline, placeholder: "2027-06-30" }) })
            ]
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [jsx(Button, { tone: "ghost", onClick: onDone, children: t("action.cancel") }), jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") })]
          })
        ]
      });
    }

    /** "Add money" for one goal. */
    function ContributeForm({ goal, onDone }) {
      const [amount, setAmount] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const submit = async () => {
        const cents = parseYuan(amount);
        if (cents === null || cents <= 0) {
          complain(new Error(t("plan.contributeAmount")));
          return;
        }
        setBusy(true);
        try {
          const saved = await writeSimple("/goals", { op: "contribute", id: goal.id, amount: Math.abs(cents) }, "toast.contributed");
          if (saved) onDone?.();
        } finally {
          setBusy(false);
        }
      };
      return jsx(Dialog, {
        label: t("plan.goalContribute"),
        onClose: onDone,
        children: [
          jsx("h3", { className: "dshfw-dialog__title", children: `${goal.name} · ${t("plan.goalContribute")}` }),
          jsx("div", {
            className: "dshfw-form dshfw-form--single",
            children: jsx(Field, { label: t("plan.contributeAmount"), children: jsx(TextInput, { label: t("plan.contributeAmount"), value: amount, onChange: setAmount, inputMode: "decimal", placeholder: "0.00" }) })
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [jsx(Button, { tone: "ghost", onClick: onDone, children: t("action.cancel") }), jsx(Button, { tone: "primary", onClick: submit, disabled: busy, children: t("action.save") })]
          })
        ]
      });
    }

    /** One savings goal card. */
    function GoalCard({ goal, onContribute, onEdit, onRemove }) {
      const done = goal.progress >= 1;
      return jsx("article", {
        className: `dshfw-goal${done ? " is-done" : ""}`,
        children: [
          jsx("header", {
            className: "dshfw-goal__head",
            children: [
              jsx("h4", { className: "dshfw-goal__name", children: goal.name }),
              done ? jsx(Chip, { tone: "good", children: t("plan.goalDone") }) : goal.deadline === "" ? null : jsx(Chip, { children: goal.deadline }),
              jsx("span", {
                className: "dshfw-goal__tools",
                children: [
                  jsx(IconButton, { label: t("action.edit"), onClick: onEdit, children: jsx(IconChevronRight, { size: 13 }) }),
                  jsx(IconButton, { label: t("action.remove"), tone: "danger", onClick: onRemove, children: jsx(IconTrash, { size: 13 }) })
                ]
              })
            ]
          }),
          jsx("div", {
            className: "dshfw-goal__amounts",
            children: [
              jsx("span", { className: "dshfw-goal__saved dshfw-num", children: money(goal.saved, { decimals: 0 }) }),
              jsx("span", { className: "dshfw-goal__target dshfw-num", children: ` / ${money(goal.target, { decimals: 0 })}` }),
              jsx("span", { className: "dshfw-goal__pct dshfw-num", children: sharePercent(goal.progress) })
            ]
          }),
          jsx(Progress, { ratio: goal.progress, tone: done ? "good" : "accent" }),
          jsx("footer", {
            className: "dshfw-goal__foot",
            children: [
              jsx("span", { children: t("plan.goalRemaining", { amount: money(Math.max(0, goal.target - goal.saved), { decimals: 0 }) }) }),
              done ? null : jsx("span", { children: t("plan.goalMonthly", { amount: money(goal.monthlyNeeded, { decimals: 0 }) }) }),
              jsx("span", { className: "dshfw-spacer" }),
              jsx(Button, { tone: "outline", size: "sm", onClick: onContribute, label: t("plan.goalContribute"), children: t("plan.goalContribute") })
            ]
          })
        ]
      });
    }

    /** Budget vs actual, goal cards, the advisory tips and the AI read. */
    function PlanPage({ snapshot, insight }) {
      const [form, setForm] = react.useState(null);
      const budgets = snapshot.budgets;
      const scale = Math.max(...budgets.map((row) => Math.max(row.limit, row.spent)), 1);
      const total = snapshot.budgetTotal;
      const totalUsed = total.limit > 0 ? clamp(total.spent / total.limit, 0, 1) : 0;
      const totalOver = total.limit > 0 && total.spent > total.limit;
      const overPercent = total.limit > 0 ? Math.round(((total.spent - total.limit) / total.limit) * 100) : 0;
      const totalSlices = totalOver
        ? [
            { key: "inside", label: t("chart.total"), value: total.limit, color: "var(--dshfw-accent)" },
            { key: "over", label: t("plan.over", { n: String(overPercent) }), value: Math.max(1, total.spent - total.limit), color: "var(--dshfw-neg)" }
          ]
        : [{ key: "spent", label: t("chart.total"), value: Math.max(1, total.spent), color: "var(--dshfw-accent)" }];
      const budgetDialog =
        form === null ? null : form.kind === "budget" ? jsx(BudgetForm, { snapshot, record: form.record, onDone: () => setForm(null) }) : form.kind === "goal" ? jsx(GoalForm, { record: form.record, onDone: () => setForm(null) }) : jsx(ContributeForm, { goal: form.record, onDone: () => setForm(null) });
      return [
        jsx("div", {
          className: "dshfw-grid dshfw-grid--plan",
          children: [
            jsx(Card, {
              title: t("plan.budget"),
              sub: t("plan.budgetTotal"),
              actions: jsx(Button, { tone: "outline", size: "sm", onClick: () => setForm({ kind: "budget", record: null }), label: t("plan.editBudget"), children: t("plan.editBudget") }),
              children: [
                jsx("div", {
                  className: `dshfw-budgettotal${totalOver ? " is-over" : ""}`,
                  children: [
                    jsx("div", {
                      className: "dshfw-donut__wrap dshfw-donut__wrap--sm",
                      children: jsx(Donut, { size: 128, thickness: 16, slices: totalSlices, center: { value: sharePercent(totalUsed), caption: t("plan.budget") }, label: t("plan.budgetTotal") })
                    }),
                    jsx("div", {
                      className: "dshfw-budgettotal__nums",
                      children: [
                        jsx("span", { className: "dshfw-budgettotal__big dshfw-num", children: money(total.spent, { decimals: 0 }) }),
                        jsx("span", { className: "dshfw-muted dshfw-num", children: ` / ${money(total.limit, { decimals: 0 })}` }),
                        jsx("span", {
                          className: `dshfw-budgettotal__note${totalOver ? " is-over" : ""}`,
                          children: total.limit > 0 ? (totalOver ? t("plan.over", { n: String(overPercent) }) : t("plan.left", { amount: money(total.limit - total.spent, { decimals: 0 }) })) : t("plan.noBudget")
                        })
                      ]
                    })
                  ]
                }),
                budgets.length === 0
                  ? jsx("p", { className: "dshfw-empty__line", children: t("plan.emptyBudget") })
                  : jsx("ul", {
                      className: "dshfw-budgets",
                      children: budgets.map((row) => jsx("li", { className: "dshfw-budgets__row", onClick: () => setForm({ kind: "budget", record: row }), children: jsx(BudgetBar, { budget: row, scale }) }))
                    })
              ]
            }),
            jsx(Card, {
              title: t("plan.goals"),
              sub: String(snapshot.goals.length),
              actions: jsx(Button, { tone: "outline", size: "sm", icon: jsx(IconPlus, { size: 13 }), onClick: () => setForm({ kind: "goal", record: null }), label: t("plan.addGoal"), children: t("plan.addGoal") }),
              children:
                snapshot.goals.length === 0
                  ? jsx("p", { className: "dshfw-empty__line", children: t("plan.goalEmpty") })
                  : jsx("div", {
                      className: "dshfw-goals",
                      children: snapshot.goals.map((goal) =>
                        jsx(GoalCard, {
                          goal,
                          onContribute: () => setForm({ kind: "contribute", record: goal }),
                          onEdit: () => setForm({ kind: "goal", record: goal }),
                          onRemove: () => void writeSimple("/goals", { op: "remove", id: goal.id }, "toast.goalRemoved")
                        })
                      )
                    })
            })
          ]
        }),
        jsx(Card, {
          title: t("plan.tips"),
          className: "dshfw-tips",
          children:
            snapshot.tips.length === 0
              ? jsx("p", { className: "dshfw-empty__line", children: t("plan.tipsEmpty") })
              : jsx("ul", {
                  className: "dshfw-tiplist",
                  children: snapshot.tips.map((tip, index) => {
                    const Glyph = tip.level === "warn" ? IconWarn : tip.level === "good" ? IconGood : IconInfo;
                    return jsx("li", {
                      key: `${String(index)}-${tip.title}`,
                      className: `dshfw-tip dshfw-tip--${tip.level}`,
                      children: [
                        jsx("span", { className: "dshfw-tip__icon", children: jsx(Glyph, { size: 15 }) }),
                        jsx("span", {
                          className: "dshfw-tip__text",
                          children: [jsx("b", { className: "dshfw-tip__title", children: tip.title }), jsx("span", { className: "dshfw-tip__detail", children: tip.detail })]
                        }),
                        jsx("span", { className: "dshfw-tip__level", children: t(`tip.level.${tip.level}`) })
                      ]
                    });
                  })
                })
        }),
        jsx(InsightCard, { insight }),
        budgetDialog
      ];
    }

    /** The month's written read, labelled with the source that produced it. */
    function InsightCard({ insight }) {
      const [retryBusy, setRetryBusy] = react.useState(false);
      const run = async () => {
        setRetryBusy(true);
        await refreshInsight(null);
        setRetryBusy(false);
      };
      const busy = insight?.busy === true || retryBusy;
      const source = insight?.source === "ai" ? "model" : "rules";
      return jsx("section", {
        className: "dshfw-insight",
        "aria-label": t("ai.insight"),
        children: [
          jsx("header", {
            className: "dshfw-insight__head",
            children: [
              jsx("h3", { className: "dshfw-insight__title", children: [jsx(IconSpark, { size: 14 }), t("ai.insight")] }),
              jsx("span", { className: `dshfw-insight__badge dshfw-insight__badge--${source}`, children: t(`ai.${source}`) }),
              jsx("span", { className: "dshfw-spacer" }),
              jsx(Button, { tone: "ghost", size: "sm", onClick: run, disabled: busy, label: t("ai.refresh"), children: t("ai.refresh") })
            ]
          }),
          busy
            ? jsx("p", { className: "dshfw-insight__body is-busy", children: [jsx("span", { className: "dshfw-shimmer" }), t("ai.insightBusy")] })
            : insight?.failure
              ? jsx("p", { className: "dshfw-insight__body is-error", children: t("ai.failed", { message: insight.failure }) })
              : jsx("p", { className: "dshfw-insight__body", children: insight?.text ?? "" })
        ]
      });
    }

// ── import wizard ─────────────────────────────────────────────────────
    /** The three-step import dialog: pick → preview → done. */
    function ImportWizard({ wizard, onClose }) {
      if (wizard === null) return null;
      const steps = ["file", "preview", "done"];
      const index = Math.max(0, steps.indexOf(wizard.step));
      return jsx(Dialog, {
        label: t("import.title"),
        onClose: onClose,
        wide: true,
        children: [
          jsx("header", {
            className: "dshfw-wizard__head",
            children: [
              jsx("h3", { className: "dshfw-dialog__title", children: t("import.title") }),
              jsx(IconButton, { label: t("action.close"), onClick: onClose, children: jsx(IconClose, { size: 14 }) })
            ]
          }),
          jsx("ol", {
            className: "dshfw-steps",
            children: steps.map((step, position) =>
              jsx("li", {
                key: step,
                className: `dshfw-steps__item${position === index ? " is-current" : ""}${position < index ? " is-done" : ""}`,
                children: [
                  jsx("span", { className: "dshfw-steps__num", children: position < index ? jsx(IconCheck, { size: 12 }) : String(position + 1) }),
                  t(`import.step.${step}`)
                ]
              })
            )
          }),
          wizard.step === "file" ? jsx(WizardFile, { wizard }) : null,
          wizard.step === "preview" ? jsx(WizardPreview, { wizard }) : null,
          wizard.step === "done" ? jsx(WizardDone, { wizard }) : null,
          wizard.failure === "" ? null : jsx("p", { className: "dshfw-wizard__error", role: "alert", children: wizard.failure })
        ]
      });
    }

    /** Step 1: drop zone, file picker and the CSV paste box. */
    function WizardFile({ wizard }) {
      const [text, setText] = react.useState("");
      const [over, setOver] = react.useState(false);
      const onDrop = (event) => {
        event?.preventDefault?.();
        setOver(false);
        const file = event?.dataTransfer?.files?.[0];
        if (file !== null && file !== undefined) void importFile(file);
      };
      return jsx("div", {
        className: "dshfw-wizard__body",
        children: [
          jsx("input", {
            className: "dshfw-file",
            type: "file",
            accept: ".csv,.tsv,.xlsx,.xls,.xml,.txt",
            "aria-label": t("import.pick"),
            onChange: (event) => {
              const file = event?.target?.files?.[0];
              if (file !== null && file !== undefined) void importFile(file);
            }
          }),
          jsx("div", {
            className: `dshfw-drop${over ? " is-over" : ""}`,
            onDragOver: (event) => {
              event?.preventDefault?.();
              setOver(true);
            },
            onDragLeave: () => setOver(false),
            onDrop,
            children: [
              jsx("span", { className: "dshfw-drop__icon", children: jsx(IconUpload, { size: 22 }) }),
              jsx("p", { className: "dshfw-drop__title", children: t("import.drop") }),
              jsx("p", { className: "dshfw-drop__or", children: t("import.or") }),
              jsx(Button, {
                tone: "primary",
                onClick: () => {
                  const field = document.querySelector?.(".dshfw-file");
                  if (field !== null && field !== undefined && typeof field.click === "function") field.click();
                },
                label: t("import.pick"),
                children: t("import.pick")
              }),
              jsx("p", { className: "dshfw-drop__hint", children: t("import.hint") })
            ]
          }),
          jsx("div", {
            className: "dshfw-paste",
            children: [
              jsx("label", { className: "dshfw-paste__label", children: t("import.paste") }),
              jsx("textarea", {
                className: "dshfw-textarea",
                value: text,
                placeholder: t("import.pastePlaceholder"),
                "aria-label": t("import.paste"),
                onChange: (event) => setText(event?.target?.value ?? "")
              }),
              jsx("div", {
                className: "dshfw-paste__foot",
                children: [
                  wizard.busy ? jsx("span", { className: "dshfw-muted", children: t("import.parsing") }) : null,
                  jsx(Button, {
                    tone: "outline",
                    disabled: wizard.busy || text.trim() === "",
                    onClick: () => void parseImport({ name: "pasted.csv", text }),
                    label: t("import.parse"),
                    children: t("import.parse")
                  })
                ]
              })
            ]
          })
        ]
      });
    }

    /** Step 2: the preview table with editable categories. */
    function WizardPreview({ wizard }) {
      const visible = wizard.rows.slice(0, PREVIEW_ROWS);
      const autoCount = num(wizard.auto, 0) > 0 ? num(wizard.auto, 0) : wizard.rows.filter((row) => row.confidence !== "default").length;
      const duplicateCount = num(wizard.duplicates, 0) > 0 ? num(wizard.duplicates, 0) : wizard.rows.filter((row) => row.duplicate).length;
      const rate = wizard.autoRate > 0 ? Math.round(wizard.autoRate * 100) : Math.round((autoCount / Math.max(1, wizard.rows.length)) * 100);
      const categoryOptions = [...new Set([...CATEGORIES, INCOME_CATEGORY])];
      return jsx("div", {
        className: "dshfw-wizard__body",
        children: [
          jsx("div", {
            className: "dshfw-wizard__summary",
            children: [
              jsx("p", { className: "dshfw-wizard__stat", children: t("import.summary", { n: String(wizard.rows.length), m: String(autoCount), rate: String(rate) }) }),
              jsx("p", { className: "dshfw-wizard__file dshfw-num", children: `${t("import.file")}：${wizard.file}` }),
              duplicateCount > 0 ? jsx("p", { className: "dshfw-wizard__dupes", children: t("import.dupes", { n: String(duplicateCount) }) }) : null,
              wizard.warnings.length > 0 ? jsx("p", { className: "dshfw-wizard__dupes", children: t("import.warnings", { n: String(wizard.warnings.length) }) }) : null,
              jsx("p", { className: "dshfw-wizard__note", children: t("import.previewNote", { n: String(Math.min(PREVIEW_ROWS, wizard.rows.length)) }) })
            ]
          }),
          jsx("div", {
            className: "dshfw-wizard__scroll",
            children: jsx("table", {
              className: "dshfw-table dshfw-table--preview",
              children: [
                jsx("thead", {
                  children: jsx("tr", {
                    children: [t("import.colDate"), t("import.colMerchant"), t("import.colAmount"), t("import.colCategory"), t("import.colStatus")].map((label, index) =>
                      jsx("th", { key: `${String(index)}-${label}`, scope: "col", className: index === 2 ? "dshfw-num" : "", children: label })
                    )
                  })
                }),
                jsx("tbody", {
                  children: visible.map((row, position) =>
                    jsx("tr", {
                      className: `dshfw-row__main${row.duplicate ? " is-duplicate" : ""}`,
                      children: [
                        jsx("td", { className: "dshfw-num", children: row.date }),
                        jsx("td", { className: "dshfw-row__merchant", children: row.merchant }),
                        jsx("td", { className: `dshfw-num${row.direction === "income" ? " is-income" : ""}`, children: `${row.direction === "income" ? "+" : "−"}${money(row.amount)}` }),
                        jsx("td", {
                          children: jsx("select", {
                            className: "dshfw-select dshfw-select--sm",
                            value: row.category,
                            "aria-label": `${t("import.colCategory")} ${String(position + 1)}`,
                            onChange: (event) => setPreviewCategory(row.key, event?.target?.value ?? row.category),
                            children: categoryOptions.map((value) => jsx("option", { value, children: value }))
                          })
                        }),
                        jsx("td", {
                          children: row.duplicate ? jsx("span", { className: "dshfw-tag dshfw-tag--dup", children: t("import.statusDup") }) : jsx("span", { className: "dshfw-tag", children: t("import.statusNew") })
                        })
                      ]
                    })
                  )
                })
              ]
            })
          }),
          jsx("div", {
            className: "dshfw-dialog__foot",
            children: [
              jsx(Button, { tone: "ghost", onClick: () => setState({ wizard: { ...wizard, step: "file", rows: [], failure: "" } }), children: t("action.back") }),
              jsx("span", { className: "dshfw-spacer" }),
              jsx(Button, {
                tone: "primary",
                disabled: wizard.busy || wizard.rows.length === 0,
                onClick: () => void confirmImport(),
                label: t("import.confirm"),
                children: wizard.busy ? t("import.saving") : t("import.confirm")
              })
            ]
          })
        ]
      });
    }

    /** Step 3: the result. */
    function WizardDone({ wizard }) {
      return jsx("div", {
        className: "dshfw-wizard__body dshfw-wizard__body--done",
        children: [
          jsx("span", { className: "dshfw-wizard__tick", children: jsx(IconCheck, { size: 24 }) }),
          jsx("h4", { className: "dshfw-wizard__doneTitle", children: t("import.result") }),
          jsx("p", { className: "dshfw-muted", children: t("import.resultAdded", { n: String(wizard.added) }) }),
          wizard.duplicates > 0 ? jsx("p", { className: "dshfw-muted", children: t("import.resultDup", { n: String(wizard.duplicates) }) }) : null,
          jsx(Button, { tone: "primary", onClick: closeWizard, label: t("action.done"), children: t("action.done") })
        ]
      });
    }

    // ── empty / error states ──────────────────────────────────────────────
    /** A blank ledger: one large guided card with the two starting points. */
    function EmptyState() {
      const state = useApp();
      return jsx("section", {
        className: "dshfw-empty",
        children: [
          jsx("div", {
            className: "dshfw-empty__art",
            "aria-hidden": "true",
            children: jsx("svg", {
              viewBox: "0 0 220 120",
              className: "dshfw-empty__svg",
              children: [
                jsx("circle", { cx: 74, cy: 60, r: 40, className: "dshfw-empty__ring dshfw-empty__ring--a" }),
                jsx("circle", { cx: 122, cy: 60, r: 40, className: "dshfw-empty__ring dshfw-empty__ring--b" }),
                jsx("circle", { cx: 98, cy: 60, r: 40, className: "dshfw-empty__ring dshfw-empty__ring--c" }),
                jsx("path", { d: "M18 104h184", className: "dshfw-empty__base" })
              ]
            })
          }),
          jsx("h2", { className: "dshfw-empty__title", children: t("empty.title") }),
          jsx("p", { className: "dshfw-empty__desc", children: t("empty.desc") }),
          jsx("div", {
            className: "dshfw-empty__actions",
            children: [
              jsx(Button, { tone: "primary", icon: jsx(IconUpload, { size: 15 }), onClick: openWizard, label: t("empty.import"), children: t("empty.import") }),
              jsx(Button, { tone: "outline", onClick: () => void loadDemo(), disabled: state.demoBusy, label: t("empty.demo"), children: state.demoBusy ? t("empty.demoBusy") : t("empty.demo") })
            ]
          }),
          jsx("p", { className: "dshfw-empty__privacy", children: t("empty.privacy") })
        ]
      });
    }

    /** A failed load: the message and a retry. */
    function ErrorState({ message }) {
      const state = useApp();
      return jsx("section", {
        className: "dshfw-error",
        role: "alert",
        children: [
          jsx("span", { className: "dshfw-error__icon", children: jsx(IconWarn, { size: 20 }) }),
          jsx("p", { className: "dshfw-error__text", children: t("error.load", { message: message ?? t("error.generic") }) }),
          jsx(Button, { tone: "primary", onClick: () => void loadMonth(state.month), label: t("error.retry"), children: t("error.retry") })
        ]
      });
    }


    // ── 总看板：一年干了什么 ──────────────────────────────────────────────
    /**
     * 「总看板」页：把整年的钱放在一屏里。
     *
     * 版面按「问题的重要性」从上到下排，而不是按数据表结构排：
     *
     *   1. 年度两个大数（花了多少 / 赚了多少）——最想知道的答案，给最大字号
     *   2. 每月收支双柱——「钱花在哪些月份」，柱高直接可比
     *   3. 每月结余——「哪几个月入不敷出」，负数朝下
     *   4. 年度支出构成 + 预算完成度——「花在哪、有没有超」
     *
     * 本月三数仍在「收支」页，这里刻意只讲全年，避免两页说同一件事。
     */
    function DashboardPage({ snapshot, onFilter }) {
      const yearly = snapshot.yearly;
      const rows = Array.isArray(snapshot.trend) ? snapshot.trend : [];
      const hasData = rows.some((row) => row.income !== 0 || row.expense !== 0);
      if (!hasData) {
        return jsx(Card, { title: t("board.title"), children: jsx("p", { className: "dshfw-muted", children: t("chart.noData") }) });
      }
      const deficit = yearly.balance < 0;
      const totalBudget = (Array.isArray(snapshot.budgets) ? snapshot.budgets : []).find((row) => row.category === "__total__") ?? null;
      return jsxs("div", {
        className: "dshfw-board",
        children: [
          // ① 年度的两个大数
          jsxs("section", {
            className: "dshfw-board__hero",
            children: [
              jsxs("div", {
                className: "dshfw-board__big",
                "data-tone": "expense",
                children: [
                  jsx("span", { className: "dshfw-board__big-label", children: t("board.yearExpense", { year: String(yearly.year) }) }),
                  jsx("span", { className: "dshfw-board__big-value dshfw-num", children: money(yearly.expense, { decimals: 0 }) }),
                  jsx("span", {
                    className: "dshfw-board__big-foot",
                    children: t("board.monthlyAvg", { amount: money(yearly.avgExpense, { decimals: 0 }) })
                  })
                ]
              }),
              jsxs("div", {
                className: "dshfw-board__big",
                "data-tone": "income",
                children: [
                  jsx("span", { className: "dshfw-board__big-label", children: t("board.yearIncome", { year: String(yearly.year) }) }),
                  jsx("span", { className: "dshfw-board__big-value dshfw-num", children: money(yearly.income, { decimals: 0 }) }),
                  jsx("span", {
                    className: "dshfw-board__big-foot",
                    children: t("board.monthlyAvg", { amount: money(yearly.avgIncome, { decimals: 0 }) })
                  })
                ]
              }),
              jsxs("div", {
                className: "dshfw-board__big",
                "data-tone": deficit ? "negative" : "balance",
                children: [
                  jsx("span", { className: "dshfw-board__big-label", children: t("board.yearBalance", { year: String(yearly.year) }) }),
                  jsx("span", {
                    className: "dshfw-board__big-value dshfw-num",
                    children: money(yearly.balance, { decimals: 0, sign: true })
                  }),
                  jsx("span", {
                    className: "dshfw-board__big-foot",
                    children: deficit ? t("stat.deficit") : t("board.monthsCount", { n: String(yearly.months) })
                  })
                ]
              })
            ]
          }),
          // ①.5 数据完整性提醒：先于图表出现，避免用户先被数字吓到
          (Array.isArray(snapshot.dataNotes) ? snapshot.dataNotes : []).map((note, index) =>
            jsxs("div", {
              key: `note-${String(index)}`,
              className: "dshfw-datanote",
              "data-level": note.level,
              role: "status",
              children: [
                jsx("span", { className: "dshfw-datanote__icon", children: jsx(IconWarn, { size: 15 }) }),
                jsxs("span", {
                  className: "dshfw-datanote__body",
                  children: [jsx("b", { children: note.title }), note.detail === "" ? null : ` ${note.detail}`]
                })
              ]
            })
          ),
          // ② 每月收支双柱
          jsx(Card, {
            title: t("board.monthlyFlow"),
            sub: t("board.monthlyFlowSub"),
            children: [
              jsx(MonthlyBars, { rows, current: snapshot.month }),
              jsx(AxisNote, { snapshot })
            ]
          }),
          // ③ 每月结余 + ④ 预算完成度
          jsxs("div", {
            className: "dshfw-grid dshfw-grid--2",
            children: [
              jsx(Card, {
                title: t("board.monthlyBalance"),
                sub: t("board.monthlyBalanceSub"),
                children: jsx(BalanceBars, { rows, current: snapshot.month })
              }),
              jsx(Card, {
                title: t("board.budget"),
                sub: t("board.budgetSub"),
                children: jsx(BudgetProgress, { snapshot, totalBudget })
              })
            ]
          }),
          // ⑤ 年度支出构成
          jsx(Card, {
            title: t("board.category"),
            sub: t("board.categorySub"),
            children: jsx(CategoryDonut, { snapshot, onFilter })
          })
        ]
      });
    }

    /**
     * 预算完成度：本月实际支出 vs 月度目标。
     *
     * 没有设「整月目标」时，用各分类预算之和当基准，并说明这一点——
     * 否则用户会以为那个数是自己设的。
     */
    function BudgetProgress({ snapshot, totalBudget }) {
      const s = snapshot.summary;
      const limit = totalBudget !== null ? totalBudget.limit : (snapshot.budgetTotal?.limit ?? 0);
      if (!(limit > 0)) {
        return jsx("p", { className: "dshfw-muted", children: t("board.noBudget") });
      }
      const spent = s.expense;
      const used = limit > 0 ? spent / limit : 0;
      const over = spent > limit;
      const explicit = totalBudget !== null;
      return jsxs("div", {
        className: "dshfw-budgetbar",
        "data-over": over ? "true" : undefined,
        children: [
          jsx("div", {
            className: "dshfw-budgetbar__track",
            children: jsx("span", {
              className: "dshfw-budgetbar__fill",
              style: { width: `${String(Math.min(100, used * 100))}%` }
            })
          }),
          jsxs("div", {
            className: "dshfw-budgetbar__row",
            children: [
              jsx("span", { className: "dshfw-budgetbar__num dshfw-num", children: t("board.spentOf", { spent: money(spent, { decimals: 0 }), limit: money(limit, { decimals: 0 }) }) }),
              jsx("span", {
                className: "dshfw-budgetbar__pct dshfw-num",
                children: over
                  ? t("plan.over", { n: String(Math.round((used - 1) * 100)) })
                  : t("board.remain", { amount: money(limit - spent, { decimals: 0 }) })
              })
            ]
          }),
          jsx("p", {
            className: "dshfw-budgetbar__note",
            children: explicit ? t("board.budgetExplicit") : t("board.budgetDerived")
          })
        ]
      });
    }

    /** 年度支出构成的环形图（复用分类颜色与下钻交互）。 */
    function CategoryDonut({ snapshot, onFilter }) {
      const slices = donutSlices(snapshot);
      if (slices.length === 0) return jsx("p", { className: "dshfw-muted", children: t("chart.noData") });
      return jsx("div", {
        className: "dshfw-flow__overview",
        children: jsx(Card, {
          title: t("flow.category"),
          children: jsx(Composition, { slices, onSelect: onFilter, selected: "" })
        })
      });
    }

    // ── the page ──────────────────────────────────────────────────────────
    /**
     * 底部常驻的「随手记一笔」输入条。
     *
     * 这是整个面板最重要的入口：记账的阻力越低，账本越不会断。输入一句
     * 「35 咖啡」回车即入账，不需要先点开表单、选分类、填日期。解析出来的
     * 金额/日期/商户会实时显示成一行预览，认不出来就把提示写在原地。
     *
     * @param {{ onDone?: () => void }} props `onDone` 记账成功后回调（面板用来切到收支页）。
     */
    function QuickEntry({ onDone }) {
      const state = useApp();
      const [text, setText] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const inputRef = react.useRef(null);
      const parsed = react.useMemo(() => (text.trim() === "" ? null : parseQuickEntry(text)), [text]);
      const submit = async () => {
        if (busy) return;
        const draft = parseQuickEntry(text);
        if (draft === null) {
          setError(t("quick.unparsed"));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          // 金额走「分」（和 TxnEditor 一致）；分类/目的留空，交给 Host 的规则引擎
          // 按商户名归类——这样「35 咖啡」能自动落进「餐饮 / 生活必须」。
          const ok = await saveTxn({
            id: "",
            fields: {
              date: draft.date,
              amount: Math.round(draft.amount * 100),
              direction: draft.direction,
              category: draft.direction === "income" ? "收入" : "",
              purpose: "",
              merchant: draft.merchant,
              account: "现金",
              note: ""
            }
          });
          if (ok) {
            setText("");
            if (typeof onDone === "function") onDone();
          }
        } finally {
          setBusy(false);
        }
      };
      const keyDown = (event) => {
        if (event?.key === "Enter" && !event?.shiftKey) {
          event.preventDefault?.();
          void submit();
        }
      };
      return jsx("div", {
        className: "dshfw-quick",
        "data-busy": busy ? "true" : undefined,
        children: [
          jsx("span", { className: "dshfw-quick__glyph", "aria-hidden": "true", children: jsx(IconPlus, { size: 16 }) }),
          jsx("input", {
            ref: inputRef,
            className: "dshfw-quick__input",
            type: "text",
            value: text,
            placeholder: t("quick.placeholder"),
            "aria-label": t("quick.label"),
            onChange: (event) => {
              setText(event?.target?.value ?? "");
              if (error !== null) setError(null);
            },
            onKeyDown: keyDown
          }),
          parsed === null
            ? error === null
              ? null
              : jsx("span", { className: "dshfw-quick__hint is-error", role: "status", children: error })
            : jsx("span", {
                className: "dshfw-quick__hint",
                "data-direction": parsed.direction,
                children: t("quick.preview", {
                  amount: money(Math.round(parsed.amount * 100), { decimals: 2 }),
                  merchant: parsed.merchant,
                  date: parsed.date.slice(5)
                })
              }),
          jsx(Button, { tone: parsed === null ? "outline" : "primary", size: "sm", onClick: () => void submit(), disabled: busy, label: t("quick.submit"), children: busy ? t("quick.busy") : t("quick.submit") })
        ]
      });
    }

    /**
     * 演示账本提示条：告诉用户「这些数字是样例」，并给一条随时能走的出口。
     *
     * 好的默认可观但不能骗人——铺了演示数据就必须说清楚，并且一键就能换成
     * 自己的真账本（清空后不会再自动铺回来）。
     */
    function DemoNotice() {
      const [busy, setBusy] = react.useState(false);
      const clear = async () => {
        if (busy) return;
        setBusy(true);
        try {
          const value = await delJson("/demo", {});
          if (value?.snapshot !== undefined) setState({ snapshot: normalizeSnapshot(value.snapshot) });
          await reload();
          notify(translate("demo.cleared"));
        } catch (error) {
          complain(error);
        } finally {
          setBusy(false);
        }
      };
      return jsx("div", {
        className: "dshfw-demonote",
        role: "status",
        children: [
          jsx("span", { className: "dshfw-demonote__text", children: [jsx("b", { children: t("demo.title") }), ` ${t("demo.desc")}`] }),
          jsx("div", {
            className: "dshfw-demonote__actions",
            children: [
              jsx(Button, { tone: "outline", size: "sm", onClick: openWizard, label: t("demo.import"), children: t("demo.import") }),
              jsx(Button, { tone: "ghost", size: "sm", onClick: () => void clear(), disabled: busy, label: t("demo.clear"), children: busy ? t("demo.clearing") : t("demo.clear") })
            ]
          })
        ]
      });
    }

    /** The main panel. Reads the app store and composes the whole cockpit. */
    function FinancePage(props) {
      const state = useApp();
      // The shell may hand the page its own translator; module-level code (writes
      // that outlive a render) keeps using the one bound in apply().
      const snapshot = state.snapshot;
      react.useEffect(() => {
        if (appStore.state.phase === "idle") void loadMonth(appStore.state.month);
      }, []);
      const blank = snapshot === null || isBlank(snapshot);
      const loading = state.phase === "loading" && snapshot === null;
      const tab = state.tab;
      const pickTab = (next) => setState({ tab: TABS.includes(next) ? next : "flow" });
      const onFilter = (category) => setState({ filterCategory: category, tab: "flow" });
      let body;
      if (state.phase === "error" && snapshot === null) {
        body = jsx(ErrorState, { message: state.error });
      } else if (snapshot === null) {
        body = jsx(Skeleton, { lines: loading ? 5 : 4 });
      } else if (blank) {
        // A ledger with nothing in it yet: the two starting points are the
        // whole page. (A wired-up ledger with an empty month still gets the
        // tables, because the tabs each have something to say about zero.)
        body = jsx(EmptyState, {});
      } else {
        const panes = {
          board: [jsx(DashboardPage, { snapshot, onFilter })],
          flow: [jsx(StatStrip, { snapshot }), jsx("div", { className: "dshfw-grid dshfw-grid--2", children: [jsx(FlowTrend, { snapshot }), jsx(Card, { title: t("flow.top"), children: jsx(TopExpenses, { snapshot, onPick: onFilter }) })] }), jsx(FlowOverview, { snapshot, filter: state.filterCategory, onFilter }), jsx(FlowList, { snapshot })],
          assets: [jsx(AssetsPage, { snapshot })],
          invest: [jsx(InvestPage, { snapshot })],
          plan: [jsx(PlanPage, { snapshot, insight: state.insight })]
        };
        body = jsx("div", { className: "dshfw-tabpane", "data-pane": tab, children: panes[TABS.includes(tab) ? tab : "flow"] });
      }
      return jsx("div", {
        className: "dshfw-page",
        children: [
          jsx(Header, {}),
          jsx("div", {
            className: "dshfw-scroll",
            children: jsx("div", {
              className: "dshfw-inner",
              children: [
                jsx(TabBar, { tab, onPick: pickTab }),
                snapshot !== null && snapshot.settings?.demo === true && !blank ? jsx(DemoNotice, {}) : null,
                state.error !== null && state.phase !== "error"
                  ? jsx("div", {
                      className: "dshfw-banner",
                      role: "status",
                      children: [jsx(IconWarn, { size: 14 }), jsx("span", { children: state.error }), jsx("button", { type: "button", className: "dshfw-banner__retry", onClick: () => void loadMonth(state.month), children: t("error.retry") })]
                    })
                  : null,
                body
              ]
            })
          }),
          state.toast === null ? null : jsx("div", { className: "dshfw-toast", role: "status", children: state.toast.message }),
          jsx(QuickEntry, { onDone: () => setState({ tab: "flow" }) }),
          jsx(ImportWizard, { wizard: state.wizard, onClose: closeWizard })
        ]
      });
    }

    /** The sidebar row. */
    const PanelIcon = (props) => jsx(IconWallet, { size: typeof props?.size === "number" ? props.size : 18 });

    // ── styles ────────────────────────────────────────────────────────────
    /** The browser-safe font stacks: local faces only, never a download. */
    const FONT_UI = `var(--dsw-font-family,ui-sans-serif,-apple-system,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif)`;
    /** Numbers use a tabular face so columns line up like a ledger. */
    const FONT_NUM = `"SF Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,"Roboto Mono",monospace`;
    /** The dark palette hangs off the shell's own theme attribute. */
    const DARK_SCOPE = "body[data-ds-dark-theme]";

    /** `--dshfw-cN` for both themes plus the two semantic accents. */
    const paletteCss = () => {
      const light = PALETTE.map((entry, index) => `--dshfw-c${String(index)}:${entry.light}`).join(";");
      const dark = PALETTE.map((entry, index) => `--dshfw-c${String(index)}:${entry.dark}`).join(";");
      return `.dshfw-page{${light};--dshfw-income:#3E6E8E;--dshfw-pos:#B4432F;--dshfw-neg:#2E7D67;--dshfw-accent:var(--dshfw-c0);}
${DARK_SCOPE} .dshfw-page{${dark};--dshfw-income:#79A9C6;--dshfw-pos:#E08A74;--dshfw-neg:#6FB8A1;}
`.replace(".dshfw-page[data-theme-auto]{}", "");
    };

    const CSS = String.raw`
.dshfw-page{box-sizing:border-box;position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;color:var(--dsw-alias-label-primary);font-family:${FONT_UI};font-size:14px;line-height:22px;background:var(--dsw-alias-bg-base)}
.dshfw-page *{box-sizing:border-box}
.dshfw-page button{font-family:inherit}
.dshfw-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.dshfw-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshfw-spacer{flex:1 1 auto}

/* ── header ─────────────────────────────────────────────────────────── */
.dshfw-header{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:14px clamp(14px,3vw,32px) 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.dshfw-brand{display:flex;align-items:center;gap:10px;min-width:0}
.dshfw-brand__mark{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:10px;color:#fff;background:linear-gradient(150deg,var(--dshfw-c1),var(--dshfw-c5));box-shadow:0 1px 2px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.28)}
.dshfw-brand__text{display:flex;flex-direction:column;min-width:0}
.dshfw-brand__title{margin:0;font-size:15px;font-weight:600;line-height:20px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-brand__sub{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-month{display:flex;align-items:center;gap:6px;margin-left:auto}
.dshfw-month__switch{display:inline-flex;align-items:center;gap:2px;height:32px;padding:0 2px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dshfw-month__label{min-width:104px;padding:0 8px;text-align:center;font-size:13px;font-weight:500;letter-spacing:-.01em;white-space:nowrap}
.dshfw-month__today{height:28px;padding:0 10px;border:none;border-radius:999px;background:color-mix(in srgb,var(--dshfw-accent) 14%,transparent);color:var(--dshfw-accent);font-size:12px;cursor:pointer}
.dshfw-month__today:hover{background:color-mix(in srgb,var(--dshfw-accent) 22%,transparent)}
.dshfw-header__actions{display:flex;align-items:center;gap:6px}

/* ── controls ───────────────────────────────────────────────────────── */
.dshfw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;min-height:28px;padding:0 14px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s ease,border-color .12s ease,transform .12s ease,opacity .12s ease;white-space:nowrap}
.dshfw-btn:hover{transform:translateY(-.5px)}
.dshfw-btn:active{transform:none}
.dshfw-btn:disabled{opacity:.42;cursor:not-allowed;transform:none}
.dshfw-btn--sm{height:28px;padding:0 10px;font-size:12px;border-radius:8px}
.dshfw-btn--primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-bg-base);font-weight:500}
.dshfw-btn--primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.dshfw-btn--outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dshfw-btn--outline:hover{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfw-btn--ghost{color:var(--dsw-alias-label-secondary)}
.dshfw-btn--ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfw-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.dshfw-btn__text{white-space:nowrap}
.dshfw-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color .12s ease,color .12s ease}
.dshfw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshfw-iconbtn--danger:hover{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dshfw-iconbtn:disabled{opacity:.4;cursor:not-allowed}
.dshfw-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap}
.dshfw-chip.is-active{border-color:color-mix(in srgb,var(--dshfw-accent) 45%,transparent);background:color-mix(in srgb,var(--dshfw-accent) 12%,transparent);color:var(--dshfw-accent)}
.dshfw-chip--good{border-color:color-mix(in srgb,var(--dshfw-neg) 45%,transparent);color:var(--dshfw-neg);background:color-mix(in srgb,var(--dshfw-neg) 10%,transparent)}
.dshfw-input,.dshfw-select,.dshfw-textarea{width:100%;min-height:32px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;outline:none;transition:border-color .12s ease}
.dshfw-input::placeholder,.dshfw-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshfw-input:focus,.dshfw-select:focus,.dshfw-textarea:focus{border-color:var(--dshfw-accent);outline-offset:1px}
.dshfw-select--sm{min-height:26px;height:26px;padding:0 6px;font-size:12px;border-radius:6px}
.dshfw-textarea{min-height:96px;resize:vertical;font-family:${FONT_NUM};font-size:12px;line-height:18px}
.dshfw-search{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary)}
.dshfw-search:focus-within{border-color:var(--dshfw-accent)}
.dshfw-search__input{width:150px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none}
.dshfw-search__input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshfw-btn:focus-visible,.dshfw-iconbtn:focus-visible,.dshfw-tabs__tab:focus-visible,.dshfw-menu__item:focus-visible,.dshfw-input:focus-visible,.dshfw-select:focus-visible,.dshfw-search__input:focus-visible,.dshfw-banner__retry:focus-visible,.dshfw-row__main:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dshfw-accent));outline-offset:2px}

/* ── menu ───────────────────────────────────────────────────────────── */
.dshfw-menu{position:relative}
.dshfw-menu__pop{position:absolute;top:calc(100% + 6px);right:0;z-index:40;display:flex;flex-direction:column;min-width:168px;padding:4px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent,0 10px 26px rgba(0,0,0,.22));animation:dshfw-pop .12s ease-out}
.dshfw-menu__item{display:block;width:100%;padding:7px 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;text-align:left;cursor:pointer}
.dshfw-menu__item:hover{background:var(--dsw-alias-interactive-bg-hover)}

/* ── tabs ───────────────────────────────────────────────────────────── */
.dshfw-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable}
.dshfw-inner{display:flex;flex-direction:column;gap:16px;width:100%;max-width:1180px;margin:0 auto;padding:14px clamp(14px,3vw,32px) 88px}
.dshfw-tabs{position:sticky;top:0;z-index:6;padding:6px 0 2px;background:var(--dsw-alias-bg-base)}
.dshfw-tabs__track{position:relative;display:grid;grid-template-columns:repeat(var(--tab-count,4),minmax(0,1fr));border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshfw-tabs__tab{position:relative;z-index:1;height:36px;padding:0 6px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:13.5px;letter-spacing:.02em;cursor:pointer;transition:color .16s ease}
.dshfw-tabs__tab:hover{color:var(--dsw-alias-label-secondary)}
.dshfw-tabs__tab.is-active{color:var(--dsw-alias-label-primary);font-weight:600}
.dshfw-tabs__ink{position:absolute;left:0;bottom:-.5px;height:2px;border-radius:2px;background:var(--dshfw-accent);transition:transform .26s cubic-bezier(.22,.8,.3,1)}
.dshfw-tabpane{display:flex;flex-direction:column;gap:16px;animation:dshfw-in .12s ease-out}

/* ── cards & grid ───────────────────────────────────────────────────── */
.dshfw-grid{display:grid;gap:16px}
.dshfw-grid--2{grid-template-columns:repeat(2,minmax(0,1fr))}
.dshfw-grid--plan{grid-template-columns:minmax(0,1.15fr) minmax(0,1fr)}
.dshfw-span2{grid-column:span 2}
.dshfw-card{display:flex;flex-direction:column;gap:12px;min-width:0;padding:16px 18px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dshfw-card--chart,.dshfw-card--table{background:var(--dsw-alias-bg-layer-1)}
.dshfw-card--hero{padding:18px 20px;background:linear-gradient(160deg,color-mix(in srgb,var(--dshfw-accent) 5%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 55%)}
.dshfw-card__head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px}
.dshfw-card__heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshfw-card__title{margin:0;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
.dshfw-card__sub{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshfw-card__actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px}

/* ── headline numbers ───────────────────────────────────────────────── */
.dshfw-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) 1.1fr;gap:0;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshfw-stat{display:flex;flex-direction:column;gap:4px;min-width:0;padding:18px 20px;border-left:.5px solid var(--dsw-alias-border-l2)}
.dshfw-stat:first-child{border-left:none}
.dshfw-stat__label{font-size:11.5px;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary)}
.dshfw-stat__value{display:flex;align-items:baseline;gap:2px;font-size:clamp(28px,3.4vw,38px);font-weight:600;line-height:1.08;letter-spacing:-.02em;color:var(--dsw-alias-label-primary)}
.dshfw-stat__unit{font-size:.42em;font-weight:500;letter-spacing:0;color:var(--dsw-alias-label-tertiary)}
.dshfw-stat__foot{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-stat--income .dshfw-stat__value{color:var(--dshfw-income)}
.dshfw-stat--negative .dshfw-stat__value{color:var(--dsw-alias-state-error-primary)}
.dshfw-stat--positive .dshfw-stat__value{color:var(--dsw-pos,var(--dshfw-pos))}
.dshfw-strip__aside{display:flex;flex-direction:column;justify-content:center;gap:10px;padding:16px 18px;border-left:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,transparent)}
.dshfw-strip__excluded{margin:0;padding-top:8px;border-top:.5px dotted var(--dsw-alias-border-l2);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshfw-strip__review{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-warning-primary,var(--dshfw-c0));font-variant-numeric:tabular-nums}
.dshfw-metric{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dshfw-metric__label{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-metric__value{font-size:13px;font-weight:600;letter-spacing:-.01em}
.dshfw-hero{display:flex;align-items:center;justify-content:space-between;gap:24px}
.dshfw-hero__figure{display:flex;flex-direction:column;gap:2px;align-items:center;flex:1 1 auto}
.dshfw-hero__foot{display:flex;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-hero--invest .dshfw-hero__side{display:flex;flex-direction:column;gap:14px;min-width:150px}
.dshfw-mini{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshfw-mini__label{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-mini__value{font-size:16px;font-weight:600;letter-spacing:-.01em}
.dshfw-mini__foot{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshfw-mini--positive .dshfw-mini__value{color:var(--dshfw-pos)}
.dshfw-mini--negative .dshfw-mini__value{color:var(--dshfw-neg)}

/* ── charts ─────────────────────────────────────────────────────────── */
.dshfw-donut{display:flex;flex-direction:column;align-items:center;gap:8px;margin:0 auto}
.dshfw-donut__wrap{display:flex;justify-content:center;padding:4px 0 2px}
.dshfw-donut__wrap--sm .dshfw-donut{margin:0}
.dshfw-donut__svg{overflow:visible}
.dshfw-donut__track{stroke:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.dshfw-donut__arc{transform:rotate(-90deg);transform-origin:center;transition:opacity .16s ease;animation:dshfw-ring .9s cubic-bezier(.22,.8,.3,1) backwards;stroke-linecap:butt}
.dshfw-donut__arc.is-clickable{cursor:pointer}
.dshfw-donut__arc.is-clickable:hover{opacity:.82}
.dshfw-donut__arc.is-dim{opacity:.28}
.dshfw-donut__value{font-family:${FONT_NUM};font-size:19px;font-weight:600;fill:var(--dsw-alias-label-primary);letter-spacing:-.02em}
.dshfw-donut__caption{font-family:${FONT_UI};font-size:10.5px;fill:var(--dsw-alias-label-tertiary)}
.dshfw-donut__empty{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshfw-line{width:100%;height:132px;display:block;overflow:visible}
.dshfw-line__path{stroke-dasharray:1;stroke-dashoffset:0;animation:dshfw-draw 1.1s cubic-bezier(.4,0,.2,1) backwards}
.dshfw-line__area{animation:dshfw-fadein .9s ease-out backwards}
.dshfw-line__dot{fill:var(--dsw-alias-bg-layer-1);stroke:currentColor;stroke-width:1.6;animation:dshfw-fadein .4s ease-out backwards}
.dshfw-line__zero{stroke:color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);stroke-width:1;stroke-dasharray:3 4}
.dshfw-axis{display:grid;gap:0;font-size:10.5px;color:var(--dsw-alias-label-tertiary);text-align:center}
.dshfw-chart__empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshfw-trend{display:flex;flex-direction:column;gap:10px;position:relative}
.dshfw-trend__plot{position:relative}
.dshfw-trend__legend{display:flex;gap:14px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dshfw-key{display:inline-flex;align-items:center;gap:6px}
.dshfw-key__line{width:14px;height:2px;border-radius:2px;background:currentColor}
.dshfw-key__line--income{background:var(--dshfw-income)}
.dshfw-key__line--expense{background:var(--dshfw-c0)}
.dshfw-key--up{color:var(--dshfw-pos)}
.dshfw-comp{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dshfw-comp__row{display:grid;grid-template-columns:10px minmax(56px,auto) minmax(40px,1fr) auto 38px;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer;transition:background-color .12s ease}
.dshfw-comp__row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfw-comp__row.is-selected{background:color-mix(in srgb,var(--dshfw-accent) 12%,transparent)}
.dshfw-comp__dot{width:8px;height:8px;border-radius:3px}
.dshfw-comp__name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-comp__bar{position:relative;display:block;height:6px;border-radius:3px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);overflow:hidden}
.dshfw-comp__fill{display:block;height:100%;border-radius:3px;animation:dshfw-grow .7s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-comp__value{font-size:12.5px;font-weight:600;letter-spacing:-.01em;text-align:right;white-space:nowrap}
.dshfw-comp__share{font-size:11.5px;color:var(--dsw-alias-label-tertiary);text-align:right}

/* ── flow: legend card, top five ────────────────────────────────────── */
.dshfw-flow__overview{display:grid;grid-template-columns:minmax(220px,.8fr) minmax(0,1.4fr);gap:16px}
.dshfw-top{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dshfw-top__row{display:flex;align-items:center;gap:12px;padding:7px 8px;border-radius:9px;cursor:pointer;transition:background-color .12s ease}
.dshfw-top__row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfw-top__rank{flex:none;width:16px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-align:center}
.dshfw-top__main{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0}
.dshfw-top__name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-top__meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshfw-top__meta .dshfw-dot{vertical-align:middle;margin-right:4px}
.dshfw-top__bar{display:block;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);overflow:hidden}
.dshfw-top__fill{display:block;height:100%;border-radius:2px;animation:dshfw-grow-x .6s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-top__amount{font-size:13px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
.dshfw-dot{display:inline-block;width:7px;height:7px;border-radius:3px;flex:none}
.dshfw-dot--liab{background:var(--dshfw-neg);border-radius:50%}

/* ── tables ─────────────────────────────────────────────────────────── */
.dshfw-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dshfw-filterbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:0 2px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-filterbar__count{font-variant-numeric:tabular-nums}
.dshfw-table{width:100%;border-collapse:collapse;font-size:13px}
.dshfw-table th{position:sticky;top:0;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:11px;font-weight:500;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary);text-align:left;white-space:nowrap;background:var(--dsw-alias-bg-layer-1)}
.dshfw-table th.dshfw-num,.dshfw-table td.dshfw-num{text-align:right}
.dshfw-table td{padding:8px 10px;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent);vertical-align:middle}
.dshfw-row__main{cursor:pointer;transition:background-color .1s ease}
.dshfw-row__main:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfw-row__date{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshfw-row__merchant{max-width:280px}
.dshfw-row__merchantInner{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshfw-row__name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-row__note{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-src{display:inline-block;margin-left:6px;padding:0 5px;border-radius:4px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2)}
.dshfw-row__account{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}
.dshfw-row__amount{font-weight:600;letter-spacing:-.01em;white-space:nowrap}
.dshfw-row__amount.is-income{color:var(--dshfw-income)}
.dshfw-row__tools{width:68px;white-space:nowrap;text-align:right}
.dshfw-row__toolsInner{display:inline-flex;gap:0;opacity:0;transition:opacity .12s ease}
.dshfw-row__main:hover .dshfw-row__toolsInner,.dshfw-row.is-open .dshfw-row__toolsInner,.dshfw-row__main:focus-within .dshfw-row__toolsInner{opacity:1}
.dshfw-row.is-open{background:color-mix(in srgb,var(--dshfw-accent) 5%,transparent)}
.dshfw-row.is-open .dshfw-row__toolsInner{opacity:1}
.dshfw-row__expand>td{padding:0;border-bottom:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2.5%,transparent)}
.dshfw-row__editor{display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;animation:dshfw-in .14s ease-out}
.dshfw-row__editing{margin:0;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.dshfw-cat{display:inline-flex;align-items:center;gap:5px;padding:1px 8px 1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;white-space:nowrap}
.dshfw-mark{padding:0 1px;border-radius:2px;background:color-mix(in srgb,var(--dshfw-accent) 26%,transparent);color:inherit}
.dshfw-listfoot{display:flex;justify-content:center;padding-top:2px}
.dshfw-addsheet{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,transparent);animation:dshfw-in .14s ease-out}

/* ── forms ──────────────────────────────────────────────────────────── */
.dshfw-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px 12px;width:100%}
.dshfw-form--single{grid-template-columns:minmax(0,1fr)}
.dshfw-form__foot{grid-column:1/-1;display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
.dshfw-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dshfw-field--wide{grid-column:1/-1}
.dshfw-field__label{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-field__hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshfw-seg{grid-column:1/-1;display:inline-flex;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);width:fit-content}
.dshfw-seg__item{height:26px;min-width:56px;padding:0 12px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;transition:background-color .14s ease,color .14s ease}
.dshfw-seg__item.is-active{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12)}

/* ── plain lists (assets, liabilities) ──────────────────────────────── */
.dshfw-plain{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.dshfw-plain__row{display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
.dshfw-plain__row:last-child{border-bottom:none}
.dshfw-plain__row.is-due{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#C58A2E) 9%,transparent);border-radius:8px}
.dshfw-plain__main{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.dshfw-plain__name{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-plain__meta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dshfw-due{font-style:normal;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#A8741F));font-weight:600}
.dshfw-plain__valueCol{display:flex;flex-direction:column;align-items:flex-end;gap:1px}
.dshfw-plain__value{font-size:13px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
.dshfw-plain__sub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshfw-plain__tools{display:flex;gap:0;opacity:0;transition:opacity .12s ease}
.dshfw-plain__row:hover .dshfw-plain__tools,.dshfw-plain__row:focus-within .dshfw-plain__tools{opacity:1}

/* ── investments ────────────────────────────────────────────────────── */
.dshfw-delta{display:inline-flex;align-items:baseline;gap:4px;font-weight:600;letter-spacing:-.02em}
.dshfw-delta__arrow{font-size:.72em;line-height:1}
.dshfw-delta__rate{font-size:.5em;font-weight:500;letter-spacing:0;opacity:.85}
.dshfw-delta--xl{font-size:clamp(28px,3.4vw,38px);line-height:1.1}
.dshfw-delta--md{font-size:15px}
.dshfw-delta--up{color:var(--dshfw-pos)}
.dshfw-delta--down{color:var(--dshfw-neg)}
.dshfw-delta--flat{color:var(--dsw-alias-label-secondary)}
.dshfw-table td.is-up{color:var(--dshfw-pos)}
.dshfw-table td.is-down{color:var(--dshfw-neg)}
.dshfw-pnlbar{position:relative;display:block;height:3px;border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);overflow:hidden;margin:2px 0 1px}
.dshfw-pnlbar__base{position:absolute;left:50%;top:0;bottom:0;width:1px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.dshfw-pnlbar__fill{position:absolute;top:0;bottom:0;left:50%;border-radius:2px;background:var(--dshfw-pos);animation:dshfw-grow-x .7s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-pnlbar__fill.is-down{left:auto;right:50%;background:var(--dshfw-neg)}

/* ── planning ───────────────────────────────────────────────────────── */
.dshfw-budgettotal{display:flex;align-items:center;gap:16px}
.dshfw-budgettotal__nums{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshfw-budgettotal__big{font-size:24px;font-weight:600;letter-spacing:-.02em}
.dshfw-budgettotal__note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-budgettotal__note.is-over{color:var(--dsw-alias-state-error-primary);font-weight:600}
.dshfw-budgets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dshfw-budgets__row{padding:2px;border-radius:8px;cursor:pointer;transition:background-color .12s ease}
.dshfw-budgets__row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshfw-budget{display:grid;grid-template-columns:64px minmax(60px,1fr) auto;align-items:center;gap:10px;padding:4px 2px}
.dshfw-budget__name{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-budget__track{position:relative;display:block;height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);overflow:hidden}
.dshfw-budget__fill{position:absolute;left:0;top:0;height:100%;border-radius:4px;background:var(--dshfw-accent);animation:dshfw-grow-x .7s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-budget__over{position:absolute;top:0;height:100%;left:100%;transform:translateX(-100%);border-radius:0 4px 4px 0;background:repeating-linear-gradient(135deg,var(--dsw-alias-state-error-primary) 0 4px,color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent) 4px 8px)}
.dshfw-budget.is-over .dshfw-budget__fill{background:var(--dsw-alias-state-error-primary);opacity:.55}
.dshfw-budget__num{font-size:12px;white-space:nowrap;text-align:right;color:var(--dsw-alias-label-secondary)}
.dshfw-budget__num b{color:var(--dsw-alias-label-primary);font-weight:600}
.dshfw-budget.is-over .dshfw-budget__num b{color:var(--dsw-alias-state-error-primary)}
.dshfw-budget__label{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dshfw-budget__slash{color:var(--dsw-alias-label-tertiary)}
.dshfw-goals{display:flex;flex-direction:column;gap:10px}
.dshfw-goal{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 1.5%,transparent)}
.dshfw-goal.is-done{border-color:color-mix(in srgb,var(--dshfw-neg) 35%,transparent)}
.dshfw-goal__head{display:flex;align-items:center;gap:8px;min-width:0}
.dshfw-goal__name{margin:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshfw-goal__tools{margin-left:auto;display:flex;gap:0;opacity:0;transition:opacity .12s ease}
.dshfw-goal:hover .dshfw-goal__tools{opacity:1}
.dshfw-goal__amounts{display:flex;align-items:baseline;gap:0}
.dshfw-goal__saved{font-size:17px;font-weight:600;letter-spacing:-.01em}
.dshfw-goal__target{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshfw-goal__pct{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-goal__foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-progress{display:block;height:8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);overflow:hidden}
.dshfw-progress__fill{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,color-mix(in srgb,var(--dshfw-accent) 70%,transparent),var(--dshfw-accent));animation:dshfw-grow-x .8s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-progress--good .dshfw-progress__fill{background:linear-gradient(90deg,color-mix(in srgb,var(--dshfw-neg) 70%,transparent),var(--dshfw-neg))}
.dshfw-tips{background:var(--dsw-alias-bg-layer-1)}
.dshfw-tiplist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.dshfw-tip{display:flex;align-items:flex-start;gap:10px;padding:9px 8px;border-radius:9px}
.dshfw-tip+.dshfw-tip{border-top:.5px solid color-mix(in srgb,var(--dsw-alias-border-l2) 55%,transparent)}
.dshfw-tip__icon{display:inline-flex;flex:none;margin-top:3px}
.dshfw-tip__text{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.dshfw-tip__title{font-size:12.5px;font-weight:600}
.dshfw-tip__detail{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-tip__level{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;margin-top:2px}
.dshfw-tip--info .dshfw-tip__icon{color:var(--dsw-alias-brand-primary)}
.dshfw-tip--warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#C58A2E) 6%,transparent)}
.dshfw-tip--warn .dshfw-tip__icon{color:var(--dsw-alias-state-warn-primary,#C58A2E)}
.dshfw-tip--good .dshfw-tip__icon{color:var(--dshfw-neg)}

/* ── AI insight ─────────────────────────────────────────────────────── */
.dshfw-insight{display:flex;flex-direction:column;gap:8px;padding:16px 18px;border-radius:14px;border:.5px solid color-mix(in srgb,var(--dshfw-accent) 26%,var(--dsw-alias-border-l2));background:linear-gradient(150deg,color-mix(in srgb,var(--dshfw-accent) 7%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 60%)}
.dshfw-insight__head{display:flex;align-items:center;gap:8px}
.dshfw-insight__title{margin:0;display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:600;color:var(--dshfw-accent)}
.dshfw-insight__badge{padding:0 7px;border-radius:999px;font-size:10.5px;line-height:17px;border:.5px solid currentColor}
.dshfw-insight__badge--rules{color:var(--dsw-alias-label-tertiary)}
.dshfw-insight__badge--model{color:var(--dshfw-accent)}
.dshfw-insight__body{margin:0;font-size:13px;line-height:23px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dshfw-insight__body.is-error{color:var(--dsw-alias-state-error-primary)}
.dshfw-shimmer{display:inline-block;width:64px;height:10px;margin-right:8px;border-radius:3px;vertical-align:middle;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent),color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent),color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent));background-size:200% 100%;animation:dshfw-shimmer 1.2s linear infinite}

/* ── dialogs & wizard ───────────────────────────────────────────────── */
.dshfw-scrim{position:fixed;inset:0;z-index:90;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:6vh 16px 32px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 32%,transparent);animation:dshfw-fadein .14s ease-out}
.dshfw-dialog{width:min(520px,100%);display:flex;flex-direction:column;gap:14px;padding:18px 20px 16px;border-radius:16px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.28));animation:dshfw-pop .16s ease-out}
.dshfw-dialog--wide{width:min(860px,100%)}
.dshfw-dialog__title{margin:0;font-size:15px;font-weight:600;letter-spacing:-.01em}
.dshfw-dialog__foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}
.dshfw-wizard__head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dshfw-steps{list-style:none;margin:0;padding:0;display:flex;gap:4px;align-items:center}
.dshfw-steps__item{display:inline-flex;align-items:center;gap:6px;padding:0 4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshfw-steps__item:not(:last-child)::after{content:"";width:18px;height:1px;background:var(--dsw-alias-border-l2);margin-left:4px}
.dshfw-steps__item.is-current{color:var(--dsw-alias-label-primary);font-weight:600}
.dshfw-steps__item.is-done{color:var(--dshfw-accent)}
.dshfw-steps__num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid currentColor;font-size:10.5px;font-variant-numeric:tabular-nums}
.dshfw-wizard__body{display:flex;flex-direction:column;gap:12px;min-height:0}
.dshfw-wizard__body--done{align-items:center;text-align:center;padding:14px 0 4px}
.dshfw-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.dshfw-drop{display:flex;flex-direction:column;align-items:center;gap:8px;padding:26px 16px 22px;border-radius:14px;border:1.5px dashed var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-label-primary) 2%,transparent);text-align:center;transition:border-color .14s ease,background-color .14s ease}
.dshfw-drop.is-over{border-color:var(--dshfw-accent);background:color-mix(in srgb,var(--dshfw-accent) 10%,transparent)}
.dshfw-drop__icon{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;color:var(--dshfw-accent);background:color-mix(in srgb,var(--dshfw-accent) 14%,transparent)}
.dshfw-drop__title{margin:0;font-size:14px;font-weight:600}
.dshfw-drop__or{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-drop__hint{margin:4px 0 0;max-width:460px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshfw-paste{display:flex;flex-direction:column;gap:6px}
.dshfw-paste__label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-paste__foot{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.dshfw-wizard__summary{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-wizard__stat{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshfw-wizard__file{margin:0;color:var(--dsw-alias-label-tertiary)}
.dshfw-wizard__dupes{margin:0;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#A8741F))}
.dshfw-wizard__note{margin:0;flex-basis:100%;color:var(--dsw-alias-label-tertiary)}
.dshfw-wizard__scroll{max-height:min(46vh,420px);overflow:auto;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2)}
.dshfw-wizard__error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary)}
.dshfw-wizard__tick{display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;color:#fff;background:var(--dshfw-neg);animation:dshfw-pop .3s cubic-bezier(.22,.8,.3,1)}
.dshfw-wizard__doneTitle{margin:0;font-size:16px;font-weight:600}
.dshfw-table--preview td{padding:6px 10px}
.dshfw-row__main.is-duplicate{opacity:.5}
.dshfw-tag{padding:0 6px;border-radius:999px;font-size:10.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);white-space:nowrap}
.dshfw-tag--dup{color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}

/* ── empty, error, skeleton, toast ──────────────────────────────────── */
.dshfw-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:40px 20px 44px;border-radius:18px;border:.5px solid var(--dsw-alias-border-l2);background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--dshfw-accent) 8%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 62%);text-align:center}
.dshfw-empty__art{width:100%;max-width:240px}
.dshfw-empty__svg{width:100%;height:auto;overflow:visible}
.dshfw-empty__ring{fill:none;stroke-width:10;stroke-linecap:round;stroke-dasharray:251;stroke-dashoffset:0;animation:dshfw-ring 1.4s cubic-bezier(.22,.8,.3,1) backwards}
.dshfw-empty__ring--a{stroke:var(--dshfw-c0);opacity:.85}
.dshfw-empty__ring--b{stroke:var(--dshfw-c1);opacity:.75;animation-delay:.12s}
.dshfw-empty__ring--c{stroke:var(--dshfw-c5);opacity:.7;animation-delay:.24s}
.dshfw-empty__base{stroke:color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent);stroke-width:1;stroke-dasharray:4 5}
.dshfw-empty__title{margin:2px 0 0;font-size:19px;font-weight:600;letter-spacing:-.01em}
.dshfw-empty__desc{margin:0;max-width:430px;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.dshfw-empty__actions{display:flex;flex-wrap:wrap;justify-content:center;gap:10px;margin-top:6px}
.dshfw-empty__privacy{margin:6px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-empty__line{margin:0;padding:14px 2px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-error{display:flex;flex-direction:column;align-items:center;gap:10px;padding:28px 20px;border-radius:14px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,var(--dsw-alias-bg-layer-1));text-align:center}
.dshfw-error__icon{color:var(--dsw-alias-state-error-primary)}
.dshfw-error__text{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dshfw-banner{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:10px;font-size:12.5px;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#A8741F));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#C58A2E) 12%,transparent)}
.dshfw-banner__retry{margin-left:auto;border:none;background:transparent;color:inherit;font:inherit;font-weight:600;text-decoration:underline;cursor:pointer}
.dshfw-skeleton{display:flex;flex-direction:column;gap:12px}
.dshfw-sk{border-radius:10px;background:var(--dsw-alias-bg-skeleton,color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent));animation:dshfw-pulse 1.4s ease-in-out infinite}
.dshfw-sk--title{width:180px;height:22px}
.dshfw-sk--stat{height:96px;flex:1 1 0}
.dshfw-sk--panel{height:180px;flex:1 1 0}
.dshfw-sk--line{height:14px}
.dshfw-sk__row{display:flex;gap:12px}
.dshfw-toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);z-index:60;max-width:min(520px,calc(100% - 32px));padding:9px 16px;border-radius:999px;background:var(--dsw-alias-toast-bg,var(--dsw-alias-label-primary));color:var(--dsw-alias-toast-label,var(--dsw-alias-bg-base));font-size:12.5px;box-shadow:var(--dsw-elevation-prominent,0 10px 26px rgba(0,0,0,.24));animation:dshfw-in .18s ease-out}

/* ── quick entry dock (随手记一笔) ───────────────────────────────────── */
.dshfw-quick{flex:none;display:flex;align-items:center;gap:10px;margin:0 clamp(14px,3vw,32px) 14px;padding:8px 10px 8px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));box-shadow:var(--dsw-elevation-prominent,0 6px 20px rgba(0,0,0,.06));transition:border-color .16s ease,box-shadow .16s ease,transform .16s ease}
.dshfw-quick:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px var(--dsw-focus-ring-color,rgba(13,148,136,.18));transform:translateY(-1px)}
.dshfw-quick[data-busy="true"]{opacity:.7}
.dshfw-quick__glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dshfw-accent);color:#fff;opacity:.92}
.dshfw-quick__input{flex:1 1 auto;min-width:0;height:32px;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:${FONT_UI};font-size:13.5px;line-height:32px}
.dshfw-quick__input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshfw-quick__hint{flex:none;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dshfw-quick__hint[data-direction="income"]{color:var(--dshfw-income)}
.dshfw-quick__hint.is-error{color:var(--dsw-alias-state-error-primary)}

/* ── demo ledger notice ─────────────────────────────────────────────── */
.dshfw-demonote{display:flex;align-items:center;gap:10px;padding:9px 14px;margin-bottom:12px;border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dshfw-accent);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dshfw-demonote__text{flex:1 1 auto;min-width:0}
.dshfw-demonote__text b{color:var(--dsw-alias-label-primary);font-weight:600}
.dshfw-demonote__actions{flex:none;display:flex;gap:8px}


.dshfw-datanote{display:flex;gap:10px;align-items:flex-start;padding:11px 14px;border:.5px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dshfw-c0);border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dshfw-datanote[data-level="warn"]{border-left-color:var(--dsw-alias-state-warning-primary,var(--dshfw-c0))}
.dshfw-datanote__icon{flex:none;display:inline-flex;color:var(--dshfw-c0);padding-top:1px}
.dshfw-datanote__body b{color:var(--dsw-alias-label-primary);font-weight:600}

/* ── 总看板 ─────────────────────────────────────────────────────────── */
.dshfw-board{display:flex;flex-direction:column;gap:16px}
.dshfw-board__hero{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;background:var(--dsw-alias-border-l2)}
.dshfw-board__big{display:flex;flex-direction:column;gap:6px;padding:22px 24px 20px;background:var(--dsw-alias-bg-base)}
.dshfw-board__big-label{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dshfw-board__big-value{font-size:clamp(26px,3vw,36px);line-height:1.1;letter-spacing:-.025em;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshfw-board__big[data-tone="income"] .dshfw-board__big-value{color:var(--dshfw-income)}
.dshfw-board__big[data-tone="balance"] .dshfw-board__big-value{color:var(--dshfw-pos)}
.dshfw-board__big[data-tone="negative"] .dshfw-board__big-value{color:var(--dsw-alias-state-error-primary)}
.dshfw-board__big-foot{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}

/* 双柱图 */
.dshfw-bars{display:flex;flex-direction:column;gap:10px}
.dshfw-bars__legend{display:flex;gap:16px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshfw-bars__plot{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:6px;height:190px;align-items:end}
.dshfw-bars__col{display:flex;flex-direction:column;align-items:center;gap:6px;height:100%}
.dshfw-bars__pair{display:flex;align-items:flex-end;justify-content:center;gap:3px;width:100%;height:100%;padding-bottom:2px}
.dshfw-bars__bar{width:42%;max-width:22px;border-radius:3px 3px 0 0;transform-origin:bottom center;animation:dshfw-grow .6s cubic-bezier(.22,1,.36,1) both}
.dshfw-bars__bar--expense{background:var(--dshfw-c0);opacity:.92}
.dshfw-bars__bar--income{background:var(--dshfw-income);opacity:.72}
.dshfw-bars__col.is-current .dshfw-bars__bar{outline:1.5px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshfw-bars__label{font-size:11px;line-height:1.25;text-align:center;white-space:pre-line;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshfw-bars__col.is-current .dshfw-bars__label{color:var(--dsw-alias-label-primary);font-weight:600}

/* 结余正负柱 */
.dshfw-balbars{display:flex;flex-direction:column;gap:8px}
.dshfw-balbars__plot{position:relative;height:172px}
.dshfw-balbars__axis{position:absolute;left:0;right:0;top:var(--zero);border-top:.5px dashed var(--dsw-alias-border-l2)}
.dshfw-balbars__cols{position:absolute;inset:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:5px}
.dshfw-balbars__col{position:relative;height:100%}
.dshfw-balbars__bar{position:absolute;left:50%;width:46%;max-width:20px;margin-left:-23%;border-radius:3px;transform-origin:center;animation:dshfw-grow .55s cubic-bezier(.22,1,.36,1) both}
.dshfw-balbars__bar.is-positive{background:var(--dshfw-pos);opacity:.85}
.dshfw-balbars__bar.is-negative{background:var(--dsw-alias-state-error-primary);opacity:.8}

/* 预算完成度 */
.dshfw-budgetbar{display:flex;flex-direction:column;gap:10px;padding-top:6px}
.dshfw-budgetbar__track{height:12px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);overflow:hidden}
.dshfw-budgetbar__fill{display:block;height:100%;border-radius:999px;background:var(--dshfw-accent);transform-origin:left center;animation:dshfw-grow-x .8s cubic-bezier(.22,1,.36,1) both}
.dshfw-budgetbar[data-over="true"] .dshfw-budgetbar__fill{background:repeating-linear-gradient(45deg,var(--dsw-alias-state-error-primary) 0 6px,color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,#fff) 6px 12px)}
.dshfw-budgetbar__row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.dshfw-budgetbar__num{font-size:19px;font-weight:600;letter-spacing:-.01em}
.dshfw-budgetbar__pct{font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dshfw-budgetbar[data-over="true"] .dshfw-budgetbar__pct{color:var(--dsw-alias-state-error-primary);font-weight:600}
.dshfw-budgetbar__note{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dshfw-trend__yearly{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* ── motion ─────────────────────────────────────────────────────────── */
@keyframes dshfw-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dshfw-pop{from{opacity:0;transform:translateY(-4px) scale(.99)}to{opacity:1;transform:none}}
@keyframes dshfw-fadein{from{opacity:0}to{opacity:1}}
@keyframes dshfw-ring{from{stroke-dasharray:0 999}to{stroke-dasharray:inherit}}
@keyframes dshfw-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes dshfw-grow{from{transform:scaleY(0)}to{transform:scaleY(1)}}
@keyframes dshfw-grow-x{from{transform:scaleX(0);transform-origin:left center}to{transform:scaleX(1);transform-origin:left center}}
@keyframes dshfw-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
@keyframes dshfw-pulse{0%,100%{opacity:.55}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){
  .dshfw-page *,.dshfw-page *::before,.dshfw-page *::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}
}

/* ── responsive ─────────────────────────────────────────────────────── */
@media (max-width:1200px){.dshfw-strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){.dshfw-strip__aside{grid-column:1/-1;flex-direction:row;gap:24px;border-left:none;border-top:.5px solid var(--dsw-alias-border-l2)}}
@media (max-width:900px){
  .dshfw-board__hero{grid-template-columns:minmax(0,1fr)}
  .dshfw-bars__plot{height:150px}
  .dshfw-strip{grid-template-columns:minmax(0,1fr)}
  .dshfw-stat{border-left:none;border-top:.5px solid var(--dsw-alias-border-l2)}
  .dshfw-stat:first-child{border-top:none}
  .dshfw-grid--2,.dshfw-grid--plan{grid-template-columns:minmax(0,1fr)}
  .dshfw-span2{grid-column:auto}
  .dshfw-flow__overview{grid-template-columns:minmax(0,1fr)}
  .dshfw-hero{flex-direction:column;align-items:stretch;gap:16px}
  .dshfw-hero--invest .dshfw-hero__side{flex-direction:row;justify-content:space-between}
  .dshfw-header>.dshfw-month{margin-left:0;order:3;width:100%}
  .dshfw-header__actions{margin-left:auto}
  .dshfw-table{font-size:12.5px}
  .dshfw-row__account,.dshfw-table th:nth-child(4){display:none}
  .dshfw-search__input{width:110px}
  .dshfw-budget{grid-template-columns:56px minmax(40px,1fr) auto}
  .dshfw-dialog--wide{width:min(100%,100%)}
}
`;

    /** Install the stylesheet once; returns a disposer. */
    const installStyles = () => {
      if (document.getElementById(STYLE_ID) !== null) return () => {};
      const tag = document.createElement("style");
      tag.id = STYLE_ID;
      tag.dataset.plugin = DOM_ID;
      tag.textContent = `${CSS}\n${paletteCss()}`;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    };

    // ── plugin body ───────────────────────────────────────────────────────
    /** Required Client services. */
    const inject = ["slots", "locale", "layout"];

    /**
     * Install the stylesheet, register the locale and both surfaces, and load
     * the selected month so the first paint already has numbers.
     * @param {object} ctx the plugin's Client context.
     */
    function apply(ctx) {
      const disposers = [];
      disposers.push(installStyles());
      setTranslator(typeof ctx.locale.bind === "function" ? ctx.locale.bind(NS) : (key) => key);
      if (typeof ctx.locale.register === "function") {
        disposers.push(ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }));
      }
      // A slot `label` is resolved by the shell as the whole dictionary for the
      // namespace, not as one key inside it.
      ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, FinancePage));
      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: 16,
            locale: NS,
            label: () => NS
          },
          PanelIcon
        )
      );
      // A fresh generation is a fresh page: it opens on this month, with no
      // filter, no half-finished wizard, nothing carried over.
      appStore.state = { ...appStore.state, month: monthKey(), phase: "idle", snapshot: null, txns: [], tab: "board", filterCategory: "", query: "", openTxnId: "", editor: null, wizard: null, insight: null, toast: null, error: null };
      if (typeof ctx.effect === "function") {
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {}
          }
          appStore.listeners.clear();
        }, "finance-workspace: styles, locale, subscriptions");
      }
    }

    /** Simplified Chinese dictionary (compiled in by scripts/build.mjs). */
    const DICT_ZH = __DICT_ZH__;
    /** English dictionary. */
    const DICT_EN = __DICT_EN__;

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
