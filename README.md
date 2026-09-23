# rspack-binding-optimize

Rspack 专用的中文 Agent skill 与工具仓库。从 sftrace 排序 binding API 热点，提取快速独立 case，在 case 上迭代，回到真实项目验收。无固定收益门槛；无法稳定复现改善的实现修改必须回退。

## 使用

将 `skills/rspack-binding-optimize` 整个目录复制到 Agent 的 skills 目录，随后在 Rspack 项目中请求使用 `$rspack-binding-optimize`。也可以直接使用本仓库：

```sh
export SKILL="$(pwd)/skills/rspack-binding-optimize"
python3 -m venv .venv
.venv/bin/pip install -r "$SKILL/scripts/requirements.txt"
node "$SKILL/scripts/cli.mjs" --help
node "$SKILL/scripts/cli.mjs" harness-list
```

需要 Node.js 22+、Python 3.9+、Polars 1.x、DuckDB 1.x。另行安装 [sftrace](https://github.com/quininer/sftrace) 与动态库；Rspack 复用已有 profiling/XRay 接入，性能测量使用非插桩优化产物。

入口：[SKILL.md](skills/rspack-binding-optimize/SKILL.md)。完整工作流：

1. 采集代表性真实负载；大 trace 建磁盘索引，先 overview，后按线程/时间窗口查询。
2. 聚合同函数与祖先路径，按可消除的绝对成本排序，映射回 Rspack JS/Rust API。
3. 选择 harness，固定真实边界、输入分布与语义断言，建立独立基线。
4. 修改实现并交错测量；独立复测稳定改善后，验证真实项目正确性和无回退。
5. 接受或精确回退实现，保留所有证据，重新排序下一候选。

内置 harness：`assets-read`、`assets-update`、`module-graph`、`stats-json`，以及 `custom`。模板通过真实 Rspack compiler 进入有效 hook，构建准备和清理在计时外；它们不是已经发现的热点或优化成果。扩展方式见 [harness 合同](skills/rspack-binding-optimize/references/harnesses.md)。

详细说明：[Rspack 接入](skills/rspack-binding-optimize/references/rspack.md)、[sftrace](skills/rspack-binding-optimize/references/sftrace.md)、[大 trace](skills/rspack-binding-optimize/references/large-traces.md)、[优先级](skills/rspack-binding-optimize/references/prioritization.md)、[基准](skills/rspack-binding-optimize/references/benchmark.md)、[记录](skills/rspack-binding-optimize/references/records.md)。

## 开发验证

```sh
node --test tests/*.test.mjs
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
.venv/bin/python tests/large-trace-smoke.py --frames 1000000
node tests/rspack-smoke.mjs --entry /rspack/packages/rspack/dist/index.js \
  --native /rspack/crates/node_binding/rspack.PLATFORM.node
```

smoke 消费预先构建的 Rspack 产物，验证全部内置 harness 的语义、native 加载和生命周期。测试数据只证明工具行为，不作为生产性能收益。

大 trace 压力检查使用 2000002 条合成事件，验证 64 MB DuckDB 预算下的磁盘落盘、完整 self 归因与窗口聚合树；该预算不是进程 RSS 上限。
