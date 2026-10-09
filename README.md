# Magpie Codex Sentinel

一个可安装到 Magpie 的 Codex 检测插件。它通过你指定的真实 provider/model 运行固定、可复现的小型能力测试，保存本地记录，并与同配置参考表现比较。可选的 ModelTrace 模块单独提供输出指纹候选。

日常使用从 **quick → standard → 建立基线 → 同配置复测** 开始。能力题有本地确定性答案；指纹结果只有候选相似度，两者分别呈现。

## 1. 安装并配置目标

### 准备条件

- Magpie 已启动，且其中已经连接了你要检测的 Codex 账户或通道。
- 默认调用本机网关 http://127.0.0.1:3425/v1；如果你改过端口，请同步修改 baseUrl。
- 在 Magpie 中使用插件，由 Magpie 的 Bun 插件运行时执行。单独运行随包 CLI 需要 **Node.js 22 或更高版本**。
- 本包运行时没有需要额外安装的 npm 依赖，不需要执行 npm install。

### 从 GitHub 安装（推荐）

直接安装 [v0.1.0](https://github.com/swiftwind0405/magpie-codex-sentinel/releases/tag/v0.1.0)，不需要先下载源码或构建：

~~~bash
magpie plugin add github:swiftwind0405/magpie-codex-sentinel#v0.1.0
~~~

这个命令固定安装 v0.1.0。也可以在 **插件 → 发现 → 非官方插件 · GitHub** 中查找 `magpie-codex-sentinel`；发现列表有缓存，新发布的仓库可能稍后才出现。没有版本后缀的 GitHub 安装会使用仓库当前代码：

~~~bash
magpie plugin add github:swiftwind0405/magpie-codex-sentinel
~~~

[Magpie 发布与上架文档](https://usemagpie.ai/docs/zh/plugins#publish)说明了 GitHub 发现规则。安装完成后，继续设置下面的真实检测目标并登录网关。

### 安装本地目录（开发或手动下载时）

在解压目录的上一级运行：

~~~bash
magpie plugin add ./magpie-codex-sentinel
~~~

这是就地加载。安装后请保留这个目录的位置，尤其是 src 和 vendor；不要只复制 index.mjs。[Magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins#quick)说明了本地文件夹安装方式。

### 复制实际模型 ID

在 Magpie 的模型列表中找到要检测的通道，复制其完整 **provider/model** ID。如果已有本地源码，也可以在源码目录用随包 CLI 查询：

~~~bash
cd magpie-codex-sentinel
node bin/sentinel.mjs models --json
~~~

不要只写模型简称，不要选择 codex-sentinel 自己的四个诊断模型。插件不预设任何 Codex 模型名称，以你的 Magpie 当前返回的模型列表为准。

### 设置检测目标

将下面 target 中的 `<provider>/<model>` 替换为上一步复制的真实 ID，effort 选择该通道实际支持的档位，然后直接保存插件选项：

~~~bash
magpie plugin options magpie-codex-sentinel \
  '{"target":"<provider>/<model>","effort":"high"}'
~~~

默认连接本机网关 `http://127.0.0.1:3425/v1`。如果你改过端口，在上面的 JSON 中同时加入实际 `baseUrl`。

如果还需要使用 CLI，可以在自己的工作目录创建一份不含密钥的 `sentinel.config.json`；有本地源码时，也可以复制 `sentinel.config.example.json`。完整配置示例：

~~~json
{
  "baseUrl": "http://127.0.0.1:3425/v1",
  "target": "<provider>/<model>",
  "effort": "high",
  "seed": "sentinel-v1-reference",
  "maxOutputTokens": 8192,
  "timeoutMs": 120000,
  "runTimeoutMs": 1800000
}
~~~

如果你需要固定 Magpie 中的某个账户，可以增加 account 字段，填写该 Magpie 实例支持的账户选择值。未固定时，结果代表整条路由，可能受到多账户轮换影响。

如果使用或修改了这份配置文件，在它所在的目录将 JSON 显式保存为插件选项：

~~~bash
magpie plugin options magpie-codex-sentinel "$(cat sentinel.config.json)"
~~~

本插件使用上面的 CLI 命令设置选项。已核对的 Magpie 界面只为 middleware 显示 JSON 选项编辑器，不能假定这个 provider 插件也有相同按钮。**插件选项和 CLI 不会自动互读**：插件从 Magpie 的 options 读取；CLI 需要每次通过 --config 指定这份文件。修改 JSON 后，若希望插件也更新，需要再次执行上面的 options 命令。

### 登录诊断 provider

~~~bash
magpie plugin login codex-sentinel
~~~

这里填写的是 **Magpie 网关密钥**：本机默认配置通常填写 magpie；如果你给网关配置了自己的访问密钥，就填写实际网关密钥。它不是让你另外提供 Codex 订阅令牌。

CLI 的密钥只通过 MAGPIE_GATEWAY_KEY 环境变量传入，不写入配置 JSON：

~~~bash
export MAGPIE_GATEWAY_KEY='magpie'
~~~

上例适用于采用默认本机访问设置的网关；自定义网关请在环境中设置实际值。插件登录和 CLI 环境变量也需要指向同一套网关访问身份，才能复用同配置基线。

## 2. 在 Magpie 客户端中使用

安装并登录后，在通过 Magpie 接入的客户端中选择以下模型 ID，然后发送对应的**完整指令**。

| 模型 ID | 发送内容 | 功能 | 最多发出的测试推理请求 |
| --- | --- | --- | ---: |
| codex-sentinel/quick | sentinel check | 6 题快速初筛 | 6 |
| codex-sentinel/standard | sentinel check | 18 题标准检测，与已设置的同配置基线比较 | 18 |
| codex-sentinel/fingerprint | sentinel fingerprint | 3 份 ModelTrace 输出指纹采样 | 3 |
| codex-sentinel/history | sentinel history | 查看本地历史 | 0 |
| codex-sentinel/history | sentinel baseline id1 id2 id3 | 使用指定的标准检测建立基线 | 0 |

这些是发送给诊断模型的普通消息文本，不是注册到 Codex/OpenCode 客户端的本地命令。使用 sentinel 开头可以避免 /check 等内容被客户端先当作斜杠命令拦截。插件仍保留 /check、/fingerprint、/history 和 /baseline 别名，主要供直接通过 HTTP 发送聊天消息时使用。

普通聊天、连接测试或不匹配的指令只返回帮助说明，不会启动检测。上表中的 id1、id2、id3 需要替换为历史里真实的完整 run ID。

本插件通过模型回答展示进度和报告，没有原生自定义页面。需要保存或分享较完整的结果时，使用 CLI 导出 HTML、JSON 或 Markdown。

## 3. 第一次使用：先建立自己的参考

建议先运行一次 quick，确认目标配置、认证和返回格式都正常，再运行 standard。

在你认为通道工作正常时，使用**同一配置、同一 seed**完成至少 3 轮标准检测。通过 history 记录这三轮的 ID，再明确选定它们：

~~~text
sentinel baseline id1 id2 id3
~~~

引擎会检查：

- 全部是完整完成的 standard；quick、指纹、运行中、取消或网络失败记录不进入基线。
- 至少 3 个不同 run ID，最多可选 20 个，不能把同一轮重复计算。
- 目标、网关访问身份、账户选择、请求档位、seed、题库版本和相关运行参数一致。
- 每题都有完整且一致的网关路由证据，路由已经结束，成功尝试唯一，没有 fallback；网关报告的模型和已记录的档位信息也一致。
- 题目 ID 与顺序一致。

基线取选中各轮的总通过率均值，以及各题型通过率均值。它表示**你选定的本机参考表现**，不自动宣称这些历史样本已被官方认证为“健康”。之后的新结果不会自动覆盖基线。

更换模型、账户选择、密钥、档位、seed 或影响比较的运行参数后，应建立新的参考。固定 seed 使题目和顺序可复现，不保证模型每次给出相同回答。

### 如何看下降提示

只有完整标准检测且实际路由可比较时，才会进入下降判定：

1. 本轮总通过率比基线均值低 **至少 20 个百分点**。
2. 同时，至少两个题型的通过率各低 **至少 15 个百分点**。

两项均满足时，报告“发现下降信号，建议同配置复测”。基线建立后的最近连续两轮同配置 standard 都满足条件时，报告“连续两轮表现低于参考，请排查通道与配置”。

例如从 90% 降到 70% 是下降 20 个百分点，不是相对下降 20%。这些是固定的**工程阈值**，没有被标定成“降智概率”或统计置信度。复测由你手动发起；插件不会自动停用模型、替你切换通道或阻断原来的工作。

| 报告情况 | 应怎样理解 |
| --- | --- |
| 快速初筛完成 | 只看这 6 题的表现，继续用 standard 才能比较参考 |
| 尚无同配置基线 | 本轮已有分数，但缺少可比较的历史参考 |
| 未触发预设下降阈值 | 这轮没有达到规则阈值，不等同于证明所有能力正常 |
| 发现下降信号 | 保持相同配置再跑一次，检查各题型、路由和格式变化 |
| 连续两轮低于参考 | 优先排查账户轮换、网关报告的模型、档位记录、网关配置和持续的题型表现 |
| 路由不一致或证据不足 | 本轮分数可以查看，但不能归结为原模型能力下降 |
| 运行不完整 | 超时、限流、拒答、工具调用、截断等单独列出，不按答错补齐 |

## 4. CLI 命令

以下命令在插件目录中运行。--config 接收上一节的裸 options JSON 对象，不需要再包一层 options，认证不从该文件读取，请只通过 MAGPIE_GATEWAY_KEY 提供 CLI 网关密钥。

~~~bash
# 当前 Magpie 可用模型
node bin/sentinel.mjs models --config sentinel.config.json --json

# 快速 / 标准检测
node bin/sentinel.mjs run --profile quick --config sentinel.config.json
node bin/sentinel.mjs run --profile standard --config sentinel.config.json

# 独立的可选指纹检测
node bin/sentinel.mjs fingerprint --config sentinel.config.json

# 历史与单轮记录
node bin/sentinel.mjs history --config sentinel.config.json
node bin/sentinel.mjs show RUNID --config sentinel.config.json

# 选择已完成的标准检测建立基线
node bin/sentinel.mjs baseline ID1 ID2 ID3 --config sentinel.config.json

# 导出已有记录，不发起新的模型推理
node bin/sentinel.mjs export RUNID --out report.html --format html --config sentinel.config.json
node bin/sentinel.mjs export RUNID --out report.json --format json --config sentinel.config.json
node bin/sentinel.mjs export RUNID --out report.md --format md --config sentinel.config.json
~~~

RUNID、ID1、ID2、ID3 都需要替换为真实历史 ID。想通过 CLI 建立首个基线，就用同一份配置连续执行 3 次 standard，查看 history，再执行 baseline。

通用选项包括：

| CLI 选项 | 用途 |
| --- | --- |
| --config FILE | 读取本次 CLI 使用的 JSON 配置 |
| --target ID | 本次覆盖真实的 provider/model |
| --effort VALUE | 本次覆盖请求的推理档位 |
| --account VALUE | 本次覆盖账户选择 |
| --base-url URL | 本次覆盖 Magpie 网关地址 |
| --seed VALUE | 本次覆盖 seed；会改变可比较配置 |
| --directory DIR | 指定 Magpie 配置目录；默认数据放在它下面的 codex-sentinel |
| --json | 使用 JSON 输出，进度写到 stderr，便于程序读取 |
| --data-dir DIR | 本次覆盖检测记录目录 |
| --timeout-ms N / --run-timeout-ms N | 本次覆盖单题 / 整轮超时 |
| --max-output-tokens N | 本次覆盖请求输出参数，不保证上游执行 |
| --max-response-bytes N | 本次覆盖本地响应读取上限 |
| --allow-remote | 显式允许 HTTPS 的非本机网关 |
| --force | export 时允许覆盖已经存在的目标文件 |

不要把 --directory 当作导出目录。导出文件位置由 export 的 --out 指定；持久化检测目录可以用 JSON 中的 dataDir 单独设置。默认导出不会覆盖已经存在的文件，需要明确传入 --force 才覆盖。

CLI 退出码用于程序判断执行结果：

| 退出码 | 含义 |
| --- | --- |
| 0 | 请求流程完成，不等于已证明模型健康或身份正确 |
| 1 | 配置、存储或命令执行异常 |
| 2 | 完整能力检测达到预设下降阈值 |
| 3 | 检测不完整，或指纹有效样本不足 |
| 130 | 已取消 |

## 5. 配置选项

| JSON 字段 | 默认值 | 作用 |
| --- | --- | --- |
| baseUrl | http://127.0.0.1:3425/v1 | Magpie 的 OpenAI 兼容网关根路径，须以 /v1 结尾 |
| target | 空，必须填写 | 当前模型列表里的真实 provider/model |
| effort | high | 请求档位；default 表示不显式发送档位 |
| account | 未固定 | 通过 Magpie 账户选择请求头固定账户 |
| seed | sentinel-v1-reference | 固定能力题目；指纹中仅固定三条参考 prompt 的顺序 |
| maxOutputTokens | 8192 | 请求中的输出 token 参数，是否执行取决于通道 |
| timeoutMs | 120000 | 单题 HTTP 请求超时，毫秒 |
| runTimeoutMs | 1800000 | 整轮检测超时，毫秒 |
| maxResponseBytes | 8388608 | 单次响应读取上限，默认 8 MiB |
| dataDir | Magpie 配置目录/codex-sentinel | 插件自己的记录目录；相对路径以配置目录解析 |
| allowRemote | false | 连接非本机网关时需显式设为 true，并使用 HTTPS |

baseUrl 不接受嵌入的用户名、密码、查询参数或 fragment。实际访问密钥由插件登录或 CLI 环境变量提供。

effort 接受的配置名称包含 none、minimal、low、medium、high、xhigh、max、ultra、default，但不代表所有上游模型都支持这些档位。报告会同时保留请求档位与网关记录的档位；网关记录不等于供应商认证的真实推理预算，缺失信息保留未知。

## 6. 请求次数、取消与 Codex 参数改写

插件串行发送测试，同一数据目录只允许一轮检测运行。quick、standard、fingerprint 分别最多发出 **6、18、3 个测试推理请求**；历史、设置基线和导出不会发起推理。模型列表和路由查询属于额外的读取请求。Magpie 自身重试、账户轮换或 fallback 可能产生额外上游尝试，因此这不是供应商端的硬请求数或费用上限。

本次核对的 [Magpie Codex 订阅适配器](https://github.com/yetone/magpie/blob/4cbde14cea7b41f6acef44cf33021eac9c65abe3/internal/provider/codex_request.go)会：

- 使用 Codex 自带的系统指令，并将客户端自己的 instructions 放到 developer 输入中。
- 删除 max_output_tokens、max_completion_tokens、temperature 和 top_p 等参数。
- 将 tool_choice 改为 auto。
- 将 ultra 推理档位转换成 max。

因此，**新测试会话没有原工作聊天历史，不等于系统提示词完全干净或未经改写**。maxOutputTokens 是请求值，特别是经上述 Codex 订阅路径时，不能把它当作费用硬上限。插件保留 tools 为空且不会执行模型提出的工具调用；若检测到工具介入，该题会单列，不当作能力失败。

你取消检测或触发超时时，插件会停止继续发出探针，并尝试中断在途请求。客户端或 Magpie 已停止等待，不保证供应商立即停止推理或计费。usage 只按上游实际返回的已知数据记录；缺失值保持未知，不补成 0。

## 7. 本地保存了什么

默认记录位置为 **Magpie 配置目录/codex-sentinel**。CLI 未指定 --directory 时采用 XDG_CONFIG_HOME 下的 magpie，或 ~/.config/magpie；Magpie 插件优先使用宿主传入的配置目录。

主要文件是 runs 下的逐轮 JSON，以及 baselines 下按比较配置保存的基线 JSON。每题结束写入进度检查点；运行中、取消与完整结束分别标记，部分完成记录不会进入基线。并发锁和原子替换避免两轮同时写坏记录。单份记录读写均限制为 32 MiB（UTF-8 字节）；超限会停止后续探测、保留之前可读的检查点，并报告最终保存失败。当前输出仍包含已取得的结果，CLI 此时返回 1。

报告保留内置题目、确定性标准答案、模型最终答案、判分、运行参数摘要、路由证据、时延及已知 usage。不会把工作聊天发给被测目标，不保存访问密钥或模型思考原文。用于比较的访问身份以摘要记录，显式账户配置以提示或掩码展示。导出的原始报告会包含合成题与其最终回答，分享前可自行查看。

## 8. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 没有 target，或提示模型不存在 | 重新查询 models，复制真实完整 ID，并在插件 options / CLI 配置中分别保存 |
| 插件能运行，CLI 显示另一目标或没有历史 | 给 CLI 显式传 --config；核对 --directory、dataDir 和 MAGPIE_GATEWAY_KEY |
| 401 / 403 | 检查 Magpie 网关密钥与目标账户认证；不要把 Codex 订阅令牌填成网关密钥 |
| 429 / 额度不足 | 该轮会提前停止并单列原因，待额度恢复后手动重试 |
| 有分数但无法建立基线 | 核对完整 standard、同 seed、同配置，以及路由 done、唯一成功尝试和无 fallback 条件 |
| 请求写了 high，网关记录的档位不同 | 对照请求与路由记录，检查 Magpie 和目标通道的参数映射；不要把记录当作供应商实际推理预算证明 |
| 指纹候选与目标名称不同 | 查看候选库是否收录目标及未校准限制，不据此单独认定换模或降智 |
| 同一 seed 每次仍有差异 | seed 固定题目，不控制上游模型采样；用多轮参考看本地波动 |
| 已有检测在运行 | 等待同一数据目录中的检测结束，或取消该轮后再启动 |

## 9. 验证范围与来源

仓库包含确定性题目校验、输出解析、插件接口、存储与基线，以及 mock 网关相关测试。可在 Node.js 22+ 下运行：

~~~bash
node --test test/*.test.mjs
~~~

本次在 macOS / Node.js 25.8.0 和 Bun 1.3.5 下，**46 项测试全部通过**，包括通过本地 HTTP 模拟网关运行真实插件入口、CLI、能力检测、指纹检测和历史比较。还使用固定版本的 Magpie 官方 Bun 宿主验证了插件加载、模型注册、帮助响应和检测启动。具体范围见[验证记录](docs/VALIDATION.md)。**尚未使用真实 Magpie / Codex 账户完成现场端到端检测，也没有完成检测误报率的独立校准。** 离线测试通过不代表线上通道一定兼容，也不代表指纹身份判断或能力下降结论具有已标定准确率。

- [设计与判定规则](docs/DESIGN.md)
- [第三方来源与授权](THIRD_PARTY_NOTICES.md)
- [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins#quick)
- [codex-candy-eval 参考提交](https://github.com/haowang02/codex-candy-eval/tree/29127fa5a12fb7654e865f684dcaf55ade181349)
- [ModelTrace 参考提交](https://github.com/xqy2006/ModelTrace/tree/d4131b30243dfa05e70180b5eedde742103f1d73)

本项目为独立插件，不属于 Magpie、OpenAI 或上述参考项目的官方认证产品。
