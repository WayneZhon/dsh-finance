/**
 * lib/domain.js —— 个人理财工作台的领域层。
 *
 * 这里只放**纯函数与常量**：没有 IO、没有状态、没有第三方依赖。
 * 金额一律使用「分」的整数（`1234` 表示 12.34 元）；日期一律 `YYYY-MM-DD`、
 * 月份一律 `YYYY-MM`，全部按本地时间解释。
 *
 * @module dsh-finance/domain
 */

/** 支出分类（唯一一套，流水 category 必须取自 CATEGORIES）。 */
export const EXPENSE_CATEGORIES = Object.freeze([
  '餐饮',
  '交通',
  '购物',
  '居家',
  // 「家庭」是给家人的钱（赡养、给伴侣）与住在家庭之外的房租水电。
  // 与「人情往来」不同：后者专指红包、份子钱这类社交性支出。
  '家庭',
  '医疗',
  '教育',
  '娱乐',
  '通讯',
  '人情往来',
  '保险',
  '还贷',
  '投资',
  '其他',
]);

/** 收入分类：收入方向固定用 `"收入"`。 */
export const INCOME_CATEGORY = '收入';

/** 全部可选分类（支出分类 + 收入）。 */
export const CATEGORIES = Object.freeze([...EXPENSE_CATEGORIES, INCOME_CATEGORY]);

/** 记账目的；收入行允许为空串。 */
export const PURPOSES = Object.freeze(['生活必须', '娱乐享受', '未来保障', '人情社交', '自我实现']);

/** 资产类型。 */
export const ASSET_KINDS = Object.freeze(['cash', 'investment', 'property', 'other']);

/** 负债类型。 */
export const LIABILITY_KINDS = Object.freeze(['mortgage', 'car', 'credit', 'consumer', 'other']);

/** 持仓类型。 */
export const HOLDING_TYPES = Object.freeze(['fund', 'stock', 'bond', 'other']);

/**
 * 保单/存款/理财的类型。
 *
 * 这三类在记账上的**共性远大于差异**：都有一笔钱、一个到期或续保的日期、
 * 以及「到点了要处理」的诉求。所以用一份模型承载，而不是三套表。
 */
export const POLICY_KINDS = Object.freeze(['insurance', 'deposit', 'wealth', 'other']);

/** 保险险种。 */
export const INSURANCE_TYPES = Object.freeze([
  'medical', 'critical', 'accident', 'life', 'annuity', 'car', 'property', 'other',
]);

/** 缴费周期。 */
export const PAY_CYCLES = Object.freeze(['yearly', 'half_year', 'quarterly', 'monthly', 'once']);

/** 流水来源。 */
export const SOURCE_KINDS = Object.freeze(['import', 'manual', 'agent']);

/** 收支方向。 */
export const DIRECTIONS = Object.freeze(['expense', 'income']);

/** 资产 / 负债 / 持仓 / 预算 / 目标等类型的中文名（Host 侧给人看/给模型看）。 */
export const KIND_LABELS = Object.freeze({
  cash: '现金/存款',
  investment: '投资',
  property: '房产',
  other: '其他',
  mortgage: '房贷',
  car: '车贷',
  credit: '信用卡',
  consumer: '消费贷',
  fund: '基金',
  stock: '股票',
  bond: '债券',
});

/** 数据文件结构版本号。 */
export const DB_VERSION = 1;

/** 一份空库的工厂；每次返回新对象，避免共享引用。 */
export function emptyDb() {
  return {
    version: DB_VERSION,
    txns: [],
    assets: [],
    liabilities: [],
    holdings: [],
    policies: [],
    budgets: [],
    goals: [],
    rules: {},
    imports: [],
    settings: { currency: 'CNY', emergencyMonths: 6 },
  };
}

/* ------------------------------------------------------------------ */
/* 金额工具（分）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把金额字符串 / 数字解析成「分」的整数。
 *
 * 支持：`12.34`、`¥1,234.56`、`￥12`、`+35.00`、`-8.5`、`12元`、全角数字、
 * `1,234`（按元解释）、价格里的空格与不换行空格。末尾的 `-`（部分银行导出
 * 写成 `100.00-`）按负数处理。无法解析返回 `null`（绝不抛异常，便于上层统计
 * skipped 行）。
 *
 * @param {string|number|null|undefined} value 原始金额
 * @returns {number|null} 分（可能为负），无法解析时为 null
 */
