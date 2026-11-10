/**
 * lib/importer.js —— 账单解析器（零依赖）。
 *
 * 支持：支付宝 CSV（UTF-8 / GB18030）、微信支付 CSV、通用 CSV/TSV、
 * xlsx（自实现最小 ZIP + worksheet.xml + sharedStrings.xml）、
 * SpreadsheetML `.xml`。**绝不静默丢行**：解析不出金额/日期的行进入 `skipped`
 * 并附带人话 `warnings`。
 *
 * 契约（见 CONTRACT.md「导入契约」）：
 * `parseBill({ name, content }, { now })` →
 * `{ format, columns, rows, warnings, skipped }`
 *
 * @module dsh-finance/import
 */

import { inflateRawSync } from 'node:zlib';
import {
  dayKey,
  dedupeKeyOf,
  normalizeMerchant,
  parseAmountToCents,
} from './domain.js';
import { classifyRows, mapCategoryHint } from './classify.js';
import { judgeRows } from './flow.js';
import { channelFromPaymentMethod, channelHintOfMerchant } from './channel.js';

/** 列角色：解析时按角色取值，不依赖列的顺序。 */
const COLUMN_ROLES = Object.freeze([
  'date',
  'time',
  'merchant',
  'note',
  'amount',
  'expense',
  'income',
  'direction',
  'status',
  'account',
  'category',
  'order',
]);

/**
 * 表头别名 → 角色。键是**归一化**后的表头文本（见 {@link normalizeHeader}）。
 * @type {Readonly<Record<string, string>>}
 */
const HEADER_ALIASES = Object.freeze({
  // 日期
  交易时间: 'date',
  交易日期: 'date',
  交易创建时间: 'date',
  交易发生时间: 'date',
  支付时间: 'date',
  记账时间: 'date',
  记账日期: 'date',
  时间: 'date',
  日期: 'date',
  发生日期: 'date',
  入账日期: 'date',
  date: 'date',
  'trade date': 'date',
  'transaction date': 'date',
  transdate: 'date',
  // 时间（只有时分秒的那一列）
  时间点: 'time',
  // 商户
  交易对方: 'merchant',
  对方: 'merchant',
  商户: 'merchant',
  商户名称: 'merchant',
  对方户名: 'merchant',
  收款方: 'merchant',
  付款方: 'merchant',
  收付方: 'merchant',
  交易对手: 'merchant',
  商家: 'merchant',
  merchant: 'merchant',
  payee: 'merchant',
  // 摘要 / 备注
  商品说明: 'note',
  商品: 'note',
  商品名称: 'note',
  交易说明: 'note',
  说明: 'note',
  摘要: 'note',
  用途: 'note',
  交易类型: 'note',
  备注: 'note',
  附言: 'note',
  详情: 'note',
  订单备注: 'note',
  note: 'note',
  memo: 'note',
  description: 'note',
  remark: 'note',
  // 金额
  金额: 'amount',
  金额元: 'amount',
  交易金额: 'amount',
  金额人民币: 'amount',
  发生额: 'amount',
  交易额: 'amount',
  收支金额: 'amount',
  amount: 'amount',
  // 拆分金额
  支出: 'expense',
  支出金额: 'expense',
  借方发生额: 'expense',
  借方金额: 'expense',
  借: 'expense',
  付款金额: 'expense',
  debit: 'expense',
  收入: 'income',
  收入金额: 'income',
  贷方发生额: 'income',
  贷方金额: 'income',
  贷: 'income',
  收款金额: 'income',
  credit: 'income',
  // 方向（各家银行/支付渠道叫法差异很大，能认的都收进来）
  收支: 'direction',
  '收/支': 'direction',
  '收/付': 'direction',
  收支类型: 'direction',
  收支方向: 'direction',
  收支标志: 'direction',
  交易方向: 'direction',
  交易类型标志: 'direction',
  发生额方向: 'direction',
  资金方向: 'direction',
  资金流向: 'direction',
  借贷标志: 'direction',
  借贷: 'direction',
  借贷方向: 'direction',
  借贷类型: 'direction',
  '借/贷': 'direction',
  收付: 'direction',
  收付标志: 'direction',
  收付方向: 'direction',
  direction: 'direction',
  'income/expense': 'direction',
  'in/out': 'direction',
  // 状态
  当前状态: 'status',
  交易状态: 'status',
  状态: 'status',
  status: 'status',
  // 账户
  收付款方式: 'account',
  '收/付款方式': 'account',
  收付款方式说明: 'account',
  '收/付款方式说明': 'account',
  支付方式: 'account',
  账户: 'account',
  账号: 'account',
  卡号: 'account',
  银行卡: 'account',
  本方账号: 'account',
  交易卡号: 'account',
  account: 'account',
  // 分类
  交易分类: 'category',
  类别: 'category',
  分类: 'category',
  账单分类: 'category',
  category: 'category',
  // 订单号
  交易订单号: 'order',
  交易单号: 'order',
  商户单号: 'order',
  订单号: 'order',
});

