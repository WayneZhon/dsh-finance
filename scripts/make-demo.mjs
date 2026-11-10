#!/usr/bin/env node
/**
 * Write realistic demo bills next to the plugin so the dashboard can be tried
 * without touching the user's real money data.
 *
 * Two artifacts, both pure data and both safe to publish:
 *
 *   scripts/fixtures/demo-alipay.csv   支付宝风格账单（表头前有说明行、含"收/支"列）
 *   scripts/fixtures/demo-generic.csv  通用银行流水（一列带正负号的金额）
 *
 * The numbers are synthetic: a plausible monthly life (rent, groceries, coffee,
 * commute, salary) with a mild upward drift on expenses, generated from a fixed
 * seed so the files are reproducible and the tests can assert exact counts.
 *
 * Usage: node scripts/make-demo.mjs [--months 6]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(root, "scripts", "fixtures");

/** Deterministic PRNG (mulberry32) so the demo is byte-reproducible. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(20261106);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + random() * (max - min);
/** 元 → 保留两位的字符串。 */
const yuan = (value) => (Math.round(value * 100) / 100).toFixed(2);
const pad = (value) => String(value).padStart(2, "0");

/** 描述一天里的常见消费：一天 0-4 笔。 */
function dayExpenses(month, day, drift) {
  const out = [];
  const weight = 1 + drift;
  // 餐饮：每天 1-2 顿
  const meals = random() < 0.75 ? 1 : 0;
  for (let i = 0; i < meals; i += 1) {
    out.push({
      merchant: pick(["星巴克(国贸店)", "瑞幸咖啡", "麦当劳(建国路店)", "海底捞火锅", "沙县小吃", "西贝莜面村", "美团外卖", "蜜雪冰城"]),
      category: "餐饮",
      amount: between(12, 88) * weight,
    });
  }
  // 通勤
  if (random() < 0.6) {
    out.push({ merchant: pick(["滴滴出行", "北京地铁", "高德打车", "中国石化加油站"]), category: "交通", amount: between(3, 46) * weight });
  }
  // 购物 / 生活
  if (random() < 0.28) {
    out.push({
      merchant: pick(["淘宝网", "京东商城", "拼多多", "盒马鲜生", "永辉超市", "名创优品", "优衣库"]),
      category: random() < 0.55 ? "居家" : "购物",
      amount: between(29, 480) * weight,
    });
  }
  // 少见的医疗 / 娱乐
  if (random() < 0.06) out.push({ merchant: pick(["北京协和医院", "叮当快药", "同仁堂药店"]), category: "医疗", amount: between(45, 620) });
  if (random() < 0.08) out.push({ merchant: pick(["猫眼电影", "网易云音乐会员", "爱奇艺会员", "Steam"]) , category: "娱乐", amount: between(15, 168) });
  return out;
}

/** 生成一个月的流水（含固定项）。 */
function monthRows(year, month, index) {
  const days = new Date(year, month, 0).getDate();
  const drift = index * 0.035;
  const rows = [];
  for (let day = 1; day <= days; day += 1) {
    for (const item of dayExpenses(month, day, drift)) {
      rows.push({ date: `${year}-${pad(month)}-${pad(day)}`, ...item, kind: "expense" });
    }
  }
  // 固定支出
  rows.push({ date: `${year}-${pad(month)}-05`, merchant: "链家房租", category: "居家", amount: 6500 + index * 0, kind: "expense" });
  rows.push({ date: `${year}-${pad(month)}-08`, merchant: "国家电网电费", category: "居家", amount: between(120, 260), kind: "expense" });
  rows.push({ date: `${year}-${pad(month)}-10`, merchant: "中国移动话费", category: "通讯", amount: 128, kind: "expense" });
  rows.push({ date: `${year}-${pad(month)}-12`, merchant: "中国平安保险", category: "保险", amount: 386, kind: "expense" });
  rows.push({ date: `${year}-${pad(month)}-15`, merchant: "招商银行房贷", category: "还贷", amount: 12800, kind: "expense" });
  // 收入
  rows.push({ date: `${year}-${pad(month)}-10`, merchant: "某科技公司工资", category: "收入", amount: 28600, kind: "income" });
  if (random() < 0.5) rows.push({ date: `${year}-${pad(month)}-20`, merchant: "闲鱼卖二手", category: "收入", amount: between(80, 900), kind: "income" });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const months = Number(process.argv[process.argv.indexOf("--months") + 1]) || 6;
const now = new Date(2026, 10, 6); // 2026-11-06，与需求文档同日
const alipay = [];
const generic = [];
for (let i = months - 1; i >= 0; i -= 1) {
  const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
  const rows = monthRows(date.getFullYear(), date.getMonth() + 1, months - 1 - i);
  for (const row of rows) {
    const time = `${pad(Math.floor(between(7, 22)))}:${pad(10 + Math.floor(random() * 50))}:${pad(Math.floor(random() * 60))}`;
    if (row.kind === "expense") {
      alipay.push([`${row.date} ${time}`, row.category, row.merchant, row.merchant, "支出", yuan(row.amount), pick(["余额宝", "招商银行储蓄卡(1234)", "花呗"]), "交易成功", `2026${pad(1)}${String(alipay.length).padStart(8, "0")}`, "", ""]);
    } else {
      alipay.push([`${row.date} ${time}`, "转账红包", row.merchant, "工资/收入", "收入", yuan(row.amount), "余额宝", "交易成功", `2026${pad(1)}${String(alipay.length).padStart(8, "0")}`, "", ""]);
    }
    generic.push([row.date, row.merchant, row.kind === "expense" ? `-${yuan(row.amount)}` : yuan(row.amount), row.kind === "expense" ? "支出" : "收入", "招商银行储蓄卡(1234)", row.category]);
  }
}

const alipayHeader = "交易时间,交易分类,交易对方,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注";
const alipayText = [
  "支付宝交易记录明细查询",
  "账号:demo@example.com",
  "起始日期:[2026-05-01 00:00:00]    终止日期:[2026-11-06 23:59:59]",
  "---------------------------------交易记录明细列表------------------------------------",
  alipayHeader,
  ...alipay.map((cells) => cells.map((cell) => (/[,"\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","))
].join("\n");

const genericText = [
  "交易日期,摘要,金额,收支方向,账户,分类",
  ...generic.map((cells) => cells.join(","))
].join("\n");

mkdirSync(fixtureDir, { recursive: true });
writeFileSync(join(fixtureDir, "demo-alipay.csv"), `${alipayText}\n`, "utf8");
writeFileSync(join(fixtureDir, "demo-generic.csv"), `${genericText}\n`, "utf8");
console.log(`wrote ${String(alipay.length)} 支付宝行 / ${String(generic.length)} 通用行 → scripts/fixtures/`);