/**
 * @wayne/dsh-finance · Host half.
 *
 * 一个本机账本文件（`~/.dsh/dsh-finance/finance.json`）、一套给四页驾驶舱用的
 * HTTP 接口、一个从用户**自己的**默认模型流式取字的 AI 桥，以及八个 agent 工具。
 * 除了 Harness 本来就会发出的模型调用之外，任何数据都不离开这台机器。
 *
 * 真正必须由 Host 集成来的部分放在这里，而不是 `lib/`：
 *
 *   - 模型调用：`ctx.llm.stream()` 走用户的默认路由
 *     （`ctx.get("agentDefaultModel").currentSelection()`），只取可见文本；
 *   - 面板接口：注册在 `ctx.webServer` 的 `/dsh-finance/api` 前缀上；
 *   - 工具：`ctx.tools.register()`（八个 `finance_*`）。
 *
 * 其余（文件存储、账单解析、规则分类、看板聚合、路由表、AI 桥）都在 `lib/`
 * 里，是带自己测试的普通模块。
 *
 * 这个插件**不**碰银行、**不**下单、**不**给投资建议：它只记录和展示。
 *
 * @module @wayne/dsh-finance
 */

import { createAiBridge } from "./lib/ai.js";
import { createStore } from "./lib/store.js";
import { registerRoutes } from "./lib/routes.js";
import { registerTools } from "./lib/tools.js";
import { scanPolicyFile } from "./lib/policy-scan.js";

/** 插件身份（cordis 行与诊断用）。 */
export const name = "@wayne/dsh-finance";

/**
 * 硬依赖。`tools` 是必需的（八个 agent 工具）；`webServer` 负责面板接口，
 * 但纯 CLI 的运行里可能根本没有它，所以只在 `apply` 里做可选激活，不写进
 * 这里的硬注入。
 */
export const inject = ["tools"];

/**
 * 挂载 Host 半边。
 *
 * @param {object} ctx 插件上下文（已含 `tools`）。
 * @param {{ file?: string, dataFile?: string, timeoutMs?: number, exportDir?: string }} [config] 可选配置。
 */