/** 表头里的噪声字符（版本尾缀等）直接剥掉，便于识别。 */
const HEADER_NOISE = [
  '（元）',
  '(元)',
  '（人民币）',
  '(人民币)',
  '（含手续费）',
  '(含手续费)',
  '（不含手续费）',
  '[支出]',
  '[收入]',
  '[冻结金额]',
  '（分）',
  '(分)',
];

/**
 * 归一化表头：全角转半角、去空白与 BOM、剥掉单位括号、小写。
 *
 * @param {string} header 原始表头
 * @returns {string}
 */
export function normalizeHeader(header) {
  let text = String(header ?? '');
  text = text.replace(/^\uFEFF/, '');
  text = text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  text = text.replace(/\u3000/g, ' ').trim();
  for (const noise of HEADER_NOISE) {
    while (text.includes(noise)) text = text.split(noise).join('');
  }
  text = text.replace(/[\s"'`]/g, '');
  // 支付宝「收/支」「金额(元)」这类已由噪声表处理，这里再兜底去掉孤立的斜杠说明
  return text.toLowerCase();
}

/**
 * 把文件内容统一转成字符串：`Buffer/Uint8Array` 自动探测 UTF-8 / GB18030，
 * 已经是字符串的直接用（剥掉 BOM）。
 *
 * @param {string|Uint8Array|ArrayBuffer} content 文件内容
 * @returns {string}
 */
export function decodeText(content) {
  if (typeof content === 'string') return content.replace(/^\uFEFF/, '');
  if (content instanceof ArrayBuffer) content = new Uint8Array(content);
  if (content instanceof Uint8Array) {
    const buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const asUtf8 = buf.toString('utf8');
    if (!asUtf8.includes('\uFFFD')) return asUtf8.replace(/^\uFEFF/, '');
    try {
      return new TextDecoder('gb18030').decode(buf).replace(/^\uFEFF/, '');
    } catch {
      return asUtf8.replace(/^\uFEFF/, '');
    }
  }
  return String(content ?? '');
}

/**
 * RFC4180 风格的 CSV 解析：支持引号字段、字段内逗号/换行、`""` 转义、
 * CRLF/CR/LF 换行、BOM。
 *
 * @param {string} text 文本
 * @param {string} [delimiter] 分隔符；不传则自动探测
 * @returns {string[][]} 二维表（保留空行，由调用方决定是否跳过）
 */
export function parseDelimited(text, delimiter) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const delim = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      pushRow();
      i += src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // 文件末尾没有换行时补最后一行
  if (field !== '' || row.length > 0) pushRow();
  return rows;
}

/**
 * 自动探测分隔符：在候选（`\t` `,` `;` `|`）里选表头行命中数最多的。
 * @param {string} text 文本
 * @returns {string}
 */
export function detectDelimiter(text) {
  const head = String(text ?? '').split(/\r\n|\n|\r/).filter((line) => line.trim()).slice(0, 6);
  const candidates = ['\t', ',', ';', '|'];
  let best = ',';
  let bestScore = -1;
  for (const delim of candidates) {
    let score = 0;
    for (const line of head) {
      // 引号内的分隔符不该计数：粗略去掉引号段再数
      const stripped = line.replace(/"[^"]*"/g, '');
      score += stripped.split(delim).length - 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return bestScore <= 0 ? ',' : best;
}

/**
 * 把一行单元格识别成「列角色表」；命中角色少于 2 个则返回 null（不是表头行）。
 *
 * @param {string[]} cells 表头单元格
 * @returns {Record<string, number> | null} 角色 → 列下标
 */
function mapHeaderRole(cells) {
  const map = {};
  (cells || []).forEach((cell, index) => {
    const key = normalizeHeader(cell);
    if (!key) return;
    const role = HEADER_ALIASES[key];
    if (role && map[role] === undefined) map[role] = index;
  });
  // 「金额」与「支出/收入」拆分列同时出现时，优先用拆分列
  if (map.expense !== undefined && map.income !== undefined && map.amount !== undefined) {
    // 两种都存在：保留全部，方向判定时优先拆分列（见 rowFromRecord）
  }
  const hits = Object.keys(map).length;
  const hasMoney = map.amount !== undefined || map.expense !== undefined || map.income !== undefined;
  if (hits < 2 || !hasMoney) return null;
  return map;
}

/**
 * 在若干行里找表头行：前 40 行内第一个能被 {@link mapHeaderRole} 识别的行。
 *
 * @param {string[][]} table 二维表
 * @returns {{ headerIndex: number, roles: Record<string, number> } | null}
 */
function findHeader(table) {
  const limit = Math.min(table.length, 40);
  for (let i = 0; i < limit; i += 1) {
    const roles = mapHeaderRole(table[i]);
    if (roles) return { headerIndex: i, roles };
  }
  return null;
}

/**
 * 判断一行是否「近似空行」（全空或只有一个单元格）。
 * @param {string[]} cells 单元格
 * @returns {boolean}
 */
function isBlankRow(cells) {
  return !cells || cells.every((cell) => String(cell ?? '').trim() === '');
}

/**
 * 解析日期单元格：支持 `2026-11-03`、`2026/11/3`、`2026.11.03`、
 * `2026年11月3日`、`20261103`、Excel 序列号（如 `45900`）、带时分秒。
 *
 * @param {unknown} value 原始值
 * @param {number} [now] 当前时间戳（用于补年份）
 * @returns {string} `YYYY-MM-DD`；无法识别返回 `""`
 */
export function parseDateCell(value, now = Date.now()) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (!text) return '';
  // 标准可识别格式：直接交给 dayKey
  const direct = dayKey(text);
  if (direct) return direct;
  // 中文年月日
  const cn = /^(\d{4})年(\d{1,2})月(\d{1,2})日?/.exec(text);
  if (cn) return `${cn[1]}-${String(Number(cn[2])).padStart(2, '0')}-${String(Number(cn[3])).padStart(2, '0')}`;
  // 紧凑 8 位：20261103
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  // Excel 序列号（1900 日期系统；1 = 1900-01-01，序列号 60 是虚构的 1900-02-29）
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial > 20000 && serial < 80000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
  }
  // 只有月日（部分银行账单）：补今年的
  const md = /^(\d{1,2})[/\-.月](\d{1,2})日?$/.exec(text);
  if (md) {
    const year = new Date(now).getFullYear();
    return `${year}-${String(Number(md[1])).padStart(2, '0')}-${String(Number(md[2])).padStart(2, '0')}`;
  }
  return '';
}

/** 方向列文案 → 方向。 */
const DIRECTION_WORDS = Object.freeze({
  支出: 'expense',
  支: 'expense',
  付: 'expense',
  付款: 'expense',
  付出: 'expense',
  消费: 'expense',
  出: 'expense',
  转出: 'expense',
  借: 'expense',
  借出: 'expense',
  借方: 'expense',
  借项: 'expense',
  支出金额: 'expense',
  现金支出: 'expense',
  转账支出: 'expense',
  收入: 'income',
  收: 'income',
  进: 'income',
  收款: 'income',
  收进: 'income',
  进账: 'income',
  转入: 'income',
  贷: 'income',
  贷方: 'income',
  贷项: 'income',
  收入金额: 'income',
  现金收入: 'income',
  转账收入: 'income',
  '收入/存入': 'income',
  expense: 'expense',
  debit: 'expense',
  out: 'expense',
  outflow: 'expense',
  spend: 'expense',
  'payment': 'expense',
  income: 'income',
  credit: 'income',
  in: 'income',
  inflow: 'income',
  receipt: 'income',
});

/**
 * 解析方向列（`收/支`、`收支方向`、`借贷标志` 等）。
 *
 * 返回值约定：`expense` 支出 / `income` 收入 / `none` 不计收支（转账、理财申赎）/
 * `''` 认不出（调用方回退到金额正负号）。
 *
 * @param {unknown} value 原始文案
 * @returns {'expense'|'income'|'none'|''} 方向
 */
export function parseDirectionCell(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text) return '';
  if (text.includes('不计') || text === '其他' || text === '中性交易' || text === '不计入收支') return 'none';
  if (DIRECTION_WORDS[text]) return DIRECTION_WORDS[text];
  // 含「退」的多半是退款入账；含「收入」的优先按收入
  if (text.includes('收入') || text.includes('入账') || text.includes('存入')) return 'income';
  if (text.includes('退') && !text.includes('收入')) return 'expense';
  if (/^(支出|支|付|出)/.test(text)) return 'expense';
  if (/^(收入|收|进|贷)/.test(text)) return 'income';
  return '';
}

