/**
 * lib/nlp.js —— 一句话录入：把中文自然语言解析成结构化记录。
 *
 * 记账工具最劝退的环节是**填表**：给一笔保单要选险种、填保额、填缴费周期、
 * 填续保日……十几项。但人说话时只讲关键信息：
 *
 *   「平安重疾险，每年4860，明年12月15号续保」
 *   「招行活期有18万5」
 *   「买了1000股招商银行，成本34块5，现在38」
 *   「存了10万三年定期，2027年3月到期，利率3.5」
 *
 * 本模块把这类句子解析成可以直接入库的结构，**认不出的字段就留空**，
 * 绝不瞎猜——猜错一个金额比少填一个字段更糟。
 *
 * 设计原则：
 *   1. **先认类型**（保单/资产/持仓/流水），类型错了后面全错；
 *   2. 金额支持「18万5」「1.8万」「4860」「10万」等中文口语写法；
 *   3. 日期支持「明年12月15」「2027年3月」「下个月」「12月15号」；
 *   4. 解析不确定时宁可只填认识的字段，其余交给用户改。
 *
 * @module dsh-finance/nlp
 */

import { dayKey, isDateText, monthKey, normalizeMerchant, parseAmountToCents } from './domain.js';

/** 可解析的记录类型。 */
export const INTENTS = Object.freeze(['txn', 'asset', 'holding', 'policy', 'unknown']);

/* ────────────────────────── 金额 ────────────────────────── */

/**
 * 解析中文口语金额，返回「分」。
 *
 * 支持：`18万` `18万5`（=18.5万）`1.8万` `10万` `4860` `34块5` `3.5%` 中的数字
 * `一万八`（=18000）`两千` 这类。**只认能确定的**，返回 null 表示没认出。
 *
 * @param {string} text 文本
 * @returns {number|null} 分，或 null
 */
export function parseMoneyText(text) {
  const source = String(text ?? '');
  if (source === '') return null;

  // 分三种写法依次尝试，避免一个巨型正则里组号互相干扰：
  //   A) `12万8` / `18万5` / `1.8万` / `10万` —— 万/千 为单位，尾数是千位/百位
  //   B) `34块5` / `34元5`                  —— 「块/元」后的尾数是角
  //   C) `4860` / `34.5`                    —— 纯数字，按元
  const unitMatch = /(\d+(?:\.\d+)?)\s*(万|千|k|w)\s*(\d)?/iu.exec(source);
  if (unitMatch !== null) {
    const base = Number(unitMatch[1]);
    const tail = unitMatch[3] === undefined ? null : Number(unitMatch[3]);
    const scale = /万|w/iu.test(unitMatch[2]) ? 10000 : 1000;
    const value = tail === null ? base : base + tail / 10;
    return Math.round(value * scale * 100);
  }
  const currencyMatch = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)\s*(\d)?/iu.exec(source);
  if (currencyMatch !== null) {
    const base = Number(currencyMatch[1]);
    const tail = currencyMatch[2] === undefined ? null : Number(currencyMatch[2]);
    return Math.round((tail === null ? base : base + tail / 10) * 100);
  }
  const plainMatch = /(\d+(?:\.\d+)?)/u.exec(source);
  if (plainMatch !== null) return Math.round(Number(plainMatch[1]) * 100);

  // 中文数字：一万八 / 两千 / 三万五千
  //
  // **必须要求上下文**：中文里「一」「两」这类字到处都是（「一份保险」
  // 「两个账户」），不能见到就当钱。只认两种情况：
  //   a) 整句就是这个数字（「一万八」）
  //   b) 数字后面紧跟货币/数量单位（「两千元」「三万五」）
  const cn = /([一二两三四五六七八九十百千万]+)/u.exec(source);
  if (cn !== null) {
    const trimmed = source.trim();
    const followedByUnit = /(?:元|块|块钱|万|千)/u.test(source.slice(cn.index + cn[1].length));
    const isWholeNumber = trimmed === cn[1] || trimmed === `${cn[1]}元` || trimmed === `${cn[1]}块`;
    if (followedByUnit || isWholeNumber) {
      const value = parseChineseNumber(cn[1]);
      if (value !== null && value > 0) return Math.round(value * 100);
    }
  }
  return null;
}

/**
 * 解析中文数字表达式（支持到「万」）。
 *
 * @param {string} text 例如「一万八」「两千」「三万五千」
 * @returns {number|null} 数值（元），或 null
 */
