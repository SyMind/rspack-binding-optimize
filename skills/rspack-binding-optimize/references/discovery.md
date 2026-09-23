# 项目发现与边界归因

## 先建立一张接入地图

从目标项目的 `AGENTS.md`、package scripts、Cargo features/build.rs、JS 入口和已有 benchmark 查起，记录到会话的 `project-context.md`：

- 目标指标和固定负载：哪个阶段慢，哪个调用方/插件会触发它，输入规模与重复访问方式；先选可重复的代表性短负载。
- 公共 JS API → JS 包装层 → napi-rs 导出/转换 → native owner 的位置；反向 hook、loader、callback/TSFN 也要画出返回路径。
- 实际加载的 JS 入口和 `.node` 文件、源码 revision/未提交快照、工具链、feature、诊断/优化构建命令、项目测试命令。
- 对象的有效访问窗口、缓存代次、错误处理、同步/Promise/callback 完成方式和 owner 关闭规则。

先检查现有 sftrace feature、初始化入口和构建脚本。已有接入就复用，不再加一个 setup/ctor。隔离工作树不会自动携带未提交代码、未跟踪 fixture、构建产物或正确的依赖链接；明确选择基线并保存/复制必要快照，核对各工作树实际加载的 addon。不得清除用户修改。

## 把热点归因到可修改的 API

原生函数排名不等于 binding API 排名。每个候选都需要对应实际 JS 调用者、方向、输入/输出和源码位置；没有边界关联的编译器/解析器热点不应冒充绑定优化。

| 路径 | 要检查的成本 | sftrace 之外需要补充的证据 |
| --- | --- | --- |
| JS→Rust | JS wrapper、napi trampoline、FromNapiValue、目标方法、ToNapiValue、JS 后续物化 | 实际 getter/方法调用数、输入元素/字节、返回字段中真正被读取的比例 |
| Rust→JS→Rust | 参数转换、TSFN 排队、线程切换、JS callback、Promise 等待、返回转换 | callback 执行次数、排队/执行区间、返回数据规模，按请求或调用 ID 关联 |
| 生命周期/缓存 | 重复创建快照、重复字符串/对象分配、命中与失效 | cold/warm/invalidation 的比例、所有权/代次，旧对象的访问合同 |

napi-rs 的参数转换可能发生在被标注方法进入之前；内联转换或 V8/Node-API 内部代码可能没有独立的 XRay 帧。sftrace 未显示 `ToNapiValue` 不代表没有转换成本，也不能直接把 wrapper 的全部 self 归为 CPU 转换。先看上下游调用链，必要时对同一负载补 JS CPU profile、边界聚合计数或调度证据。

临时计数记录稳定 API 名、调用方/阶段、calls、输入/输出大小、物化对象/字符串数、缓存命中/失效；异步桥增加关联 ID。聚合后批量输出，诊断开关关闭时不进入计时路径。不要在每次调用时打印日志。JS 与 Rust 不同线程的时间线要通过明确关联或等待关系连接，不能伪造为一条连续调用栈。

## 从证据选择可验证的机制

- 大结果只读取少部分：考虑粗粒度惰性物化，同时覆盖读取全部字段的场景。
- 同一代次重复转换：考虑缓存已拥有的快照，覆盖重建、删除、close 和 mutation 后失效。
- 高频逐元素跨边界：考虑批处理，保留调用顺序、异常、对象身份和回调时序。
- 不可变且常读的字段：比较一次物化与重复 getter；验证 own/prototype descriptor 合同。
- 大量纯数据传输：比较结构化 N-API 构造与序列化路径，把 Rust 序列化、传输、JS 解析全部计入。undefined、BigInt、RegExp、循环引用、原型、函数或 native identity 不能被有损替代。
- TSFN/回调重建与调度：检查能否减少创建/调度次数，不能改成不等待、不释放回调或跨 owner 共享。

这些只是机制菜单，不是默认优化清单。先按 `prioritization.md` 的累计成本和可消除工作排序，再选择一条假设；以代码、计数与 case 复现确认它，不能仅从类型名判断。
