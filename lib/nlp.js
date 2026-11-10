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
  let total = 0;
  let section = 0;
  let current = 0;
  let wan = 0;
  for (const char of source) {
    if (char in DIGITS) {
      current = DIGITS[char];
      continue;
    }
    if (char in UNITS) {
      const unit = UNITS[char];
      // 「一万八」里的「八」在「万」之后没有单位，要按千位补
      if (current === 0 && unit === 10) current = 1;
      section += (current === 0 ? 1 : current) * unit;
      current = 0;
      continue;
    }
    if (char === '万') {
      wan = (section + current) * 10000;
      section = 0;
      current = 0;
      continue;
    }
    return null;
  }
  // 「一万八」：万之后只剩个位数 8，但它表示 8 千
  const tailValue = current > 0 && wan > 0 ? current * 1000 : current;
  const value = wan + section + tailValue;
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
 * 解析保单 / 存款 / 理财。
 *
 * @param {string} text 句子
 * @param {number|Date} now 当前时间
 * @returns {object|null} 保单结构，或 null
 */
export function parsePolicy(text, now = Date.now()) {
  const source = String(text ?? '').trim();
  if (source === '') return null;

  // 存款 / 理财 还是保险
  const isInsurance = /保险|保单|险|保费|保额|重疾|续保/u.test(source);
  const kind = isInsurance ? 'insurance' : (/定期|存款|存单/u.test(source) ? 'deposit' : 'wealth');

  // 险种
  let type = 'other';
  if (kind === 'insurance') {
    for (const [key, words] of INSURANCE_TYPE_WORDS) {
      if (words.some((word) => source.includes(word))) {
        type = key;
        break;
      }
    }
  }

  // 金额：区分「保额」与「保费」
  const amountMatch = /保额\s*([^，,。；;]+)/u.exec(source);
  const premiumMatch = /(?:保费|每年|每年交|年缴|每年缴|缴)\s*([^，,。；;]+)/u.exec(source);
  const amount = amountMatch !== null ? parseMoneyText(amountMatch[1]) : null;
  let premium = premiumMatch !== null ? parseMoneyText(premiumMatch[1]) : null;
  // 保险必须有钱：如果只认出一个数，按保费处理（保单最常说的是「每年多少钱」）
  if (kind === 'insurance' && premium === null && amount !== null && amountMatch !== null) {
    // 明确写了「保额」，那这笔就是保额，保费留空
    premium = null;
  } else if (kind !== 'insurance' && premium === null) {
    // 存款理财：那个数就是本金
    premium = null;
  }
  const principal = kind === 'insurance' ? (amount ?? 0) : (parseMoneyText(source) ?? 0);

  // 纯数字兜底：句子里只有一个金额时，保险按保费、存款按本金
  if (kind === 'insurance' && (amount ?? 0) === 0 && premium === null) {
    const anyMoney = parseMoneyText(source);
    if (anyMoney !== null) premium = anyMoney;
  }

  if ((principal ?? 0) === 0 && (premium ?? 0) === 0 && (amount ?? 0) === 0) return null;

  // 名称：去掉数字与虚词后剩下的描述性短语
  const name = cleanName(source);

  // 日期
  const dueDate = parseDateText(source, now);

  // 缴费周期：存款/理财是一次性存入，保险默认按年缴
  let payCycle = kind === 'insurance' ? 'yearly' : 'once';
  if (/每月|月缴|按月/u.test(source)) payCycle = 'monthly';
  else if (/每季|季缴|按季/u.test(source)) payCycle = 'quarterly';
  else if (/半年|半年缴/u.test(source)) payCycle = 'half_year';
  else if (/一次性|趸交|缴清/u.test(source)) payCycle = 'once';

  // 利率（万分比）
  // 「利率3.5」和「利率3.5%」都要认；没有 % 时按百分数理解（口语里几乎不省）
  const rateMatch = /(?:利率|年化|收益率?)\s*(\d+(?:\.\d+)?)\s*(?:%)?/u.exec(source);
  const rate = rateMatch !== null ? Math.round(Number(rateMatch[1]) * 100) : 0;

  // 期数（20年缴）
  const periodsMatch = /(\d+)\s*年\s*(?:缴|交)/u.exec(source);
  const totalPeriods = periodsMatch !== null ? Number(periodsMatch[1]) : 0;

  return {
    kind,
    name: name || (kind === 'insurance' ? '未命名保单' : '未命名存款'),
    issuer: '',
    type,
    amount: kind === 'insurance' ? (amount ?? 0) : principal,
    premium: kind === 'insurance' ? (premium ?? 0) : 0,
    rate,
    policyNo: '',
    payCycle,
    dueDate,
    maturityDate: '',
    paidPeriods: 0,
    totalPeriods,
    autoRenew: /自动续保/u.test(source),
    note: ''
  };
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