/** 状态文案里表示「钱没真的动」的标记（退款/关闭/失败/撤销）。 */
const VOID_STATUS_KEYWORDS = ['已关闭', '交易关闭', '支付失败', '已失败', '已撤销', '已取消', '退款成功', '全额退款', '已退款'];

/**
 * 判断状态列是否属于「不计入收支」。
 *
 * @param {unknown} value 状态文案
 * @returns {boolean}
 */
export function isVoidStatus(value) {
  const text = String(value ?? '');
  if (!text) return false;
  return VOID_STATUS_KEYWORDS.some((word) => text.includes(word));
}

/**
 * 由一行的「角色取值表」构造 RawRow。
 *
 * @param {Record<string, string>} rec 角色 → 原始文本
 * @param {{ now?: number, account?: string, source?: string }} [options]
 * @returns {{ row?: import('./importer.js').RawRow, reason?: string }}
 */
function rowFromRecord(rec, options = {}) {
  const now = options.now || Date.now();
  const date = parseDateCell(rec.date, now);
  if (!date) return { reason: `日期无法识别：${rec.date ? `「${rec.date}」` : '这一列为空'}` };

  // ── 金额 ───────────────────────────────────────────────────────────────
  // 三种列形态：
  //   a) 借/贷 两列（支出列、收入列各一）：哪列有非零值就是哪个方向；
  //   b) 单列金额 + 方向列；
  //   c) 单列金额，靠正负号表达方向。
  const expenseCents = rec.expense !== undefined && rec.expense !== '' ? parseAmountToCents(rec.expense) : null;
  const incomeCents = rec.income !== undefined && rec.income !== '' ? parseAmountToCents(rec.income) : null;

  let amount = null;
  let signedCents = null; // 带符号的分，用于「正负号」判定
  let amountText = '';
  // 金额来自哪一列推导：`expense`/`income` 表示借贷双列（列本身已经表达方向），
  // `null` 表示单列金额，需要靠方向列或正负号判断。
  let directionFromColumn = null;

  // 方向列：先记下来，稍后按优先级裁决
  const directionCell = parseDirectionCell(rec.direction);

  if (expenseCents !== null && expenseCents !== 0 && (incomeCents === null || incomeCents === 0)) {
    // a) 只有支出列有值
    amount = Math.abs(expenseCents);
    signedCents = -amount;
    amountText = rec.expense;
    directionFromColumn = 'expense';
  } else if (incomeCents !== null && incomeCents !== 0 && (expenseCents === null || expenseCents === 0)) {
    // a) 只有收入列有值
    amount = Math.abs(incomeCents);
    signedCents = amount;
    amountText = rec.income;
    directionFromColumn = 'income';
  } else {
    const rawAmount = rec.amount !== undefined ? rec.amount : (expenseCents !== null ? rec.expense : rec.income);
    amountText = rawAmount;
    const cents = parseAmountToCents(rawAmount);
    if (cents === null) {
      return { reason: `金额无法解析：${rawAmount !== undefined && rawAmount !== '' ? `「${rawAmount}」` : '这一列为空'}` };
    }
    signedCents = cents;
    amount = Math.abs(cents);
  }

  if (amount === null || !Number.isFinite(amount)) {
    return { reason: `金额无法解析：${amountText ? `「${amountText}」` : '这一列为空'}` };
  }
  if (amount === 0) return { reason: '金额为 0，跳过' };

  // ── 方向裁决（优先级从高到低）──────────────────────────────────────────
  // 1. 显式方向列：`收/支`、`收支方向`、`借贷标志` 等说了算。
  //    注意「不计收支」要单独处理（转账/理财申赎不算收支）。
  //    方向列说「支出」而金额带 `-` 时**不要双重取反**——只取绝对值，方向以方向列为准。
  // 2. 借贷双列（支出金额列 / 收入金额列）：有值的那一列直接表达方向。
  // 3. 金额正负号：`-` 是支出，`+` 是收入。
  // 4. 以上都没有 → 默认支出。
  const rawAmountText = String(amountText ?? '').trim();
  const hasPlusSign = rawAmountText.startsWith('+');

  let direction;
  if (directionCell === 'income' || directionCell === 'expense') {
    direction = directionCell; // 规则 1：方向列优先，忽略金额符号（避免双重取反）
  } else if (directionFromColumn !== null) {
    direction = directionFromColumn; // 规则 2：借贷双列，值所在列即方向
  } else if (signedCents < 0) {
    direction = 'expense'; // 规则 3：负号
  } else if (hasPlusSign) {
    direction = 'income'; // 规则 3：显式 `+`
  } else {
    direction = 'expense'; // 规则 4：默认支出
  }

  const merchant = String(rec.merchant ?? '').trim();
  const note = String(rec.note ?? '').trim();
  const status = String(rec.status ?? '').trim();
  if (status && isVoidStatus(status) && direction !== 'income') {
    return { reason: `交易状态为「${status}」，视为未实际发生` };
  }

  // 「不计收支」不再直接丢弃：这是一笔**真实的资金变动**（转账、理财申赎、
  // 提现），进库但标 `money: true` 不计入收支统计，用户仍能在流水里看到它。
  // 账本的完整性要求「凡发生过的都在」，至于算不算收支另说。
  const notCountable = directionCell === 'none';

  const row = {
    date,
    amount,
    direction,
    merchant: merchant || note || '未知商户',
    account: String(rec.account || options.account || '').trim(),
    note,
    raw: { ...rec },
  };
  // 原始账单里的时间戳带时分秒（如「2026-11-01 08:12:33」），
  // 跨账单识别同一笔消费时它是决定性证据，所以要单独留一份。
  const timeMatch = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(rec.date ?? '').trim());
  if (timeMatch) {
    row.time = `${String(Number(timeMatch[1])).padStart(2, '0')}:${timeMatch[2]}:${timeMatch[3] ?? '00'}`;
  }
  // 支付渠道：账单自带的「收/付款方式」列就是答案，认不出再从商户名里找线索
  const method = channelFromPaymentMethod(row.account);
  if (method.kind !== 'unknown') {
    row.channel = method.channel;
    row.channelKind = method.kind;
    row.channelLabel = method.label;
  } else {
    const hint = channelHintOfMerchant(row);
    row.channel = hint.label || String(row.account ?? '');
    row.channelKind = hint.kind;
    row.channelLabel = hint.label;
  }
  if (notCountable) {
    // 方向缺失时按金额符号猜一个，仅用于展示（不计收支不参与汇总）。
    row.direction = amount < 0 ? 'expense' : 'income';
    row.money = true;
    row.flow = { verdict: 'exclude', reason: 'transfer', detail: '账单标记为「不计收支」（转账/理财/提现）', matched: 'bill' };
  }
  const categoryHint = mapCategoryHint(rec.category, direction);
  if (categoryHint) row.categoryHint = categoryHint;
  row.dedupeKey = dedupeKeyOf(row);
  return { row };
}

