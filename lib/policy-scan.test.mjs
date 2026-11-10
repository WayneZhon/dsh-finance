import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectFileKind,
  extractPolicyFields,
  nextAnniversary,
  normalizeOcrText,
  scanCapability,
  upperCaseMoney,
} from './policy-scan.js';

/** 一份真实 OCR 输出的近似文本（含 OCR 常见的引号与空格噪声）。 */
const OCR_TEXT = `中国平安人寿保险股份有限公司
保险合同， 电子保单

保单号            P2026110800123

投保人    王某某

被保险人           王某某
险种名称           平安福重大疾病保险
基本保险金额 ”人民币伍拾万元整 (500,000元)
保险期间           终身
交费期间           20年交
年交保费         人民币肆仟捌佰陆拾元整 (4,860元)
合同生效日 ”2021年12月15日
保险费应交日“每年12月15日`;

const NOW = new Date(2026, 10, 10).getTime();

test('能力探测：给出 ocr / pdf 两个布尔值，不会抛异常', () => {
  const capability = scanCapability();
  assert.equal(typeof capability.ocr, 'boolean');
  assert.equal(typeof capability.pdf, 'boolean');
  // 有 OCR 才可能有 PDF（PDF 要先栅格化）
  if (capability.pdf) assert.equal(capability.ocr, true);
});

test('文件类型：扩展名与魔数都能判', () => {
  assert.equal(detectFileKind('a.pdf', ''), 'pdf');
  assert.equal(detectFileKind('a.PNG', ''), 'image');
  assert.equal(detectFileKind('a.txt', ''), 'text');
  // 无扩展名时看魔数
  assert.equal(detectFileKind('blob', Buffer.from('%PDF-1.7 ...')), 'pdf');
  assert.equal(detectFileKind('blob', Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image');
  assert.equal(detectFileKind('blob', Buffer.from([0xff, 0xd8, 0xff])), 'image');
});

test('OCR 文本清洗：去空行、压空格，但不改内容', () => {
  const messy = '第一行  有多余空格\n\n\n第二行\u3000\u00a0制表\n';
  const clean = normalizeOcrText(messy);
  assert.equal(clean, '第一行  有多余空格\n第二行  制表');
  // 内容本身不能被吞掉
  assert.ok(clean.includes('有多余空格'));
  assert.ok(clean.includes('制表'));
});

test('大写金额：伍拾万 = 500000 元', () => {
  assert.equal(upperCaseMoney('伍拾万元整'), 50000000);
  assert.equal(upperCaseMoney('肆仟捌佰陆拾元'), 486000);
  assert.equal(upperCaseMoney('壹万元'), 1000000);
  assert.equal(upperCaseMoney('没有大写数字'), null);
});

test('字段抽取：真实 OCR 文本里的关键字段全部认对', () => {
  const fields = extractPolicyFields(OCR_TEXT, { now: NOW });
  assert.equal(fields.kind, 'insurance');
  assert.equal(fields.name, '平安福重大疾病保险');
  assert.equal(fields.issuer, '中国平安人寿保险股份有限公司');
  assert.equal(fields.type, 'critical');
  assert.equal(fields.amount, 50000000, '保额 50 万');
  assert.equal(fields.premium, 486000, '年缴保费 4860');
  assert.equal(fields.policyNo, 'P2026110800123');
  assert.equal(fields.totalPeriods, 20);
  assert.equal(fields.payCycle, 'yearly');
  assert.equal(fields.dueDate, '2026-12-15', '每年12月15日 → 下一次发生日');
});

test('金额优先用括号里的阿拉伯数字，不靠不可靠的大写', () => {
  // OCR 常把「肆仟捌佰」认成「肆什抽佰」，阿拉伯数字才是可信来源
  const fields = extractPolicyFields('基本保险金额 人民币伍拾万元整 (500,000元)', { now: NOW });
  assert.equal(fields.amount, 50000000);
});

test('续保日按周年滚动到下一次', () => {
  // 今天 11-10，12-15 还没到 → 今年
  assert.equal(nextAnniversary(12, 15, NOW), '2026-12-15');
  // 今天 11-10，1-5 今年已过 → 明年
  assert.equal(nextAnniversary(1, 5, NOW), '2027-01-05');
  // 非法参数不返回垃圾
  assert.equal(nextAnniversary(13, 5, NOW), '');
  assert.equal(nextAnniversary(5, 40, NOW), '');
});

test('认不出时字段留空，不瞎填', () => {
  const fields = extractPolicyFields('这是一段没有任何保单信息的文字', { now: NOW });
  assert.equal(fields.amount, 0);
  assert.equal(fields.premium, 0);
  assert.equal(fields.policyNo, '');
  assert.equal(fields.dueDate, '');
});

test('存款/理财：本金与利率', () => {
  const deposit = extractPolicyFields('招商银行 三年期定期存款\n本金 100,000元\n年利率 3.50%\n到期日 2027年3月1日', { now: NOW });
  assert.equal(deposit.kind, 'deposit');
  assert.equal(deposit.amount, 10000000);
  assert.equal(deposit.rate, 350);
  assert.equal(deposit.dueDate, '2027-03-01');
  assert.equal(deposit.payCycle, 'once', '存款是一次性');
});

test('险种按关键词细化', () => {
  assert.equal(extractPolicyFields('百万医疗险', { now: NOW }).type, 'medical');
  assert.equal(extractPolicyFields('意外伤害保险', { now: NOW }).type, 'accident');
  assert.equal(extractPolicyFields('定期寿险', { now: NOW }).type, 'life');
  assert.equal(extractPolicyFields('养老年金保险', { now: NOW }).type, 'annuity');
  assert.equal(extractPolicyFields('机动车车险', { now: NOW }).type, 'car');
});
