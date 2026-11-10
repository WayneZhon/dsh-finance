/**
 * lib/analysis.js —— 看板聚合（纯函数）。
 *
 * `financeSnapshot(db, { month, now })` 是四端共用的唯一「看板数据源」：
 * 所有金额都是**分**，`share` 是 0-1 的比例。任何派生数字都必须能下钻回明细。
 *
 * @module dsh-finance/analysis
 */

import {
  ASSET_KINDS,
  EXPENSE_CATEGORIES,
  HOLDING_TYPES,
  INCOME_CATEGORY,
  KIND_LABELS,
  LIABILITY_KINDS,
  PURPOSES,
  clamp,
  currentMonth,
  dateInMonth,
  dayKey,
  daysBetween,
  isDateText,
  isMonthText,
  monthKey,
  monthRange,
  ratio,
  safeAdd,
  shiftMonth,
} from './domain.js';
import { nextDue } from './store.js';
import { deriveTodos, familyOverview, nextPremiumDate, premiumCalendar } from './todos.js';

/** 趋势默认展示的月份数。 */
/**
 * 趋势展示的月数。
 *
 * 12 个月是「一眼看到一整年」的天然单位：既能做柱状对比，也能看出淡旺季。
 * 面板的折线图仍只画最近 6 个月（点上更清楚），柱状图用满 12 个月。
 */
const TREND_MONTHS = 12;

/** 把库里的流水按月份分组（只保留有效行）。 */
function groupByMonth(txns) {
  const map = new Map();
  for (const txn of txns) {
    const key = monthKey(txn.date);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(txn);
  }
  return map;
}

/** 只统计真实收支的行（`money: true` 的是「钱的事本身」，不计入收支）。 */
function isRealFlow(txn) {
  return !txn.money;
}

/** 该行的累计修正置信度是否来自规则/用户（AI 兜底不算自动）。 */
function isAutoClassified(txn) {
  return txn.confidence === 'rule' || txn.confidence === 'user';
}

/**
 * 计算看板快照。
 *
 * @param {object} db 整库（`store.getDb()` / `exportJson()` / 测试里的手工对象）
 * @param {{ month?: string, now?: number }} [options] `month` 缺省为当前月
 * @returns {object} 见 CONTRACT「聚合契约」
 */