/**
 * 把二维表解析成 RawRow 列表（CSV/TSV 与 xlsx 共用）。
 *
 * @param {string[][]} table 二维表（第一行起可能是说明文字）
 * @param {{ now?: number }} [options]
 * @returns {{ columns: Record<string,string>, rows: import('./importer.js').RawRow[], warnings: string[], skipped: number }}
 */
export function parseTable(table, options = {}) {
  const warnings = [];
  const rows = [];
  let skipped = 0;
  const header = findHeader(table);
  if (!header) {
    return {
      columns: {},
      rows: [],
      warnings: ['没有找到表头行：需要至少包含「日期」和「金额」两列。请检查文件是否为账单导出格式。'],
      skipped: 0,
    };
  }
  const { headerIndex, roles } = header;
  const headerCells = table[headerIndex].map((cell) => String(cell ?? '').trim());
  const columns = {};
  for (const [role, index] of Object.entries(roles)) {
    columns[role] = headerCells[index] ?? role;
  }
  if (headerIndex > 0) {
    warnings.push(`已跳过表头前的 ${headerIndex} 行说明文字。`);
  }

  for (let i = headerIndex + 1; i < table.length; i += 1) {
    const cells = table[i];
    if (isBlankRow(cells)) continue;
    const rec = {};
    for (const [role, index] of Object.entries(roles)) {
      rec[role] = cells[index] === undefined ? '' : String(cells[index]).trim();
    }
    const result = rowFromRecord(rec, options);
    if (result.row) {
      rows.push(result.row);
    } else {
      skipped += 1;
      if (warnings.length < 12) {
        warnings.push(`第 ${i + 1} 行未导入：${result.reason}`);
      }
    }
  }
  if (skipped > 0) {
    warnings.push(`共 ${skipped} 行未导入（金额/日期不可用或不计收支），其余 ${rows.length} 行已解析。`);
  }
  return { columns, rows, warnings, skipped };
}