export function parseChineseNumber(text) {
  const source = String(text ?? '').trim();
  if (source === '') return null;
  const DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const UNITS = { 十: 10, 百: 100, 千: 1000 };
  /** 单位从大到小的位序，用来判断「末尾那个裸数字该落在哪一位」。 */
  const RANK = { 万: 4, 千: 3, 百: 2, 十: 1 };
  let total = 0;
  let section = 0;
  let current = 0;
  /** 上一个看到的单位有多「大」——末尾裸数字按它的下一级补。 */
  let lastRank = 0;
  /** 是否见过「零」——「一万零八」= 10008，「一万八」= 18000。 */
  let sawZero = false;

  for (const char of source) {
    if (char in DIGITS) {
      const digit = DIGITS[char];
      if (digit === 0) {
        sawZero = true;
        continue;
      }
      current = digit;
      continue;
    }
    if (char in UNITS) {
      const rank = RANK[char];
      section += (current === 0 ? 1 : current) * UNITS[char];
      current = 0;
      // 记「最后一个」单位而不是最大单位：「三万五千六」末尾的 6 要按千的下一级（百）算
      lastRank = rank;
      sawZero = false;
      continue;
    }
    if (char === '万') {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
      lastRank = 4;
      sawZero = false;
      continue;
    }
    return null;
  }

  // 末尾没有单位的裸数字（「一万八」「三万五千六」）：
  //   - 前面出现过「零」→ 它就是个位（一万零八 = 10008）
  //   - 否则按上一个单位的下一级补：万→千（一万八=18000）、千→百（三万五千六=35600）
  let tail = 0;
  if (current > 0) {
    if (sawZero) tail = current;
    else if (lastRank === 4) tail = current * 1000;
    else if (lastRank === 3) tail = current * 100;
    else if (lastRank === 2) tail = current * 10;
    else tail = current;
  }
  const value = total + section + tail;
  return value > 0 ? value : null;
}

/* ────────────────────────── 日期 ────────────────────────── */

/**
 * 解析口语日期，返回 `YYYY-MM-DD`。
 *
 * 支持：`明年12月15` `2027年3月` `12月15号` `下个月` `明年` `3年后`
 * 具体到日才算完整日期；只有年月时按该月 1 日。
 *
 * @param {string} text 文本
 * @param {number|Date} [now] 当前时间
 * @returns {string} `YYYY-MM-DD`，认不出返回 ''
 */
export function parseDateText(text, now = Date.now()) {
  const source = String(text ?? '');
  if (source === '') return '';
  const current = new Date(now);
  const year = current.getFullYear();
  const month = current.getMonth() + 1;

  // 已是标准格式
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/u.exec(source);
  if (iso !== null) {
    const text_ = `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(Number(iso[3])).padStart(2, '0')}`;
    return isDateText(text_) ? text_ : '';
  }

  // 完整年份：2027年3月15日 / 2027.3.15
  const full = /(\d{4})\s*[年.\-/]\s*(\d{1,2})(?:\s*[月.\-/]\s*(\d{1,2}))?/u.exec(source);
  if (full !== null) {
    const y = Number(full[1]);
    const m = Number(full[2]);
    const d = full[3] === undefined ? 1 : Number(full[3]);
    const value = `${String(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isDateText(value) ? value : '';
  }

  // 明年 / 后年 / 今年 + 月日
  let baseYear = year;
  if (/后年/u.test(source)) baseYear = year + 2;
  else if (/明年|次年/u.test(source)) baseYear = year + 1;

  // 「12月15」「12月15号」「12月」都要认；15 后面可以没有「日/号」
  const monthDay = /(\d{1,2})\s*月\s*(?:(\d{1,2})\s*[日号]?)?/u.exec(source);
  if (monthDay !== null) {
    const m = Number(monthDay[1]);
    const d = monthDay[2] === undefined ? 1 : Number(monthDay[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const value = `${String(baseYear)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return isDateText(value) ? value : '';
    }
  }

  // N 年后 / N 个月后
  const later = /(\d+)\s*年\s*后/u.exec(source);
  if (later !== null) return dayKey(new Date(year + Number(later[1]), current.getMonth(), current.getDate()));
  const monthsLater = /(\d+)\s*个?月\s*后/u.exec(source);
  if (monthsLater !== null) return dayKey(new Date(year, current.getMonth() + Number(monthsLater[1]), current.getDate()));

  // 只有年份
  if (/明年/u.test(source)) return `${String(year + 1)}-01-01`;
  const bareYear = /^(\d{4})\s*年?$/u.exec(source.trim());
  if (bareYear !== null) return `${bareYear[1]}-01-01`;

  return '';
}