export function financeSnapshot(db, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const data = db && typeof db === 'object' ? db : {};
  const txns = Array.isArray(data.txns) ? data.txns : [];
  const assetsRaw = Array.isArray(data.assets) ? data.assets : [];
  const liabilitiesRaw = Array.isArray(data.liabilities) ? data.liabilities : [];
  const holdingsRaw = Array.isArray(data.holdings) ? data.holdings : [];
  const budgetsRaw = Array.isArray(data.budgets) ? data.budgets : [];
  const goalsRaw = Array.isArray(data.goals) ? data.goals : [];
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};

  const byMonth = groupByMonth(txns);
  const monthSet = new Set(byMonth.keys());
  const requested = typeof options.month === 'string' ? options.month : '';
  const month = isMonthText(requested)
    ? requested
    : [...monthSet].sort().pop() || currentMonth(now);

  const monthsAvailable = [...monthSet].sort().reverse();
  const monthTxns = (byMonth.get(month) || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const sumExpense = (list) => safeAdd(...list.filter((t) => t.direction === 'expense' && isRealFlow(t)).map((t) => t.amount));
  const sumIncome = (list) => safeAdd(...list.filter((t) => t.direction === 'income' && isRealFlow(t)).map((t) => t.amount));

  /* ---------- summary ---------- */
  const income = sumIncome(monthTxns);
  const expense = sumExpense(monthTxns);
  // 收支口径：有多少笔被判定为「资金搬移」没算进收支、有多少笔大额需要确认。
  // 这是面板要说清楚的事——否则用户会觉得「我明明转了 2 万，支出怎么没变」。
  const excluded = monthTxns.filter((t) => !isRealFlow(t));
  const reviewQueue = monthTxns.filter((t) => t.flow && t.flow.verdict === 'review');
  const summary = {
    income,
    expense,
    balance: income - expense,
    txnCount: monthTxns.length,
    autoClassified: monthTxns.filter(isAutoClassified).length,
    autoRate: ratio(monthTxns.filter(isAutoClassified).length, monthTxns.length),
    // 不计入收支的笔数与金额（按方向拆开，面板上显示成「另有 3 笔转账 ¥25,000 未计入」）
    excludedCount: excluded.length,
    excludedIncome: excluded.filter((t) => t.direction === 'income').reduce((acc, t) => acc + (Number(t.amount) || 0), 0),
    excludedExpense: excluded.filter((t) => t.direction === 'expense').reduce((acc, t) => acc + (Number(t.amount) || 0), 0),
    reviewCount: reviewQueue.length,
  };

  /* ---------- byCategory / byPurpose ---------- */
  const byCategory = groupAmounts(
    monthTxns.filter((t) => t.direction === 'expense' && isRealFlow(t)),
    (t) => (EXPENSE_CATEGORIES.includes(t.category) ? t.category : '其他'),
    expense,
    'category',
  );
  const byPurpose = groupAmounts(
    monthTxns.filter((t) => t.direction === 'expense' && isRealFlow(t)),
    (t) => (PURPOSES.includes(t.purpose) ? t.purpose : '生活必须'),
    expense,
    'purpose',
  );

  /* ---------- trend ---------- */
  const trendMonths = monthRange(month, TREND_MONTHS);
  const trend = trendMonths.map((key) => {
    const list = byMonth.get(key) || [];
    const inc = sumIncome(list);
    const exp = sumExpense(list);
    return { month: key, income: inc, expense: exp, balance: inc - exp };
  });

  /* ---------- 年度汇总 ---------- */
  // 「今年一共花了多少」是仅次于本月三数的问题，之前完全没有出口。
  // 口径与月度一致：只算真实收支（不计 money 标记的行）。
  const yearOf = (key) => String(key).slice(0, 4);
  const currentYear = yearOf(month);
  const yearTxns = (data.txns || []).filter((t) => yearOf(t.date) === currentYear);
  const yearIncome = sumIncome(yearTxns);
  const yearExpense = sumExpense(yearTxns);
  const monthsElapsed = [...new Set(yearTxns.map((t) => String(t.date).slice(0, 7)))].length;
  const yearly = {
    year: currentYear,
    income: yearIncome,
    expense: yearExpense,
    balance: yearIncome - yearExpense,
    // 有数据的月份数，用来算月均；没数据的新用户不会被月均除零
    months: monthsElapsed,
    avgExpense: monthsElapsed > 0 ? Math.round(yearExpense / monthsElapsed) : 0,
    avgIncome: monthsElapsed > 0 ? Math.round(yearIncome / monthsElapsed) : 0,
    txnCount: yearTxns.length,
  };

  /* ---------- 保单档案 / 待办 / 工作台 ---------- */
  const policiesRaw = Array.isArray(data.policies) ? data.policies : [];
  const membersRaw = Array.isArray(data.members) ? data.members : [];
  const paymentsRaw = Array.isArray(data.payments) ? data.payments : [];
  const todoState = data.todoState !== null && typeof data.todoState === 'object' ? data.todoState : {};

  // 每份保单的档案视图：把「看懂卡片」需要的答案算好，面板直接渲染
  const archive = policiesRaw.map((policy) => buildPolicyCard(policy, paymentsRaw, now));

  const todos = deriveTodos(policiesRaw, paymentsRaw, todoState, now);
  const calendar = premiumCalendar(policiesRaw, now);

  const policies = {
    // ── 向后兼容的字段（旧面板/旧工具还在用）──
    ...buildPolicyReminders(policiesRaw, now),
    // 全部保单本身
    all: policiesRaw.map((policy) => ({ ...policy })),
    totalPremium: safeAdd(...policiesRaw.filter((policy) => policy.kind === 'insurance').map((policy) => policy.premium)),
    totalAmount: safeAdd(...policiesRaw.map((policy) => policy.amount)),
    // ── 新的档案与待办 ──
    /** 每份保单的「看懂卡片」数据（含保障责任、限制、缴费进度、理赔指引）。 */
    archive,
    /** 待办：续期缴费、到期、等待期/犹豫期结束、自定义检查。 */
    todos,
    /** 年度缴费日历：未来 12 个月每月计划缴多少。 */
    calendar,
    /** 家庭概览：按成员分组。 */
    family: familyOverview(membersRaw, policiesRaw),
    members: membersRaw.map((member) => ({ ...member })),
    payments: paymentsRaw.map((payment) => ({ ...payment })),
  };

  /** 工作台首页要的聚合：先回答「我现在要做什么」。 */
  const workbench = {
    /** 近期待办（逾期 + 今天 + 7 天内）。 */
    urgent: todos.filter((todo) => todo.bucket === 'overdue' || todo.bucket === 'today' || todo.bucket === 'soon'),
    /** 全部待办（含更远的）。 */
    todos,
    overdue: todos.filter((todo) => todo.bucket === 'overdue').length,
    today: todos.filter((todo) => todo.bucket === 'today').length,
    soon: todos.filter((todo) => todo.bucket === 'soon').length,
    calendar,
    family: policies.family,
    counts: {
      policies: policiesRaw.length,
      members: membersRaw.length,
      attachments: policiesRaw.reduce((acc, policy) => acc + (Array.isArray(policy.attachments) ? policy.attachments.length : 0), 0),
      // 「待确认的识别结果」= 还没有任何保障责任/日期的保单，说明档案不完整
      incomplete: archive.filter((card) => card.completeness.missing.length > 0).length,
    },
  };

  /* ---------- 数据完整性提醒 ---------- */
  // 「年结余 -25 万」在一个月收入只有几千的账本里非常刺眼，但那往往不是
  // 花超了，而是**收入的那份账单还没导入**（工资在银行卡流水里，微信账单
  // 里几乎不会有工资）。这里把这种情况说出来，而不是让用户自己猜。
  const dataNotes = [];
  if (yearExpense > 0) {
    const incomeMonths = new Set(yearTxns.filter((t) => t.direction === 'income' && isRealFlow(t)).map((t) => String(t.date).slice(0, 7)));
    const monthsWithExpense = monthsElapsed;
    if (incomeMonths.size === 0) {
      dataNotes.push({
        level: 'warn',
        title: '这一年还没有任何收入记录',
        detail: '工资多半在银行卡流水里，微信/支付宝账单一般不含工资。导入银行账单后年结余才有意义。',
      });
    } else if (monthsWithExpense >= 3 && incomeMonths.size <= Math.max(1, Math.floor(monthsWithExpense / 3))) {
      dataNotes.push({
        level: 'warn',
        title: `只有 ${String(incomeMonths.size)} 个月有收入记录`,
        detail: '收支不成比例时，年结余会看起来像巨额亏损。确认一下银行/工资卡的账单是不是也导进来了。',
      });
    }
  }

  /* ---------- topExpenses ---------- */
  const topExpenses = monthTxns
    .filter((t) => t.direction === 'expense' && isRealFlow(t))
    .slice()
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({ id: t.id, date: t.date, merchant: t.merchant, amount: t.amount, category: t.category }));

  /* ---------- assets ---------- */
  const assets = buildAssets(assetsRaw);

  /* ---------- liabilities ---------- */
  const liabilities = buildLiabilities(liabilitiesRaw, now);

  /* ---------- netWorth ---------- */
  const netWorth = assets.total - liabilities.total;

  /* ---------- netWorthTrend ---------- */
  const netWorthTrend = buildNetWorthTrend(netWorth, trend);

  /* ---------- invest ---------- */
  const invest = buildInvest(holdingsRaw);

  /* ---------- budgets ---------- */
  const budgets = buildBudgets(budgetsRaw, byMonth.get(month) || [], month);
  const budgetTotal = {
    limit: safeAdd(...budgets.map((b) => b.limit)),
    spent: safeAdd(...budgets.map((b) => b.spent)),
    used: 0,
  };
  budgetTotal.used = budgetTotal.limit > 0 ? ratio(budgetTotal.spent, budgetTotal.limit) : 0;

  /* ---------- goals ---------- */
  const goals = goalsRaw.map((goal) => buildGoal(goal, now));

  /* ---------- tips ---------- */
  const tips = buildTips({
    summary,
    budgets,
    assets,
    liabilities,
    netWorth,
    invest,
    settings,
    month,
  });

  return {
    month,
    summary,
    byCategory,
    byPurpose,
    trend,
    topExpenses,
    assets,
    liabilities,
    netWorth,
    netWorthTrend,
    invest,
    budgets,
    budgetTotal,
    yearly,
    dataNotes,
    policies,
    workbench,
    goals,
    tips,
    monthsAvailable,
  };
}