export function parseAmountToCents(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100);
  }
  let text = String(value);
  if (!text) return null;
  // 全角数字与符号 → 半角
  text = text
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF0B]/g, '+')
    .replace(/[\uFF0D\u2212]/g, '-')
    .replace(/[\uFF0E]/g, '.')
    .replace(/[\uFF0C]/g, ',');
  text = text.replace(/[,\s\u00a0\u3000]/g, '');
  text = text.replace(/[¥￥$€£元人民币]/g, '');
  if (!text) return null;

  let negative = false;
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (text.startsWith('+')) {
    text = text.slice(1);
  } else if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1);
  } else if (/^\(.*\)$/.test(text)) {
    // 会计记账法 (123.00) 表示负数
    negative = !negative;
    text = text.slice(1, -1);
  }
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(text)) return null;

  // 用字符串拆分整数/小数部分再相乘，彻底绕开浮点误差
  const [intPart, fracRaw = ''] = text.split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  const third = fracRaw.length > 2 ? Number(fracRaw[2]) : 0;
  let cents = Number(intPart || '0') * 100 + Number(frac);
  if (third >= 5) cents += 1; // 三位以上小数四舍五入到分
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * 把「分」格式化成人类可读的金额字符串。
 *
 * @param {number} cents 分
 * @param {{ sign?: boolean, symbol?: boolean, group?: boolean, decimals?: number }} [options]
 *   sign 恒显示正负号；symbol 带上 `¥`；group 千分位（默认 true）；decimals 小数位（默认 2）
 * @returns {string} 例如 `¥1,234.56`
 */
export function formatCents(cents, options = {}) {
  const { sign = false, symbol = true, group = true, decimals = 2 } = options;
  const n = Math.round(Number(cents) || 0);
  const negative = n < 0;
  const abs = Math.abs(n);
  let digits = String(decimals === 0 ? Math.round(abs / 100) : abs / 100);
  if (decimals > 0) {
    digits = (abs / 100).toFixed(Math.min(decimals, 2));
    if (decimals > 2) digits += '0'.repeat(decimals - 2);
  }
  let [intPart, fracPart] = digits.split('.');
  if (group) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  const prefix = negative ? '-' : sign ? '+' : '';
  return `${prefix}${symbol ? '¥' : ''}${body}`;
}

/**
 * 安全整数加法：把一串「分」相加，忽略非有限值。
 *
 * @param {...(number|null|undefined)} values 分
 * @returns {number} 和（分）
 */
export function safeAdd(...values) {
  let total = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) total += Math.round(value);
    else if (Array.isArray(value)) total += safeAdd(...value);
  }
  return total;
}

/**
 * 把任意输入钳到 `[min, max]` 区间；非数字返回 min。
 *
 * @param {number} value 值
 * @param {number} min 下限
 * @param {number} max 上限
 * @returns {number}
 */
export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 安全除法：分母为 0 / 非数字时返回 fallback，并把结果四舍五入到 4 位小数
 * （比例只用于展示，不需要更高精度）。
 *
 * @param {number} numerator 分子
 * @param {number} denominator 分母
 * @param {number} [fallback=0] 兜底值
 * @returns {number}
 */
