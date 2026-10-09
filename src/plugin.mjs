// Magpie runs this as an OpenCode v1 provider plugin. The virtual provider
// answers locally; only the evaluation engine talks to the configured gateway.
const PROVIDER = "codex-sentinel";
const VIRTUAL_BASE = "http://127.0.0.1:1/codex-sentinel/v1";
const MODELS = {
  quick: "Codex 检测 · 快速",
  standard: "Codex 检测 · 标准",
  fingerprint: "Codex 检测 · 行为指纹",
  history: "Codex 检测 · 历史与基线",
};

function abortError(reason) {
  return reason instanceof Error ? reason : new DOMException("检测已取消", "AbortError");
}

function assertActive(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

function linkAbort(parent) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    controller,
    cleanup() {
      parent?.removeEventListener("abort", abort);
    },
  };
}

function userText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
  }
  return "";
}

function actionFor(model, text) {
  // Plain text works in agents that intercept their own /slash commands.
  if (/^sentinel (check|fingerprint|history)$/.test(text)) text = '/' + text.slice(9);
  if (text.startsWith('sentinel baseline ')) text = '/baseline ' + text.slice(18);
  if ((model === "quick" || model === "standard") && text === "/check") {
    return { kind: "evaluation", profile: model };
  }
  if (model === "fingerprint" && text === "/fingerprint") {
    return { kind: "fingerprint", profile: "fingerprint" };
  }
  if (model === "history" && text === "/history") return { kind: "history" };
  if (model === "history" && /^\/baseline\s+\S/.test(text)) {
    return { kind: "baseline", runIds: text.split(/\s+/).slice(1) };
  }
  return null;
}

function inline(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return "`" + value.trim().replace(/[\r\n`]/g, " ").slice(0, 200) + "`";
}

function gatewayLabel(value) {
  if (typeof value !== "string" || !value.trim()) return "自动使用本机 Magpie 网关";
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return inline(url.toString(), "尚未配置");
  } catch {
    return "配置格式有误，请检查 baseUrl";
  }
}

function help(model, options) {
  const config = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const command = model === "fingerprint" ? "sentinel fingerprint" : model === "history" ? "sentinel history" : "sentinel check";
  return [
    `# ${MODELS[model]}`,
    "",
    "这是 Codex Sentinel 的诊断入口。只有发送下面的完整指令才会执行；普通聊天与 Magpie 的连接测试只返回本说明。",
    "",
    `- 当前目标：${inline(config.target, "未设置，请在插件选项配置 target")}`,
    `- 网关：${gatewayLabel(config.baseUrl)}`,
    `- 推理强度：${inline(config.effort, "使用检测引擎的默认配置")}`,
    `- 账户：${config.account ? "已配置固定账户" : "未固定，结果只能用于该路由的整体比较"}`,
    "",
    `当前入口的指令：**\`${command}\`**。`,
    "",
    "| 模型入口 | 完整指令 | 功能 |",
    "| --- | --- | --- |",
    "| quick | `sentinel check` | 快速运行内置评测 |",
    "| standard | `sentinel check` | 标准评测并与已设置的基线比较 |",
    "| fingerprint | `sentinel fingerprint` | 收集辅助行为信号 |",
    "| history | `sentinel history` | 查看本地检测记录，不调用模型 |",
    "| history | `sentinel baseline id1 id2 id3` | 使用检测记录建立基线；引擎会校验记录是否可比较 |",
    "",
    "评测只发送内置题目，不会发送这段聊天的工作内容。主动检测会使用被测模型的额度。检测结果反映测试表现，不能证明服务商暗中更换了模型。",
  ].join("\n");
}

function visibleError(error, apiKey) {
  let message = typeof error?.message === "string" ? error.message : "执行失败，请检查配置后重试。";
  if (apiKey && apiKey !== "magpie") message = message.split(apiKey).join("[已隐藏密钥]");
  return message
    .replace(/(Bearer\s+)[^\s,;]+/gi, "$1[已隐藏密钥]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已隐藏凭据]@")
    .slice(0, 1000);
}

function progressText(event, apiKey) {
  if (typeof event === "string") return visibleError({ message: event }, apiKey);
  if (typeof event?.message === "string") return visibleError({ message: event.message }, apiKey);
  if (Number.isFinite(event?.completed) && Number.isFinite(event?.total)) {
    return `已完成 ${event.completed}/${event.total} 项。`;
  }
  return "";
}

async function requestBody(input, init) {
  let text;
  const body = init?.body;
  if (typeof body === "string") text = body;
  else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) text = new TextDecoder().decode(body);
  else if (body && typeof body.text === "function") text = await body.text();
  else if (body == null && input instanceof Request) text = await input.clone().text();
  else throw new Error("请求体需要合法的 JSON 对象。");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("请求体需要合法的 JSON 对象。");
  }
  return parsed;
}

function responseHeaders(stream = false) {
  return {
    "content-type": stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    // An error from the tested target must not sign the virtual provider out.
    "x-magpie-sign-in": "kept",
  };
}

function invalidRequest(message) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status: 400,
    headers: responseHeaders(),
  });
}