/**
 * 按分组键聚合金额，降序，带占比与笔数。
 *
 * @param {object[]} list 流水
 * @param {(txn: object) => string} keyOf 分组键
 * @param {number} total 分母（总支出）
 * @param {string} keyName 输出字段名
 * @returns {Array<object>}
 */
function groupAmounts(list, keyOf, total, keyName) {
  const map = new Map();
  for (const txn of list) {
    const key = keyOf(txn);
    const entry = map.get(key) || { amount: 0, count: 0 };
    entry.amount += Math.round(txn.amount) || 0;
    entry.count += 1;
    map.set(key, entry);
  }
  return [...map.entries()]
    .map(([key, entry]) => ({
      [keyName]: key,
      amount: entry.amount,
      share: ratio(entry.amount, total),
      count: entry.count,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** 资产聚合。 */
function buildAssets(list) {
  const items = list.map((asset) => ({
    id: asset.id,
    name: asset.name,
    kind: ASSET_KINDS.includes(asset.kind) ? asset.kind : 'other',
    kindLabel: KIND_LABELS[asset.kind] || KIND_LABELS.other,
    value: Math.round(asset.value) || 0,
    account: asset.account || '',
    note: asset.note || '',
  }));
  const total = safeAdd(...items.map((i) => i.value));
  const grouped = new Map();
  for (const item of items) grouped.set(item.kind, (grouped.get(item.kind) || 0) + item.value);
  const byKind = [...grouped.entries()]
    .map(([kind, amount]) => ({ kind, label: KIND_LABELS[kind] || kind, amount, share: ratio(amount, total) }))
    .sort((a, b) => b.amount - a.amount);
  return { total, byKind, items };
}

/** 负债聚合：补下次还款日、逾期标记、未来 30 天待还。 */
function buildLiabilities(list, now) {
  const today = dayKey(now);
  const items = list.map((liability) => {
    const due = nextDue(liability, today);
    return {
      id: liability.id,
      name: liability.name,
      kind: LIABILITY_KINDS.includes(liability.kind) ? liability.kind : 'other',
      kindLabel: KIND_LABELS[liability.kind] || KIND_LABELS.other,
      balance: Math.round(liability.balance) || 0,
      monthlyPayment: Math.round(liability.monthlyPayment) || 0,
      dueDay: liability.dueDay,
      dueDate: due.dueDate,
      dueInDays: due.dueInDays,
      overdue: due.overdue,
      note: liability.note || '',
    };
  });
  const total = safeAdd(...items.map((i) => i.balance));
  // 窗口取「未来一个自然月」（最多 31 天），这样月末的还款日也能被看见
  const upcoming = items
    .filter((item) => item.monthlyPayment > 0 && item.dueInDays <= 31)
    .map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      amount: item.monthlyPayment,
      dueDate: item.dueDate,
      dueInDays: item.dueInDays,
      overdue: item.overdue,
    }))
    .sort((a, b) => a.dueInDays - b.dueInDays);
  return { total, items: items.sort((a, b) => b.balance - a.balance), upcoming };
}

/**
 * 净资产走势：以「当前净资产」为锚，向更早的月份按各月结余反推。
 *
 * 逻辑：`netWorth(t) = netWorth(t+1) - balance(t+1)`；即
 * 上个月的净资产 = 本月净资产 - 本月结余（本月赚的都留在净资产里）。
 * 返回的每一项都对应 `trend` 里的月份，最后一项就是当前净资产。
 */
function buildNetWorthTrend(netWorth, trend) {
  const out = new Array(trend.length);
  let anchor = netWorth;
  for (let i = trend.length - 1; i >= 0; i -= 1) {
    out[i] = { month: trend[i].month, netWorth: anchor };
    anchor -= trend[i].balance;
  }
  return out;
}

/** 投资聚合：成本、市值、盈亏、配置比例、逐笔盈亏。 */
function buildInvest(list) {
  const items = list.map((holding) => {
    const shares = Number(holding.shares) || 0;
    const costPrice = Math.round(holding.costPrice) || 0;
    const price = Math.round(holding.price) || 0;
    const cost = Math.round(shares * costPrice);
    const value = Math.round(shares * price);
    return {
      id: holding.id,
      name: holding.name,
      code: holding.code || '',
      type: HOLDING_TYPES.includes(holding.type) ? holding.type : 'other',
      typeLabel: KIND_LABELS[holding.type] || KIND_LABELS.other,
      shares,
      costPrice,
      price,
      cost,
      value,
      pnl: value - cost,
      pnlRate: cost > 0 ? ratio(value - cost, cost) : 0,
      note: holding.note || '',
    };
  });
  const cost = safeAdd(...items.map((i) => i.cost));
  const value = safeAdd(...items.map((i) => i.value));
  const pnl = value - cost;
  const grouped = new Map();
  for (const item of items) grouped.set(item.type, (grouped.get(item.type) || 0) + item.value);
  const byType = [...grouped.entries()]
    .map(([type, amount]) => ({ type, label: KIND_LABELS[type] || type, value: amount, share: ratio(amount, value) }))
    .sort((a, b) => b.value - a.value);
  return {
    cost,
    value,
    pnl,
    pnlRate: cost > 0 ? ratio(pnl, cost) : 0,
    byType,
    items: items.sort((a, b) => b.value - a.value),
  };
}

/**
 * 预算：当月预算优先，没有则用 `default`；`spent` 是当月该分类支出。
 *
 * @returns {Array<{ id: string, category: string, limit: number, spent: number, used: number, over: boolean, source: string }>}
 */
/** 「整月支出上限」这条特殊预算用的分类名。 */
export const TOTAL_BUDGET_CATEGORY = '__total__';

function buildBudgets(budgetsRaw, monthTxns, month) {
  const spentByCategory = new Map();
  let spentTotal = 0;
  for (const txn of monthTxns) {
    if (txn.direction !== 'expense' || !isRealFlow(txn)) continue;
    const amount = Math.round(txn.amount) || 0;
    const key = EXPENSE_CATEGORIES.includes(txn.category) ? txn.category : '其他';
    spentByCategory.set(key, (spentByCategory.get(key) || 0) + amount);
    spentTotal += amount;
  }
  // 整月目标：不是某个分类的上限，而是「这个月一共最多花多少」。
  spentByCategory.set(TOTAL_BUDGET_CATEGORY, spentTotal);
  const byCategory = new Map();
  for (const budget of budgetsRaw) {
    if (!budget || !budget.category) continue;
    const category = String(budget.category);
    const existing = byCategory.get(category);
    if (!existing) {
      byCategory.set(category, budget);
      continue;
    }
    // 当月预算优先于 default
    const rank = (b) => (b.month === month ? 2 : b.month === 'default' ? 1 : 0);
    if (rank(budget) > rank(existing)) byCategory.set(category, budget);
  }
  return [...byCategory.entries()]
    .map(([category, budget]) => {
      const limit = Math.round(budget.limit) || 0;
      const spent = spentByCategory.get(category) || 0;
      return {
        id: budget.id,
        category,
        limit,
        spent,
        used: limit > 0 ? ratio(spent, limit) : 0,
        over: spent > limit,
        source: budget.month === month ? 'month' : 'default',
      };
    })
    .sort((a, b) => {
      // 整月目标永远排最前，它是「总闸」
      if (a.category === TOTAL_BUDGET_CATEGORY) return -1;
      if (b.category === TOTAL_BUDGET_CATEGORY) return 1;
      return b.used - a.used;
    });
}


/**
 * 把一份保单整理成「看懂卡片」。
 *
 * 用户打开保单想知道的是六件事，而不是看到一堆字段：
 *
 *   这份保险是干什么的 / 谁受到保障 / 什么情况能赔 /
 *   有哪些限制 / 还要交多久 / 出事了怎么办
 *
 * 所以这里不是把保单原样透传，而是**按问题组织**：每个答案都尽量带上
 * `source`（合同条款位置），让用户能回到原文核对。
 *
 * 同时算出 `completeness`：还缺哪些关键字段。识别之后有些字段没认出来，
 * 界面上要显眼地提示「这份档案还不完整」，而不是让用户以为已经齐了。
 *
 * @param {object} policy 保单
 * @param {object[]} payments 缴费记录
 * @param {number} now 当前时间戳
 * @returns {object} 看懂卡片
 */
function buildPolicyCard(policy, payments, now) {
  const own = (Array.isArray(payments) ? payments : []).filter((payment) => payment.policyId === policy.id);
  const paidTotal = safeAdd(...own.map((payment) => payment.amount));
  const today = dayKey(now);

  // 缴费进度：期数优先，没有期数就看缴费记录
  const periodsByName = policy.totalPeriods > 0
    ? { paid: policy.paidPeriods, total: policy.totalPeriods }
    : { paid: own.length, total: policy.payYears > 0 ? policy.payYears : 0 };
  const remainingPeriods = periodsByName.total > 0 ? Math.max(0, periodsByName.total - periodsByName.paid) : 0;

  // 保障期限
  const coverageUsable = policy.maturityDate === '' ? null : daysBetween(today, policy.maturityDate);
  const effectiveDays = policy.effectiveDate === '' ? null : daysBetween(policy.effectiveDate, today);

  // 保障责任汇总：每条都带保额与免赔额，并按保额排序（大的在前）
  const duties = (Array.isArray(policy.duties) ? policy.duties : [])
    .slice()
    .sort((a, b) => (b.amount || 0) - (a.amount || 0));

  const totalDeductible = safeAdd(...duties.map((duty) => duty.deductible));
  const maxWaiting = Math.max(0, ...duties.map((duty) => duty.waitingDays || 0));

  // 档案完整性：缺什么就说什么，别让人以为已经齐了
  const missing = [];
  if (policy.policyNo === '') missing.push('policyNo');
  if (policy.effectiveDate === '') missing.push('effectiveDate');
  if (policy.kind === 'insurance' && duties.length === 0) missing.push('duties');
  if (policy.kind === 'insurance' && policy.amount === 0) missing.push('amount');
  if (policy.kind === 'insurance' && policy.premium === 0) missing.push('premium');
  if (policy.dueDate === '') missing.push('dueDate');
  if (policy.holder === '' && policy.insured.length === 0) missing.push('people');

  return {
    id: policy.id,
    kind: policy.kind,
    type: policy.type,
    name: policy.name,
    issuer: policy.issuer,
    policyNo: policy.policyNo,
    status: policy.status,
    memberId: policy.memberId,
    // ① 一句话：这份是干什么的
    summary: typeof policy.summary === 'string' && policy.summary !== '' ? policy.summary : describePolicy(policy),
    // ② 谁受到保障
    people: {
      holder: policy.holder,
      insured: policy.insured,
      beneficiaries: policy.beneficiaries,
    },
    // ③ 什么情况能赔
    duties,
    // ④ 有哪些限制
    limits: {
      exclusions: policy.exclusions,
      deductible: totalDeductible,
      waitingDays: maxWaiting,
      // 等待期还没过时把日期算出来，比只说「90 天」有用
      waitingEndsOn: maxWaiting > 0 && policy.effectiveDate !== ''
        ? dayKey(new Date(new Date(`${policy.effectiveDate}T00:00:00`).getTime() + maxWaiting * 86400000))
        : '',
      coverageYears: policy.coverageYears,
    },
    // ⑤ 还要交多久
    paying: {
      premium: policy.premium,
      payCycle: policy.payCycle,
      payYears: policy.payYears,
      paidPeriods: periodsByName.paid,
      totalPeriods: periodsByName.total,
      remainingPeriods,
      paidTotal,
      payments: own.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12),
      nextDueDate: nextPremiumDate(policy, now),
    },
    // ⑥ 出事了怎么办
    claim: policy.claimGuide,
    // 时间线
    dates: {
      effectiveDate: policy.effectiveDate,
      effectiveDays,
      dueDate: policy.dueDate,
      maturityDate: policy.maturityDate,
      coverageUsable,
    },
    // 文件：主合同、批单、缴费凭证
    attachments: (Array.isArray(policy.attachments) ? policy.attachments : []).map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      at: item.at,
      // 不把整段原文塞进快照（可能几十万字），只给长度让界面提示「可查看原文」
      textLength: String(item.text ?? '').length,
    })),
    completeness: {
      missing,
      ready: missing.length === 0,
      ratio: Math.round(((8 - Math.min(8, missing.length)) / 8) * 100),
    },
    note: policy.note,
  };
}