/* ------------------------------------------------------------------ */
/* xlsx：最小 ZIP 读取（中央目录 + stored/deflate）                     */
/* ------------------------------------------------------------------ */

/**
 * 读取 ZIP 包内所有文件（只支持 stored(0) 与 deflate(8)，xlsx 只会用这两种）。
 *
 * @param {Buffer} buf 完整文件字节
 * @returns {Map<string, Buffer>} 文件名 → 内容
 */
export function readZip(buf) {
  const files = new Map();
  // 1) 找中央目录结束记录 EOCD（签名 0x06054b50），从尾部往前扫
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= scanFrom; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx 文件（找不到中央目录）');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    // 2) 读本地文件头，数据紧随其后
    if (buf.readUInt32LE(localOffset) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        files.set(name, Buffer.from(data));
      } else if (method === 8) {
        try {
          const inflated = inflateRawSync(data);
          files.set(name, Buffer.from(inflated));
        } catch {
          /* 单个条目损坏不影响其它条目 */
        }
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
    void uncompSize;
  }
  if (files.size === 0) throw new Error('不是有效的 zip/xlsx 文件（没能读出任何条目）');
  return files;
}

/**
 * 解 XML 实体。
 * @param {string} text XML 片段
 * @returns {string}
 */
function unescapeXml(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

/**
 * 解析 `xl/sharedStrings.xml` → 字符串数组。
 *
 * @param {string} xml 文件内容
 * @returns {string[]}
 */
export function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    // <si> 里可能有多段 <r><t>，全部拼接；忽略 <rPh> 注音
    const body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(body))) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

