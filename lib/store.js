/**
 * lib/store.js —— JSON 文件存储层。
 *
 * 特性：
 * - 默认落盘 `~/.dsh/dsh-finance/finance.json`，可用 `file` 覆盖；
 * - **原子写**（同目录临时文件 + `rename`），断电不会留半份 JSON；
 * - **串行写队列**：同一时刻只有一个写操作在跑，后到的排队；
 * - 坏文件自动备份成 `.corrupt-<ts>` 并从空库启动，原因记在 `describeStorage()`；
 * - 构造阶段**绝不抛异常**（磁盘不可写也只是降级为内存库并记一条说明）。
 *
 * 所有金额是「分」的整数，所有写操作都会返回最新快照对象（浅拷贝）。
 *
 * @module dsh-finance/store
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  ASSET_KINDS,
  CATEGORIES,
  DB_VERSION,
  DEFAULT_SETTINGS,
  HOLDING_TYPES,
  POLICY_KINDS,
  INSURANCE_TYPES,
  PAY_CYCLES,
  POLICY_STATUS,
  RELATIONS,
  TODO_STATUS,
  ATTACHMENT_KINDS,
  INCOME_CATEGORY,
  KIND_LABELS,
  LIABILITY_KINDS,
  PURPOSES,
  SOURCE_KINDS,
  clamp,
  currentMonth,
  dayKey,
  dateInMonth,
  dedupeKeyOf,
  daysBetween,
  emptyDb,
  isDateText,
  isMonthText,
  monthKey,
  newId,
  normalizeMerchant,
  normalizeSettings,
  oneOf,
  parseAmountToCents,
  shiftMonth,
} from './domain.js';
import { classify, suggestPurpose } from './classify.js';
import { isSamePurchase } from './channel.js';

/** 默认数据目录。 */
export function defaultDataDir() {
  return join(homedir(), '.dsh', 'dsh-finance');
}

/** 默认数据文件路径。 */
export function defaultDataFile() {
  return join(defaultDataDir(), 'finance.json');
}

/* ------------------------------------------------------------------ */
/* 数据校验 / 归一化                                                    */
/* ------------------------------------------------------------------ */

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 把「库里已有金额」统一成非负的分。
 *
 * 注意语义差异：库内/接口传的**数字一律视为分**（`1234` = 12.34 元）；
 * 只有字符串才按元解析（`"12.34"` = 1234 分），方便手工编辑 JSON 时写 `"12.34"`。
 * 负数一律取绝对值（金额字段恒为正，方向由 `direction` 表达）。
 *
 * @param {unknown} value 金额（分，或元字符串）
 * @param {number} [fallback=0] 兜底
 * @returns {number} 分
 */
export function centsOf(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(Math.round(value));
  const parsed = parseAmountToCents(value);
  return parsed === null ? Math.abs(Math.round(fallback)) : Math.abs(parsed);
}

/** 带符号的分（用于「金额是负=支出」这种外部输入）。 */
function signedCentsOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  const parsed = parseAmountToCents(value);
  return parsed === null ? null : parsed;
}

/**
 * 把任意值转成数组：数组原样（浅拷贝），对象转成 `Object.values`，其它 → `[]`。
 * @param {unknown} value 输入
 * @returns {object[]}
 */
function asList(value) {
  if (Array.isArray(value)) return value.filter((item) => isPlainObject(item));
  if (isPlainObject(value)) return Object.values(value).filter((item) => isPlainObject(item));
  return [];
}

/**
 * 推断账单行的方向：优先用显式 `direction`，否则按金额符号（负数=支出）。
 *
 * @param {{ direction?: string, amount?: unknown }} row 行
 * @returns {'expense'|'income'}
 */
function normalizeRowDirection(row) {
  if (row.direction === 'income' || row.direction === '收入') return 'income';
  if (row.direction === 'expense' || row.direction === '支出') return 'expense';
  const cents = signedCentsOf(row.amount);
  return cents !== null && cents > 0 ? 'income' : 'expense';
}

/**
 * 补齐并纠正一条流水。
 *
 * @param {object} input 原始流水（可缺字段）
 * @param {{ now: number, keepId?: boolean }} context 上下文
 * @returns {object} 规范化后的流水
 */
function normalizeTxn(input, context) {
  const now = context.now;
  const raw = isPlainObject(input) ? input : {};
  const direction = raw.direction === 'income' || raw.direction === '收入' ? 'income'
    : raw.direction === 'expense' || raw.direction === '支出' ? 'expense'
      : null;
  const signed = signedCentsOf(raw.amount) ?? 0;
  const finalDirection = direction || 'expense';
  const amount = Math.abs(signed);
  if (amount === 0) throw new Error('金额不能为 0，请填写正确的金额');

  // 没给日期 → 记今天；给了但认不出 → 报错（不要静默改成今天）
  const hasDate = raw.date !== undefined && raw.date !== null && String(raw.date).trim() !== '';
  const date = hasDate ? dayKey(raw.date) : dayKey(new Date(now));
  if (!isDateText(date)) throw new Error(`日期格式不对：「${raw.date}」，需要 YYYY-MM-DD`);

  const merchant = String(raw.merchant ?? '').trim().slice(0, 120);
  const note = String(raw.note ?? '').trim().slice(0, 500);
  const account = String(raw.account ?? '').trim().slice(0, 80);

  let category = CATEGORIES.includes(raw.category) ? raw.category : '';
  let purpose = PURPOSES.includes(raw.purpose) ? raw.purpose : '';
  let confidence = '';
  if (finalDirection === 'income') {
    category = INCOME_CATEGORY;
    purpose = '';
  }
  if (!category) {
    // 用用户修正记忆兜底（`rules` 由调用方传入 normalizeTxn 的上下文）
    const guessed = classify({ merchant, note, direction: finalDirection, amount }, context.rules || {});
    category = guessed.category;
    if (!purpose) purpose = guessed.purpose;
    if (guessed.confidence) confidence = guessed.confidence;
  }
  if (!purpose && finalDirection === 'expense') purpose = suggestPurpose(category);

  const id = context.keepId && typeof raw.id === 'string' && raw.id ? raw.id : newId('txn');
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const txn = {
    id,
    date,
    amount,
    direction: finalDirection,
    category,
    purpose,
    account,
    merchant: merchant || '未知商户',
    note,
    source: oneOf(raw.source, SOURCE_KINDS, 'manual'),
    importId: typeof raw.importId === 'string' ? raw.importId : '',
    // 注意：amount 是**分**，而 domain.dedupeKeyOf 的约定是「数字=元」，
    // 所以这里用已归一化的字段自己拼指纹，避免多乘一次 100。
    dedupeKey: typeof raw.dedupeKey === 'string' && raw.dedupeKey
      ? raw.dedupeKey
      : `${date}|${amount}|${finalDirection}|${normalizeMerchant(merchant)}`,
    money: raw.money === true,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
  const finalConfidence = raw.confidence ? String(raw.confidence) : confidence;
  if (finalConfidence) txn.confidence = finalConfidence;
  // 支付渠道与精确时间：跨账单识别「同一笔消费」要靠它们，
  // 不落盘的话重启后就没法再去重。
  if (typeof raw.channel === 'string' && raw.channel !== '') txn.channel = raw.channel;
  if (typeof raw.channelKind === 'string' && raw.channelKind !== '') txn.channelKind = raw.channelKind;
  if (typeof raw.channelLabel === 'string' && raw.channelLabel !== '') txn.channelLabel = raw.channelLabel;
  if (typeof raw.time === 'string' && /^\d{2}:\d{2}(:\d{2})?$/u.test(raw.time)) txn.time = raw.time;
  // 收支口径判定：记下「为什么不计收支」（或为什么需要用户确认），
  // 界面据此显示一句人话，而不是让用户猜自己那 2 万去哪了。
  if (raw.flow !== null && typeof raw.flow === 'object' && typeof raw.flow.verdict === 'string') {
    txn.flow = {
      verdict: ['count', 'exclude', 'review'].includes(raw.flow.verdict) ? raw.flow.verdict : 'count',
      reason: typeof raw.flow.reason === 'string' ? raw.flow.reason : '',
      detail: typeof raw.flow.detail === 'string' ? raw.flow.detail : '',
    };
  }
  return txn;
}

/** 规范化资产。 */
function normalizeAsset(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('资产名称不能为空');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('ast'),
    name,
    kind: oneOf(raw.kind, ASSET_KINDS, 'cash'),
    value: centsOf(raw.value),
    account: String(raw.account ?? '').trim().slice(0, 80),
    note: String(raw.note ?? '').trim().slice(0, 500),
    updatedAt: context.now,
  };
}

