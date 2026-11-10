/**
 * lib/policy-scan.js —— 上传保单附件，识别成结构化字段。
 *
 * 用户手上是一堆 PDF / 截图：电子保单、投保单、银行存单。让他们照着抄进
 * 表单是最劝退的环节，所以这里做「上传 → 识别 → 确认」。
 *
 * ## 隐私设计（这是本模块最重要的约束）
 *
 * 保单里是姓名、身份证号、保额、家庭关系，敏感度极高。所以：
 *
 *   1. **文件不出本机**：OCR 走本机安装的 tesseract，不调任何云服务；
 *   2. **默认不碰 AI**：字段抽取先用纯正则（`extractPolicyFields`），
 *      只有调用方显式要求时才把文本交给用户自己的模型；
 *   3. **临时文件必删**：上传的字节写到系统临时目录，识别完立刻删除。
 *
 * ## 识别的两条路径
 *
 *   PDF  → `sips` 栅格化成 PNG → tesseract OCR（macOS 自带 sips）
 *   图片 → 直接 tesseract OCR
 *   文本 → 原样使用
 *
 * 找不到 tesseract / sips 时不报错崩掉，而是返回「无法识别」+ 建议用户
 * 粘贴文本——很多 PDF 选中文字就能复制，这是最省事的兜底。
 *
 * @module dsh-finance/policy-scan
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';

import { parseAmountToCents } from './domain.js';

const run = promisify(execFile);

/** OCR 与转换的超时（毫秒）。大 PDF 首页可能慢，但超过这个就没意义了。 */
const OCR_TIMEOUT_MS = 60_000;

/** tesseract 的常见安装位置，按优先级找。 */
const TESSERACT_CANDIDATES = [
  '/opt/homebrew/bin/tesseract',
  '/usr/local/bin/tesseract',
  '/usr/bin/tesseract',
  'tesseract',
];

/** sips 的实际路径（macOS 自带）。 */
const SIPS = '/usr/bin/sips';

/**
 * 找可执行文件：先看绝对路径是否存在，最后交给 PATH。
 *
 * @param {string[]} candidates 候选路径
 * @returns {string|null} 可用的命令，或 null
 */
function findBinary(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    return candidate; // 让 execFile 去 PATH 里找
  }
  return null;
}

/** 当前机器能否做 OCR。面板据此决定按钮是启用还是给出提示。 */
export function scanCapability() {
  const tesseract = findBinary(TESSERACT_CANDIDATES);
  const hasSips = existsSync(SIPS);
  return {
    ocr: tesseract !== null,
    // PDF 需要栅格化；没有 sips 就只能处理图片与纯文本
    pdf: tesseract !== null && hasSips,
    tesseract,
    sips: hasSips ? SIPS : null,
  };
}

/**
 * 判断文件的类型。
 *
 * @param {string} name 文件名
 * @param {Uint8Array|string} content 内容
 * @returns {"pdf"|"image"|"text"} 类型
 */
export function detectFileKind(name, content) {
  const ext = extname(String(name ?? '')).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff'].includes(ext)) return 'image';
  if (['.txt', '.csv', '.md'].includes(ext)) return 'text';
  // 没有扩展名时看魔数：PDF 以 %PDF 开头
  if (typeof content !== 'string' && content instanceof Uint8Array) {
    const head = Buffer.from(content.slice(0, 5)).toString('latin1');
    if (head.startsWith('%PDF')) return 'pdf';
    // PNG / JPEG 魔数
    if (content[0] === 0x89 && content[1] === 0x50) return 'image';
    if (content[0] === 0xff && content[1] === 0xd8) return 'image';
  }
  return 'text';
}

/**
 * 用 tesseract 识别一张图片。
 *
 * `chi_sim+eng`：保单既有中文也有保单号、日期这类英文数字，两种都要。
 *
 * @param {string} imagePath 图片路径
 * @param {object} capability `scanCapability()` 的结果
 * @returns {Promise<string>} 识别出的文本
 */
