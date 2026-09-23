# 大型项目与大 sftrace

## 先限制采集成本

先明确首次构建、增量 rebuild、某个插件阶段等目标，使用仍能复现目标机制的最短真实负载，避免整段开发服务器会话。多个子进程分别采集，不写同一文件。不要默认按函数过滤采集：缺失祖先会破坏 self 归因。若只能缩减插桩/采集范围，明确记录覆盖率，不能和完整 trace 直接比较份额。

`trace --convert none` 只保存原始文件和采集日志，之后在资源合适的机器单独运行 `sftrace convert --type pola sf.log -o sf.pola`。采集与转换各有独立的 `--trace-timeout-ms`、`--convert-timeout-ms`（默认均 300000），应根据负载设定有限预算。转换本身属于上游 sftrace，下面的 DuckDB 预算不能限制它；若转换资源不足，缩短负载或迁移分析机器。原始二进制不能按字节切段、head 或随机采样事件，否则入口/退出及符号关系会损坏。

保留 `sf.log`、`sf.pola`、`sf.pola.symtab`、metadata 和日志，按不可变证据归档。分析器只检查路径/大小/mtime 变化，不代替归档校验和。

## 一次配对，多次查询

```sh
python3 "$SKILL/scripts/sftrace_index.py" prepare --path /trace/sf.pola \
  --index /trace/index --memory-mb 512 --temp-gb 8 --threads 2
python3 "$SKILL/scripts/sftrace_index.py" overview --index /trace/index \
  --output /trace/overview.json
python3 "$SKILL/scripts/sftrace_index.py" overview --index /trace/index \
  --tid 123 --buckets 32 --output /trace/thread-123.json
python3 "$SKILL/scripts/sftrace_index.py" summary --index /trace/index \
  --tid 123 --start-ns 1000000 --end-ns 2000000 --limit 20 \
  --output /trace/phase.json
```

prepare 按 sftrace 全局 frame ID 的连续范围分批配对入口/退出，再保存为 DuckDB 磁盘表，同时保存线程信息与符号。同一帧的入口/退出始终在一批，不按时间切断长调用。分片宽度随内存预算调整，GROUP BY/排序可落盘，避免一次对全量帧执行高基数聚合或将所有事件交给 Python。索引目录必须不存在，失败索引不能复用。原始文件发生变化时重建。已配对表按线程/开始时间排序，查询可复用并跳过无关数据，但跨窗口长帧仍需读取；不承诺所有窗口查询都是常数时间。

overview 只返回前 N 个线程（按事件数）及指定线程至多 100 个时间桶。事件密度用于选择阶段，不等于耗时或收益。结合 workload 日志确认线程和阶段，然后看 flat self/total/calls，继续缩小窗口查聚合树。保留启动、稳态、rebuild 等独立范围，避免只选择支持假设的阶段。

summary 在数据库里计算 self、聚合同函数和 caller，只取前 N 行；符号筛选发生在归因之后，不破坏分母。先完整配对，再按窗口裁剪，保留覆盖窗口的祖先。不同窗口的 calls 不能直接相加：跨窗口长帧会重复出现。

`--max-tree-frames` 默认 100000：窗口超过预算时返回 flat 排名和明确的 tree 不可用原因，不导出全量帧。按线程/阶段缩小范围后再查树；`--focus` 只选择展示的路径，`--limit` 只限制结果，都不是降低扫描/配对内存的方法。设置 0 可完全跳过树。树只读取窗口中的有界帧和对应符号，保留不同祖先路径与递归层级。

## 资源与停止条件

每次命令均可设置 `--memory-mb`、`--temp-gb`、`--threads`。默认 512 MB/8 GB/2 线程；临时 spill 在索引旁的 DuckDB 临时目录。失败保留原始 trace 和失败 metadata，先检查磁盘/预算，再减少线程、缩小采集或迁移机器，不无限重试。索引文件和原始文件所需磁盘空间另计；`temp-gb` 只限制临时 spill。

DuckDB 的 memory_limit 不是进程 RSS 的硬上限，Python 有界树也会占用内存；有严格限制时使用操作系统/容器资源预算。不要在低内存机器上把树上限直接调到百万。SQL 阶段也可能因算子/资源不足失败，不把“支持落盘”描述成保证处理任意大小。[DuckDB 资源说明](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads) 与 [配置限制](https://duckdb.org/docs/current/configuration/pragmas)。

小 trace 可用 `sftrace_summary.py` 一次性分析；该路径有事件数保护，超过预算改用索引模式。不要读完整 Parquet/JSON、全量符号表或完整 Perfetto trace 到 Agent 上下文。交给 Agent 的是概要、候选表与后续查询路径；需要图形查看时只导出/查看相关阶段，原始文件留在磁盘。