export function apply(ctx, config = {}) {
  const log = (message, error) => {
    try {
      if (error === undefined) console.warn(`[dsh-finance] ${message}`);
      else console.warn(`[dsh-finance] ${message}`, error);
    } catch {
      // 日志本身抛异常不能把插件带下去。
    }
  };

  const store = createStore({
    ...(typeof config.file === "string" && config.file !== "" ? { file: config.file } : {}),
    ...(typeof config.dataFile === "string" && config.dataFile !== "" ? { file: config.dataFile } : {}),
    log: (entry) => {
      // store 用 `{ level, message }` 汇报，转成一行可读的警告。
      if (entry !== null && typeof entry === "object") log(String(entry.message ?? ""));
      else log(String(entry));
    }
  });

  // 尽早打开：文件坏了在启动时报一条警告，而不是等用户第一次点开看板时炸。
  try {
    store.ready().catch((error) => log("账本加载失败：", error));
  } catch (error) {
    log("账本加载失败：", error);
  }

  // 装完就是干净账本：不再自动铺演示数据，用户第一次点开看到的是引导页，
// 由他自己决定「导入账单」还是「先看看示例」。
  //
  // 旧版本会给空账本自动铺 12 个月演示数据。这个行为已经去掉（默认
  // `demo: false`）——理财插件里的数字必须先是用户自己的，演示数据再好看
  // 也只是一份需要被清掉的干扰。想恢复旧行为可设 `demo: true`。
  if (config.demo === true) {
    try {
      Promise.resolve()
        .then(() => store.seedDemoIfEmpty())
        .then((seeded) => {
          if (seeded === true) log("已铺好演示账本（12 个月），随时可在面板里清空");
        })
        .catch((error) => log("演示账本初始化跳过：", error));
    } catch (error) {
      log("演示账本初始化跳过：", error);
    }
  }

  const ai = createAiBridge({
    selection: () => selectionOf(ctx, log),
    streamText: (request) => streamText(ctx, request, log),
    ...(Number.isFinite(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {})
  });

  /** 工具用的依赖：fs 服务（读账单、写导出）、工作目录与 AI 桥。 */
  const toolDeps = () => ({
    store,
    ai,
    // 保单附件识别（本地 OCR）：工具与路由共用同一个实现
    scanPolicyFile: (file) => scanPolicyFile(file),
    fs: serviceOf(ctx, "fs"),
    cwd: workingDirectoryOf(ctx),
    log,
    config: typeof config === "object" && config !== null ? config : {}
  });

  // ── agent 工具 ─────────────────────────────────────────────────────────
  try {
    const disposers = registerTools(ctx, toolDeps());
    ctx.effect(
      () => () => {
        for (const dispose of disposers.splice(0).reverse()) {
          try {
            dispose();
          } catch {
            // 插件卸载时工具本来也会一起消失。
          }
        }
      },
      "dsh-finance: tools"
    );
  } catch (error) {
    log("工具注册失败：", error);
  }

  // ── 面板接口 ───────────────────────────────────────────────────────────
  const mountRoutes = (webCtx) => {
    try {
      return registerRoutes(webCtx, { store, ai });
    } catch (error) {
      log("理财接口注册失败：", error);
      return () => {};
    }
  };
  if (typeof ctx.inject === "function") {
    // 可选依赖：有 web server 的地方才有面板，没有的地方工具照常可用。
    ctx.inject(["webServer"], (webCtx) => {
      webCtx.effect(() => mountRoutes(webCtx), "dsh-finance: routes");
    });
  } else if (typeof ctx.get === "function" && ctx.get("webServer") !== undefined) {
    const dispose = mountRoutes(ctx);
    ctx.effect(() => dispose, "dsh-finance: routes");
  }
}

/**
 * 读一个 Host 服务，读不到就返回 null（可选依赖一律不抛）。
 * @param {object} ctx 插件上下文。
 * @param {string} key 服务名。
 * @returns {unknown} 服务或 null。
 */
function serviceOf(ctx, key) {
  try {
    if (typeof ctx.get === "function") return ctx.get(key) ?? null;
    return ctx[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * 当前会话的工作目录（导出文件的默认落点）。
 * @param {object} ctx 插件上下文。
 * @returns {string} 绝对路径。
 */
function workingDirectoryOf(ctx) {
  try {
    const service = serviceOf(ctx, "workingDirectory");
    if (service !== null && service !== undefined && typeof service.defaultDirectory === "string" && service.defaultDirectory !== "") {
      return service.defaultDirectory;
    }
  } catch {
    // 没有工作目录服务就用进程的 cwd。
  }
  return process.cwd();
}

/**
 * 用户的默认模型路由；没有配置时返回 null。
 *
 * 读 Host 服务而不是 Config 字段，这样面板会跟随用户在「设置 → 模型」里的选择。
 * @param {object} ctx 插件上下文。
 * @param {(message: string, error?: unknown) => void} log 诊断出口。
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | null} 选择。
 */
function selectionOf(ctx, log) {
  try {
    const service = serviceOf(ctx, "agentDefaultModel");
    if (service === null || service === undefined || typeof service.currentSelection !== "function") return null;
    const selected = service.currentSelection();
    if (selected === null || selected === undefined) return null;
    const provider = typeof selected.provider === "string" ? selected.provider : "";
    const model = typeof selected.model === "string" ? selected.model : "";
    if (provider === "" || model === "") return null;
    return {
      provider,
      model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) })
    };
  } catch (error) {
    log("读取默认模型失败：", error);
    return null;
  }
}

/**
 * 调一次模型并把文本收齐。
 *
 * Host 的 `llm.stream()` 吐的是原始 chunk，这里只留可见文本：累积
 * `text-delta`，`finish.reason.kind === "error"` 时用 provider 的原话 reject
 * （桥会把它记成一次模型错误，接口随即降级到规则提示）。
 * @param {object} ctx 插件上下文。
 * @param {{ system: string, user: string, signal: AbortSignal }} request 调用参数。
 * @param {(message: string, error?: unknown) => void} log 诊断出口。
 * @returns {Promise<string>} 模型的文本。
 */
async function streamText(ctx, request, log) {
  const llm = serviceOf(ctx, "llm");
  if (llm === null || llm === undefined || typeof llm.stream !== "function") {
    throw Object.assign(new Error("这个 Harness 里没有可用的模型服务"), { code: "no-llm" });
  }
  const selection = selectionOf(ctx, log);
  if (selection === null) throw Object.assign(new Error("还没有选择默认模型"), { code: "no-model" });
  const options = {
    provider: selection.provider,
    model: selection.model,
    system: request.system,
    messages: [{ role: "user", content: [{ type: "text", text: request.user }] }],
    signal: request.signal
  };
  if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort;
  let text = "";
  for await (const chunk of llm.stream(options)) {
    if (chunk === null || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
    else if (chunk.type === "block-end" && chunk.block?.type === "text" && text === "" && typeof chunk.block.text === "string") {
      // 只报整块的 provider：没有 delta 时用它。
      text = chunk.block.text;
    } else if (chunk.type === "finish") {
      const reason = chunk.reason;
      if (reason?.kind === "error") {
        throw Object.assign(new Error(reason.failure?.message ?? "模型调用失败"), { code: reason.failure?.code ?? "model-error" });
      }
      if (reason?.kind === "aborted") {
        throw Object.assign(new Error("模型调用被取消"), { code: "aborted" });
      }
      break;
    }
  }
  return text;
}