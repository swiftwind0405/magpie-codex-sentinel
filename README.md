# Codex Sentinel

**[打开检测台](http://127.0.0.1:47821)**

关闭网页后，在 Magpie「插件 → 已安装」中点击本插件，进入详情，再点击上方「打开检测台」即可重新打开。Magpie 需保持运行、插件需保持启用；如果修改了插件的 port 选项，请使用对应端口的地址。

用于检查 **Codex provider 下具体账号表现**的 Magpie 插件。启用后自动打开本地网页，选择账号和模型、运行固定题集、查看逐题证据，并与该账号自己的历史基线比较。可选的 ModelTrace 模块单独提供输出指纹候选。

**v0.2.1** 采用 Magpie 风格的紧凑界面，支持浅色、深色和跟随系统主题，账号卡片显示额度条与选中状态，并支持依次检测全部 Codex 账号。插件和网页服务由 Magpie 管理，不注册供应商、登录方式或虚拟模型，不需要修改 Magpie。v0.1.0 的聊天模型入口已替换为账号检测网页。

## 1. 安装并打开

### 准备条件

- Magpie **0.1.1132 或更新版本**正在运行，Codex provider 已登录账号。旧版本不会进入网页账号检测，避免忽略固定账号请求头后误归属结果。
- 插件使用 Magpie 自带的 Bun，不需要单独安装 Node。只有 CLI 和开发测试需要 **Node.js 22+**。
- 当前源码没有运行时 npm 依赖，不需要构建或执行 npm install。

安装固定版本：

~~~bash
magpie plugin add github:swiftwind0405/magpie-codex-sentinel#v0.2.1
~~~

也可以在 Magpie「插件」页面从 GitHub 安装 `swiftwind0405/magpie-codex-sentinel`。无需填写 Sentinel 登录信息。开发时仍可用 `magpie plugin add /absolute/path/to/magpie-codex-sentinel` 加载本地源码。

浏览器会自动打开 **http://127.0.0.1:47821**。页面列出 Codex 账号、额度和当前配置下的最近标准检测；没有标准记录时显示快速初筛。选择账号、模型和推理强度，再点击开始。安装、打开网页和刷新列表都不会启动推理。

要一次检查所有账号，选好模型、推理强度和检测类型，点击 **「全部检测 · N 个账号」**。页面会显示总请求数；每个账号依次执行一轮相同配置的检测，各自保存报告，标准检测只与该账号自己的基线比较。限流、认证失败等账号错误会单独显示，随后继续下一个账号；点击「停止全部检测」会取消当前账号并停止排队账号。结果无法保存时也会停止后续检测，当前报告仍可导出。

批次列表显示每个账号的等待、检测中、已完成或未完成状态，可直接查看已生成的报告。刷新或关闭网页后批次继续；退出 Magpie 后不会自动续跑，已写入的报告可从账号历史查看。启动前账号列表若发生变化，需要刷新列表后重新开始。

- 自动读取 Magpie 配置中的网关端口，使用默认本机认证，不显示密钥输入框。
- 服务只监听 127.0.0.1，网关密钥留在服务进程中，不传给浏览器。
- 关闭或刷新网页不会取消正在进行的检测；再次打开可以恢复当前进度。
- 点击「停止本轮检测」取消当前任务并保存状态。停用、更新插件或退出 Magpie 会关闭宿主；保留已写入的逐题记录，未完成记录不能用于下降判断。
- 重复宿主共用同一端口；原宿主退出后另一个宿主接管。30 秒内不重复弹出浏览器。
- 自动打开失败时，可手动访问上述本地地址。

在 Magpie 的插件选项里可设置 open 和 port。CLI 也可设置：

~~~bash
magpie plugin options magpie-codex-sentinel '{"open":false,"port":47822}'
~~~

### 自定义网关与复现设置

普通本机使用不需要配置文件或网关密钥。插件选项可覆盖 baseUrl、target、effort、seed 和下文的运行参数。CLI 作为可选入口，与插件共用检测引擎和记录目录：

~~~bash
npm start -- --port 47822
npm start -- --no-open --port 47822
~~~

使用自定义网关密钥时，通过服务进程的 MAGPIE_GATEWAY_KEY 环境变量传入；不把密钥写入配置文件、URL 或网页。远程网关还需要 HTTPS 和 --allow-remote。

CLI 需要固定账户、超时等设置时，可以将 sentinel.config.example.json 复制为 sentinel.config.json，填入真实模型 ID，再启动：

~~~bash
npm start -- --config sentinel.config.json --port 47822
~~~

配置示例（target 必须替换为模型列表里的完整 ID；effort 选择实际支持的档位）：

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

网页中的账号、模型、档位和种子是本轮选择；其他设置取自插件选项或 CLI 配置。网页仅接受 Magpie 当前返回的 Codex 账号和 codex/ 模型，不能选择自动路由。引擎用 X-Magpie-Account 固定账号：账号限流或不可用时停止，不换账号补答。CLI 的 run 仍允许未指定 --account；这种记录仅代表整条路由，不会归到账号卡片中。

### 从 v0.1.0 插件迁移

用下面的命令替换旧版本，插件会重新启用并打开网页：

~~~bash
magpie plugin add github:swiftwind0405/magpie-codex-sentinel#v0.2.1
~~~

旧的 `codex-sentinel/quick` 等虚拟模型不再提供，请在客户端选择正常工作模型。若另外装过本地开发目录，先用 `magpie plugin off /absolute/path/to/magpie-codex-sentinel` 停用该目录，避免同时加载两份插件。

新版继续使用相同的检测记录目录，旧报告和基线文件保留。过去未固定账号的结果不能归属到某个账号，也不能作为新账号检测的基线。新版本的账号标识加入比较配置，需要重新建立账号基线。旧记录仍可通过 CLI history/show/export 查看。

## 2. 网页中可以做什么

| 操作 | 功能 | 最多发出的测试推理请求 |
| --- | --- | ---: |
| 快速初筛 | 每个题型 2 题，查看选定账号的基本表现 | 6 |
| 标准检测 | 每个题型 6 题，与同配置基线比较 | 18 |
| 行为指纹 | ModelTrace 数字输出采样，提供辅助候选 | 3 |
| 全部检测 | 按所选类型依次检查全部 N 个 Codex 账号，分别保存报告 | N × 所选类型的请求数 |
| 检测历史 | 查看已保存的报告和逐题证据 | 0 |
| 设为基线 | 勾选至少 3 轮完整标准检测，建立参考 | 0 |
| 导出 HTML / JSON / MD | 下载当前完整报告 | 0 |

检测串行运行。重复点击、刷新页面或另开标签页不会自动启动另一轮。仅发送内置测试题，不读取项目文件或正在工作的聊天内容。

## 3. 第一次使用：先建立自己的参考

建议先运行一次 quick，确认目标配置、认证和返回格式都正常，再运行 standard。

在你认为账号工作正常时，使用**同一账号、同一模型/档位、同一 seed**完成至少 3 轮标准检测。在网页顶部点击「历史记录」，在「检测历史」中勾选这三轮并点击「设为基线」。不同账号必须各自建立参考。CLI 也可以使用历史里的完整 run ID：

~~~text
node bin/sentinel.mjs baseline ID1 ID2 ID3
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

例如从 90% 降到 70% 是下降 20 个百分点，不是相对下降 20%。这些是固定的**工程阈值**，没有被标定成“降智概率”或统计置信度。复测由你手动发起；Sentinel 不会自动停用模型、替你切换通道或阻断原来的工作。

| 报告情况 | 应怎样理解 |
| --- | --- |
| 快速初筛完成 | 只看这 6 题的表现，继续用 standard 才能比较参考 |
| 尚无同配置基线 | 本轮已有分数，但缺少可比较的历史参考 |
| 未触发预设下降阈值 | 这轮没有达到规则阈值，不等同于证明所有能力正常 |
| 发现下降信号 | 保持相同配置再跑一次，检查各题型、路由和格式变化 |
| 连续两轮低于参考 | 排查该账号、网关报告的模型、档位记录、网关配置和持续的题型表现 |
| 路由不一致或证据不足 | 本轮分数可以查看，但不能归结为原模型能力下降 |
| 运行不完整 | 超时、限流、拒答、工具调用、截断等单独列出，不按答错补齐 |

## 4. CLI 命令

以下命令在项目目录中运行。--config 接收上一节的 JSON 配置对象，不需要再包一层 options；自定义网关密钥通过 MAGPIE_GATEWAY_KEY 环境变量提供。

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
| --no-open / --port N | 网页启动选项：不自动打开浏览器 / 指定监听端口（0 为自动分配） |
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
| 130 | CLI 检测命令已取消；网页服务正常关闭返回 0，取消状态记录在报告中 |

## 5. 配置选项

| JSON 字段 | 默认值 | 作用 |
| --- | --- | --- |
| baseUrl | http://127.0.0.1:3425/v1 | Magpie 的 OpenAI 兼容网关根路径，须以 /v1 结尾 |
| target | 空，开始检测前选择 | 当前模型列表里的真实 provider/model |
| effort | high | 请求档位；default 表示不显式发送档位 |
| account | 未固定 | 通过 Magpie 账户选择请求头固定账户 |
| open | true | 插件加载时自动打开浏览器；只影响插件入口 |
| port | 47821 | 插件网页端口；CLI 使用 --port |
| seed | sentinel-v1-reference | 固定能力题目；指纹中仅固定三条参考 prompt 的顺序 |
| maxOutputTokens | 8192 | 请求中的输出 token 参数，是否执行取决于通道 |
| timeoutMs | 120000 | 单题 HTTP 请求超时，毫秒 |
| runTimeoutMs | 1800000 | 整轮检测超时，毫秒 |
| maxResponseBytes | 8388608 | 单次响应读取上限，默认 8 MiB |
| dataDir | Magpie 配置目录/codex-sentinel | Sentinel 记录目录；相对路径以配置目录解析 |
| allowRemote | false | 连接非本机网关时需显式设为 true，并使用 HTTPS |

baseUrl 不接受嵌入的用户名、密码、查询参数或 fragment。实际访问密钥来自 MAGPIE_GATEWAY_KEY 环境变量或默认本机认证。

effort 接受的配置名称包含 none、minimal、low、medium、high、xhigh、max、ultra、default，但不代表所有上游模型都支持这些档位。报告会同时保留请求档位与网关记录的档位；网关记录不等于供应商认证的真实推理预算，缺失信息保留未知。

## 6. 请求次数、取消与 Codex 参数改写

检测引擎串行发送测试，同一数据目录只允许一轮检测运行。quick、standard、fingerprint 分别最多发出 **6、18、3 个测试推理请求**；历史、设置基线和导出不会发起推理。模型、账号列表和路由查询属于额外读取。固定账号请求不会切换其他账号，Magpie 对同一请求的重试仍可能产生额外上游尝试，因此这不是供应商端的硬请求数或费用上限。

本次核对的 [Magpie Codex 订阅适配器](https://github.com/yetone/magpie/blob/4cbde14cea7b41f6acef44cf33021eac9c65abe3/internal/provider/codex_request.go)会：

- 使用 Codex 自带的系统指令，并将客户端自己的 instructions 放到 developer 输入中。
- 删除 max_output_tokens、max_completion_tokens、temperature 和 top_p 等参数。
- 将 tool_choice 改为 auto。
- 将 ultra 推理档位转换成 max。

因此，**新测试会话没有原工作聊天历史，不等于系统提示词完全干净或未经改写**。maxOutputTokens 是请求值，特别是经上述 Codex 订阅路径时，不能把它当作费用硬上限。检测引擎保留 tools 为空且不会执行模型提出的工具调用；若检测到工具介入，该题会单列，不当作能力失败。

你取消检测或触发超时时，引擎会停止继续发出探针，并尝试中断在途请求。客户端或 Magpie 已停止等待，不保证供应商立即停止推理或计费。usage 只按上游实际返回的已知数据记录；缺失值保持未知，不补成 0。

## 7. 本地保存了什么

默认记录位置为 **Magpie 配置目录/codex-sentinel**。网页服务与 CLI 未指定 --directory 时采用 XDG_CONFIG_HOME 下的 magpie，或 ~/.config/magpie。

主要文件是 runs 下的逐轮 JSON，以及 baselines 下按比较配置保存的基线 JSON。每题结束写入进度检查点；运行中、取消与完整结束分别标记，部分完成记录不会进入基线。并发锁和原子替换避免两轮同时写坏记录。单份记录读写均限制为 32 MiB（UTF-8 字节）；超限会停止后续探测、保留之前可读的检查点，并报告最终保存失败。当前输出仍包含已取得的结果，CLI 此时返回 1。

报告保留内置题目、确定性标准答案、模型最终答案、判分、运行参数摘要、路由证据、时延及已知 usage。不会把工作聊天发给被测目标，不保存访问密钥或模型思考原文。网页显示从 Magpie 读取的账号名称；落盘及导出的配置使用账号摘要标识和掩码，网页通过标识映射回账号名。归属依赖 Magpie 执行固定账号契约，不能独立认证供应商内部身份。

## 8. 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 没有 target，或提示模型不存在 | 在网页刷新模型列表并重新选择；CLI 使用 models 返回的完整 ID |
| 网页能运行，CLI 显示另一目标或没有历史 | 给 CLI 显式传 --config 或 --target；核对 --directory、dataDir 和 MAGPIE_GATEWAY_KEY |
| 页面无法连接 Magpie | 确认 Magpie 正在运行，网关地址和密钥正确，再点击刷新模型 |
| 47821 端口已被占用 | 关闭旧的独立服务，或在插件选项设置 port；CLI 可用 --port 47822 |
| 401 / 403 | 检查 Magpie 网关密钥与目标账户认证；不要把 Codex 订阅令牌填成网关密钥 |
| 429 / 额度不足 | 该轮会提前停止并单列原因，待额度恢复后手动重试 |
| 有分数但无法建立基线 | 核对完整 standard、同 seed、同配置，以及路由 done、唯一成功尝试和无 fallback 条件 |
| 请求写了 high，网关记录的档位不同 | 对照请求与路由记录，检查 Magpie 和目标通道的参数映射；不要把记录当作供应商实际推理预算证明 |
| 指纹候选与目标名称不同 | 查看候选库是否收录目标及未校准限制，不据此单独认定换模或降智 |
| 同一 seed 每次仍有差异 | seed 固定题目，不控制上游模型采样；用多轮参考看本地波动 |
| 已有检测在运行 | 等待同一数据目录中的检测结束，或取消该轮后再启动 |

## 9. 验证范围与来源

仓库包含确定性题目校验、输出解析、本地网页 HTTP 接口、存储与基线，以及本地 fixture 网关相关测试。可在 Node.js 22+ 下运行：

~~~bash
node --test test/*.test.mjs
~~~

检查覆盖插件无 provider 加载、宿主退出与接管、真实 HTTP 网页入口、账号固定请求、跨账号基线拒绝、取消、存储和评分。现场验证与尚未覆盖的边界见[验证记录](docs/VALIDATION.md)。

- [设计与判定规则](docs/DESIGN.md)
- [第三方来源与授权](THIRD_PARTY_NOTICES.md)
- [Magpie 插件文档](https://usemagpie.ai/docs/zh/plugins#quick)
- [codex-candy-eval 参考提交](https://github.com/haowang02/codex-candy-eval/tree/29127fa5a12fb7654e865f684dcaf55ade181349)
- [ModelTrace 参考提交](https://github.com/xqy2006/ModelTrace/tree/d4131b30243dfa05e70180b5eedde742103f1d73)

本项目为独立检测工具，不属于 Magpie、OpenAI 或上述参考项目的官方认证产品。