/* ────────────────────────── 意图识别 ────────────────────────── */

/** 保单/存款/理财的信号词。 */
const POLICY_HINTS = [
  '保险', '保单', '险', '保费', '保额', '重疾', '医疗险', '意外险', '寿险', '年金', '车险', '财产险',
  '续保', '续费', '定期', '存款', '存单', '理财', '到期', '年化', '利率', '缴清'
];

/** 持仓的信号词。 */
const HOLDING_HINTS = ['股', '基金', 'etf', '持仓', '成本', '份额', '买入', '建仓', '债券'];

/** 资产的信号词。 */
const ASSET_HINTS = ['活期', '余额', '存款有', '房产', '房子', '车值', '公积金', '账户有', '现金有'];

/**
 * 判断一句话想录入什么。
 *
 * @param {string} text 文本
 * @returns {string} `txn` | `policy` | `holding` | `asset` | `unknown`
 */
export function detectIntent(text) {
  const source = String(text ?? '').toLowerCase();
  if (source.trim() === '') return 'unknown';
  // 保单优先：它和流水最容易混（「交保费 4860」是流水，但「重疾险保额50万」是保单）
  const policyScore = POLICY_HINTS.filter((hint) => source.includes(hint)).length;
  const holdingScore = HOLDING_HINTS.filter((hint) => source.includes(hint)).length;
  const assetScore = ASSET_HINTS.filter((hint) => source.includes(hint)).length;
  // 「买/交/付」+ 金额 = 一笔流水；没有这类动词、只描述持有时才是建档
  const isSpending = /(花了|付了|交了|交了保费|买了|消费|支出)/u.test(source);
  if (policyScore > 0) return isSpending && !/保额|续保|到期|年化|利率/u.test(source) ? 'txn' : 'policy';
  // 买股票/基金不是消费——钱从现金变成了投资品，属于**持仓**。
  // 只有当句子在描述一笔支付（「买了基金花了500」）时才走流水。
  if (holdingScore > 0) return /花了|支付|消费/u.test(source) ? 'txn' : 'holding';
  if (assetScore > 0 && !isSpending) return 'asset';
  return 'txn';
}

/* ────────────────────────── 解析器 ────────────────────────── */

/** 保单险种关键词。 */
const INSURANCE_TYPE_WORDS = [
  ['critical', ['重疾', '重疾险']],
  ['medical', ['医疗险', '百万医疗', '医疗']],
  ['accident', ['意外险', '意外']],
  ['life', ['寿险', '定期寿险', '终身寿']],
  ['annuity', ['年金', '养老金', '年金险']],
  ['car', ['车险', '交强险']],
  ['property', ['财产险', '家财险']]
];

/**
 * 从一段文本里挑金额，**排除日期、版本、期数、编号**。
 *
 * 保单句子里到处是数字：「12月15号」「2026版」「20年缴」「保单号P123」。
 * 把第一个数字当保费是最常见也最致命的错误——所以这里只接受满足以下之一的：
 *
 *   1. 带货币单位（元/块/块 钱/万/千）；
 *   2. 位于金额标签之后、且不是紧邻「月/日/年/版/号/期/岁」。
 *
 * @param {string} segment 待查找的片段
 * @returns {number|null} 分，找不到返回 null（**不是 0**）
 */
export function pickMoney(segment) {
  const source = String(segment ?? '');
  if (source.trim() === '') return null;
  // 明确带单位的，直接接受（18万5 / 4860元 / 一万八）
  const withUnit = pickMoneyWithUnit(source);
  if (withUnit !== null) return withUnit;
  // 裸数字：排除看起来像日期/版本/编号的
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)/gu)) {
    const value = match[1];
    const start = match.index ?? 0;
    const before = source.slice(Math.max(0, start - 3), start);
    const after = source.slice(start + value.length, start + value.length + 3);
    // 紧跟日期/版本/编号单位 → 不是钱
    if (/^\s*(月|日|号|年|版|期|岁|周|天)/u.test(after)) continue;
    if (/(第|共)\s*$/u.test(before)) continue;
    // 6 位以上且没有小数 → 更像保单号/电话
    if (/^\d{6,}$/u.test(value)) continue;
    // 纯年份（1900-2099）
    if (/^(19|20)\d{2}$/u.test(value)) continue;
    return Math.round(Number(value) * 100);
  }
  return null;
}

