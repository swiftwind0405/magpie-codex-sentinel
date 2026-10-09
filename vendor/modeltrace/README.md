# ModelTrace 源码快照

来源：[xqy2006/ModelTrace](https://github.com/xqy2006/ModelTrace)。固定提交：[`d4131b30243dfa05e70180b5eedde742103f1d73`](https://github.com/xqy2006/ModelTrace/commit/d4131b30243dfa05e70180b5eedde742103f1d73)，提交时间 2026-09-30 22:09:42 UTC。

上游源文件通过 GitHub connector 读取，按 UTF-8 / LF 原样保留。MIT 许可证和 copyright 见 `LICENSE`。`provenance.json` 记录各文件的原始路径、固定提交链接、字节数、SHA-256 与采集时间；`upstream-provenance.json` 是上游 Guard 自带 provenance 的原始副本。`package.json` 仅声明 ES module，使原始 `fingerprint-core.js` 可以直接导入。

| 本地文件 | 上游文件 |
| --- | --- |
| `fingerprint-core.js` | `static/fingerprint-core.js` |
| `unified_bank.json` | `data/unified_bank.json` |
| `probe-output.mjs` | `codex-plugin/modeltrace-guard/scripts/probe-output.mjs` |
| `challenge_suite.py` | `challenge_suite.py` |
| `upstream-provenance.json` | `codex-plugin/modeltrace-guard/assets/provenance.json` |
| `LICENSE` | `LICENSE` |

`reference-probes.json` 是从原始 `challenge_suite.py` 的 `fingerprint_suite()` 返回值中选取 `condition == "environment-06"` 得到的三个完整记录，提示词未修改。这是建库使用过的 clean / English / JSON 环境，challenge ID 为 `query-16`、`query-17`、`query-18`，请求数量分别为 301、319、327。生产运行只读 JSON，不执行 Python。

插件 seed 只改变三条固定提示词的顺序和本地 ID，不插入提示词，也不生成或固定模型回答。相同 seed 不保证相同模型输出。每条提示词应独立发给待测 Codex，保留相同模型和推理设置。实际 Magpie / Codex 包装层可能带有自己的提示词，因此使用相同探针文本不代表复现了上游全部采集条件。

本模块只输出当前参考库内的候选权重。完整库包含 17 个模型标签、612 份参考回答；它没有能力题的标准答案。候选权重不是模型身份证明或降智分数，未收录模型也会被归入现有候选。上游明确标记同上下文、多语言条件尚未独立校准，本插件也没有经过 Magpie 调用路径的独立校准。禁止将上游交叉验证准确率描述为本插件在实际环境中的准确率。

上游 scorer 和 bank 的 SHA-256 与上游 provenance 一致：

- scorer：`83fa5bd611e18f8339122582335123c8ea168ed242298bb31f4e363abeeb6e4a`
- bank：`e514c76928ea38d23bc0f14d3935f23c97b1efb6d96b18a19bdc88ad2d830536`

离线测试只验证来源完整性、严格格式校验、数值稳定性和空结果处理；合成测试数组不用于估算模型归因准确率。