async function ocrImage(imagePath, capability) {
  if (capability.tesseract === null) throw new Error('这台机器上没有安装 OCR 引擎（tesseract）');
  try {
    const { stdout } = await run(
      capability.tesseract,
      [imagePath, 'stdout', '-l', 'chi_sim+eng', '--psm', '6'],
      { timeout: OCR_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    // tesseract 有时会把「识别质量差」也当非零退出，但已经有输出
    if (error !== null && typeof error === 'object' && typeof error.stdout === 'string' && error.stdout.trim() !== '') {
      return error.stdout;
    }
    throw new Error(`OCR 失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 把 PDF 首页栅格化，供 OCR 使用。
 *
 * 保单的关键信息（保额、保费、保单号、生效日）几乎都在第一页的表格里，
 * 所以只转第一页——既快又避免把几十页扫描件全 OCR 一遍。
 *
 * @param {string} pdfPath PDF 路径
 * @param {string} outPath 输出 PNG 路径
 * @param {object} capability `scanCapability()` 的结果
 * @returns {Promise<boolean>} 是否成功
 */
async function rasterizePdf(pdfPath, outPath, capability) {
  if (capability.sips === null) return false;
  try {
    await run(capability.sips, ['-s', 'format', 'png', '-Z', '2400', pdfPath, '--out', outPath], {
      timeout: OCR_TIMEOUT_MS,
    });
    return existsSync(outPath);
  } catch {
    return false;
  }
}

/**
 * 扫描一份保单附件，返回 OCR 原文与抽取到的字段。
 *
 * @param {{ name?: string, content: Uint8Array|string }} file 文件
 * @param {{ capability?: object }} [options]
 * @returns {Promise<{ kind: string, text: string, fields: object, warnings: string[], capability: object }>}
 *   `fields` 里没认出的字段是 `''` / `0`，调用方据此决定要不要让用户补
 */
export async function scanPolicyFile(file, options = {}) {
  const capability = options.capability ?? scanCapability();
  const name = String(file?.name ?? 'upload');
  const content = file?.content;
  const kind = detectFileKind(name, content);
  const warnings = [];
  let text = '';

  if (kind === 'text') {
    text = typeof content === 'string' ? content : Buffer.from(content ?? []).toString('utf8');
  } else {
    // 二进制先落到临时目录，再交给 OCR；无论成败最后都删掉
    const dir = mkdtempSync(join(tmpdir(), 'dsh-finance-scan-'));
    try {
      const source = join(dir, basename(name) || 'upload.bin');
      writeFileSync(source, typeof content === 'string' ? Buffer.from(content, 'base64') : content);

      if (kind === 'pdf') {
        if (!capability.pdf) {
          throw new Error('这台机器无法把 PDF 转成图片（需要 macOS 的 sips）');
        }
        const png = join(dir, 'page1.png');
        const ok = await rasterizePdf(source, png, capability);
        if (!ok) throw new Error('PDF 转图失败，可能是加密或损坏的文件');
        text = await ocrImage(png, capability);
        warnings.push('只识别了 PDF 的第一页（保额、保费、保单号通常都在这一页）。');
      } else {
        text = await ocrImage(source, capability);
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 临时目录清理失败不该让整个识别失败
      }
    }
  }

  text = normalizeOcrText(text);
  if (text.trim() === '') {
    warnings.push('没读出文字。可以试试：把 PDF 里的文字直接复制粘贴，或换一张更清晰的截图。');
  }

  return {
    kind,
    text,
    fields: extractPolicyFields(text),
    warnings,
    capability: { ocr: capability.ocr, pdf: capability.pdf },
  };
}

/**
 * 整理 OCR 原文：去掉多余空行、全角空格，统一标点。
 *
 * OCR 会在中英文之间塞很多空格，也会把「，」认成「, 」。这里做最小清洗，
 * 但**保留原文**（`text` 字段），方便用户核对识别是否可信。
 *
 * @param {string} raw 原始文本
 * @returns {string} 清洗后的文本
 */
export function normalizeOcrText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\u00a0|\u3000/gu, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]{2,}/gu, '  ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

/* ────────────────────────── 字段抽取 ────────────────────────── */

/** 把「人民币伍拾万元整（500,000元）」里的阿拉伯数字取出来，取不到再解析大写。 */
function moneyFrom(text) {
  if (text === undefined || text === null) return 0;
  const source = String(text);
  // 优先括号里的阿拉伯数字：OCR 对大写数字（肆仟捌佰）容易认错，阿拉伯数字更可靠
  const bracket = /[（(]\s*(?:人民币)?\s*([\d,]+(?:\.\d+)?)\s*元?\s*[)）]/u.exec(source);
  if (bracket !== null) {
    const cents = parseAmountToCents(bracket[1].replace(/,/gu, ''));
    if (cents !== null) return Math.abs(cents);
  }
  // 再找裸的阿拉伯数字
  const plain = /([\d,]+(?:\.\d+)?)\s*(万)?\s*元/u.exec(source);
  if (plain !== null) {
    const base = Number(plain[1].replace(/,/gu, ''));
    if (Number.isFinite(base)) return Math.round((plain[2] === '万' ? base * 10000 : base) * 100);
  }
  // 最后退到大写数字
  const upper = upperCaseMoney(source);
  if (upper !== null) return upper;
  return 0;
}

/**
 * 解析中文大写金额（伍拾万 = 500000）。
 *
 * 只处理保单里常见的写法：壹贰叁肆伍陆柒捌玖拾佰仟万。OCR 常把它认错，
 * 所以这只是**兜底**——有阿拉伯数字时永远优先用阿拉伯数字。
 *
 * @param {string} text 文本
 * @returns {number|null} 分，或 null
 */
export function upperCaseMoney(text) {
  const DIGITS = { 零: 0, 壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9 };
  const UNITS = { 拾: 10, 佰: 100, 仟: 1000 };
  const source = String(text ?? '');
  const match = /[零壹贰叁肆伍陆柒捌玖拾佰仟万]+/u.exec(source);
  if (match === null) return null;
  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of match[0]) {
    if (char in DIGITS) {
      current = DIGITS[char];
    } else if (char in UNITS) {
      section += (current === 0 ? 1 : current) * UNITS[char];
      current = 0;
    } else if (char === '万') {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
    }
  }
  const value = total + section + current;
  return value > 0 ? value * 100 : null;
}

/**
 * 从 OCR 文本里抽取保单字段。
 *
 * 只做**有把握的**抽取：认不出就留空，让用户在预览里补。宁可少填，
 * 不能填错——保额差一个零是灾难。
 *
 * @param {string} text OCR 文本
 * @returns {object} 字段（未识别的为 '' / 0）
 */
export function extractPolicyFields(text, options = {}) {
  const source = String(text ?? '');
  const fields = {
    kind: '',
    name: '',
    issuer: '',
    type: '',
    amount: 0,
    premium: 0,
    rate: 0,
    policyNo: '',
    payCycle: '',
    dueDate: '',
    maturityDate: '',
    totalPeriods: 0,
    confidence: {},
  };

  /** 取「标签后面那一小段」文本。标签之间的分隔常见是空白、冒号或全角空格。 */
  const after = (label) => {
    const pattern = new RegExp(`${label}\\s*[:：]?\\s*([^\\n]{1,40})`, 'u');
    const match = pattern.exec(source);
    return match === null ? '' : match[1].trim();
  };

  // 保单号：字母 + 数字的组合，或纯长数字
  const policyNo = /(?:保单号|合同号|保单编号|保险单号)\s*[:：]?\s*([A-Za-z0-9\-]{6,})/u.exec(source);
  if (policyNo !== null) fields.policyNo = policyNo[1];

  // 保额
  const coverage = after('(?:基本保险金额|保险金额|保额)');
  if (coverage !== '') fields.amount = moneyFrom(coverage);

  // 保费
  const premium = after('(?:年交保费|年缴保费|保险费|保费|每期保费)');
  if (premium !== '') fields.premium = moneyFrom(premium);

  // 险种名称
  const product = after('(?:险种名称|产品名称|险种|保险产品)');
  if (product !== '') fields.name = clip(product);

  // 保险公司：出现在开头的公司名
  const issuer = /([\u4e00-\u9fa5]{2,12}(?:人寿|财产|健康|养老)?保险(?:股份)?(?:有限)?(?:责任)?公司)/u.exec(source);
  if (issuer !== null) {
    fields.issuer = issuer[1];
  } else {
    const bank = /([\u4e00-\u9fa5]{2,10}银行)/u.exec(source);
    if (bank !== null) fields.issuer = bank[1];
  }

  // 交费期间：20年交 / 趸交 / 一次性
  const periods = /(?:交费期间|缴费期间|交费期|保险期间)[:：\s]*(\d+)\s*年/u.exec(source);
  if (periods !== null) fields.totalPeriods = Number(periods[1]);
  if (/趸交|一次性缴清|一次性交/u.test(source)) fields.payCycle = 'once';
  else if (fields.totalPeriods > 0) fields.payCycle = 'yearly';

  // 日期：优先完整年月日，其次「每年M月D日」这种周年写法
  const dueFull = /(?:保险费应交日|应交日|续保日|到期日|满期日)[^0-9]{0,14}(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*[月.\-/]\s*(\d{1,2})/u.exec(source);
  if (dueFull !== null) {
    fields.dueDate = ymd(dueFull[1], dueFull[2], dueFull[3]);
    fields.confidence.dueDate = 'label';
  } else {
    // 「保险费应交日 每年12月15日」：保单的交费日是**周年重复**的，取下一次发生日
    const dueAnnual = /(?:保险费应交日|应交日|续保日|缴费日)[^0-9]{0,14}(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u.exec(source);
    if (dueAnnual !== null) {
      const next = nextAnniversary(Number(dueAnnual[1]), Number(dueAnnual[2]), options.now ?? Date.now());
      if (next !== '') {
        fields.dueDate = next;
        fields.confidence.dueDate = 'annual';
      }
    }
  }

  // 存款/理财：利率
  const rate = /(?:年利率|年化收益率|预期年化|利率)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/u.exec(source);
  if (rate !== null) fields.rate = Math.round(Number(rate[1]) * 100);

  // 推断类型。
  // 顺序很重要：**必须先判保险**。「定期寿险」里既有「定期」（像存款）
  // 又有「寿险」（是保险），先判存款就全错了。
  // 「险」单字也算保险信号——保单正文里「百万医疗险」「车险」常不带「保险」二字。
  if (/保险|保单|保费|保额|险种|险/u.test(source)) {
    fields.kind = 'insurance';
    if (/重疾|重大疾病/u.test(source)) fields.type = 'critical';
    else if (/医疗/u.test(source)) fields.type = 'medical';
    else if (/意外/u.test(source)) fields.type = 'accident';
    else if (/寿险|身故/u.test(source)) fields.type = 'life';
    else if (/年金|养老/u.test(source)) fields.type = 'annuity';
    else if (/车险|机动车/u.test(source)) fields.type = 'car';
    else if (/财产|家财/u.test(source)) fields.type = 'property';
    else fields.type = 'other';
  } else if (/定期|存单|存款/u.test(source)) {
    fields.kind = 'deposit';
    fields.payCycle = fields.payCycle || 'once';
    if (fields.premium === 0) fields.premium = 0;
    // 存款把本金放在 amount
    if (fields.amount === 0) fields.amount = moneyFrom(after('(?:本金|存款金额|存入金额)'));
  } else if (/理财|基金|净值/u.test(source)) {
    fields.kind = 'wealth';
    fields.payCycle = fields.payCycle || 'once';
  }

  // 名称兜底：没认出险种名就用文件名以外的第一行有意义文本
  if (fields.name === '') {
    const line = source.split('\n').map((item) => item.trim()).find((item) => item.length >= 4 && !/^[\d\s:：.\-/]+$/u.test(item));
    if (line !== undefined) fields.name = clip(line);
  }

  return fields;
}

/**
 * 拼一个 `YYYY-MM-DD`，月日补零。
 * @param {string|number} year 年
 * @param {string|number} month 月
 * @param {string|number} day 日
 * @returns {string} 日期
 */
function ymd(year, month, day) {
  return `${String(year)}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
}

/**
 * 「每年 M 月 D 日」的下一次发生日。
 *
 * 保单的交费日按周年重复，今天已经过了今年的那天就顺延到明年——
 * 提醒要看的是**下一次**，不是已经过去的那次。
 *
 * @param {number} month 月（1-12）
 * @param {number} day 日（1-31）
 * @param {number} now 当前时间戳
 * @returns {string} `YYYY-MM-DD`，参数非法时返回 ''
 */
export function nextAnniversary(month, day, now = Date.now()) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return '';
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  for (let offset = 0; offset <= 1; offset += 1) {
    const candidate = new Date(today.getFullYear() + offset, month - 1, day);
    // 2 月 29 日在平年会滚到 3 月 1 日，这是可接受的近似
    if (candidate.getTime() >= startOfToday) return ymd(candidate.getFullYear(), month, day);
  }
  return '';
}

/**
 * 截断过长文本（保单名称不该长到塞满一行）。
 * @param {string} value 文本
 * @param {number} [max=40] 最大长度
 * @returns {string} 截断后的文本
 */
function clip(value, max = 40) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}