/**
 * 用现有字段拼一句「这份保险是干什么的」。
 *
 * 用户没有自己写 summary、AI 也不可用时的兜底。宁可朴素，也要能看懂。
 *
 * @param {object} policy 保单
 * @returns {string} 一句话说明
 */
function describePolicy(policy) {
  const TYPE_TEXT = {
    medical: '医疗费用报销',
    critical: '重大疾病一次性给付',
    accident: '意外伤害保障',
    life: '身故/全残给付',
    annuity: '养老年金给付',
    car: '车辆损失与责任',
    property: '财产损失保障',
    other: '保障',
  };
  if (policy.kind === 'deposit') {
    const years = policy.coverageYears > 0 ? `${String(policy.coverageYears)} 年期` : '';
    return `${policy.issuer || '银行'}的${years}存款${policy.rate > 0 ? `，年化 ${String(policy.rate / 100)}%` : ''}`;
  }
  if (policy.kind === 'wealth') {
    return `${policy.issuer || ''}的理财产品${policy.rate > 0 ? `，预期年化 ${String(policy.rate / 100)}%` : ''}`.trim();
  }
  if (policy.kind !== 'insurance') return policy.name;
  const what = TYPE_TEXT[policy.type] ?? '保障';
  const who = policy.insured.length > 0 ? `为 ${policy.insured.join('、')} ` : '';
  const amount = policy.amount > 0 ? `，保额 ${formatWan(policy.amount)}` : '';
  return `${who}提供${what}${amount}`.trim();
}

