# 交付验证记录

版本：0.1.0。核对日期：2026-10-09。

## 已完成

运行环境为 macOS / Node.js 25.8.0 / Bun 1.3.5。执行 `npm test` 和 `bun test`：各 **46 项通过，0 失败、0 跳过**。`npm run check` 通过。

| 范围 | 验证内容 |
| --- | --- |
| 确定性题库 | 糖果最坏情况 oracle 与独立穷举一致；原始数量所有 201,600 种实际取法；种子重放；JS 跟踪与约束解的独立核验 |
| 最终答案 | 完整 JSON 和严格类型；拒绝正文出现答案的误命中；Codex commentary 与 final_answer 分离；空最终答案不回退到说明文字 |
| HTTP / SSE | 真实本地 HTTP 服务；UTF-8 / CRLF 分片；completed 状态校验；截断与缺少终态；工具调用与 reasoning token 缺失；失败和截断响应保留已知 model/usage，部分文本不进入判分 |
| Magpie 接口形状 | 四个 provider 模型、API 登录 loader、Chat Completions JSON/SSE；安装与普通连接测试不运行探针 |
| 端到端共享引擎 | 从实际 index.mjs 加载插件并使用普通文本 sentinel check；经本地模拟网关完成 6 题；独立进程 CLI 得到 JSON 结果 |
| 证据与比较 | 读取完成 trace、排除未完成 route；固定三轮参考；单次与连续下降；模型变化不混比；损坏基线不覆盖原件且本轮结果仍保存 |
| 错误与取消 | HTTP、JSON、SSE 中的限流/认证错误提前停止；通用 SSE 错误读取已完成 route 的失败状态；最后一题后取消不作下降判定；CLI 整轮超时返回 3，用户取消返回 130；取消基线操作不开始写入；宿主和响应流取消贯通 |
| 持久化 | 旧锁恢复并发时只有一个所有者；逐题检查点；读写均限制为 32 MiB UTF-8 字节，超限保留原检查点并停止；缺 verdict 的损坏记录不影响历史列表和 CLI JSON 输出；密钥和完整账户邮箱不进入历史 JSON |
| 指纹 | 完整上游文件 SHA-256；精确参考 prompt；输出合法性；数值稳定；与能力判定分离；请求不额外添加本地 instructions |
| 导出 | HTML 对题干/最终回答转义；CLI 支持 HTML、JSON、Markdown |

这些 HTTP 响应由本机 fixture 生成。合成 fixture 的正确率仅用于验证程序，**不是对任何真实模型的检测成绩**。

## 源码兼容性核对

| 项目 | 固定提交 |
| --- | --- |
| Magpie 请求改写 | 4cbde14cea7b41f6acef44cf33021eac9c65abe3 |
| Magpie Bun 宿主与路由契约 | 62b1c995ffaebb223ad040b4c54ebabab0078c7a |
| codex-candy-eval（仅参考思路） | 29127fa5a12fb7654e865f684dcaf55ade181349 |
| ModelTrace（MIT 原件） | d4131b30243dfa05e70180b5eedde742103f1d73 |

已核对 Magpie 的 provider hook、插件选项、账户固定请求头、响应模型头、session route 类型与 Codex 请求改写代码。主分支在本次工作期间有新提交，上表记录实际核对的冻结版本。

使用第二个 Magpie 提交的原始 `internal/plugin/host.js` 在 Bun 中启动宿主，通过其 stdin/stdout RPC 加载本目录插件，验证初始化、四个模型注册、普通消息返回帮助且不发探针、`sentinel check` 返回流式结果及本地网关 HTTP 429 后只发一个探针。该验证使用临时目录与测试凭据，没有运行完整 Go 网关。

## 尚未现场验证

当前环境没有 Magpie 可执行程序，没有接入用户的 Codex 通道。已验证上述固定版本的 Bun 宿主，但没有执行完整 Magpie 网关到真实供应商的端到端推理，也没有测试其他 Magpie 版本、供应商的最终 token 上限执行情况或独立误报率。

本机首次安装后按 README 执行：列模型、配置真实 target、登录、运行 quick；确认路由 trace 完整后再进行 standard 和基线建立。`magpie provider test codex-sentinel` 只验证入口能返回帮助，不会代替正式检测。

上线后的结论范围仍是固定小题集在指定路由上的表现。报告中的网关 model、档位、自报 model 与 ModelTrace 候选，都不能独立证明供应商的实际模型权重或内部推理预算。