/**
 * 只认带货币单位的金额（元/块/万/千），中文大写也在这里处理。
 *
 * @param {string} source 文本
 * @returns {number|null} 分，或 null
 */
function pickMoneyWithUnit(source) {
  const unit = /(\d+(?:\.\d+)?)\s*(万|千|k|w)\s*(\d)?/iu.exec(source);
  if (unit !== null) {
    const base = Number(unit[1]);
    const tail = unit[3] === undefined ? null : Number(unit[3]);
    const scale = /万|w/iu.test(unit[2]) ? 10000 : 1000;
    return Math.round((tail === null ? base : base + tail / 10) * scale * 100);
  }
  const currency = /(\d+(?:\.\d+)?)\s*(?:元|块|块钱)\s*(\d)?/iu.exec(source);
  if (currency !== null) {
    const base = Number(currency[1]);
    const tail = currency[2] === undefined ? null : Number(currency[2]);
    return Math.round((tail === null ? base : base + tail / 10) * 100);
  }
  // 中文大写/小写数字，但必须带单位或整段就是这个数
  const cn = /([一二两三四五六七八九十百千万零]+)\s*(?:元|块)?/u.exec(source);
  if (cn !== null) {
    const value = parseChineseNumber(cn[1]);
    if (value !== null) {
      const rest = source.replace(cn[0], '').trim();
      // 后面还跟着别的数字（如「三份」）时要求带货币单位
      if (/元|块/u.test(cn[0]) || rest === '') return Math.round(value * 100);
    }
  }
  return null;
}

/**
 * 解析日期，**同时返回精度**。
 *
 * 「2027年3月」只知道到月，不能静默补成 3 月 1 日然后按天提醒——
 * 那会让用户收到一条基于猜测的提醒。精度不足时交给核对步骤确认。
 *
 * @param {string} text 文本
 * @param {number|Date} [now] 当前时间
 * @returns {{ date: string, precision: "day"|"month"|"year"|"none", source: string }}
 */
export function parseDateInfo(text, now = Date.now()) {
  const source = String(text ?? '');
  const current = new Date(now);
  const baseYear = current.getFullYear();
  const relative = /(后年|明年|次年|今年|下个月|本月)/u.exec(source);

  // 完整年月日
  const full = /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/u.exec(source);
  if (full !== null) {
    const value = ymd(Number(full[1]), Number(full[2]), Number(full[3]));
    return { date: value, precision: 'day', source: full[0] };
  }
  // 只有年月
  const monthOnly = /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*月?/u.exec(source);
  if (monthOnly !== null && !/日|号/u.test(source.slice(monthOnly.index + monthOnly[0].length, monthOnly.index + monthOnly[0].length + 2))) {
    const value = ymd(Number(monthOnly[1]), Number(monthOnly[2]), 1);
    return { date: value, precision: 'month', source: monthOnly[0].trim() };
  }
  // 明年/后年 + 月日
  let year = baseYear;
  if (/后年/u.test(source)) year = baseYear + 2;
  else if (/明年|次年/u.test(source)) year = baseYear + 1;
  // 下个月
  if (/下个月/u.test(source)) {
    const next = new Date(baseYear, current.getMonth() + 1, 1);
    return { date: ymd(next.getFullYear(), next.getMonth() + 1, 1), precision: 'month', source: '下个月' };
  }
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u.exec(source);
  if (monthDay !== null) {
    return { date: ymd(year, Number(monthDay[1]), Number(monthDay[2])), precision: 'day', source: monthDay[0] };
  }
  const monthBare = /(\d{1,2})\s*月(?:份)?/u.exec(source);
  if (monthBare !== null) {
    return { date: ymd(year, Number(monthBare[1]), 1), precision: 'month', source: monthBare[0] };
  }
  // N 年后 / N 个月后
  const yearsLater = /(\d+)\s*年\s*后/u.exec(source);
  if (yearsLater !== null) {
    return { date: ymd(baseYear + Number(yearsLater[1]), current.getMonth() + 1, current.getDate()), precision: 'day', source: yearsLater[0] };
  }
  const monthsLater = /(\d+)\s*个?月\s*后/u.exec(source);
  if (monthsLater !== null) {
    const next = new Date(baseYear, current.getMonth() + Number(monthsLater[1]), current.getDate());
    return { date: ymd(next.getFullYear(), next.getMonth() + 1, next.getDate()), precision: 'day', source: monthsLater[0] };
  }
  if (relative !== null) {
    return { date: ymd(year, 1, 1), precision: 'year', source: relative[0] };
  }
  return { date: '', precision: 'none', source: '' };
}