/**
 * 把「分」格式化成便于阅读的口径（1.2 万 / 5000）。
 * @param {number} cents 分
 * @returns {string} 文本
 */
function formatWan(cents) {
  const yuan = Math.round((Number(cents) || 0) / 100);
  if (yuan >= 10000) {
    const wan = yuan / 10000;
    return `${wan % 1 === 0 ? String(wan) : wan.toFixed(1)} 万`;
  }
  return `${String(yuan)} 元`;
}

/**
 * 保单 / 存款 / 理财的到期与续保提醒。
 *
 * 这类东西的价值就在于**「到点要处理」**：保费忘了交会失效，存款到期不转存
 * 会按活期计息，理财到期不赎回就闲置。所以这里按「还剩几天」分档：
 *
 *   overdue  已过期 / 已逾期（最紧急，单独置顶）
 *   soon     30 天内
 *   upcoming 90 天内
 *   later    更远
 *
 * 没有日期的不进提醒（只作为持仓展示）。
 *
 * @param {object[]} policies 保单列表
 * @param {number} now 当前时间戳
 * @returns {{ items: object[], overdue: number, soon: number, next: object|null }}
 */
export function buildPolicyReminders(policies, now) {
  const today = dayKey(now);
  const list = Array.isArray(policies) ? policies : [];
  const items = list
    .filter((policy) => isDateText(policy?.dueDate))
    .map((policy) => {
      const days = daysBetween(today, policy.dueDate);
      const bucket = days < 0 ? 'overdue' : days <= 30 ? 'soon' : days <= 90 ? 'upcoming' : 'later';
      return {
        id: policy.id,
        kind: policy.kind,
        name: policy.name,
        issuer: policy.issuer,
        type: policy.type,
        dueDate: policy.dueDate,
        // 保险看「要交多少钱」，存款理财看「多少钱到期」
        amount: policy.kind === 'insurance' ? policy.premium : policy.amount,
        premium: policy.premium,
        policyAmount: policy.amount,
        payCycle: policy.payCycle,
        autoRenew: policy.autoRenew === true,
        paidPeriods: policy.paidPeriods ?? 0,
        totalPeriods: policy.totalPeriods ?? 0,
        days,
        bucket,
        // 一句话说明这个日期意味着什么
        action: policy.kind === 'insurance'
          ? (days < 0 ? '续保已逾期' : '需要续保/缴费')
          : (days < 0 ? '已到期未处理' : '到期需处理'),
      };
    })
    .sort((a, b) => a.days - b.days);
  const overdue = items.filter((item) => item.bucket === 'overdue').length;
  const soon = items.filter((item) => item.bucket === 'soon').length;
  return {
    items,
    overdue,
    soon,
    // 最近一件要处理的（含已逾期）
    next: items.length > 0 ? items[0] : null,
  };
}