/**
 * 解析 worksheet XML → 二维单元格表（按 `r` 属性定位列，自动补空列）。
 *
 * @param {string} xml worksheet 内容
 * @param {string[]} shared sharedStrings
 * @returns {string[][]}
 */
export function parseSheetXml(xml, shared = []) {
  const table = [];
  if (!xml) return table;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowIndexAttr = /r="(\d+)"/.exec(rm[1]);
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let autoCol = 0;
    while ((cm = cellRe.exec(rm[2]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const refMatch = /r="([A-Z]+)(\d+)"/.exec(attrs);
      const colIndex = refMatch ? columnIndex(refMatch[1]) : autoCol;
      autoCol = colIndex + 1;
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : 'n';
      let value = '';
      if (type === 'inlineStr') {
        const isMatch = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = isMatch ? unescapeXml(isMatch[1]) : '';
      } else {
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vMatch ? unescapeXml(vMatch[1]) : '';
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'str' || type === 'e') value = raw;
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw;
      }
      cells[colIndex] = value;
    }
    const rowIndex = rowIndexAttr ? Number(rowIndexAttr[1]) - 1 : table.length;
    table[rowIndex] = Array.from(cells, (cell) => (cell === undefined ? '' : cell));
  }
  // 补齐稀疏数组
  return Array.from(table, (row) => (row === undefined ? [] : row));
}

/**
 * 列字母 → 0 基下标（`A` → 0，`AA` → 26）。
 * @param {string} letters 列字母
 * @returns {number}
 */
function columnIndex(letters) {
  let n = 0;
  for (const ch of String(letters || 'A')) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, n - 1);
}

/**
 * 解析 xlsx：找出第一个工作表（按 workbook.xml 顺序取 sheet1 或第一个 r:id 对应文件）。
 *
 * @param {Buffer} buf 文件字节
 * @returns {string[][]}
 */
