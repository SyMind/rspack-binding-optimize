# sftrace 接入与分析

检查 `sftrace --help`、`sftrace record --help`、`sftrace convert --help`，记录版本或源码 revision。已核对 [上游 sftrace](https://github.com/quininer/sftrace) 提交 `2d5380684cb82d27232d751852f0a1f1b97e2065` 的 CLI/Parquet 格式；工具调用 `record -o`、`convert --type pola`，不复制其实现。

## Rspack 诊断构建

按 [Rspack 接入](rspack.md) 复用 `crates/node_binding/scripts/build.mjs` 和现有 setup。安装匹配的 sftrace CLI/动态库，用 `sftrace record --print-solib` 验证路径。需要自行安装动态库时，放到 `record --print-solib-install-dir` 指向的位置。

在隔离的诊断工作树运行 `SFTRACE=1 pnpm run build:binding:profiling`，需要时 `pnpm run build:js`。检查构建日志确实启用 sftrace-setup/XRay，并确认目标负载加载该 `.node`；遵守当前工具链/平台要求。`CARGO_TARGET_DIR` 不保证最终 `.node` 不被覆盖，诊断/测量应使用独立工作树或独立输出路径。不要重复添加 setup/ctor。

macOS 仍须遵守上游 LLDB/ptrace 要求；`record` 不会自动解决。无法采集时复用支持的平台/远程 runner 或已有 trace，并记录差异，不声称本机成功采集。多个子进程分别记录，避免同时写一份日志。

## 采集、索引、查询

```sh
node "$SKILL/scripts/cli.mjs" trace --repo /path/rspack \
  --output /path/trace-01 -- node workload.cjs
python3 "$SKILL/scripts/sftrace_index.py" prepare --path /path/trace-01/sf.pola \
  --index /path/trace-01/index
python3 "$SKILL/scripts/sftrace_index.py" overview --index /path/trace-01/index \
  --output /path/trace-01/overview.json
python3 "$SKILL/scripts/sftrace_index.py" summary --index /path/trace-01/index \
  --tid 123 --limit 20 --output /path/trace-01/hotspots.json
```

`SKILL` 指向本 skill 目录，Python 安装 `scripts/requirements.txt` 中的依赖。结合工作负载日志确认线程，不凭 ID 大小或事件数猜主线程。异步桥同时检查相关工作线程与等待关系。必要时使用 `--start-ns/--end-ns` 限定阶段，`--symbol` 过滤 flat 表，`--focus` 展示匹配符号的祖先与子树；按 [优先级](prioritization.md) 排序后再建 case。

默认 trace 清理继承的函数/线程过滤变量，保存命令、Git 状态、原始日志及转换日志。检查转换错误、丢帧、错配及异常嵌套；这些情况会令 self 和聚合树不可用。self 含未插桩调用、等待与追踪开销，不等于 CPU 时间。普通编译器计算热点要进一步映射到 binding 边界，不直接列为 binding 优化。

大型项目先按 [大 trace 处理](large-traces.md) 配置资源预算，必要时 `--convert none` 后单独转换。只向 Agent 提供有界摘要；原始数据不进入上下文。小 trace 可用 `sftrace_summary.py sf.pola --output summary.json`，超过 500000 个事件会拒绝并提示索引路径。

可选 `sftrace convert sf.log -o trace.pb.gz` 供 Perfetto 查看。函数平面聚合类似 Slices 分组，按完整祖先路径聚合同函数类似 Slice Flamegraph；保留递归和不同 caller 上下文。图形查看只是诊断，不能用 trace 耗时、文件大小或跨线程耗时之和声称性能改善。