export function ratio(numerator, denominator, fallback = 0) {
  const d = Number(denominator);
  const n = Number(numerator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return fallback;
  return Math.round((n / d) * 10000) / 10000;
}

/* ------------------------------------------------------------------ */
/* 日期 / 月份工具（本地时间）                                          */
/* ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 判断是否为合法的 `YYYY-MM-DD` 且真实存在（拒绝 2026-02-30）。
 *
 * @param {string} text 候选字符串
 * @returns {boolean}
 */
export function isDateText(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [y, m, d] = text.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

/**
 * 判断是否为合法的 `YYYY-MM`。
 *
 * @param {string} text 候选字符串
 * @returns {boolean}
 */
export function isMonthText(text) {
  if (typeof text !== 'string') return false;
  const m = /^(\d{4})-(\d{2})$/.exec(text);
  if (!m) return false;
  const month = Number(m[2]);
  return month >= 1 && month <= 12;
}

/**
 * `YYYY-MM` → 该月天数。
 *
 * @param {number} year 年
 * @param {number} month 月（1-12）
 * @returns {number}
 */
export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * 取日期字符串的月份，或把 `Date`/时间戳按本地时间转成 `YYYY-MM`。
 *
 * @param {string|number|Date} date 日期
 * @returns {string} `YYYY-MM`；无法识别返回 `""`
 */
export function monthKey(date) {
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
  }
  if (typeof date === 'number' && Number.isFinite(date)) {
    return monthKey(new Date(date));
  }
  if (typeof date === 'string') {
    const m = /^(\d{4})[-/.](\d{1,2})/.exec(date.trim());
    if (m) return `${m[1]}-${pad2(Number(m[2]))}`;
  }
  return '';
}

/**
 * 取日期字符串的日部分，或把 `Date`/时间戳按本地时间转成 `YYYY-MM-DD` 的日期部分。
 *
 * @param {string|number|Date} date 日期
 * @returns {string} `YYYY-MM-DD`；无法识别返回 `""`
 */
export function dayKey(date) {
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }
  if (typeof date === 'number' && Number.isFinite(date)) return dayKey(new Date(date));
  if (typeof date === 'string') {
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(date.trim());
    if (m) return `${m[1]}-${pad2(Number(m[2]))}-${pad2(Number(m[3]))}`;
  }
  return '';
}

/**
 * 当前月份的 `YYYY-MM`（本地时间）。
 *
 * @param {number|Date} [now=Date.now()] 时间戳或 Date
 * @returns {string}
 */
export function currentMonth(now = Date.now()) {
  return monthKey(new Date(now));
}

/**
 * 月份加减。
 *
 * @param {string} month `YYYY-MM`
 * @param {number} delta 偏移月数（可负）
 * @returns {string} `YYYY-MM`
 */
export function shiftMonth(month, delta) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return currentMonth();
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + Number(delta || 0);
  const year = Math.floor(total / 12);
  const mm = (total % 12 + 12) % 12 + 1;
  return `${year}-${pad2(mm)}`;
}

/**
 * 返回最近 `n` 个月（以 `month` 结尾），升序。
 *
 * @param {string} month 结束月份 `YYYY-MM`
 * @param {number} [n=6] 月份数
 * @returns {string[]} 例如 `["2026-06", ..., "2026-11"]`
 */
export function monthRange(month, n = 6) {
  const count = Math.max(1, Math.floor(Number(n) || 1));
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) out.push(shiftMonth(month, -i));
  return out;
}

/**
 * 两个 `YYYY-MM-DD` 之间相差的天数（`to - from`，按本地日历日计算）。
 *
 * @param {string} from 起始日
 * @param {string} to 结束日
 * @returns {number} 天数；无法解析返回 0
 */
export function daysBetween(from, to) {
  const a = dayKey(from);
  const b = dayKey(to);
  if (!a || !b) return 0;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const start = Date.UTC(ay, am - 1, ad);
  const end = Date.UTC(by, bm - 1, bd);
  return Math.round((end - start) / 86400000);
}

/**
 * `month` 内的第 `day` 个（日历日），越界会钳到月末。
 *
 * @param {string} month `YYYY-MM`
 * @param {number} day 日（1-31）
 * @returns {string} `YYYY-MM-DD`
 */
export function dateInMonth(month, day) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) return dayKey(new Date());
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = clamp(day, 1, daysInMonth(y, mo));
  return `${m[1]}-${m[2]}-${pad2(d)}`;
}

/* ------------------------------------------------------------------ */
/* id 生成                                                            */
/* ------------------------------------------------------------------ */

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz0123456789';

/**
 * 生成形如 `txn_ab12cd3e` 的 id。
 *
 * @param {string} [prefix="id"] 前缀（txn/acc/ast/lia/hold/bud/goal/imp）
 * @param {() => number} [random=Math.random] 随机源（测试注入）
 * @returns {string}
 */
export function newId(prefix = 'id', random = Math.random) {
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    const r = clamp(random(), 0, 0.999999);
    out += ID_ALPHABET[Math.floor(r * ID_ALPHABET.length)];
  }
  return `${String(prefix || 'id').replace(/[^a-z0-9]+/gi, '') || 'id'}_${out}`;
}