/** 目标：进度、剩余月数、每月需存。 */
function buildGoal(goal, now) {
  const target = Math.round(goal.target) || 0;
  const saved = Math.round(goal.saved) || 0;
  const today = dayKey(now);
  const deadline = dayKey(goal.deadline);
  const remainingDays = deadline ? Math.max(0, daysBetween(today, deadline)) : 0;
  const remainingMonths = deadline ? Math.max(0, Math.ceil(remainingDays / 30.44)) : 0;
  const remaining = Math.max(0, target - saved);
  return {
    id: goal.id,
    name: goal.name,
    target,
    saved,
    deadline: deadline || '',
    note: goal.note || '',
    progress: target > 0 ? clamp(ratio(saved, target), 0, 1) : 0,
    remaining,
    remainingMonths,
    monthlyNeeded: remainingMonths > 0 ? Math.ceil(remaining / remainingMonths) : remaining,
    done: saved >= target,
  };
}

/**
 * 生成通用提示。只讲事实与通用理财常识，**绝不推荐具体买卖**。
 *
 * @param {object} context 上下文
 * @returns {Array<{ level: 'info'|'warn'|'good', title: string, detail: string }>}
 */
function buildTips(context) {
  const { summary, budgets, assets, liabilities, netWorth, invest, settings, month } = context;
  const tips = [];
  const currency = (cents) => {
    const yuan = Math.round(cents / 100);
    return `¥${yuan.toLocaleString('zh-CN')}`;
  };

  // 1) 应急金覆盖月数（只算现金/存款类资产）
  const cash = safeAdd(
    ...assets.items.filter((item) => item.kind === 'cash' || item.kind === 'other').map((item) => item.value),
  );
  const monthExpense = summary.expense;
  const targetMonths = clamp(settings.emergencyMonths ?? 6, 1, 36);
  if (monthExpense > 0) {
    const cover = Math.round((cash / monthExpense) * 10) / 10;
    const level = cover >= targetMonths ? 'good' : cover >= targetMonths / 2 ? 'info' : 'warn';
    tips.push({
      level,
      title: `应急金约可覆盖 ${cover} 个月开销`,
      detail: `手上能随时取用的钱约 ${currency(cash)}，按本月支出 ${currency(monthExpense)} 计算，能撑 ${cover} 个月；建议准备 ${targetMonths} 个月（约 ${currency(monthExpense * targetMonths)}）。`,
    });
  } else {
    tips.push({
      level: 'info',
      title: '这个月还没有支出记录',
      detail: `导入账单或记几笔账，才能算出应急金、预算使用率这些指标。`,
    });
  }

  // 2) 负债率
  if (assets.total > 0) {
    const debtRatio = ratio(liabilities.total, assets.total);
    const level = debtRatio >= 0.6 ? 'warn' : debtRatio >= 0.4 ? 'info' : 'good';
    tips.push({
      level,
      title: `负债率 ${(debtRatio * 100).toFixed(1)}%`,
      detail: `负债 ${currency(liabilities.total)} ÷ 资产 ${currency(assets.total)} = ${(debtRatio * 100).toFixed(1)}%。一般把负债率控制在 50% 以内比较从容。`,
    });
  } else if (liabilities.total > 0) {
    tips.push({
      level: 'warn',
      title: '还没录入资产',
      detail: `当前登记了 ${currency(liabilities.total)} 负债，但资产是空的，录一下资产就能看到真实净资产和负债率。`,
    });
  }

  // 3) 本月超支
  const over = budgets.filter((b) => b.over);
  if (over.length) {
    const names = over.map((b) => `${b.category}超 ${currency(b.spent - b.limit)}`).join('、');
    tips.push({
      level: 'warn',
      title: `${over.length} 个分类本月超出预算`,
      detail: `${names}。可以在「规划」里调预算，或者看看这几类里有没有能往后放的开销。`,
    });
  } else if (budgets.length) {
    const highest = budgets[0];
    if (highest && highest.used >= 0.8) {
      tips.push({
        level: 'info',
        title: `「${highest.category}」预算已用 ${(highest.used * 100).toFixed(0)}%`,
        detail: `已花 ${currency(highest.spent)} / 预算 ${currency(highest.limit)}，这个月还剩 ${currency(Math.max(0, highest.limit - highest.spent))}。`,
      });
    }
  } else {
    tips.push({
      level: 'info',
      title: '还没设置预算',
      detail: '在「规划」页给餐饮、购物这些大类设个上限，超支会在这里提醒你。',
    });
  }

  // 4) 结余率
  if (summary.income > 0) {
    const rate = ratio(summary.balance, summary.income);
    if (rate < 0) {
      tips.push({
        level: 'warn',
        title: '本月支出超过收入',
        detail: `${month} 收入 ${currency(summary.income)}、支出 ${currency(summary.expense)}，差额 ${currency(summary.balance)}。连续几个月为负的话，先看看「大额消费」里是哪几笔。`,
      });
    } else {
      const level = rate >= 0.3 ? 'good' : 'info';
      tips.push({
        level,
        title: `本月结余率 ${(rate * 100).toFixed(0)}%`,
        detail: `收入 ${currency(summary.income)}，存下 ${currency(summary.balance)}。结余率 30% 以上算是比较健康的储蓄节奏。`,
      });
    }
  }

  // 5) 投资配置（只讲比例与盈亏，不给买卖建议）
  if (invest.value > 0) {
    const sign = invest.pnl >= 0 ? '浮盈' : '浮亏';
    tips.push({
      level: 'info',
      title: `投资部分${sign} ${currency(Math.abs(invest.pnl))}`,
      detail: `市值 ${currency(invest.value)}，成本 ${currency(invest.cost)}，收益率 ${(invest.pnlRate * 100).toFixed(1)}%。占净资产 ${(ratio(invest.value, Math.max(netWorth, 1)) * 100).toFixed(0)}%。`,
    });
  }

  // 6) 净资产
  if (netWorth !== 0) {
    tips.push({
      level: netWorth > 0 ? 'good' : 'warn',
      title: `净资产 ${currency(netWorth)}`,
      detail: netWorth > 0
        ? `资产 ${currency(assets.total)} 减去负债 ${currency(liabilities.total)}。这个数字才是真正属于你的钱。`
        : `负债比资产多了 ${currency(-netWorth)}，优先把高息负债降下来会更轻松。`,
    });
  }

  return tips;
}

