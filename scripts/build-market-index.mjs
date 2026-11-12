/**
 * scripts/build-market-index.mjs —— 生成插件市场索引（format 1）。
 *
 * ## 这个文件是干什么的
 *
 * DSH 的「插件市场」不是中心化商店：它读**用户自己配置的索引 URL**。
 * 索引就是一份 JSON（format 1），列出可安装的插件、每个版本的来源与
 * 兼容范围。用户把索引 URL 填进 Discover 面板，就能搜到并一键安装。
 *
 * 所以「上架」= 把这份 JSON 发布到一个 https 地址上。
 *
 * ## 为什么要有生成脚本
 *
 * format 1 有两个字段必须精确，手写必错：
 *
 *   - `source.commit` 必须是 **40 位小写 commit SHA**。填 tag 名、短 SHA、
 *     annotated tag 的对象 SHA 都不行——pnpm 装不到东西。
 *   - `publishTimestamp` 是 **Unix 秒**（不是毫秒）。填毫秒会超出格式上限。
 *
 * 这个脚本从 git 与 package.json 现算这两个值，并按 format 1 的规则自查。
 *
 * 用法：
 *   node scripts/build-market-index.mjs            # 生成 market/index.json
 *   node scripts/build-market-index.mjs --check    # 只校验已有文件是否最新
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'market');
const OUT_FILE = join(OUT_DIR, 'index.json');

/** 索引的展示信息。改这里就能改市场里看到的标题与分类。 */
const INDEX = {
  title: { en: 'Wayne DSH Plugins', zh: 'Wayne 的 DSH 插件' },
  description: {
    en: 'Personal plugins for DeepSeek Harness: local-first finance and family policy management.',
    zh: 'DeepSeek Harness 个人插件：本地优先的记账与家庭保单管理。',
  },
  categories: {
    finance: { title: { en: 'Finance', zh: '理财记账' } },
  },
  labels: {
    localFirst: { title: { en: 'Local-first', zh: '本地优先' } },
    offline: { title: { en: 'Works offline', zh: '离线可用' } },
  },
  sortKeys: {
    stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
  },
};

/** 每个插件条目里不随版本变化的部分。 */
const PLUGIN_META = {
  title: { en: 'Family Finance & Policy Desk', zh: '家庭保单管家 · 记账工作台' },
  description: {
    en: 'Import Alipay/WeChat bills with automatic de-duplication, record anything in one sentence, upload insurance contracts for local OCR, and see income, assets, coverage and debt on one dashboard. Data never leaves your machine.',
    zh: '导入支付宝/微信账单自动分类并跨账单去重，一句话录入流水、资产、持仓、保单、负债；上传保单合同本地 OCR 识别并生成保障卡片；总看板一屏看全收支、资产、保障与负债。数据只存本机。',
  },
  author: 'WayneZhon',
  repository: 'https://github.com/WayneZhon/dsh-finance',
  homepage: 'https://github.com/WayneZhon/dsh-finance#readme',
  category: 'finance',
  labels: ['localFirst', 'offline'],
  keywords: [
    'dsh-plugin',
    'personal-finance',
    'expense-tracker',
    'bill-import',
    'alipay',
    'wechat-pay',
    'insurance',
    'policy',
    '记账',
    '保单',
    '理财',
  ],
};

/** 跑一条 git 命令，返回去尾换行的输出。 */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/**
 * 取 HEAD 的完整 commit SHA。
 *
 * 注意 `git rev-parse v1.0.0` 在 annotated tag 上返回的是 **tag 对象**的 SHA，
 * 不是 commit——必须用 `^{commit}` 解引用，否则 pnpm 装不下来。
 *
 * @param {string} ref git 引用
 * @returns {string} 40 位小写 SHA
 */
