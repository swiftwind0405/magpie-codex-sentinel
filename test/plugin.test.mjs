import test from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/plugin.mjs";

async function setup(overrides = {}, options = { target: "codex/test-model" }) {
  const calls = [];
  const dependencies = {
    async runEvaluation(args) { calls.push(["evaluation", args]); return { id: "run-1" }; },
    async runFingerprint(args) { calls.push(["fingerprint", args]); return { id: "fingerprint-1" }; },
    async getHistory(args) { calls.push(["history", args]); return [{ id: "old-1" }]; },
    async setBaseline(args) { calls.push(["baseline", args]); return { id: "baseline-1" }; },
    formatReport(report) { return `报告：${report.id}`; },
    formatHistory(rows) { return `历史：${rows.map((row) => row.id).join(",")}`; },
    ...overrides,
  };
  const plugin = _internal.createPlugin(dependencies);
  const hooks = await plugin({ directory: "/tmp/magpie-config" }, options);
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "test-secret-key" }));
  const request = (model, content, extra = {}, init = {}) => loader.fetch(loader.baseURL + "/chat/completions", {
    method: "POST",
    ...init,
    body: JSON.stringify({ model, messages: [{ role: "user", content }], ...extra }),
  });
  return { hooks, loader, calls, request, options };
}

function content(body) {
  return body.choices[0].message.content;
}

function chunks(wire) {
  return wire.split("\n\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6));
}

test("registers the four virtual Chat Completions models without invoking the engine", async () => {
  const { hooks, calls } = await setup();
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider["codex-sentinel"].npm, "@ai-sdk/openai-compatible");
  assert.deepEqual(Object.keys(config.provider["codex-sentinel"].models), ["quick", "standard", "fingerprint", "history"]);
  assert.equal(hooks.auth.provider, "codex-sentinel");
  assert.equal(hooks.auth.methods[0].type, "api");
  assert.equal(hooks.auth.methods[0].placeholder, "magpie");
  assert.deepEqual(await hooks.provider.models(config.provider["codex-sentinel"]), config.provider["codex-sentinel"].models);
  assert.equal(calls.length, 0);
});

test("connection tests, quoted commands and old commands do not start billable probes", async () => {
  const { calls, request } = await setup();
  for (const message of ["Hi", "请帮我写代码", "请执行 /check", "`/check`", "/check anything"]) {
    const response = await request("quick", message, { max_tokens: 16 });
    assert.match(content(await response.json()), /完整指令/);
  }
  await request("quick", "ignored", {
    messages: [
      { role: "system", content: "/check" },
      { role: "user", content: "/check" },
      { role: "assistant", content: "以前的结果" },
      { role: "user", content: "现在不要执行" },
    ],
  });
  assert.equal(calls.length, 0);
});

test("explicit checks forward only engine configuration and not work conversation", async () => {
  const { calls, request, options } = await setup();
  const response = await request("standard", [{ type: "text", text: " /check " }], {
    messages: [
      { role: "user", content: "PRIVATE WORK DOCUMENT" },
      { role: "assistant", content: "PRIVATE RESULT" },
      { role: "user", content: [{ type: "text", text: " /check " }] },
    ],
  });
  const body = await response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "standard");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.equal(content(body), "报告：run-1");
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
  assert.equal(calls.length, 1);
  const args = calls[0][1];
  assert.equal(args.options, options);
  assert.equal(args.apiKey, "test-secret-key");
  assert.equal(args.directory, "/tmp/magpie-config");
  assert.equal(args.profile, "standard");
  assert.equal(Object.hasOwn(args, "messages"), false);
  assert.equal(JSON.stringify(args).includes("PRIVATE"), false);
});