/**
 * 调试辅助：按路径取快照里的值，方便排查「看板数字对不上」的问题。
 *
 * @param {object} snapshot financeSnapshot 的返回值
 * @param {string} path 形如 `summary.expense`、`byCategory[0].amount`
 * @returns {unknown} 取到的值；路径不存在返回 undefined
 */
export function explain(snapshot, path) {
  if (!path) return snapshot;
  const tokens = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cursor = snapshot;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[token];
  }
  return cursor;
}

/**
 * 把快照压成一段给模型/AI 看的纯文本摘要（不依赖 locale 字典）。
 *
 * @param {object} snapshot financeSnapshot 的返回值
 * @returns {string}
 */
export function summarizeSnapshot(snapshot) {
  if (!snapshot || !snapshot.summary) return '还没有可用的财务数据。';
  const yuan = (cents) => `¥${Math.round(cents / 100).toLocaleString('zh-CN')}`;
  const { summary, byCategory, budgets, tips } = snapshot;
  const lines = [
    `${snapshot.month}：收入 ${yuan(summary.income)}，支出 ${yuan(summary.expense)}，结余 ${yuan(summary.balance)}（${summary.txnCount} 笔）。`,
  ];
  if (byCategory.length) {
    lines.push(`支出构成：${byCategory.slice(0, 4).map((c) => `${c.category} ${yuan(c.amount)}`).join('、')}。`);
  }
  const over = budgets.filter((b) => b.over);
  if (over.length) lines.push(`超预算：${over.map((b) => b.category).join('、')}。`);
  if (tips.length) lines.push(`提示：${tips.slice(0, 2).map((t) => t.title).join('；')}。`);
  return lines.join('\n');
}

/** 便于调用方拿「某月某日」而不用再 import domain（服务端拼还款日等场景）。 */
export { dateInMonth, shiftMonth };