function commitOf(ref) {
  const sha = git(['rev-parse', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error(`${ref} 不是合法 commit SHA：${sha}`);
  return sha;
}

/** 取该 commit 的提交时间（Unix 秒）。 */
function publishedAt(sha) {
  const seconds = Number(git(['show', '-s', '--format=%ct', sha]));
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`读不出 ${sha} 的提交时间`);
  return seconds;
}

/* ────────────────────────── format 1 的自查 ────────────────────────── */

const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const MAX_TIMESTAMP = 1e11;

/** 收一份错误清单，而不是遇到第一个就抛——一次改完比来回试快。 */
const problems = [];
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

/**
 * 校验本地化文本：字符串，或以语言 id 为键、**必须含 en** 的对象。
 * @param {unknown} value 值
 * @param {string} path 位置
 */
function checkLocalized(value, path) {
  if (typeof value === 'string') return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${path} 必须是字符串或语言对象`);
    return;
  }
  for (const [language, text] of Object.entries(value)) {
    check(LANGUAGE_ID.test(language), `${path}.${language} 必须是小写语言 id`);
    check(typeof text === 'string' && text.trim() !== '', `${path}.${language} 不能为空`);
  }
  check(Object.hasOwn(value, 'en'), `${path} 必须包含 en`);
}

/** 校验整份索引。 */
function validate(index) {
  check(index.format === 1, '$.format 必须是 1');
  checkLocalized(index.title, '$.title');
  if (index.description !== undefined) checkLocalized(index.description, '$.description');
  check(Array.isArray(index.plugins), '$.plugins 必须是数组');

  const declaredCategories = Object.keys(index.metadata?.categories ?? {});
  const declaredLabels = Object.keys(index.metadata?.labels ?? {});
  const names = new Set();

  for (const [position, plugin] of (index.plugins ?? []).entries()) {
    const at = `$.plugins[${String(position)}]`;
    check(typeof plugin.name === 'string' && PACKAGE_NAME.test(plugin.name), `${at}.name 不是合法 npm 包名`);
    check(!names.has(plugin.name), `${at}.name 重复：${plugin.name}`);
    names.add(plugin.name);
    if (plugin.title !== undefined) checkLocalized(plugin.title, `${at}.title`);
    if (plugin.description !== undefined) checkLocalized(plugin.description, `${at}.description`);
    if (plugin.homepage !== undefined) {
      check(/^https?:\/\//u.test(plugin.homepage), `${at}.homepage 必须是 http(s)`);
    }
    if (plugin.repository !== undefined) {
      check(/^https?:\/\//u.test(plugin.repository), `${at}.repository 必须是 http(s)`);
      check(!plugin.repository.includes('#'), `${at}.repository 不能带 fragment`);
    }
    const category = plugin.metadata?.category;
    if (category !== undefined) check(declaredCategories.includes(category), `${at}.metadata.category 未声明`);
    for (const label of plugin.metadata?.labels ?? []) {
      check(declaredLabels.includes(label), `${at}.metadata.label 未声明：${label}`);
    }

    check(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${at}.versions 不能为空`);
    const seen = new Set();
    for (const [index2, version] of (plugin.versions ?? []).entries()) {
      const vat = `${at}.versions[${String(index2)}]`;
      check(SEMVER.test(version.version), `${vat}.version 不是精确 SemVer`);
      check(!seen.has(version.version), `${vat}.version 重复`);
      seen.add(version.version);
      const stamp = version.publishTimestamp;
      check(
        Number.isInteger(stamp) && stamp >= 0 && stamp < MAX_TIMESTAMP,
        `${vat}.publishTimestamp 必须是 [0,1e11) 的**整数秒**（不是毫秒）`
      );
      const source = version.source ?? {};
      if (source.type === 'git') {
        check(COMMIT.test(source.commit ?? ''), `${vat}.source.commit 必须是 40 位小写 SHA`);
        check(/^https:\/\//u.test(source.url ?? ''), `${vat}.source.url 必须是 https`);
        check(!/\.(?:tgz|tar\.gz)$/iu.test(source.url ?? ''), `${vat}.source.url 必须是仓库地址而不是压缩包`);
        const segments = (source.url ?? '').replace(/^https:\/\/[^/]+/u, '').split('/').filter(Boolean);
        check(segments.length >= 2, `${vat}.source.url 至少要有 owner/repo 两段`);
      } else if (source.type === 'npm') {
        check(true, '');
      } else {
        problems.push(`${vat}.source.type 必须是 "npm" 或 "git"`);
      }
      const dshRange = version.engines?.dsh;
      if (dshRange !== undefined) {
        check(typeof dshRange === 'string' && dshRange.trim() !== '', `${vat}.engines.dsh 不能为空`);
        check(!dshRange.startsWith('workspace:'), `${vat}.engines.dsh 不能用 workspace: 范围`);
      }
    }
  }
}