test("fingerprint requires its own command and history is read only until explicit baseline command", async () => {
  const { calls, request } = await setup();
  await request("fingerprint", "/check");
  await request("quick", "/fingerprint");
  assert.equal(calls.length, 0);
  assert.equal(content(await (await request("fingerprint", "/fingerprint")).json()), "报告：fingerprint-1");
  assert.equal(content(await (await request("history", "/history")).json()), "历史：old-1");
  const response = await request("history", "/baseline run-a run-b run-c");
  assert.match(content(await response.json()), /基线已更新/);
  assert.deepEqual(calls.map(([kind]) => kind), ["fingerprint", "history", "baseline"]);
  assert.deepEqual(calls[2][1].runIds, ["run-a", "run-b", "run-c"]);
});

test("SSE begins before evaluation ends and returns progress, a report and DONE", { timeout: 2000 }, async () => {
  let release;
  const finished = new Promise((resolve) => { release = resolve; });
  const { request } = await setup({
    async runEvaluation({ onProgress }) {
      onProgress({ message: "已完成 1/2 项。" });
      await finished;
      return { id: "stream-run" };
    },
  });
  const response = await request("quick", "/check", { stream: true });
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let wire = decoder.decode((await reader.read()).value);
  assert.match(wire, /开始快速检测/);
  release();
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    wire += decoder.decode(next.value, { stream: true });
  }
  const events = chunks(wire);
  assert.equal(events.at(-1), "[DONE]");
  const parsed = events.slice(0, -1).map(JSON.parse);
  for (const chunk of parsed) {
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.model, "quick");
    assert.equal(chunk.choices[0].index, 0);
  }
  const text = parsed.map((chunk) => chunk.choices[0].delta.content ?? "").join("");
  assert.match(text, /已完成 1\/2 项/);
  assert.match(text, /报告：stream-run/);
  assert.equal(parsed.at(-1).choices[0].finish_reason, "stop");
});

test("cancelling a response stream cancels the evaluation", { timeout: 2000 }, async () => {
  let observedSignal;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const { request } = await setup({
    async runEvaluation({ signal }) {
      observedSignal = signal;
      began();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
  });
  const response = await request("quick", "/check", { stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await started;
  await reader.cancel("user stopped");
  assert.equal(observedSignal.aborted, true);
});

test("the host AbortSignal cancels both stream output and evaluation", { timeout: 2000 }, async () => {
  const parent = new AbortController();
  let observedSignal;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const { request } = await setup({
    async runEvaluation({ signal }) {
      observedSignal = signal;
      began();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const response = await request("quick", "/check", { stream: true }, { signal: parent.signal });
  const reader = response.body.getReader();
  await reader.read();
  await started;
  parent.abort(new DOMException("host stopped", "AbortError"));
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(observedSignal.aborted, true);
});

test("nonstreaming requests preserve cancellation instead of reporting a successful answer", async () => {
  const parent = new AbortController();
  parent.abort();
  const { request, calls } = await setup();
  await assert.rejects(request("quick", "/check", {}, { signal: parent.signal }), { name: "AbortError" });
  assert.equal(calls.length, 0);
});

test("errors are shown without the gateway key and do not mark the virtual sign-in expired", async () => {
  const { request } = await setup({
    async runEvaluation() { throw new Error("Gateway refused Bearer test-secret-key"); },
  });
  const response = await request("quick", "/check");
  const message = content(await response.json());
  assert.match(message, /检测未完成/);
  assert.equal(message.includes("test-secret-key"), false);
  assert.equal(response.headers.get("x-magpie-sign-in"), "kept");
});

test("bad JSON and unknown virtual models are rejected without touching the engine", async () => {
  const { loader, request, calls } = await setup();
  const bad = await loader.fetch(loader.baseURL, { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, "invalid_request_error");
  const missing = await request("unknown", "/check");
  assert.equal(missing.status, 400);
  assert.equal(calls.length, 0);
});

test("help never echoes gateway URL credentials or query secrets", async () => {
  const { request } = await setup({}, {
    target: "codex/test-model",
    baseUrl: "http://user:password@127.0.0.1:3425/v1?token=hidden",
    apiKey: "private-config-key",
  });
  const text = content(await (await request("quick", "Hi")).json());
  for (const secret of ["password", "token=hidden", "private-config-key"]) assert.equal(text.includes(secret), false);
});