export function readXlsxTable(buf) {
  const files = readZip(buf);
  const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = parseSharedStrings(sharedXml);

  // 优先 xl/worksheets/sheet1.xml；没有就取字典序第一个 sheet*.xml
  let sheetName = 'xl/worksheets/sheet1.xml';
  if (!files.has(sheetName)) {
    const candidates = [...files.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort();
    if (!candidates.length) throw new Error('xlsx 里没有找到工作表');
    sheetName = candidates[0];
  }
  const sheetXml = files.get(sheetName)?.toString('utf8') || '';
  return parseSheetXml(sheetXml, shared);
}

/**
 * 解析 SpreadsheetML（Excel 2003 `.xml`）→ 二维表。
 *
 * @param {string} xml 文本
 * @returns {string[][]}
 */
export function readSpreadsheetMlTable(xml) {
  const table = [];
  const rowRe = /<(?:\w+:)?Row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<(?:\w+:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Cell>)/g;
    let cm;
    let autoCol = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const indexMatch = /ss:Index="(\d+)"/.exec(attrs);
      const colIndex = indexMatch ? Number(indexMatch[1]) - 1 : autoCol;
      autoCol = colIndex + 1;
      const dataMatch = /<(?:\w+:)?Data\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Data>/.exec(inner);
      cells[colIndex] = dataMatch ? unescapeXml(dataMatch[1]).trim() : '';
    }
    table.push(Array.from(cells, (cell) => (cell === undefined ? '' : cell)));
    void rm;
  }
  return table;
}

/* ------------------------------------------------------------------ */
/* 格式探测                                                            */
/* ------------------------------------------------------------------ */

/**
 * 猜测账单格式。
 *
 * @param {string} name 文件名
 * @param {string|Uint8Array} content 内容
 * @returns {'xlsx'|'spreadsheetml'|'csv'|'tsv'}
 */
export function detectFormat(name, content) {
  const lower = String(name || '').toLowerCase();
  const isBytes = content instanceof Uint8Array || content instanceof ArrayBuffer;
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx';
  if (isBytes) {
    const head = Buffer.from(
      content instanceof ArrayBuffer ? new Uint8Array(content) : content,
    ).subarray(0, 4);
    if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return 'xlsx'; // PK\x03\x04
    if (lower.endsWith('.xml')) return 'spreadsheetml';
    return 'csv';
  }
  const text = String(content ?? '');
  if (lower.endsWith('.xml') || /Workbook[^>]*xmlns[^>]*urn:schemas-microsoft-com:office:spreadsheet/.test(text)) {
    return 'spreadsheetml';
  }
  if (lower.endsWith('.tsv')) return 'tsv';
  return 'csv';
}

/**
 * 依据内容特征猜出「账单来源」，用于返回更友好的 `format`。
 *
 * @param {string} text 解码后的文本（表格格式才有）
 * @param {string|Uint8Array} content 原始内容
 * @returns {'alipay-csv'|'wechat-csv'|'csv'|'tsv'|'xlsx'|'spreadsheetml'}
 */
function detectVendor(text) {
  const lower = String(text || '').slice(0, 4000);
  if (/支付宝|alipay/i.test(lower) && /交易时间/.test(lower)) return 'alipay-csv';
  if (/微信支付|wechat|wxpay/i.test(lower) && /交易时间/.test(lower)) return 'wechat-csv';
  if (/交易时间/.test(lower) && /商品说明/.test(lower)) return 'alipay-csv';
  if (/交易时间/.test(lower) && /当前状态/.test(lower)) return 'wechat-csv';
  return 'csv';
}

/* ------------------------------------------------------------------ */
/* 主入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 解析一份账单文件。
 *
 * @param {{ name: string, content: string|Uint8Array|ArrayBuffer }} file 文件（名 + 内容）
 *   `content` 为字符串时原样使用；为字节时自动按 UTF-8/GB18030 解码或按 xlsx 解包
 * @param {{ now?: number }} [options] `now` 用于补全缺年份的日期
 * @returns {{
 *   format: string,
 *   columns: Record<string,string>,
 *   rows: Array<{ date: string, amount: number, direction: 'expense'|'income',
 *                 merchant: string, account: string, note: string,
 *                 categoryHint?: string, dedupeKey: string, raw: Record<string,string> }>,
 *   warnings: string[],
 *   skipped: number,
 * }}
 */