/** 规范化负债。 */
function normalizeLiability(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('负债名称不能为空');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('lia'),
    name,
    kind: oneOf(raw.kind, LIABILITY_KINDS, 'other'),
    balance: centsOf(raw.balance),
    monthlyPayment: centsOf(raw.monthlyPayment),
    dueDay: Math.round(clamp(raw.dueDay ?? 1, 1, 31)),
    note: String(raw.note ?? '').trim().slice(0, 500),
    updatedAt: context.now,
  };
}

/** 规范化持仓。 */
function normalizeHolding(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('持仓名称不能为空');
  const shares = Number(raw.shares);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('hold'),
    name,
    code: String(raw.code ?? '').trim().slice(0, 24),
    type: oneOf(raw.type, HOLDING_TYPES, 'fund'),
    shares: Number.isFinite(shares) && shares >= 0 ? Math.round(shares * 10000) / 10000 : 0,
    costPrice: centsOf(raw.costPrice),
    price: centsOf(raw.price),
    note: String(raw.note ?? '').trim().slice(0, 500),
    updatedAt: context.now,
  };
}

/**
 * 规范化保单 / 存款 / 理财。
 *
 * 三者共用一份模型：一笔钱 + 一个关键日期 + 一个周期。
 * 关键日期分两种语义：
 *   - 保险：`dueDate` 是**下次续保/缴费日**
 *   - 存款理财：`dueDate` 是**到期日**（到期要处理：取出或续投）
 * `maturityDate` 只在保险里有意义（保障终止/返本日），其他类型留空。
 */
function normalizePolicy(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? raw.productName ?? '').trim().slice(0, 120);
  if (!name) throw new Error('保单/存款名称不能为空');
  const kind = oneOf(raw.kind, POLICY_KINDS, 'insurance');

  /**
   * 保障责任：每条是一个独立承诺（住院医疗、身故、重疾…）。
   * `source` 记「这条来自合同哪一页/哪一款」，看懂卡片要能指回去。
   */
  const duties = asList(raw.duties).flatMap((item) => {
    if (!isPlainObject(item)) return [];
    const dutyName = String(item.name ?? '').trim().slice(0, 80);
    if (!dutyName) return [];
    return [{
      name: dutyName,
      amount: centsOf(item.amount ?? 0),
      deductible: centsOf(item.deductible ?? 0),
      waitingDays: Number.isFinite(Number(item.waitingDays)) ? Math.max(0, Math.round(Number(item.waitingDays))) : 0,
      limit: String(item.limit ?? '').trim().slice(0, 300),
      source: String(item.source ?? '').trim().slice(0, 120),
    }];
  });

  /** 责任免除：合同里「不赔」的情形，用户最容易忽略。 */
  const exclusions = asList(raw.exclusions).flatMap((item) => {
    const text = typeof item === 'string' ? item : String(isPlainObject(item) ? item.text ?? '' : '');
    const trimmed = text.trim().slice(0, 300);
    if (!trimmed) return [];
    const source = isPlainObject(item) ? String(item.source ?? '').trim().slice(0, 120) : '';
    return [{ text: trimmed, source }];
  });

  /** 关系人：投保人、被保人、受益人。被保人可能有多个（家庭单）。 */
  const insured = asNameList(raw.insured);
  const beneficiaries = asNameList(raw.beneficiaries);

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('pol'),
    kind,
    // ── 基础信息 ──
    name,
    issuer: String(raw.issuer ?? '').trim().slice(0, 120),
    type: kind === 'insurance' ? oneOf(raw.type, INSURANCE_TYPES, 'other') : '',
    policyNo: String(raw.policyNo ?? '').trim().slice(0, 60),
    // 归属哪个家庭成员（空表示「整个家庭」）
    memberId: String(raw.memberId ?? '').trim().slice(0, 40),
    // ── 关系人 ──
    holder: String(raw.holder ?? '').trim().slice(0, 60),
    insured,
    beneficiaries,
    // ── 金额与期限 ──
    // **null = 未知，0 = 已确认的零**。两者不能混：把未知写成 0 会让
    // 「待补充」的保单看起来「不用交钱」，是这个模块最容易出的数据错误。
    amount: centsOrNull(raw.amount ?? raw.sumInsured),
    premium: centsOrNull(raw.premium),
    rate: Number.isFinite(Number(raw.rate)) ? Math.round(clamp(Number(raw.rate), 0, 10000)) : null,
    // 缴费周期：null = 未知。默认成「年缴」会让一份月缴保单的提醒全错。
    payCycle: PAY_CYCLES.includes(raw.payCycle) ? raw.payCycle : null,
    // 缴费期限（年）：null = 未知；0 = 已确认趸交/不限
    payYears: optionalCount(raw.payYears),
    // 保障期限（年）：null = 未知；0 = 终身/不限
    coverageYears: optionalCount(raw.coverageYears),
    // ── 关键日期 ──
    effectiveDate: dayKey(raw.effectiveDate),
    dueDate: dayKey(raw.dueDate),
    maturityDate: dayKey(raw.maturityDate),
    // ── 状态 ──
    status: oneOf(raw.status, POLICY_STATUS, 'active'),
    // 自动续保：null = 未知（合同没写清），true/false = 已确认
    autoRenew: typeof raw.autoRenew === 'boolean' ? raw.autoRenew : null,
    // 期数：null = 未知（首次录入历史保单时默认未知，而不是 0 期）
    paidPeriods: optionalCount(raw.paidPeriods),
    totalPeriods: optionalCount(raw.totalPeriods),
    // ── 保障内容 ──
    duties,
    exclusions,
    /** 一句话说明这份保单是干什么的（可由 AI 生成或用户填写）。 */
    summary: String(raw.summary ?? '').trim().slice(0, 300),
    /** 草稿：还没核对完，需要用户补字段。 */
    draft: raw.draft === true,
    /** 还缺哪些关键字段（`premium` / `amount` / `dueDate` …）。 */
    missing: asNameList(raw.missing, 40),
    /** 理赔指引：入口、电话、材料清单。 */
    claimGuide: {
      channel: String(raw.claimGuide?.channel ?? '').trim().slice(0, 200),
      phone: String(raw.claimGuide?.phone ?? '').trim().slice(0, 60),
      documents: asNameList(raw.claimGuide?.documents, 120),
    },
    // ── 附件（主合同 / 批单 / 缴费凭证）──
    attachments: asList(raw.attachments).flatMap((item) => {
      if (!isPlainObject(item)) return [];
      const fileName = String(item.name ?? '').trim().slice(0, 160);
      if (!fileName) return [];
      return [{
        id: typeof item.id === 'string' && item.id ? item.id : newId('att'),
        name: fileName,
        kind: oneOf(item.kind, ATTACHMENT_KINDS, 'other'),
        at: Number.isFinite(item.at) ? item.at : context.now,
        // 识别出的原文留档，便于「点击字段查看合同原文」
        text: String(item.text ?? '').slice(0, 200000),
      }];
    }),
    note: String(raw.note ?? '').trim().slice(0, 500),
    updatedAt: context.now,
  };
}

/**
 * 计数归一：空值返回 null（未知），数字截断为非负整数。
 *
 * 注意不能直接 `Number(value)`：`Number(null) === 0`，会把「未知」悄悄变成 0。
 *
 * @param {unknown} value 输入
 * @returns {number|null} 非负整数，或 null
 */
export function optionalCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.round(number));
}

/**
 * 金额归一：数字按分，字符串按元；**空值返回 null 而不是 0**。
 *
 * 保单档案里「未知」和「零」是两件事：保费未知的保单不该显示成「年缴 0 元」。
 *
 * @param {unknown} value 输入
 * @returns {number|null} 分，未知为 null
 */
export function centsOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const cents = centsOf(value, null);
  return cents === null || Number.isNaN(cents) ? null : Math.abs(cents);
}

/**
 * 把字符串或对象数组归一成字符串列表。
 *
 * 注意不能用 `asList`：它只保留普通对象，`['我','老婆']` 会被整个过滤掉。
 * 关系人（被保人/受益人）在账单和 UI 里都可能是纯字符串，必须有这条路径。
 *
 * @param {unknown} value 输入
 * @param {number} [max=60] 每项最大长度
 * @returns {string[]} 去空、去重、截断后的字符串列表
 */
function asNameList(value, max = 60) {
  const raw = Array.isArray(value) ? value : isPlainObject(value) ? Object.values(value) : [];
  const out = [];
  for (const item of raw) {
    const text = typeof item === 'string' ? item : String(isPlainObject(item) ? item.name ?? '' : '');
    const trimmed = text.trim().slice(0, max);
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}


/** 规范化家庭成员。 */
function normalizeMember(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? '').trim().slice(0, 60);
  if (!name) throw new Error('成员姓名不能为空');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('mem'),
    name,
    relation: oneOf(raw.relation, RELATIONS, 'other'),
    note: String(raw.note ?? '').trim().slice(0, 200),
    updatedAt: context.now,
  };
}

