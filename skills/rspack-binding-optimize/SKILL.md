---
name: rspack-binding-optimize
description: 用 sftrace 定位并排序 Rspack binding API 热点，提取独立基准迭代优化，验证真实项目并回退无法稳定复现收益的改动。
---

# Rspack binding API 优化

从真实负载定位可消除的 JS/Rust 边界成本，在快速独立 case 上优化，最后回到真实项目验证。不设最低收益百分比；无法稳定复现改善的实现修改必须回退。

工具入口为本目录的 `scripts/cli.mjs`（Node.js 22+）；运行 `--help` 查看命令。分析依赖见 `scripts/requirements.txt`。

## 1. 建立 Rspack 基线

读目标仓库的 `AGENTS.md`、`.agents/BINDING.md`、`.agents/DEVELOPMENT.md` 和 [Rspack 接入](references/rspack.md)。按 [边界归因](references/discovery.md) 记录负载、JS 调用者、两端源码、有效生命周期、实际 JS/native 产物与构建命令。保留用户改动，固定源码与 fixture；base/head 使用独立工作树和产物。

复用 Rspack 已有 sftrace 构建入口，诊断用 profiling，测量用两端一致的非插桩优化产物；`SFTRACE=0` 仍启用插桩，必须取消设置。编译期插桩不能靠测量时清环境变量消除。

## 2. 从 trace 排序候选

按 [sftrace 工作流](references/sftrace.md) 采集代表性负载。先建立磁盘索引并查看 overview，再查询线程/阶段窗口；大型 trace 按 [资源预算与逐层查询](references/large-traces.md) 处理。只读取有界摘要，原始 trace 留在磁盘；没有有效证据就先解决采集问题。

按 [优先级规则](references/prioritization.md) 对比同函数的 self/total/calls 排名和按祖先路径聚合的调用树。高 total、低 self 要下钻；异步桥要关联等待/回调，跨线程耗时不能相加。候选必须映射到 binding API，普通编译器热点不算绑定优化。

先列出候选的累计成本、可消除工作及证据、预计绝对节省范围、关键路径相关性、实现/验证成本，优先提取潜在收益大且证据充分的 case。sftrace 只用于归因与排序，不作为收益测量。预算导致树不可用时缩小窗口，不能把截断误判为没有热点。

## 3. 提取独立 case

按 [harness 选择与扩展](references/harnesses.md) 运行 `harness-list`，使用 `bench-init --harness NAME` 创建独立目录。填写 trace→API→生产源码→case 的映射及输入合同；内置样例不是热点证据，规模与操作必须由真实负载决定。

按 [基准合同](references/benchmark.md) 先验证输出，再冻结未优化基线。保留真实边界转换、数据分布及必要的 cold/warm/invalidation 语义；去掉扫描、完整构建和无关 I/O。对原生借用对象在有效 hook 内调用 `withContext` 的 `measure`，不可跨回调保存。用独立 case 的诊断确认原热点机制仍存在。

每轮以数秒到数十秒为目标。getter case 不证明 TSFN 调度收益；无法独立触发的桥接才提取同实现的最小 crate，并记录同步生产代码的方法。改变 case、helper、fixture 或测量条件必须重建基线。

## 4. 迭代、验证与回退

- 每轮一条可证伪假设、一个性能因素；修改真实实现，重建并完成对应正确性验证。
- 用 `bench` 交错、独立 Node 进程比较 base/head，核对加载的 JS/native 产物。收益为正且 95% bootstrap 区间下界大于 0 后，用相同产物/输入再独立复测；不设 5% 或其他最低收益门槛，不挑选偶然更快的样本。
- case 稳定改善后重建真实 Rspack，运行相关集成、类型和平台检查，验证固定真实负载无明显回退。覆盖改动涉及的身份、属性位置、顺序、错误、回调/Promise、watch rebuild、失效与 close；不要求大型项目也测出可见加速。
- 使用 [会话记录](references/records.md) 保存证据。每个 case 建独立会话；接受版本成为下一轮比较点，切换 case 继承最新接受版本。接受后复核真实热点并重新排序。
- 正确性失败、收益不稳定、项目回退或证据仍不确定时，精确撤销本轮实现并重建确认；保留 case、trace 和失败记录。不得保留“可能有用”的优化，也不得清除用户修改。

达到目标/预设轮数（默认 10）、同一热点连续两轮失败，或剩余候选无法稳定改善时停止。交付保留改动、两次 case 证据、真实项目验证、回退记录和未覆盖的限制。