function envelope(model, streaming) {
  return {
    id: `chatcmpl-sentinel-${crypto.randomUUID()}`,
    object: streaming ? "chat.completion.chunk" : "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function jsonAnswer(model, text) {
  return new Response(JSON.stringify({
    ...envelope(model, false),
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  }), { headers: responseHeaders() });
}

function startText(action) {
  switch (action?.kind) {
    case "evaluation":
      return `开始${action.profile === "quick" ? "快速" : "标准"}检测。仅发送内置评测题目。\n\n`;
    case "fingerprint":
      return "开始行为指纹探测。结果是辅助信号，不代表模型身份证明。\n\n";
    case "history":
      return "正在读取本地检测记录。\n\n";
    case "baseline":
      return "正在验证记录并更新基线。\n\n";
    default:
      return "";
  }
}

function streamAnswer({ model, action, signal: parent, execute, apiKey }) {
  const { controller: aborter, cleanup } = linkAbort(parent);
  const signal = aborter.signal;
  const encoder = new TextEncoder();
  const base = envelope(model, true);
  let ended = false;
  let stopOutput;
  const stream = new ReadableStream({
    start(controller) {
      const send = (delta, finish = null) => {
        if (ended) return;
        controller.enqueue(encoder.encode("data: " + JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) + "\n\n"));
      };
      const finish = () => {
        if (ended) return;
        send({}, "stop");
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        ended = true;
        controller.close();
      };
      const onAbort = () => {
        if (!ended) {
          ended = true;
          controller.error(abortError(signal.reason));
        }
        cleanup();
      };
      stopOutput = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        stopOutput();
        return;
      }
      // A real first text chunk keeps the caller alive during a long test.
      if (action) send({ role: "assistant", content: startText(action) });
      queueMicrotask(async () => {
        try {
          const text = await execute(signal, (event) => {
            const line = progressText(event, apiKey);
            if (line && !signal.aborted) send({ content: line + "\n\n" });
          });
          assertActive(signal);
          send({ ...(action ? {} : { role: "assistant" }), content: String(text) });
          finish();
        } catch (error) {
          if (!signal.aborted && !ended) {
            send({ content: `\n检测未完成：${visibleError(error, apiKey)}\n` });
            finish();
          }
        } finally {
          cleanup();
          stopOutput();
        }
      });
    },
    cancel(reason) {
      ended = true;
      aborter.abort(reason);
      cleanup();
      stopOutput?.();
    },
  });
  return new Response(stream, { headers: responseHeaders(true) });
}

function createPlugin(injectedEngine) {
  let enginePromise;
  const engine = () => injectedEngine
    ? Promise.resolve(injectedEngine)
    : (enginePromise ??= import("./engine.mjs"));

  return async function CodexSentinelPlugin(input = {}, options) {
    const directory = input.directory;

    async function answer(fetchInput, init, apiKey) {
      const signal = init?.signal ?? (fetchInput instanceof Request ? fetchInput.signal : undefined);
      assertActive(signal);
      let body;
      try {
        body = await requestBody(fetchInput, init);
      } catch {
        assertActive(signal);
        return invalidRequest("请求体需要合法的 JSON 对象。");
      }
      assertActive(signal);
      const model = typeof body.model === "string" ? body.model.replace(/^codex-sentinel\//, "") : "";
      if (!Object.hasOwn(MODELS, model)) return invalidRequest("未知诊断模型，请选择 quick、standard、fingerprint 或 history。");
      const action = actionFor(model, userText(body.messages));

      const execute = async (runSignal, onProgress) => {
        assertActive(runSignal);
        if (!action) return help(model, options);
        const impl = await engine();
        assertActive(runSignal);
        const shared = { options, apiKey, directory };
        if (action.kind === "history") {
          const rows = await impl.getHistory(shared);
          assertActive(runSignal);
          return impl.formatHistory(rows);
        }
        if (action.kind === "baseline") {
          await impl.setBaseline({ ...shared, runIds: action.runIds, signal: runSignal });
          assertActive(runSignal);
          return `基线已更新。\n\n使用的检测记录：${action.runIds.map((id) => inline(id, "")).join("、")}。\n\n发送 \`sentinel history\` 查看记录，之后在 standard 入口发送 \`sentinel check\` 进行比较。quick 只作初筛。`;
        }
        const args = { ...shared, profile: action.profile, signal: runSignal, onProgress };
        const report = action.kind === "fingerprint"
          ? await impl.runFingerprint(args)
          : await impl.runEvaluation(args);
        assertActive(runSignal);
        return impl.formatReport(report);
      };

      if (body.stream === true) {
        return streamAnswer({ model, action, signal, execute, apiKey });
      }
      try {
        return jsonAnswer(model, await execute(signal, () => {}));
      } catch (error) {
        assertActive(signal);
        return jsonAnswer(model, `检测未完成：${visibleError(error, apiKey)}`);
      }
    }

    return {
      async config(config) {
        config.provider ??= {};
        config.provider[PROVIDER] = {
          name: "Codex Sentinel · 能力检测",
          npm: "@ai-sdk/openai-compatible",
          api: VIRTUAL_BASE,
          models: Object.fromEntries(Object.entries(MODELS).map(([id, name]) => [id, {
            name,
            limit: { context: 200000, output: 16000 },
            tool_call: false,
            reasoning: false,
            modalities: { input: ["text"], output: ["text"] },
          }])),
        };
      },
      auth: {
        provider: PROVIDER,
        maxConcurrency: 1,
        methods: [{ type: "api", label: "Magpie 网关密钥（本机可填 magpie）", placeholder: "magpie" }],
        async loader(getAuth) {
          const auth = await getAuth();
          const key = auth?.type === "api" && typeof auth.key === "string" ? auth.key : "magpie";
          return {
            baseURL: VIRTUAL_BASE,
            apiKey: key,
            // Do not call fetch(fetchInput): the URL is a local placeholder.
            fetch: (fetchInput, init) => answer(fetchInput, init, key),
          };
        },
      },
      provider: {
        id: PROVIDER,
        async models(provider) {
          return provider.models;
        },
      },
    };
  };
}

export default createPlugin();

// Magpie calls exported functions as plugins. Helpers stay in one object;
// the public package entry point re-exports only the default plugin.
export const _internal = { createPlugin, userText, actionFor };