/** 规范化缴费记录。 */
function normalizePayment(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const policyId = String(raw.policyId ?? '').trim();
  if (!policyId) throw new Error('缴费记录必须关联一份保单');
  const date = dayKey(raw.date);
  if (!date) throw new Error('缴费记录的日期不对');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('pay'),
    policyId,
    date,
    amount: centsOf(raw.amount ?? 0),
    note: String(raw.note ?? '').trim().slice(0, 200),
    createdAt: context.now,
  };
}

/** 规范化预算。 */
function normalizeBudget(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const month = raw.month === 'default' || isMonthText(raw.month)
    ? raw.month
    : (isMonthText(raw.month) ? raw.month : 'default');
  const category = CATEGORIES.includes(raw.category) && raw.category !== INCOME_CATEGORY
    ? raw.category
    : '';
  if (!category) throw new Error(`预算分类不对：「${raw.category}」，可选：${CATEGORIES.join('/')}`);
  const limit = centsOf(raw.limit);
  if (limit <= 0) throw new Error('预算金额必须大于 0');
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('bud'),
    month,
    category,
    limit,
    updatedAt: context.now,
  };
}

/** 规范化目标。 */
function normalizeGoal(input, context) {
  const raw = isPlainObject(input) ? input : {};
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw new Error('目标名称不能为空');
  const target = centsOf(raw.target);
  if (target <= 0) throw new Error('目标金额必须大于 0');
  const saved = centsOf(raw.saved);
  const deadlineRaw = dayKey(raw.deadline);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId('goal'),
    name,
    target,
    saved: Math.min(saved, target),
    deadline: deadlineRaw || '',
    note: String(raw.note ?? '').trim().slice(0, 500),
    updatedAt: context.now,
  };
}

/**
 * 把（可能来自旧版本 / 手工编辑的）整库数据规范化成当前结构；不会抛异常。
 *
 * @param {unknown} data 原始数据
 * @param {{ now?: number }} [options]
 * @returns {object} 规范化后的库
 */
export function normalizeDb(data, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const context = { now, keepId: true };
  const db = emptyDb();
  if (!isPlainObject(data)) return db;

  db.version = DB_VERSION;
  // 先解析 rules，再解析流水 —— 流水缺分类时可以直接套用用户记忆
  if (isPlainObject(data.rules)) {
    for (const [merchant, patch] of Object.entries(data.rules)) {
      const key = normalizeMerchant(merchant);
      if (!key || !isPlainObject(patch)) continue;
      const category = CATEGORIES.includes(patch.category) ? patch.category : '';
      const purpose = PURPOSES.includes(patch.purpose) ? patch.purpose : '';
      if (!category && !purpose) continue;
      db.rules[key] = {
        category: category || '其他',
        purpose: purpose || suggestPurpose(category || '其他'),
      };
    }
  }
  const txnContext = { ...context, rules: db.rules };
  db.txns = asList(data.txns).flatMap((item) => {
    try {
      return [normalizeTxn(item, txnContext)];
    } catch {
      return [];
    }
  });
  db.assets = asList(data.assets).flatMap((item) => {
    try {
      const asset = normalizeAsset(item, context);
      asset.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [asset];
    } catch {
      return [];
    }
  });
  db.liabilities = asList(data.liabilities).flatMap((item) => {
    try {
      const liability = normalizeLiability(item, context);
      liability.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [liability];
    } catch {
      return [];
    }
  });
  db.holdings = asList(data.holdings).flatMap((item) => {
    try {
      const holding = normalizeHolding(item, context);
      holding.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [holding];
    } catch {
      return [];
    }
  });
  db.members = asList(data.members).flatMap((item) => {
    try {
      const member = normalizeMember(item, context);
      member.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [member];
    } catch {
      return [];
    }
  });
  db.payments = asList(data.payments).flatMap((item) => {
    try {
      return [normalizePayment(item, context)];
    } catch {
      return [];
    }
  });
  // 待办的用户处理状态：`{ "pol_x:premium:2026-12-15": { status, snoozeUntil, doneAt } }`
  if (isPlainObject(data.todoState)) {
    for (const [key, value] of Object.entries(data.todoState)) {
      if (!isPlainObject(value)) continue;
      const status = oneOf(value.status, TODO_STATUS, 'pending');
      db.todoState[key] = {
        status,
        snoozeUntil: dayKey(value.snoozeUntil),
        doneAt: Number.isFinite(value.doneAt) ? value.doneAt : 0,
        note: String(value.note ?? '').trim().slice(0, 200),
      };
    }
  }
  db.policies = asList(data.policies).flatMap((item) => {
    try {
      const policy = normalizePolicy(item, context);
      policy.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [policy];
    } catch {
      return [];
    }
  });
  db.budgets = asList(data.budgets).flatMap((item) => {
    try {
      const budget = normalizeBudget(item, context);
      budget.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [budget];
    } catch {
      return [];
    }
  });
  db.goals = asList(data.goals).flatMap((item) => {
    try {
      const goal = normalizeGoal(item, context);
      goal.updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt : now;
      return [goal];
    } catch {
      return [];
    }
  });
  // imports
  db.imports = asList(data.imports).map((item) => ({
    id: typeof item.id === 'string' && item.id ? item.id : newId('imp'),
    at: Number.isFinite(item.at) ? item.at : now,
    file: String(item.file ?? ''),
    format: String(item.format ?? 'csv'),
    rows: Math.round(Number(item.rows) || 0),
    added: Math.round(Number(item.added) || 0),
    dup: Math.round(Number(item.dup) || 0),
  }));
  db.settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(isPlainObject(data.settings) ? data.settings : {}) });
  return db;
}

/* ------------------------------------------------------------------ */
/* 工厂                                                               */
/* ------------------------------------------------------------------ */

/**
 * 创建存储实例。构造函数永远不会抛异常。
 *
 * @param {{ file?: string, log?: (event: { level: string, message: string }) => void }} [options]
 *   `file` 覆盖数据文件路径；`log` 接收诊断事件
 * @returns {object} store 实例（见模块文档里的方法清单）
 */