export function parseBill(file, options = {}) {
  const opts = { now: options.now ?? Date.now() };
  const name = String(file?.name ?? '');
  const content = file?.content;
  const warnings = [];

  if (content === undefined || content === null || content === ('' )) {
    return { format: 'unknown', columns: {}, rows: [], warnings: ['文件内容为空，无法解析。'], skipped: 0 };
  }

  const kind = detectFormat(name, content);
  try {
    if (kind === 'xlsx') {
      const buf = Buffer.from(
        content instanceof ArrayBuffer ? new Uint8Array(content) : content instanceof Uint8Array ? content : Buffer.from(String(content), 'latin1'),
      );
      if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
        return {
          format: 'xlsx',
          columns: {},
          rows: [],
          warnings: [`「${name || '文件'}」不是有效的 xlsx（缺少 zip 文件头）。如果是老版 .xls，请先另存为 .xlsx 或导出 CSV。`],
          skipped: 0,
        };
      }
      const table = readXlsxTable(buf);
      const parsed = parseTable(table, opts);
      return { format: 'xlsx', ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }
    if (kind === 'spreadsheetml') {
      const text = decodeText(content);
      const table = readSpreadsheetMlTable(text);
      const parsed = parseTable(table, opts);
      return { format: 'spreadsheetml', ...parsed, warnings: [...warnings, ...parsed.warnings] };
    }

    const text = decodeText(content);
    if (!text.trim()) {
      return { format: 'csv', columns: {}, rows: [], warnings: ['文件是空的，没有可导入的行。'], skipped: 0 };
    }
    const delimiter = kind === 'tsv' ? '\t' : detectDelimiter(text);
    const table = parseDelimited(text, delimiter);
    const parsed = parseTable(table, opts);
    const vendor = delimiter === '\t' ? 'tsv' : detectVendor(text);
    return { format: vendor, ...parsed, warnings: [...warnings, ...parsed.warnings] };
  } catch (error) {
    return {
      format: kind,
      columns: {},
      rows: [],
      warnings: [`解析失败：${error && error.message ? error.message : String(error)}。可以试试导出成 CSV 再导入。`],
      skipped: 0,
    };
  }
}

/**
 * 便利函数：解析后顺便用关键词规则补分类（供 routes 的 `/import` 预览使用）。
 * 不改变 CONTRACT 里 `parseBill` 的签名，只是额外叠加一层。
 *
 * @param {{ name: string, content: string|Uint8Array }} file 文件
 * @param {{ now?: number, rules?: object }} [options]
 * @returns {ReturnType<typeof parseBill>}
 */
export function parseBillWithCategories(file, options = {}) {
  const result = parseBill(file, options);
  const rules = options.rules && typeof options.rules === 'object' ? options.rules : {};
  const rows = classifyRows(result.rows, rules);
  // 分类之后判收支口径：这笔钱是「花了」还是「只是换了个账户」。
  // 放在分类后是因为它不依赖分类结果，但两件都是「导入时该做完的判断」。
  judgeRows(rows, options.flow && typeof options.flow === 'object' ? options.flow : {});
  return { ...result, rows };
}

/**
 * 把一批 RawRow 转成可写库的流水候选（补 id/分类/去重键）。真实落库由 store 完成。
 *
 * @param {Array<object>} rows RawRow 列表
 * @param {{ importId?: string, source?: string }} [meta]
 * @returns {Array<object>}
 */
export function rowsToTxns(rows, meta = {}) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    date: dayKey(row.date),
    amount: Math.abs(Math.round(Number(row.amount) || 0)),
    direction: row.direction === 'income' ? 'income' : 'expense',
    category: row.category || '其他',
    purpose: row.purpose ?? '',
    account: String(row.account ?? ''),
    merchant: String(row.merchant ?? '').trim() || '未知商户',
    note: String(row.note ?? ''),
    source: meta.source || 'import',
    importId: meta.importId || '',
    dedupeKey: row.dedupeKey || dedupeKeyOf(row),
    ...(row.flow !== null && typeof row.flow === 'object' ? { flow: row.flow } : {}),
    money: Boolean(row.money),
  }));
}

/**
 * 统计一批 RawRow 的自动分类率（0-1）。
 * @param {Array<{ confidence?: string }>} rows 行
 * @returns {number}
 */
export function autoRate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 0;
  const hit = list.filter((row) => row.confidence === 'rule' || row.confidence === 'user').length;
  return Math.round((hit / list.length) * 10000) / 10000;
}

/** 便于测试与调用方复用：归一化商户（等价于 domain 里的同名函数）。 */
export { normalizeMerchant };