/* ────────────────────────── 主流程 ────────────────────────── */

const readPackage = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * 生成索引文档。
 *
 * 用 `source: git` 而不是 npm：包还没发布到 npm 时，git 来源是唯一
 * 「别人真能装上」的路径，且 commit 钉死之后内容不会漂移。
 *
 * @returns {object} format 1 索引
 */
function buildIndex() {
  const pkg = readPackage();
  const sha = commitOf('HEAD');
  // engines.dsh 没写就不填——格式允许缺省，缺省即不做版本约束。
  //
  // 这里有个 semver 陷阱必须避开：当前 DSH 是 `0.2.1-rc.5` 这种**预发布版**，
  // 而预发布版本不满足 `>=0.2.1` 这类范围（semver 规则：范围里没有预发布
  // 标识时排除预发布版本）。随手写一个 `>=0.2.1` 会把插件标成「不兼容」，
  // 反而装不上。要约束就得写 `>=0.2.1-0`。宁可不约束，也不写错。
  const dshRange = pkg.engines?.dsh;
  const version = {
    version: pkg.version,
    publishTimestamp: publishedAt(sha),
    source: {
      type: 'git',
      url: PLUGIN_META.repository,
      // 必须是 commit，不能是 tag
      commit: sha,
    },
  };
  if (typeof dshRange === 'string' && dshRange !== '') version.engines = { dsh: dshRange };

  return {
    format: 1,
    title: INDEX.title,
    description: INDEX.description,
    metadata: { categories: INDEX.categories, labels: INDEX.labels, sortKeys: INDEX.sortKeys },
    plugins: [
      {
        name: pkg.name,
        title: PLUGIN_META.title,
        description: PLUGIN_META.description,
        author: PLUGIN_META.author,
        homepage: PLUGIN_META.homepage,
        repository: PLUGIN_META.repository,
        metadata: {
          category: PLUGIN_META.category,
          labels: PLUGIN_META.labels,
          keywords: PLUGIN_META.keywords,
          // stars 只用于排序展示，这里不给假数据，留空即可
        },
        versions: [version],
      },
    ],
  };
}

const checkOnly = process.argv.includes('--check');
const index = buildIndex();
validate(index);

if (problems.length > 0) {
  console.error('索引不符合 format 1：');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}

const serialized = `${JSON.stringify(index, null, 2)}\n`;

if (checkOnly) {
  if (!existsSync(OUT_FILE)) {
    console.error('market/index.json 不存在，先跑一次不带 --check 的生成');
    process.exit(1);
  }
  if (readFileSync(OUT_FILE, 'utf8') !== serialized) {
    console.error('market/index.json 不是最新的：commit 或版本变了，重新生成');
    process.exit(1);
  }
  console.log('market/index.json 是最新的');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, serialized);
const entry = index.plugins[0];
const installed = entry.versions[0];
console.log(`wrote market/index.json —— ${entry.name}@${installed.version}`);
console.log(`  commit: ${installed.source.commit}`);
console.log(`  发布:   ${new Date(installed.publishTimestamp * 1000).toISOString()}`);