export function createStore(options = {}) {
  const file = options.file ? String(options.file) : defaultDataFile();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const notes = []; // describeStorage() 的补充说明

  let db = emptyDb();
  let loaded = false;
  let readyPromise = null;
  let corruptBackup = '';
  let writeError = '';
  let queue = Promise.resolve();
  let writes = 0;

  const note = (message) => {
    notes.push(message);
    log({ level: 'warn', message });
  };

  const dir = dirname(file);

  /** 读盘 → 内存；任何异常都降级。 */
  function loadSync() {
    if (loaded) return;
    loaded = true;
    try {
      if (!existsSync(file)) {
        db = emptyDb();
        return;
      }
      const text = readFileSync(file, 'utf8');
      if (!text.trim()) {
        db = emptyDb();
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`);
      }
      db = normalizeDb(parsed, { now: Date.now() });
    } catch (error) {
      // 坏文件 → 备份后从空库开始
      try {
        const backup = `${file}.corrupt-${Date.now()}`;
        renameSync(file, backup);
        corruptBackup = backup;
        note(`数据文件损坏（${error.message}），已备份为 ${basename(backup)}，本次从空库开始。`);
      } catch (backupError) {
        note(`数据文件损坏（${error.message}），备份也失败了（${backupError.message}），本次从空库开始。`);
      }
      db = emptyDb();
    }
  }

  /** 原子写盘：tmp + rename。 */
  function persist() {
    writes += 1;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${basename(file)}.${process.pid}.${writes}.tmp`);
      writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
      writeError = '';
    } catch (error) {
      writeError = error && error.message ? error.message : String(error);
      note(`写入失败，本次修改只存在内存中：${writeError}`);
      throw new Error(`保存失败：${writeError}`);
    }
  }

  /** 串行执行写操作：排队 + 读盘 + 变更 + 落盘 + 返回快照引用。 */
  function enqueue(work) {
    const run = async () => {
      await ready();
      const result = work();
      return result;
    };
    const next = queue.then(run, run);
    // 队列本身不能因为单次失败而断掉
    queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 内存快照（深拷贝；Host 侧会用 `structuredClone`）。 */
  function snapshot() {
    loadSync();
    const clone = typeof structuredClone === 'function'
      ? structuredClone
      : (value) => JSON.parse(JSON.stringify(value));
    return {
      ...clone(db),
      _stats: {
        txns: db.txns.length,
        assets: db.assets.length,
        liabilities: db.liabilities.length,
        holdings: db.holdings.length,
        budgets: db.budgets.length,
        goals: db.goals.length,
        imports: db.imports.length,
      },
    };
  }

  /** 等数据加载完成（只做一次）。 */
  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        loadSync();
      })();
    }
    await readyPromise;
    return true;
  }

  /** 存储状态说明（用于 UI / 诊断）。 */
  function describeStorage() {
    loadSync();
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    return {
      file,
      dir,
      exists: existsSync(file),
      size,
      loaded,
      txns: db.txns.length,
      writes,
      corruptBackup,
      writeError,
      notes: [...notes],
      persist: 'atomic-tmp-rename',
    };
  }

  /** 数据文件路径。 */
  function path() {
    return file;
  }

  /** 当前内存库（浅拷贝，只读用途；改它不会落盘）。 */
  function getDb() {
    loadSync();
    return {
      ...db,
      txns: [...db.txns],
      assets: [...db.assets],
      liabilities: [...db.liabilities],
      holdings: [...db.holdings],
      budgets: [...db.budgets],
      goals: [...db.goals],
      imports: [...db.imports],
      rules: { ...db.rules },
      settings: { ...db.settings },
    };
  }

  /* ---------------- 流水 ---------------- */

  /**
   * 查询流水。
   * @param {{ month?: string, from?: string, to?: string, category?: string, direction?: string,
   *           q?: string, limit?: number, offset?: number, money?: boolean }} [filter]
   * @returns {{ txns: object[], total: number }} `total` 是过滤后总数（不受 limit 影响）
   */
  function listTxns(filter = {}) {
    loadSync();
    const list = filterTxns(db.txns, filter);
    const offset = Math.max(0, Math.round(Number(filter.offset) || 0));
    const limit = Number(filter.limit) > 0 ? Math.round(Number(filter.limit)) : list.length;
    return { txns: list.slice(offset, offset + limit), total: list.length };
  }

  /** 按条件筛流水（纯函数，读写共用）。 */
  function filterTxns(all, filter = {}) {
    const month = isMonthText(filter.month) ? filter.month : '';
    const from = dayKey(filter.from);
    const to = dayKey(filter.to);
    const category = filter.category ? String(filter.category) : '';
    const q = String(filter.q ?? '').trim().toLowerCase();
    const direction = filter.direction === 'income' || filter.direction === 'expense' ? filter.direction : '';
    const wantMoney = typeof filter.money === 'boolean' ? filter.money : null;
    const list = all.filter((txn) => {
      if (month && monthKey(txn.date) !== month) return false;
      if (from && txn.date < from) return false;
      if (to && txn.date > to) return false;
      if (category && txn.category !== category) return false;
      if (direction && txn.direction !== direction) return false;
      if (wantMoney !== null && Boolean(txn.money) !== wantMoney) return false;
      if (q) {
        const hay = `${txn.merchant} ${txn.note} ${txn.account} ${txn.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return list.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1));
  }

  /** 新记一笔账。 */
  async function addTxn(input) {
    return enqueue(() => {
      const txn = normalizeTxn(input, { now: Date.now(), rules: db.rules });
      if (db.txns.some((item) => item.dedupeKey === txn.dedupeKey) && input.allowDuplicate !== true) {
        throw new Error('这笔账和已有记录重复（同日期/金额/商户/方向）。如果确实要记两笔，请传 allowDuplicate: true');
      }
      db.txns.push(txn);
      persist();
      return { txn, snapshot: snapshot() };
    });
  }

  /**
   * 修改一笔账。改了 `category`/`purpose` 时会把「用户修正」写进 `rules`。
   */
  async function updateTxn(id, patch = {}) {
    return enqueue(() => {
      const index = db.txns.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这笔账：${id}`);
      const before = db.txns[index];
      const merged = normalizeTxn({ ...before, ...patch, id: before.id, createdAt: before.createdAt }, { now: Date.now(), keepId: true, rules: db.rules });
      merged.updatedAt = Date.now();
      // 修正记忆
      const categoryChanged = patch.category !== undefined && patch.category !== before.category;
      const purposeChanged = patch.purpose !== undefined && patch.purpose !== before.purpose;
      if ((categoryChanged || purposeChanged) && merged.direction === 'expense') {
        const key = normalizeMerchant(merged.merchant);
        if (key) {
          db.rules[key] = { category: merged.category, purpose: merged.purpose || suggestPurpose(merged.category) };
        }
      }
      db.txns[index] = merged;
      persist();
      return { txn: merged, snapshot: snapshot() };
    });
  }

  /** 删除一笔账。 */
  async function removeTxn(id) {
    return enqueue(() => {
      const index = db.txns.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这笔账：${id}`);
      const [removed] = db.txns.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /**
   * 导入一批账单行（RawRow 或已分类行）。
   * 按 `dedupeKey` 去重：库里已有、或同批次内重复的都计入 `duplicates`。
   *
   * @param {{ name?: string, rows: object[], format?: string }} payload
   * @returns {Promise<{ added: number, duplicates: number, importId: string, txns: object[] }>}
   */
  async function importRows(payload = {}) {
    return enqueue(() => {
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      if (!rows.length) throw new Error('没有可导入的行');
      // 跨账单匹配允许的时间误差：消费时间与对方入账时间差几分钟是常态。
      const matchWindowMs = Number.isFinite(payload.matchWindowMs) ? payload.matchWindowMs : 3 * 60 * 1000;
      const now = Date.now();
      const importId = newId('imp');
      const existing = new Set(db.txns.map((item) => item.dedupeKey));
      const added = [];
      let duplicates = 0;
      let invalid = 0;
      /** 被合并掉的记录（保留来源可追溯，不静默丢弃）。 */
      const collapsed = [];
      for (const row of rows) {
        let txn;
        try {
          txn = normalizeTxn(
            {
              ...row,
              source: row.source || 'import',
              importId,
              date: dayKey(row.date),
              amount: row.amount,
              direction: normalizeRowDirection(row),
            },
            { now, rules: db.rules },
          );
        } catch {
          invalid += 1;
          continue;
        }
        // 第一道：完全相同的指纹（同一天同金额同商户同方向）直接判重。
        if (existing.has(txn.dedupeKey)) {
          duplicates += 1;
          continue;
        }
        // 第二道：跨账单的「同一笔消费」。同一杯咖啡可能同时出现在支付宝、
        // 信用卡、储蓄卡账单里，只保留最源头（渠道优先级最高）的那条。
        const twin = db.txns.find((item) => isSamePurchase(txn, item, { windowMs: matchWindowMs }));
        if (twin !== undefined) {
          duplicates += 1;
          collapsed.push({ droppedId: txn.id ?? '', keptBy: twin.id, merchant: txn.merchant, amount: txn.amount, date: txn.date });
          continue;
        }
        existing.add(txn.dedupeKey);
        db.txns.push(txn);
        added.push(txn);
      }
      db.imports.unshift({
        id: importId,
        at: now,
        file: String(payload.name ?? ''),
        format: String(payload.format ?? 'csv'),
        rows: rows.length,
        added: added.length,
        dup: duplicates,
      });
      db.imports = db.imports.slice(0, 100);
      persist();
      const message = invalid > 0 ? `另有 ${invalid} 行数据不完整，已跳过` : '';
      return {
        added: added.length,
        duplicates,
        collapsed,
        importId,
        invalid,
        message,
        txns: added,
        snapshot: snapshot(),
      };
    });
  }

  /* ---------------- 资产 ---------------- */

  function listAssets() {
    loadSync();
    return [...db.assets].sort((a, b) => b.value - a.value);
  }

  async function addAsset(input) {
    return enqueue(() => {
      const asset = normalizeAsset(input, { now: Date.now() });
      if (db.assets.some((item) => item.name === asset.name && item.kind === asset.kind)) {
        throw new Error(`已经有同名同类型的资产「${asset.name}」了，请直接改金额`);
      }
      db.assets.push(asset);
      persist();
      return { asset, snapshot: snapshot() };
    });
  }

  async function updateAsset(id, patch = {}) {
    return enqueue(() => {
      const index = db.assets.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项资产：${id}`);
      const asset = normalizeAsset({ ...db.assets[index], ...patch, id }, { now: Date.now() });
      db.assets[index] = asset;
      persist();
      return { asset, snapshot: snapshot() };
    });
  }

  async function removeAsset(id) {
    return enqueue(() => {
      const index = db.assets.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项资产：${id}`);
      const [removed] = db.assets.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /* ---------------- 负债 ---------------- */

  function listLiabilities() {
    loadSync();
    return [...db.liabilities].sort((a, b) => b.balance - a.balance);
  }

  async function addLiability(input) {
    return enqueue(() => {
      const liability = normalizeLiability(input, { now: Date.now() });
      db.liabilities.push(liability);
      persist();
      return { liability, snapshot: snapshot() };
    });
  }

  async function updateLiability(id, patch = {}) {
    return enqueue(() => {
      const index = db.liabilities.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项负债：${id}`);
      const liability = normalizeLiability({ ...db.liabilities[index], ...patch, id }, { now: Date.now() });
      db.liabilities[index] = liability;
      persist();
      return { liability, snapshot: snapshot() };
    });
  }

  async function removeLiability(id) {
    return enqueue(() => {
      const index = db.liabilities.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项负债：${id}`);
      const [removed] = db.liabilities.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /* ---------------- 持仓 ---------------- */

  // ── 家庭成员 ────────────────────────────────────────────────────────
  function listMembers() {
    loadSync();
    return [...db.members];
  }

  async function addMember(input) {
    return enqueue(() => {
      const member = normalizeMember(input, { now: Date.now() });
      db.members.push(member);
      persist();
      return { member, snapshot: snapshot() };
    });
  }

  async function updateMember(id, patch = {}) {
    return enqueue(() => {
      const index = db.members.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这个家庭成员：${id}`);
      const member = normalizeMember({ ...db.members[index], ...patch, id }, { now: Date.now() });
      db.members[index] = member;
      persist();
      return { member, snapshot: snapshot() };
    });
  }

  async function removeMember(id) {
    return enqueue(() => {
      const index = db.members.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这个家庭成员：${id}`);
      const [removed] = db.members.splice(index, 1);
      // 成员被删后，原本归属他的保单回到「全家」
      for (const policy of db.policies) {
        if (policy.memberId === id) policy.memberId = '';
      }
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  // ── 缴费记录 ────────────────────────────────────────────────────────
  function listPayments(policyId) {
    loadSync();
    const list = [...db.payments];
    return policyId ? list.filter((item) => item.policyId === policyId) : list;
  }

  async function addPayment(input) {
    return enqueue(() => {
      const payment = normalizePayment(input, { now: Date.now() });
      if (!db.policies.some((policy) => policy.id === payment.policyId)) {
        throw new Error('缴费记录关联的保单不存在');
      }
      db.payments.push(payment);
      persist();
      return { payment, snapshot: snapshot() };
    });
  }

  async function removePayment(id) {
    return enqueue(() => {
      const index = db.payments.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这条缴费记录：${id}`);
      const [removed] = db.payments.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  // ── 待办状态（完成 / 稍后）──────────────────────────────────────────
  /**
   * 记下用户对一个待办的处理。
   *
   * 待办本身是从保单日期**派生**的，所以这里不改保单，只记「用户对它做了什么」。
   * 这样保单日期一改，待办自动跟着变，不会留下对不上的孤儿数据。
   *
   * @param {string} key `${policyId}:${kind}:${dueDate}`
   * @param {{ status?: string, snoozeUntil?: string, note?: string }} patch
   * @returns {Promise<object>} 新快照
   */
  async function setTodoState(key, patch = {}) {
    return enqueue(() => {
      const cleanKey = String(key ?? '').trim();
      if (cleanKey === '') throw new Error('缺少待办标识');
      const status = oneOf(patch.status, TODO_STATUS, 'pending');
      db.todoState[cleanKey] = {
        status,
        snoozeUntil: dayKey(patch.snoozeUntil),
        doneAt: status === 'done' ? Date.now() : 0,
        note: String(patch.note ?? '').trim().slice(0, 200),
      };
      persist();
      return { key: cleanKey, state: db.todoState[cleanKey], snapshot: snapshot() };
    });
  }

  // ── 保单附件 ────────────────────────────────────────────────────────
  /**
   * 给保单挂一份附件（主合同 / 批单 / 缴费凭证）。
   *
   * 一份保单可能有多份文件：合同、批单、每年的缴费凭证。全挂在一张保单下，
   * 避免文件散落在聊天记录和下载目录里。
   *
   * @param {string} policyId 保单 id
   * @param {{ name: string, kind?: string, text?: string }} attachment 附件
   * @returns {Promise<{ attachment: object, snapshot: object }>}
   */
  async function addAttachment(policyId, attachment = {}) {
    return enqueue(() => {
      const index = db.policies.findIndex((item) => item.id === policyId);
      if (index < 0) throw new Error(`找不到这份保单：${policyId}`);
      const fileName = String(attachment.name ?? '').trim();
      if (fileName === '') throw new Error('附件需要文件名');
      const record = {
        id: newId('att'),
        name: fileName.slice(0, 160),
        kind: oneOf(attachment.kind, ATTACHMENT_KINDS, 'other'),
        at: Date.now(),
        text: String(attachment.text ?? '').slice(0, 200000),
      };
      db.policies[index].attachments.push(record);
      db.policies[index].updatedAt = Date.now();
      persist();
      return { attachment: record, snapshot: snapshot() };
    });
  }

  async function removeAttachment(policyId, attachmentId) {
    return enqueue(() => {
      const index = db.policies.findIndex((item) => item.id === policyId);
      if (index < 0) throw new Error(`找不到这份保单：${policyId}`);
      const before = db.policies[index].attachments.length;
      db.policies[index].attachments = db.policies[index].attachments.filter((item) => item.id !== attachmentId);
      if (db.policies[index].attachments.length === before) throw new Error('找不到这个附件');
      db.policies[index].updatedAt = Date.now();
      persist();
      return { removed: true, snapshot: snapshot() };
    });
  }

  // ── 保单 / 存款 / 理财 ──────────────────────────────────────────────
  function listPolicies() {
    loadSync();
    return [...db.policies];
  }

  async function addPolicy(input) {
    return enqueue(() => {
      const policy = normalizePolicy(input, { now: Date.now() });
      db.policies.push(policy);
      persist();
      return { policy, snapshot: snapshot() };
    });
  }

  async function updatePolicy(id, patch = {}) {
    return enqueue(() => {
      const index = db.policies.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项保单/存款：${id}`);
      const policy = normalizePolicy({ ...db.policies[index], ...patch, id }, { now: Date.now() });
      db.policies[index] = policy;
      persist();
      return { policy, snapshot: snapshot() };
    });
  }

  async function removePolicy(id) {
    return enqueue(() => {
      const index = db.policies.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项保单/存款：${id}`);
      const [removed] = db.policies.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  function listHoldings() {
    loadSync();
    return [...db.holdings];
  }

  async function addHolding(input) {
    return enqueue(() => {
      const holding = normalizeHolding(input, { now: Date.now() });
      db.holdings.push(holding);
      persist();
      return { holding, snapshot: snapshot() };
    });
  }

  async function updateHolding(id, patch = {}) {
    return enqueue(() => {
      const index = db.holdings.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项持仓：${id}`);
      const holding = normalizeHolding({ ...db.holdings[index], ...patch, id }, { now: Date.now() });
      db.holdings[index] = holding;
      persist();
      return { holding, snapshot: snapshot() };
    });
  }

  async function removeHolding(id) {
    return enqueue(() => {
      const index = db.holdings.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这项持仓：${id}`);
      const [removed] = db.holdings.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /* ---------------- 预算 ---------------- */

  /** 列出预算（按月份降序、分类排序）。 */
  function listBudgets(filter = {}) {
    loadSync();
    const month = isMonthText(filter.month) ? filter.month : '';
    return db.budgets
      .filter((item) => !month || item.month === month || item.month === 'default')
      .sort((a, b) => (a.month === b.month ? a.category.localeCompare(b.category, 'zh') : a.month < b.month ? 1 : -1))
      .map((item) => ({ ...item }));
  }

  /**
   * 设置某月某分类的预算（同月同分类已有则覆盖）。
   * @param {string} month `YYYY-MM` 或 `default`
   * @param {string} category 分类
   * @param {number} limit 分
   */
  async function setBudget(month, category, limit) {
    return enqueue(() => {
      const budget = normalizeBudget({ month: month || 'default', category, limit }, { now: Date.now() });
      const index = db.budgets.findIndex((item) => item.month === budget.month && item.category === budget.category);
      if (index >= 0) {
        budget.id = db.budgets[index].id;
        db.budgets[index] = budget;
      } else {
        db.budgets.push(budget);
      }
      persist();
      return { budget, snapshot: snapshot() };
    });
  }

  /** 删除预算（传 id 或 `{ month, category }`）。 */
  async function removeBudget(idOrKey) {
    return enqueue(() => {
      const index = typeof idOrKey === 'string'
        ? db.budgets.findIndex((item) => item.id === idOrKey)
        : db.budgets.findIndex((item) => item.month === idOrKey?.month && item.category === idOrKey?.category);
      if (index < 0) throw new Error(`找不到这条预算：${typeof idOrKey === 'string' ? idOrKey : JSON.stringify(idOrKey)}`);
      const [removed] = db.budgets.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /* ---------------- 目标 ---------------- */

  function listGoals() {
    loadSync();
    return db.goals.map((item) => ({ ...item }));
  }

  async function addGoal(input) {
    return enqueue(() => {
      const goal = normalizeGoal(input, { now: Date.now() });
      db.goals.push(goal);
      persist();
      return { goal, snapshot: snapshot() };
    });
  }

  async function updateGoal(id, patch = {}) {
    return enqueue(() => {
      const index = db.goals.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这个目标：${id}`);
      const goal = normalizeGoal({ ...db.goals[index], ...patch, id }, { now: Date.now() });
      db.goals[index] = goal;
      persist();
      return { goal, snapshot: snapshot() };
    });
  }

  /** 往目标里存钱（`delta` 分，可为负表示取出）。 */
  async function contributeGoal(id, delta) {
    return enqueue(() => {
      const index = db.goals.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这个目标：${id}`);
      const goal = db.goals[index];
      const cents = signedCentsOf(delta);
      if (cents === null) throw new Error('存入金额不对，请填数字');
      goal.saved = clamp(goal.saved + cents, 0, goal.target);
      goal.updatedAt = Date.now();
      persist();
      return { goal: { ...goal }, snapshot: snapshot() };
    });
  }

  async function removeGoal(id) {
    return enqueue(() => {
      const index = db.goals.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(`找不到这个目标：${id}`);
      const [removed] = db.goals.splice(index, 1);
      persist();
      return { removed, snapshot: snapshot() };
    });
  }

  /* ---------------- 设置 / 规则 ---------------- */

  /** 取设置。 */
  function getSettings() {
    loadSync();
    return normalizeSettings(db.settings);
  }

  /** 改设置（合并）。 */
  async function updateSettings(patch = {}) {
    return enqueue(() => {
      db.settings = normalizeSettings({ ...db.settings, ...(isPlainObject(patch) ? patch : {}) });
      persist();
      return { settings: { ...db.settings }, snapshot: snapshot() };
    });
  }

  /** 取用户修正记忆（key 是归一化商户名）。 */
  function getRules() {
    loadSync();
    return { ...db.rules };
  }

  /** 记住一条商户修正（`{ category, purpose }`）。 */
  async function rememberRule(merchant, patch = {}) {
    return enqueue(() => {
      const key = normalizeMerchant(merchant);
      if (!key) throw new Error('商户名为空，没法记住这条规则');
      const category = CATEGORIES.includes(patch.category) ? patch.category : '';
      const purposeIn = PURPOSES.includes(patch.purpose) ? patch.purpose : '';
      if (!category && !purposeIn) throw new Error('至少要给分类或目的，才能记住这条规则');
      const previous = db.rules[key] || null;
      const next = {
        category: category || previous?.category || '其他',
        purpose: purposeIn || previous?.purpose || suggestPurpose(category || previous?.category || '其他'),
      };
      db.rules[key] = next;
      persist();
      return { key, rule: next, snapshot: snapshot() };
    });
  }

  /* ---------------- 整库操作 ---------------- */

  /** 导出整库 JSON（深拷贝，可直接写文件）。 */
  function exportJson() {
    loadSync();
    return snapshot();
  }

  /** 用一份数据整体替换当前库（`POST /import-db`）。 */
  async function replaceDb(data) {
    return enqueue(() => {
      const next = normalizeDb(data, { now: Date.now() });
      db = next;
      persist();
      return { snapshot: snapshot(), counts: snapshot()._stats };
    });
  }

  /** 清空所有数据（保留 settings 默认值）。 */
  async function clearAll() {
    return enqueue(() => {
      db = emptyDb();
      persist();
      return { snapshot: snapshot() };
    });
  }

  /**
   * 写入演示数据（仅在库为空时允许）。
   *
   * 空账本 + `buildDemoDb` 的 12 个月流水 / 资产 / 负债 / 持仓 / 预算 / 目标。
   * 写入后 `settings.demo` 为 true，面板据此显示「演示数据」提示条和一键清空。
   *
   * @param {number} [now=Date.now()] 当前时间
   * @returns {Promise<{ snapshot: object }>}
   */
  async function seedDemo(now = Date.now()) {
    return enqueue(() => {
      if (db.txns.length || db.assets.length || db.liabilities.length || db.holdings.length) {
        throw new Error('当前已经有数据了，「一键体验」只对空库开放');
      }
      const demo = buildDemoDb(now);
      db = normalizeDb(demo, { now: Date.now() });
      persist();
      return { snapshot: snapshot(), counts: snapshot()._stats };
    });
  }

  /**
   * 首次启动时把演示账本装进空库。
   *
   * 与 `seedDemo` 的区别：不抛错、不改动已有数据的库，只给「完全空 + 从没送过」
   * 的库铺一份见面礼，让用户第一次点开就有东西可看。`force` 为 false 时
   * 同一个库里只会成功一次（靠 `settings.demo` 与 `imports` 判断）。
   *
   * @param {{ now?: number, force?: boolean }} [options]
   * @returns {Promise<boolean>} 是否真的写入了演示数据
   */
  async function seedDemoIfEmpty(options = {}) {
    return enqueue(() => {
      const hasData = db.txns.length > 0 || db.assets.length > 0 || db.liabilities.length > 0 || db.holdings.length > 0;
      if (hasData) return false;
      // `demoOffered` 记录「这份演示账本送过了」。用户清空后它仍然是 true，
      // 所以不会每次清空都复活——否则用户永远甩不掉这份样例。
      if (options.force !== true && db.settings?.demoOffered === true) return false;
      const demo = buildDemoDb(Number.isFinite(options.now) ? options.now : Date.now());
      db = normalizeDb(demo, { now: Date.now() });
      persist();
      return true;
    });
  }

  /**
   * 清空账本（含演示数据）。
   *
   * 与 `clearAll` 的区别：清空后**不再**自动铺演示数据，并把 `demo` 标回 false。
   * 用户点「换成我自己的数据」走这条路径。
   *
   * @returns {Promise<{ snapshot: object }>}
   */
  async function resetToEmpty() {
    return enqueue(() => {
      db = emptyDb();
      // demo 关掉（不再是演示账本），但 demoOffered 保持 true：这份见面礼已经
      // 送过，清空之后不该再被自动铺回来。
      db.settings = { ...db.settings, demo: false, demoOffered: true };
      persist();
      return { snapshot: snapshot() };
    });
  }

  return {
    ready,
    snapshot,
    path,
    describeStorage,
    getDb,
    listTxns,
    addTxn,
    updateTxn,
    removeTxn,
    importRows,
    listAssets,
    addAsset,
    updateAsset,
    removeAsset,
    listLiabilities,
    addLiability,
    updateLiability,
    removeLiability,
    listMembers,
    addMember,
    updateMember,
    removeMember,
    listPayments,
    addPayment,
    removePayment,
    setTodoState,
    addAttachment,
    removeAttachment,
    listPolicies,
    addPolicy,
    updatePolicy,
    removePolicy,
    listHoldings,
    addHolding,
    updateHolding,
    removeHolding,
    listBudgets,
    setBudget,
    removeBudget,
    listGoals,
    addGoal,
    updateGoal,
    contributeGoal,
    removeGoal,
    getSettings,
    updateSettings,
    getRules,
    rememberRule,
    exportJson,
    replaceDb,
    clearAll,
    seedDemo,
    seedDemoIfEmpty,
    resetToEmpty,
    kindLabels: KIND_LABELS,
    defaultDataDir,
    defaultDataFile,
  };
}

/* ------------------------------------------------------------------ */
/* 演示数据                                                            */
/* ------------------------------------------------------------------ */

/**
 * 演示账本生成器。
 *
 * 目标不是「凑够行数」，而是让打开面板的人一眼看出这是一个真实生活：
 * 工作日有通勤和外卖、周末有聚餐和电影、每月有房租水电；年中有一次旅行
 * （机票酒店门票一笔笔都像真的）、一次体检、一场同事婚礼；收入按工龄小幅
 * 上涨，年终奖单独有一笔；应季的火锅与雪糕、双十一与年货也都在。
 *
 * 生成方式：先按「日历」生成每天的事件，再叠加几个一次性事件，最后按
 * 「日期 + 金额 + 方向 + 商户」保证同一笔不重复（去重键不撞）。随机源用
 * 固定种子，保证同一台机器每次生成的演示账本完全一致（测试可断言）。
 *
 * 金额单位：模板里写「元」，写入时统一转「分」。
 */

/** 固定种子的可复现伪随机数（mulberry32）。 */
function demoRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 演示用商户池：`[商户, 摘要, 元金额区间下界, 上界, 账户, 出现权重]`。 */
const DEMO_POOLS = {
  早餐: [
    ['巴比馒头', '早餐', 6, 14, '微信', 3],
    ['沙县小吃', '早餐', 10, 18, '支付宝', 2],
    ['瑞幸咖啡', '生椰拿铁', 12.9, 22, '支付宝', 4],
    ['星巴克(上海南京西路店)', '拿铁大杯', 32, 42, '招商银行', 2],
    ['便利店早餐', '三明治+咖啡', 12, 24, '微信', 2],
  ],
  午餐: [
    ['美团外卖', '工作日午餐', 22, 45, '支付宝', 5],
    ['饿了么', '工作日午餐', 20, 40, '支付宝', 3],
    ['公司食堂', '午餐', 12, 20, '微信', 3],
    ['和府捞面', '午餐', 32, 45, '微信', 2],
    ['老乡鸡', '午餐', 26, 38, '支付宝', 2],
  ],
  晚餐: [
    ['海底捞火锅', '朋友聚餐', 180, 420, '招商银行', 1],
    ['西贝莜面村', '家庭晚餐', 120, 230, '微信', 2],
    ['外婆家', '晚餐', 90, 180, '支付宝', 2],
    ['烧烤摊', '夜宵', 55, 120, '微信', 2],
    ['盒马鲜生', '生鲜晚餐食材', 60, 160, '支付宝', 2],
  ],
  通勤: [
    ['上海地铁', '地铁出行', 3, 9, '交通卡', 6],
    ['滴滴出行', '快车', 18, 46, '微信', 3],
    ['哈啰单车', '骑行', 1.5, 4, '支付宝', 2],
    ['中国石化', '加油', 380, 460, '招商银行', 1],
  ],
  日用: [
    ['盒马鲜生', '一周生鲜', 88, 190, '支付宝', 3],
    ['永辉超市', '买菜', 45, 120, '微信', 3],
    ['京东商城', '日用品', 60, 180, '京东白条', 2],
    ['淘宝', '家居小物', 35, 160, '支付宝', 2],
    ['名创优品', '收纳用品', 29, 89, '微信', 1],
  ],
  娱乐: [
    ['万达影城', '电影票', 45, 128, '微信', 2],
    ['网易云音乐', '黑胶会员', 18, 18, '支付宝', 1],
    ['超级猩猩健身', '月卡', 299, 299, '招商银行', 1],
    ['猫眼演出', '话剧票', 180, 380, '支付宝', 1],
  ],
};

/** 分类 → 默认记账目的（演示数据用；与 classify.js 的口径一致）。 */
function demoPurpose(category) {
  const map = {
    餐饮: '生活必须',
    交通: '生活必须',
    购物: '生活必须',
    居家: '生活必须',
    医疗: '未来保障',
    教育: '自我实现',
    娱乐: '娱乐享受',
    通讯: '生活必须',
    人情往来: '人情社交',
    保险: '未来保障',
    还贷: '未来保障',
    投资: '未来保障',
    其他: '生活必须',
  };
  return map[category] || '生活必须';
}

/** 按权重从池子里抽一条。 */
function pickWeighted(random, pool) {
  const total = pool.reduce((sum, entry) => sum + entry[5], 0);
  let roll = random() * total;
  for (const entry of pool) {
    roll -= entry[5];
    if (roll <= 0) return entry;
  }
  return pool[pool.length - 1];
}

/** 在 [min, max] 区间取两位小数。 */
function betweenYuan(random, min, max) {
  return Math.round((min + random() * (max - min)) * 100) / 100;
}

/**
 * 构造演示库（不落盘）。
 *
 * 账本覆盖最近 **12 个自然月**（含本月），约 400 笔流水。所有数据纯虚构，
 * 金额、商户、日期都是为了让看板好看、趋势能讲出故事而设计的。
 *
 * @param {number} now 当前时间戳
 * @returns {object} 可直接交给 `normalizeDb` 的库对象
 */
export function buildDemoDb(now = Date.now()) {
  const random = demoRandom(20261106);
  const baseMonth = currentMonth(now);
  const today = dayKey(now);
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(baseMonth, i - 11));
  const txns = [];
  /** 同一笔不重复：`日期|分|商户`。 */
  const seen = new Set();
  /** 往账本里放一笔；重复的同日同商户同金额会被合并成微调后的金额。 */
  const push = (date, yuanAmount, merchant, note, account, category) => {
    if (date > today) return; // 未来的日子不记
    const cents = Math.max(1, Math.round(yuanAmount * 100));
    const key = `${date}|${cents}|${merchant}`;
    if (seen.has(key)) return;
    seen.add(key);
    txns.push({
      date,
      amount: cents,
      direction: 'expense',
      category,
      purpose: demoPurpose(category),
      merchant,
      note,
      account,
      source: 'import',
      importId: 'imp_demo',
      // 演示账本模拟「规则已归类」的结果，看板上的自动分类率才不会显示 0%。
      confidence: 'rule',
    });
  };
  /** 收入。 */
  const earn = (date, yuanAmount, merchant, note, account) => {
    if (date > today) return;
    const cents = Math.max(1, Math.round(yuanAmount * 100));
    const key = `${date}|${cents}|${merchant}`;
    if (seen.has(key)) return;
    seen.add(key);
    txns.push({
      date,
      amount: cents,
      direction: 'income',
      category: INCOME_CATEGORY,
      purpose: '',
      merchant,
      note,
      account,
      source: 'import',
      importId: 'imp_demo',
      confidence: 'rule',
    });
  };

  for (const [mi, month] of months.entries()) {
    const [yearText, monthText] = month.split('-');
    const year = Number(yearText);
    const monthNumber = Number(monthText);
    const dayCount = new Date(year, monthNumber, 0).getDate();
    // 收入随工龄缓慢上涨；春节月额外发年终奖。
    const salary = 30000 + mi * 260;
    // 发薪日固定在 10 号。当月如果还没到 10 号，就把这笔挪到月初——
    // 账本里「这个月还没发工资」会让当月结余看起来像入不敷出，对演示很不友好。
    const payDay = dateInMonth(month, 10);
    const payMonth = payDay.slice(0, 7);
    const payDate = payDay > today ? dateInMonth(payMonth, 2) : payDay;
    earn(payDate, salary, '某某科技有限公司', '工资（代发）', '招商银行');
    // 季度奖 / 年终奖
    if (monthNumber === 1) earn(dateInMonth(month, 20), 68000, '某某科技有限公司', '年终奖', '招商银行');
    else if (monthNumber % 3 === 0) earn(dateInMonth(month, 25), 8000, '某某科技有限公司', '季度奖', '招商银行');
    // 理财收益：余额宝每天几毛到几块，攒成每月一笔
    earn(dateInMonth(month, 28), betweenYuan(random, 180, 460), '支付宝余额宝', '理财收益', '支付宝');
    // 理财收益同样避免落在未来：当月没到 28 号就记在月初。
    const yieldDate = dateInMonth(month, 28);
    if (yieldDate > today) {
      // 上面那笔在未来，push/earn 内部已经跳过；这里补一笔当月的。
      earn(dateInMonth(month, 3), betweenYuan(random, 150, 380), '支付宝余额宝', '理财收益', '支付宝');
    }

    for (let day = 1; day <= dayCount; day += 1) {
      const date = dateInMonth(month, day);
      if (date > today) break;
      const weekday = new Date(year, monthNumber - 1, day).getDay();
      const weekend = weekday === 0 || weekday === 6;
      const monthDay = monthNumber * 100 + day; // 便于判断季节性

      // ── 每个工作日：早餐 + 午餐 + 通勤 ──────────────────────────────
      if (!weekend) {
        if (random() < 0.72) {
          const entry = pickWeighted(random, DEMO_POOLS.早餐);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '餐饮');
        }
        if (random() < 0.88) {
          const entry = pickWeighted(random, DEMO_POOLS.午餐);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '餐饮');
        }
        if (random() < 0.95) {
          const entry = pickWeighted(random, DEMO_POOLS.通勤);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '交通');
        }
      } else {
        // ── 周末：睡到自然醒，一天一两顿 + 偶尔出门 ─────────────────
        if (random() < 0.55) {
          const entry = pickWeighted(random, DEMO_POOLS.晚餐);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '餐饮');
        }
        if (random() < 0.4) {
          const entry = pickWeighted(random, DEMO_POOLS.娱乐);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '娱乐');
        }
        if (random() < 0.35) {
          const entry = pickWeighted(random, DEMO_POOLS.通勤);
          push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], '交通');
        }
      }

      // ── 日用采购：每周一两次 ────────────────────────────────────────
      if (random() < 0.3) {
        const entry = pickWeighted(random, DEMO_POOLS.日用);
        const category = entry[0] === '盒马鲜生' || entry[0] === '永辉超市' ? '居家' : '购物';
        push(date, betweenYuan(random, entry[2], entry[3]), entry[0], entry[1], entry[4], category);
      }
      // 工作日午后的咖啡/奶茶，让「餐饮」这个分类有厚度
      if (!weekend && random() < 0.35) {
        push(date, betweenYuan(random, 9, 26), random() < 0.5 ? '瑞幸咖啡' : '蜜雪冰城', '下午茶', '微信', '餐饮');
      }

      // ── 固定支出：房租 / 水电煤 / 物业 / 宽带 ────────────────────────
      if (day === 5) push(date, 4200, '链家（房租）', '月房租', '招商银行', '居家');
      if (day === 8) push(date, betweenYuan(random, 118, 268), '国家电网', '电费', '支付宝', '居家');
      if (day === 9) push(date, betweenYuan(random, 42, 88), '上海燃气', '燃气费', '支付宝', '居家');
      if (day === 12) push(date, 320, '绿城物业', '物业管理费', '招商银行', '居家');
      if (day === 12) push(date, 129, '中国电信', '宽带年费摊销', '招商银行', '通讯');
      if (day === 18) push(date, 99, '中国移动', '话费充值', '支付宝', '通讯');
      if (day === 15) push(date, 4200, '招商银行（房贷）', '房贷月供', '招商银行', '还贷');
      if (day === 8) push(date, betweenYuan(random, 600, 1600), '招商银行信用卡', '信用卡还款', '招商银行', '还贷');
      if (day === 20) push(date, 2000, '天天基金', '沪深300指数基金定投', '招商银行', '投资');
      if (day === 22) push(date, 299, '超级猩猩健身', '月卡', '招商银行', '娱乐');

      // ── 季节性事件 ─────────────────────────────────────────────────
      // 夏天：雪糕、冷饮；冬天：火锅、羊肉汤
      if ((monthNumber >= 6 && monthNumber <= 8) && random() < 0.05) {
        push(date, betweenYuan(random, 8, 36), '雪糕批发', '冰淇淋', '微信', '餐饮');
      }
      if ((monthNumber === 12 || monthNumber <= 2) && random() < 0.045) {
        push(date, betweenYuan(random, 168, 320), '海底捞火锅', '冬天就要吃火锅', '支付宝', '餐饮');
      }
      // 双十一、618、年货
      if (monthDay === 1111 || monthDay === 618 || monthDay === 1120) {
        push(date, betweenYuan(random, 480, 1600), '淘宝', '大促囤货', '支付宝', '购物');
      }
      if (monthNumber === 2 && day === 3) push(date, betweenYuan(random, 380, 760), '永辉超市', '年货采购', '微信', '居家');
      // 换季衣服
      if ((monthNumber === 3 || monthNumber === 9) && day === 14) {
        push(date, betweenYuan(random, 320, 980), '优衣库', '换季衣服', '支付宝', '购物');
      }
      // 体检（年度一次）
      if (monthNumber === 4 && day === 18) {
        push(date, 1280, '瑞慈体检中心', '年度体检套餐', '招商银行', '医疗');
      }
      // 偶尔感冒买药
      if (random() < 0.012) {
        push(date, betweenYuan(random, 28, 96), '叮当快药', '感冒药', '微信', '医疗');
      }
      // 人情往来：红包与份子钱
      if (monthNumber === 10 && day === 2) push(date, 1000, '微信红包', '给爸妈', '微信', '人情往来');
      if (monthNumber === 10 && day === 3) push(date, 1200, '给岳父母过节费', '节日问候', '支付宝', '人情往来');
      if (monthNumber === 5 && day === 20) push(date, 888, '微信红包', '同事婚礼份子钱', '微信', '人情往来');
      if (monthNumber === 11 && day === 11) push(date, 600, '微信红包', '朋友生日', '微信', '人情往来');
      // 订阅
      if (day === 6) push(date, 25, 'Apple iCloud', '云存储订阅', '微信', '通讯');
    }

    // ── 一次性大事件：让某几个月长得不一样 ────────────────────────────
    if (monthNumber === 7) {
      // 一次旅行：机票、酒店、门票、购物，散在几天里
      push(dateInMonth(month, 12), 2180, '携程旅行', '往返机票', '招商银行', '交通');
      push(dateInMonth(month, 12), 3240, '全季酒店', '酒店 4 晚', '招商银行', '居家');
      push(dateInMonth(month, 13), 640, '景区门票', '门票', '支付宝', '娱乐');
      push(dateInMonth(month, 14), 890, '当地餐饮', '旅游餐费', '支付宝', '餐饮');
      push(dateInMonth(month, 15), 1560, '免税店', '伴手礼', '支付宝', '购物');
      push(dateInMonth(month, 16), 420, '景区打车', '当地交通', '微信', '交通');
    }
    if (monthNumber === 9) {
      // 换电脑
      push(dateInMonth(month, 6), 9899, 'Apple Store', 'MacBook', '招商银行', '购物');
    }
  }

  // 保险：年缴一次，落在最近一次保单月
  push(dateInMonth(months[months.length - 3], 16), 4860, '中国平安保险', '重疾险年缴保费', '招商银行', '保险');

  // 以下金额单位均为「分」
  const assets = [
    { name: '招行活期', kind: 'cash', value: 18640000, account: '招商银行', note: '日常开销账户' },
    { name: '支付宝余额', kind: 'cash', value: 528000, account: '支付宝', note: '' },
    { name: '微信零钱', kind: 'cash', value: 186000, account: '微信', note: '' },
    { name: '沪深300指数基金', kind: 'investment', value: 6120000, account: '天天基金', note: '每月定投 2000' },
    { name: '公积金', kind: 'other', value: 2480000, account: '公积金中心', note: '可提取部分' },
    { name: '理财通（货币基金）', kind: 'investment', value: 3500000, account: '微信', note: '应急备用' },
  ];

  const liabilities = [
    { name: '房贷', kind: 'mortgage', balance: 7860000, monthlyPayment: 780000, dueDay: 15, note: '剩余 17 年，等额本息' },
    { name: '招行信用卡', kind: 'credit', balance: 412000, monthlyPayment: 412000, dueDay: 8, note: '本月账单待还' },
    { name: '车贷', kind: 'car', balance: 960000, monthlyPayment: 340000, dueDay: 20, note: '还剩 9 期' },
  ];

  const holdings = [
    { name: '沪深300ETF', code: '510300', type: 'fund', shares: 4200, costPrice: 4120, price: 4356, note: '长期持有' },
    { name: '中证500ETF', code: '510500', type: 'fund', shares: 1800, costPrice: 6350, price: 6088, note: '定投中' },
    { name: '招商银行', code: '600036', type: 'stock', shares: 600, costPrice: 3450, price: 3862, note: '' },
    { name: '国债逆回购', code: 'GC001', type: 'bond', shares: 100, costPrice: 10000, price: 10012, note: '短期闲置' },
    { name: '医药主题基金', code: '001717', type: 'fund', shares: 2600, costPrice: 1420, price: 1286, note: '亏损中' },
  ];

  const budgets = [];
  for (const category of ['餐饮', '交通', '购物', '居家', '娱乐', '通讯']) {
    const limits = { 餐饮: 180000, 交通: 120000, 购物: 200000, 居家: 620000, 娱乐: 90000, 通讯: 25000 };
    budgets.push({ month: baseMonth, category, limit: limits[category] });
    budgets.push({ month: 'default', category, limit: Math.round(limits[category] * 1.1) });
  }

  const goals = [
    { name: '应急金', target: 5460000, saved: 3500000, deadline: dateInMonth(shiftMonth(baseMonth, 8), 28), note: '6 个月生活费' },
    { name: '日本旅行', target: 3000000, saved: 1240000, deadline: dateInMonth(shiftMonth(baseMonth, 10), 28), note: '明年秋天的行程' },
    { name: '换车首付', target: 8000000, saved: 2400000, deadline: dateInMonth(shiftMonth(baseMonth, 24), 28), note: '' },
  ];

  const rules = {
    星巴克: { category: '餐饮', purpose: '娱乐享受' },
    海底捞火锅: { category: '餐饮', purpose: '娱乐享受' },
    '链家（房租）': { category: '居家', purpose: '生活必须' },
  };

  return {
    version: DB_VERSION,
    txns,
    assets,
    liabilities,
    holdings,
    budgets,
    goals,
    rules,
    imports: [
      { id: 'imp_demo', at: now - 86400000, file: '演示账本（12 个月）', format: 'demo', rows: txns.length, added: txns.length, dup: 0 },
    ],
    settings: { currency: 'CNY', emergencyMonths: 6, demo: true, demoOffered: true },
  };
}

/**
 * 计算负债的「下次还款日」与逾期状态（analysis 与会话界面共用）。
 *
 * @param {{ dueDay?: number }} liability 负债
 * @param {string} [today] 今天 `YYYY-MM-DD`
 * @returns {{ dueInDays: number, overdue: boolean, dueDate: string }}
 */
export function nextDue(liability, today = dayKey(new Date())) {
  const dueDay = Math.round(clamp(liability?.dueDay ?? 1, 1, 31));
  const month = monthKey(today);
  let dueDate = dateInMonth(month, dueDay);
  let diff = daysBetween(today, dueDate);
  if (diff < 0) {
    dueDate = dateInMonth(shiftMonth(month, 1), dueDay);
    diff = daysBetween(today, dueDate);
  }
  const overdue = liability?.overdue === true;
  return { dueInDays: Math.max(0, diff), overdue, dueDate };
}