/** 拼 `YYYY-MM-DD`。 */
function ymd(year, month, day) {
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 从文本里切出「某个语义标签之后的一小段」。
 *
 * 金额必须按语义找：`每年4860` 是保费，`保额50万` 是保额。混在一起取第一个
 * 数字就会串位（「重疾险，每年4860保额50万」曾把 50 万当成保费）。
 *
 * @param {string} source 全文
 * @param {string[]} labels 标签（正则片段）
 * @returns {string} 标签后面的片段（到下一个标点/标签为止），没有返回 ''
 */
export function sliceAfter(source, labels) {
  const text = String(source ?? '');
  for (const label of labels) {
    const pattern = new RegExp(`(?:${label})\s*[:：]?\s*([^，,。；;\n]{1,24})`, 'u');
    const match = pattern.exec(text);
    if (match !== null) return match[1];
  }
  return '';
}

/** 在片段里判断是否有「否定」表达。 */
function isNegated(source, keyword) {
  const pattern = new RegExp(`(?:不|非|无|没有|未)\s*${keyword}`, 'u');
  return pattern.test(source);
}

/**
 * 解析保单草稿。
 *
 * 与旧版的根本区别：**认不出就留 `null`，并且允许整条没有任何金额**。
 * 用户说「百万医疗2026版」时确实还没提供保费，这该存成草稿让他补，
 * 而不是硬造一个 2026 元的保费、或者直接拒绝建档。
 *
 * 每个字段都带 `evidence`（来源片段 + 解析方式 + 是否待确认），
 * 核对界面据此把「猜的」和「确定的」分开显示。
 *
 * @param {string} text 句子
 * @param {number|Date} [now] 当前时间
 * @returns {object} 草稿（字段可能为 null）
 */
export function parsePolicyDraft(text, now = Date.now()) {
  const source = String(text ?? '').trim();
  if (source === '') return null;

  // ── 类型：保险 / 存款 / 理财 ──
  // 「续保」「投保」「保障」都指向保险——「不自动续保，每月300」里没有「保险」二字，
  // 但它显然是保单。
  const isInsurance = /保险|保单|保费|保额|险种|险|续保|投保|保障/u.test(source);
  const kind = isInsurance ? 'insurance' : (/定期|存款|存单/u.test(source) ? 'deposit' : 'wealth');

  // ── 金额：保费与保额各自在自己的区间里取 ──
  const premiumSegment = sliceAfter(source, [
    '年交保费', '年缴保费', '每期保费', '保险费', '保费',
    '每年交', '每年缴', '每年', '按年缴', '年交', '年缴',
    '每月交', '每月缴', '每月', '按月缴', '月交', '月缴',
    '每季交', '每季缴', '每季', '季交', '季缴',
    '趸交', '一次性缴'
  ]);
  const coverageSegment = sliceAfter(source, ['基本保险金额', '保险金额', '保额']);
  const principalSegment = sliceAfter(source, ['本金', '存款金额', '存入金额']);

  let premium = null;
  let coverage = null;
  if (kind === 'insurance') {
    // 保费片段可能越界到下一个语义（「每年4860保额50万」）；
    // 在「保额」处切开，取前半段而不是整段放弃——前半段正是保费。
    if (premiumSegment !== '') {
      const cut = premiumSegment.split(/保额|保险金额/u)[0];
      if (cut.trim() !== '') premium = pickMoney(cut);
    }
    if (coverageSegment !== '') coverage = pickMoney(coverageSegment);
  } else {
    coverage = principalSegment !== '' ? pickMoney(principalSegment) : null;
    // 存款理财：句子里带单位的那个数就是本金（不带单位时也接受，因为整句就是这笔钱）
    if (coverage === null) coverage = pickMoneyWithUnit(source);
  }

  // ── 缴费周期：没有明确表达就留 null，不默认年缴 ──
  let payCycle = null;
  if (/趸交|一次性|缴清/u.test(source)) payCycle = 'once';
  // 「2027年3月缴费」里的「月缴」不是月缴——前面是数字时不算
  else if (/每月|按月/u.test(source) || /(?<!\d)\s*月缴/u.test(source)) payCycle = 'monthly';
  else if (/每季|季缴|按季/u.test(source)) payCycle = 'quarterly';
  else if (/半年|半年缴/u.test(source)) payCycle = 'half_year';
  else if (/每年|年缴|按年/u.test(source)) payCycle = 'yearly';


  // ── 日期：按上下文拆成缴费日 / 到期日 / 生效日 ──
  const dates = splitDates(source, now);

  // ── 自动续保：要处理否定表达 ──
  let autoRenew = null;
  if (/(不自动续保|不续保|非自动续保|无自动续保)/u.test(source)) autoRenew = false;
  else if (/自动续保/u.test(source)) autoRenew = true;

  // ── 期数 ──
  const periods = /(\d{1,2})\s*年\s*(?:缴|交|缴费)/u.exec(source);
  const totalPeriods = periods === null ? null : Number(periods[1]);

  // ── 利率（存款理财）──
  const rateMatch = /(?:利率|年化|收益率?)\s*(\d+(?:\.\d+)?)\s*%?/u.exec(source);
  const rate = rateMatch === null ? null : Math.round(Number(rateMatch[1]) * 100);

  // ── 名称：保留原文，只去掉已识别的片段 ──
  const name = draftName(source);

  const evidence = {
    premium: premiumSegment === '' ? null : { source: premiumSegment, method: 'labeled' },
    coverage: coverageSegment === '' && principalSegment === '' ? null : { source: coverageSegment || principalSegment, method: 'labeled' },
    dueDate: dates.primary.source === '' ? null : { source: dates.primary.source, method: dates.primary.precision === 'day' ? 'exact' : 'coarse' }
  };

  const draft = {
    kind,
    name,
    issuer: '',
    type: kind === 'insurance' ? detectInsuranceType(source) : '',
    // null = 未知（不是 0）。0 只表示「已确认是零」
    amount: coverage,
    premium,
    rate,
    policyNo: '',
    payCycle,
    dueDate: dates.primary.date,
    dueDatePrecision: dates.primary.precision,
    maturityDate: dates.maturity.date,
    effectiveDate: dates.effective.date,
    paidPeriods: null,
    totalPeriods,
    autoRenew,
    evidence,
    // 草稿状态：有金额且日期明确才算能启用缴费计划
    draft: true,
    missing: []
  };
  if (draft.name === '') draft.name = '未命名保单';
  if (premium === null) draft.missing.push('premium');
  if (coverage === null) draft.missing.push('amount');
  if (dates.primary.date === '') draft.missing.push('dueDate');
  else if (dates.primary.precision !== 'day') draft.missing.push('dueDatePrecision');
  return draft;
}

/**
 * 从句子拆出三个日期：缴费/续保日、保障到期日、生效日。
 *
 * 一份合同上可能同时出现「生效日 2021-12-15」「保费应交日 每年12月15日」
 * 「保障至 2041-12-15」，只取第一个必然错。
 *
 * @param {string} source 全文
 * @param {number|Date} now 当前时间
 * @returns {{ primary: object, maturity: object, effective: object }}
 */
function splitDates(source, now) {
  const empty = { date: '', precision: 'none', source: '' };
  const text = String(source ?? '');

  /**
   * 收集文本里所有像日期的片段及其位置。
   *
   * 不能只取第一个：一份合同上常同时有「生效日」「应交日」「保障至」，
   * 取错了会把保障终止日记成下次缴费日。
   */
  const candidates = [];
  const patterns = [
    /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/gu,
    /(?:明年|后年|今年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu,
    /(?:每年|每年度的?)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu,
    /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*月/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const info = parseDateInfo(match[0], now);
      if (info.precision === 'none') continue;
      candidates.push({ ...info, index: match.index, length: match[0].length });
    }
  }
  // 同一位置可能被多个 pattern 命中，保留精度最高的那个
  const byIndex = new Map();
  for (const candidate of candidates) {
    const existing = byIndex.get(candidate.index);
    const rank = { day: 3, month: 2, year: 1, none: 0 };
    if (existing === undefined || rank[candidate.precision] > rank[existing.precision]) {
      byIndex.set(candidate.index, candidate);
    }
  }
  const list = [...byIndex.values()].sort((a, b) => a.index - b.index);
  if (list.length === 0) return { primary: empty, maturity: empty, effective: empty };

  /** 看日期前后 10 个字里的上下文词，决定它属于哪一类。 */
  const classify = (candidate) => {
    const around = text.slice(Math.max(0, candidate.index - 10), candidate.index + candidate.length + 6);
    if (/保障至|保障期至|满期|到期|终止|保至/u.test(around)) return 'maturity';
    if (/生效|承保日|起保/u.test(around)) return 'effective';
    if (/应缴|应交|缴费|续保|续期|缴付/u.test(around)) return 'primary';
    return '';
  };

  const buckets = { primary: [], maturity: [], effective: [] };
  const unclassified = [];
  for (const candidate of list) {
    const role = classify(candidate);
    if (role === '') unclassified.push(candidate);
    else buckets[role].push(candidate);
  }
  // 兜底：整句只有一个日期且没上下文时，就把它当主日期（用户说的就是它）
  if (buckets.primary.length === 0 && buckets.maturity.length === 0 && buckets.effective.length === 0 && unclassified.length === 1) {
    buckets.primary.push(unclassified[0]);
  }
  const take = (arr) => (arr.length === 0 ? empty : { date: arr[0].date, precision: arr[0].precision, source: arr[0].source });
  return { primary: take(buckets.primary), maturity: take(buckets.maturity), effective: take(buckets.effective) };
}

/** 从文本判断险种。 */
function detectInsuranceType(source) {
  if (/重疾|重大疾病/u.test(source)) return 'critical';
  if (/医疗/u.test(source)) return 'medical';
  if (/意外/u.test(source)) return 'accident';
  if (/寿险|身故/u.test(source)) return 'life';
  if (/年金|养老/u.test(source)) return 'pension';
  if (/车险|机动车/u.test(source)) return 'car';
  if (/财产|家财/u.test(source)) return 'property';
  return 'other';
}

/**
 * 草稿名称：保留原文的语义，只剥掉日期与金额这类已经单独存过的片段。
 *
 * 不做全局单字删除（旧版删「交/份/有」会把「平安福」这类产品名弄坏）。
 *
 * @param {string} text 原句
 * @returns {string} 名称
 */
export function draftName(text) {
  let name = String(text ?? '');
  // 去掉日期片段
  name = name.replace(/(?:\d{4}\s*[年.\-/]\s*)?\d{1,2}\s*月\s*(?:\d{1,2}\s*[日号])?/gu, ' ');
  name = name.replace(/\d{4}\s*[年.\-/]\s*\d{1,2}/gu, ' ');
  name = name.replace(/(?:明年|后年|今年|下个月|每年|本月)/gu, ' ');
  // 去掉带单位的金额
  name = name.replace(/\d+(?:\.\d+)?\s*(?:万|千)\s*\d?\s*(?:元|块)?/giu, ' ');
  name = name.replace(/\d+(?:\.\d+)?\s*(?:元|块|块钱)\s*\d?/giu, ' ');
  // 去掉字段标签（只删标签本身，不删内容里的字）
  name = name.replace(/(?:保额|保费|基本保险金额|保险金额|本金|年交|年缴|月缴|趸交|自动续保|不自动续保|续保|缴费|到期|生效|利率|年化|收益率|收益)/gu, ' ');
  // 动词前缀：「存了10万三年定期」→「三年定期」
  name = name.replace(/^(?:我)?(?:存了|买了|投了|有|给\S{1,6}买的)/u, ' ');
  // 去掉裸金额（「平安重疾险 4860」里的 4860），但保留年份与版本号
  name = name.replace(/\b\d+(?:\.\d+)?\b/gu, (value) => {
    if (/^(19|20)\d{2}$/u.test(value)) return value; // 年份/版本保留
    return ' ';
  });
  // 去掉标点与多余空格
  name = name.replace(/[，,。；;：:、]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return name.slice(0, 60);
}

/**
 * 解析持仓：`买了1000股招商银行，成本34块5，现在38`
 *
 * @param {string} text 句子
 * @param {number|Date} now 当前时间
 * @returns {object|null} 持仓结构，或 null
 */
export function parseHolding(text, now = Date.now()) {
  const source = String(text ?? '').trim();
  if (source === '') return null;

  // 份额：1000股 / 5000份
  const sharesMatch = /(\d+(?:\.\d+)?)\s*(?:股|份)/u.exec(source);
  const shares = sharesMatch !== null ? Number(sharesMatch[1]) : 0;
  if (!(shares > 0)) return null;

  // 成本价与现价
  const costMatch = /成本\s*(?:价)?\s*([^，,。；;]+)/u.exec(source);
  const priceMatch = /(?:现价|现在|市价|当前)\s*([^，,。；;]+)/u.exec(source);
  const costPrice = costMatch !== null ? (parseMoneyText(costMatch[1]) ?? 0) : 0;
  const price = priceMatch !== null ? (parseMoneyText(priceMatch[1]) ?? 0) : costPrice;

  // 类型
  let type = 'stock';
  if (/基金|etf/u.test(source.toLowerCase())) type = 'fund';
  else if (/债|国债/u.test(source)) type = 'bond';

  // 代码：6 位数字
  const codeMatch = /\b(\d{6})\b/u.exec(source);

  return {
    name: cleanName(source) || '未命名持仓',
    code: codeMatch !== null ? codeMatch[1] : '',
    type,
    shares,
    costPrice,
    price,
    note: ''
  };
}

/**
 * 解析资产：`招行活期有18万5` / `房子估值300万`
 *
 * @param {string} text 句子
 * @param {number|Date} now 当前时间
 * @returns {object|null} 资产结构，或 null
 */
export function parseAsset(text, now = Date.now()) {
  const source = String(text ?? '').trim();
  if (source === '') return null;
  const value = parseMoneyText(source);
  if (value === null || value <= 0) return null;

  let kind = 'cash';
  if (/房|房产|房子/u.test(source)) kind = 'property';
  else if (/基金|股票|理财|投资/u.test(source)) kind = 'investment';
  else if (/公积金/u.test(source)) kind = 'other';

  return {
    name: cleanName(source) || '未命名资产',
    kind,
    value,
    account: '',
    note: ''
  };
}

/**
 * 从一句话里提取「名称」：去掉金额、日期、虚词后剩下的描述性短语。
 *
 * @param {string} text 原句
 * @returns {string} 名称（可能为空）
 */
export function cleanName(text) {
  let name = String(text ?? '');
  // 先按标点切成片段，名称通常是第一个片段
  const head = name.split(/[，,。；;：:]/u)[0] ?? '';
  name = head;
  // 去掉金额（含单位与尾数）
  name = name.replace(/\d+(?:\.\d+)?\s*(?:万|千|k|w)\s*\d?/giu, ' ');
  name = name.replace(/\d+(?:\.\d+)?\s*(?:元|块|块钱)\s*\d?/giu, ' ');
  name = name.replace(/\d+(?:\.\d+)?\s*(?:%|元|块|万|千)?/giu, ' ');
  // 去掉日期
  name = name.replace(/(?:\d{4}\s*年\s*)?\d{1,2}\s*月\s*(?:\d{1,2}\s*[日号])?/gu, ' ');
  name = name.replace(/\d{4}\s*年/u, ' ');
  name = name.replace(/(?:明年|后年|今年|下个月|本月|到期|续保|之后)/gu, ' ');
  // 去掉字段标签
  name = name.replace(/(?:保额|保费|成本价|成本|现价|现在|市价|当前|利率|年化|收益率|收益|份额|股价|保额)/gu, ' ');
  // 去掉动词与虚词
  name = name.replace(/(?:买了|买入|存了|存|有|是|在|了|的|了|每年|每月|每季|半年|一次性|缴清|趸交|缴|交|股|份|元)/gu, ' ');
  return name.replace(/\s+/gu, ' ').trim().slice(0, 60);
}

/**
 * 兼容包装：旧调用点按「字段都有值」的对象用，这里把草稿的 null 归属整理好。
 *
 * 新代码应该用 `parsePolicyDraft`——它带 `evidence` / `missing` / `draft` 标记，
 * 核对界面靠这些把「认出的」和「要确认的」分开。
 *
 * @param {string} text 句子
 * @param {number|Date} [now] 当前时间
 * @returns {object|null} 草稿，空句子返回 null
 */
export function parsePolicy(text, now = Date.now()) {
  const draft = parsePolicyDraft(text, now);
  if (draft === null) return null;
  // 一个数字都认不出、也没有名称线索时不建档，避免入库一条完全空的记录
  const hasMoney = draft.premium !== null || draft.amount !== null;
  const hasName = draft.name !== '' && draft.name !== '未命名保单';
  const hasDate = draft.dueDate !== '';
  if (!hasMoney && !hasName && !hasDate) return null;
  return draft;
}

/**
 * 解析一句话，返回它对应的记录类型与结构化字段。
 *
 * @param {string} text 用户输入
 * @param {number|Date} [now] 当前时间
 * @returns {{ intent: string, value: object|null }} 解析结果
 */
export function parseSentence(text, now = Date.now()) {
  const intent = detectIntent(text);
  if (intent === 'policy') return { intent, value: parsePolicy(text, now) };
  if (intent === 'holding') return { intent, value: parseHolding(text, now) };
  if (intent === 'asset') return { intent, value: parseAsset(text, now) };
  return { intent, value: null };
}