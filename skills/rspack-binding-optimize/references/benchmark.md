# 独立基准与验证

## 创建 case

```sh
node "$SKILL/scripts/cli.mjs" bench-init --dir /path/bench/case \
  --evidence /path/trace/hotspots.json --api Compilation.getAssets --harness assets-read
```

输出 `case.mjs`、`manifest.json` 和 trace 摘要副本。内置 harness 可运行；custom 模板会主动失败。两者都必须先按真实 trace 完成映射、输入规模与语义断言，才可测量。

- `manifest.mapping`：trace 符号、线程、调用方、生产源文件与提取实现的对应关系。
- `manifest.inputContract`：调用次数、批次大小、数据形状、缓存生命周期和代表性输入分布。
- `manifest.fixtureFiles`：参与测量的本地输入文件及 helper/锁文件路径，工具会记录内容校验和；不要遗漏间接依赖。case 之外的源码必须通过 revision 或快照归档。
- `setup({bindingPath})`：用于可以合法持有到测试结束的 context，只准备非热点工作；加载当前 variant 的入口。
- `withContext({bindingPath, measure})`：对 callback-scoped 对象替代 setup/teardown。保持真实 owner/回调有效，在其中调用且只调用一次 `measure(context)`；同步模式下测量和 verify 当场完成，异步模式必须 await/返回该 Promise。外层可以等待整个 workload 完成并在 finally 释放 owner。
- `run(context)`：一次待测操作，返回可检查的结果；缓存失效、惰性物化和必要生命周期操作必须留在合理的计时范围。
- `beforeSample(context)`（可选）：预热后、计时前恢复起始状态；同步模式必须同步。它每个进程只执行一次，不能把本应计入的构建/转换移出计时区。cold/invalidation case 若每次操作都需要重建或失效，必须在 run 中执行，而非只重置一次。
- `verify(result, context)`：使用确定期望值/摘要/不变量验证结果与副作用；runner 校验每个进程的最后一次结果，其他输入边界、每次调用行为和错误路径由专门正确性测试覆盖。同步 withContext 的 verify 必须同步，否则会逃出有效窗口。
- `teardown(context)`（可选）：释放句柄和任务，不能把本应测量的工作延后到这里。
- `config`：`iterations` 为批次循环次数，`warmup` 为预热次数，异步 case 设置 `async:true`。同步模式不引入逐次 `await`。

不要直接运行完整构建项目作为这个 case。若必须提取 crate，带上最小 `Cargo.toml`、构建脚本、JS 入口和锁文件，沿用目标 napi-rs 版本、编译特性和所有权语义。Rust-only microbenchmark 可帮助分析算法，但不能代替 JS/Rust 边界 case。分别保留 cold、warm、invalidation 等必要场景，避免只挑一个有利输入。

## 测量

重新构建 base/head 的 **release、非 XRay/非 sftrace** addon，采用独立输出路径。仅清除环境变量无法消除编译期插桩；工具无法从任意二进制可靠判断编译选项，由 Agent 检查构建日志与实际加载路径。

`context.json` 的最小例子（填入实际值）：

```json
{
  "instrumentation": false,
  "profile": "release",
  "rust": "rustc -Vv 的完整输出",
  "host": "固定 runner/CPU 型号",
  "buildCommand": "项目真实构建命令及 feature",
  "napiVersion": "锁文件中的版本",
  "fixtureRevision": "输入版本"
}
```

```sh
node "$SKILL/scripts/cli.mjs" bench --case /path/bench/case \
  --base /path/base/packages/rspack/dist/index.js --head /path/head/packages/rspack/dist/index.js \
  --base-rev BASE_COMMIT --head-rev HEAD_COMMIT \
  --context /path/bench/context.json --artifacts /path/bench/artifacts.json --output /path/bench/round-01 --samples 12
```

每组交错顺序为 base/head、head/base，至少各 10 个独立进程。每个进程先预热、再计时、再断言。计时批次不足 1ms 会拒绝结果，应增加迭代并重建基线；通常让每批持续数十毫秒更稳健。子进程 60 秒超时。保存原始样本、版本、工具链、文件校验和、失败日志；输出路径必须不存在。

收益定义为 `(1 - head中位数/base中位数) × 100%`。不设最低收益百分比；多进程重复测量中，收益为正且 bootstrap 的 95% 区间下界大于 0 时，工具标记 `reproducibleImprovement: true`。微小但稳定的改善也可接受。这是本地筛选证据，不保证消除热节流、系统负载或相关性；有噪音应重跑固定条件，而不是挑选最佳一轮。工具清理 SFTRACE/XRAY/NAPI_BINDING_PROFILE 环境变量，项目额外诊断变量通过 `--unset-env A,B` 移除；检查 case 自身也没有诊断代码。

JS/ESM 包入口通过绝对路径加载，使用 `--artifacts /path/artifacts.json` 声明 `{ "base": ["/base/dist", "/base/addon.node"], "head": ["/head/dist", "/head/addon.node"] }`。工具递归快照显式目录和文件，测量前后检查 JS 与 native 内容，worker 核对实际加载的 `.node`。JS 入口必须提供此参数，直接 `.node` 入口可省略。不要将整个项目或 node_modules 放入产物列表；列出会影响实现的构建输出，并用锁文件固定其余依赖。Worker 子线程/子进程和 WASI 的加载不能由主进程 require.cache 证明，需要在 case/项目检查中另行核对。

非 release 的优化 profile 可声明 `optimized:true`，保持 profile/flags/feature 在 base/head 间相同。清理继承的 native-library override 后，在 setup/withContext 内按 bindingPath 选择当前产物；不要同时加载两个版本或意外从已安装包解析依赖。

第一次得到改善后，使用完全相同的产物、输入和配置再次运行 bench 到**新的输出目录**，作为 `confirmationPath`。重新生成样本，不复制结果、不只挑选有利的一轮；两轮都支持改善才接受。不设最小改善幅度，第二轮负责验证可复现性。若复测失败，先调查噪音/机制，不能提交第一轮作为完整证据。

基线必须在修改前测过，校验输出，保存源码版本和产物。每轮工具会再次交错测量该基线与候选，减少时间漂移；会话固定最初的基线，已接受版本成为后续比较点。不要覆盖旧结果或边优化边修改输入。

## 实际项目验证

case 稳定复现改善后才进入昂贵的项目验证：先重建产物，执行目标仓库要求的集成、类型和相关平台检查，再运行固定真实负载。确认优化已应用于真实调用路径，整体耗时、内存、吞吐和相关场景没有明显回退。

实际项目可使用已有 benchmark 或 CodSpeed。保存 base/head 版本、runner、输入、构建配置、重复样本或 run ID、效果及噪音范围；独立 case 的结果不能替代项目正确性及回归检查。若用提取 crate 探索，先把同一机制的补丁移植到生产实现，再用生产产物能运行的 case 验证映射；无法直接调用时保存对应代码及真实路径验证证据，不能只保留副本上的加速。收益是否可复现以独立 case 为准；大型项目的噪音可能掩盖微小改善，不要求它也出现可见加速。

回退不接受的实现后，重新构建到上一个接受版本，验证差异和输出；bench、测量和失败原因继续保留。工具只校验回退记录，不自动执行 Git 回退，避免删除目标项目的用户修改。