/* ------------------------------------------------------------------ */
/* 文本归一化                                                          */
/* ------------------------------------------------------------------ */

/** 商户名里常见、但不影响识别的装饰性前缀（渠道前缀、支付通道）。 */
const MERCHANT_NOISE = [
  '支付宝-',
  '支付宝（',
  '支付宝(',
  '微信支付-',
  '财付通-',
  '财付通(',
  '转账-',
  '商户-',
  '(特约)',
  '（特约）',
];

/**
 * 归一化商户名，用于去重指纹与「用户修正记忆」的 key。
 *
 * 规则：全角转半角、去空白、去渠道前缀、去掉括号里的订单尾巴、小写。
 * 例：`"支付宝-星巴克(上海店)  "` → `"星巴克"`。
 *
 * @param {unknown} merchant 原始商户/摘要
 * @returns {string} 归一化结果（可能为空串）
 */
export function normalizeMerchant(merchant) {
  let text = String(merchant ?? '');
  if (!text) return '';
  // 全角 ASCII → 半角
  text = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/\u3000/g, ' ');
  text = text.toLowerCase().trim();
  for (const noise of MERCHANT_NOISE) {
    if (text.startsWith(noise.toLowerCase())) {
      text = text.slice(noise.length);
      break;
    }
  }
  text = text.replace(/\((?:特约|商户)?[^)]*\)/g, '');
  // 去掉所有空白与常见分隔标点
  text = text.replace(/[\s\-_·.,，。、:：;；!！#*'"“”‘’()\[\]{}<>《》/\\|+@=&?%^~`]+/g, '');
  return text;
}

/**
 * 去重指纹：`date|amount|direction|merchant`（商户归一化后）拼接。
 *
 * @param {{ date?: string, amount?: number, direction?: string, merchant?: string }} row 行
 * @returns {string}
 */
export function dedupeKeyOf(row = {}) {
  const date = dayKey(row.date) || String(row.date ?? '').trim();
  const amount = Math.abs(Math.round(Number(row.amount) || 0));
  const direction = row.direction === 'income' ? 'income' : 'expense';
  const merchant = normalizeMerchant(row.merchant);
  return `${date}|${amount}|${direction}|${merchant}`;
}

/**
 * 把任意输入转成安全的整数「分」（恒非负）。
 *
 * @param {unknown} value 输入
 * @param {number} [fallback=0] 兜底值
 * @returns {number}
 */
export function toCents(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(Math.round(value));
  const parsed = parseAmountToCents(value);
  return parsed === null ? Math.abs(Math.round(fallback)) : Math.abs(parsed);
}

/**
 * 判断值是否在允许集合里，否则返回 fallback。
 *
 * @template T
 * @param {unknown} value 值
 * @param {readonly T[]} allowed 允许集合
 * @param {T} fallback 兜底
 * @returns {T}
 */
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/** 默认设置。`demo` 为 true 表示账本里装的是开箱演示数据，用户还没换成自己的。 */
export const DEFAULT_SETTINGS = Object.freeze({ currency: 'CNY', emergencyMonths: 6, demo: false, demoOffered: false });

/**
 * 合并设置，补齐缺失字段并纠正非法值。
 *
 * @param {object} [patch] 传入的设置片段
 * @returns {{ currency: string, emergencyMonths: number, demo: boolean, demoOffered: boolean }}
 */
export function normalizeSettings(patch) {
  const merged = { ...DEFAULT_SETTINGS, ...(patch || {}) };
  const currency = typeof merged.currency === 'string' && merged.currency.trim()
    ? merged.currency.trim().toUpperCase().slice(0, 8)
    : DEFAULT_SETTINGS.currency;
  const months = clamp(merged.emergencyMonths, 1, 36);
  // `demo` 只认真正的 true：老账本没有这个字段时按「用户自己的数据」处理，
  // 绝不能因为缺字段就在别人的真实账本上标一个演示横幅。
  // `demoOffered` 记录「这份演示账本已经送过」，用户清空后不再自动复活。
  return {
    currency,
    emergencyMonths: Math.round(months),
    demo: merged.demo === true,
    demoOffered: merged.demoOffered === true || merged.demo === true,
  };
}