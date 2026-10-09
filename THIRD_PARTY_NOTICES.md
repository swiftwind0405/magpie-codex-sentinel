# 第三方来源与授权

## ModelTrace：包含的 MIT 源码与数据

- 项目：[xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)
- 固定提交：[d4131b30243dfa05e70180b5eedde742103f1d73](https://github.com/xqy2006/ModelTrace/commit/d4131b30243dfa05e70180b5eedde742103f1d73)
- 提交时间：2026-09-30 22:09:42 UTC
- Copyright：Copyright (c) 2026 xqy2006
- 许可证：MIT，完整原文保留在 [vendor/modeltrace/LICENSE](vendor/modeltrace/LICENSE)。
- 各文件的来源链接、字节数、SHA-256 与下载时间记录在 [vendor/modeltrace/provenance.json](vendor/modeltrace/provenance.json)。

本包包含以下未修改的上游文件：

| 本包路径 | 上游路径 |
| --- | --- |
| vendor/modeltrace/fingerprint-core.js | static/fingerprint-core.js |
| vendor/modeltrace/unified_bank.json | data/unified_bank.json |
| vendor/modeltrace/probe-output.mjs | codex-plugin/modeltrace-guard/scripts/probe-output.mjs |
| vendor/modeltrace/challenge_suite.py | challenge_suite.py |
| vendor/modeltrace/upstream-provenance.json | codex-plugin/modeltrace-guard/assets/provenance.json |
| vendor/modeltrace/LICENSE | LICENSE |

统一指纹库是完整上游文件，包含 17 个模型标签与 612 份参考回答，没有替换为示例数据或缩减库。以下 hash 与上游原始 provenance 一致：

- unified_bank.json：e514c76928ea38d23bc0f14d3935f23c97b1efb6d96b18a19bdc88ad2d830536
- fingerprint-core.js：83fa5bd611e18f8339122582335123c8ea168ed242298bb31f4e363abeeb6e4a

vendor/modeltrace/reference-probes.json 是从固定提交中原始 challenge_suite.py 的 fingerprint_suite() 返回值筛选 environment-06 得到的派生 JSON，保留原始记录和 prompt 文本。vendor/modeltrace/package.json 仅补充 ESM 声明，vendor 下的 README 与本包 provenance 用于说明集成与来源。src/fingerprint.mjs 是本插件的包装层，不修改上游判分器。

上游没有独立标定本插件的 Magpie 调用环境；包含其代码与数据不意味着获得模型身份认证、准确率保证或官方背书。

## codex-candy-eval：思路参考，未复制源码或题库

- 项目：[haowang02/codex-candy-eval](https://github.com/haowang02/codex-candy-eval)
- 核对提交：[29127fa5a12fb7654e865f684dcaf55ade181349](https://github.com/haowang02/codex-candy-eval/commit/29127fa5a12fb7654e865f684dcaf55ade181349)

本次读取的仓库树中未发现 LICENSE/COPYING 文件。本插件仅参考糖果组合题作为能力探针的思路，独立编写题面、数据生成器、确定性 oracle 与测试，没有复制该仓库的代码、题库、页面或样式。它没有作为运行时依赖随包分发，也不把本包 MIT 许可证套用于该上游项目。

## Magpie：集成文档与请求行为参考

- 插件文档：[https://usemagpie.ai/docs/zh/plugins#quick](https://usemagpie.ai/docs/zh/plugins#quick)
- 仓库：[yetone/magpie](https://github.com/yetone/magpie)
- 本次实现冻结核对的提交：[4cbde14cea7b41f6acef44cf33021eac9c65abe3](https://github.com/yetone/magpie/commit/4cbde14cea7b41f6acef44cf33021eac9c65abe3)
- Codex 请求改写实现：[internal/provider/codex_request.go](https://github.com/yetone/magpie/blob/4cbde14cea7b41f6acef44cf33021eac9c65abe3/internal/provider/codex_request.go)

本包通过 Magpie 公开的 provider 插件接口集成，未打包或复制 Magpie 的程序源码。Magpie/Bun 及其宿主 SDK 由用户自己的 Magpie 安装提供，不属于本包随附的第三方运行时代码。

网页视觉参考另外固定于 [3691c2047dc947495ef5d7d67dd2e2f31639d7b1](https://github.com/yetone/magpie/commit/3691c2047dc947495ef5d7d67dd2e2f31639d7b1) 的 [GUI 样式](https://github.com/yetone/magpie/blob/3691c2047dc947495ef5d7d67dd2e2f31639d7b1/internal/gui/assets/app.css)与 [页面结构](https://github.com/yetone/magpie/blob/3691c2047dc947495ef5d7d67dd2e2f31639d7b1/internal/gui/assets/index.html)，沿用其中的中性底色、强调色和紧凑控件风格。Sentinel 的组件布局、交互代码和 SVG 图形独立实现，未引入 Magpie 的 GUI 脚本、图标或桌面依赖；此视觉参考不改变前述请求行为的核对版本。

## 本插件自己的代码

除上面明确列出的上游组件及派生数据外，本包新增的插件适配、检测引擎、确定性题目、CLI 和文档按根目录 [LICENSE](LICENSE) 的 MIT 条款提供。第三方文件继续保留原作者版权与许可证。
