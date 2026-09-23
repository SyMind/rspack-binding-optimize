# Harness 选择与扩展

先完成热点排序，再选择与真实调用路径一致的模板：

| 名称 | 计时范围 | 不能据此证明 |
| --- | --- | --- |
| assets-read | `getAssets`、名称/source 读取及物化；默认 64 个 256 字节资产 | 首次访问成本、未读 source 的路径 |
| assets-update | 每次 `updateAsset` 后重新读取 source，包含 mutation 和物化 | watch rebuild 或其他缓存的失效正确性 |
| module-graph | 遍历真实 modules、identifier、chunkGraph 查询；默认 16 个导入 | 大型图的规模规律、旧 Module 跨 rebuild 可用 |
| stats-json | 固定选项 `Stats.toJson` 的调用与返回物化 | 全字段 stats、不同插件/选项、真实业务的序列化占比 |
| custom | 主动失败的接口模板，按证据补全 | mock 或纯 Rust 循环能代表绑定成本 |

```sh
node "$SKILL/scripts/cli.mjs" harness-list
node "$SKILL/scripts/cli.mjs" bench-init --dir /bench/get-assets \
  --evidence /trace/phase.json --api Compilation.getAssets --harness assets-read
```

工具复制 case 与 `compiler.mjs` helper，自动将 helper 放入 `manifest.fixtureFiles`。先修改输入规模、消费方式和断言，完成 manifest，再冻结基线。样例参数只是能运行的起点，不是生产输入分布。必须另外保留真实负载相应规模，防止只优化小样例。

`compiler.mjs` 用最小 entry 生成真实编译上下文，在同步 processAssets tap 中执行 measure 和断言，然后等待 run 完成并 close，finally 删除本次临时目录。启动、解析、I/O 不在计时区内，但仍计入 case 总运行时间。需要其他阶段时修改副本的 hook，不要把原生借用对象带到回调之外。一次测量只加载一个工作树的入口和 native。

getter harness 的循环发生在 JS callback 内，不包含触发该 callback 的 Rust→JS 调度。TSFN、loader 或 hook bridge 优化需要 `run` 真正驱动边界请求，包含参数转换、调度、回调完成及返回转换；不能把 JS Tapable 循环当作 native bridge。优先沿用 Rspack 已有可调用入口；没有可独立调用的入口才提取相同实现的最小 crate。

## 增加 harness

1. 在 `assets/harnesses/` 添加一个操作明确的 case，复用 helper 或提供自己的 owner/lifecycle；避免把所有 API 合成一个不可归因的大循环。
2. 在 `scripts/harnesses.mjs` 登记名称、说明、case 文件和 helper；helper 复制到 case 根目录，文件名不得冲突。新 fixture/配置/loader 也必须列入 `fixtureFiles`。
3. 在此表说明计时边界、输入合同、cold/warm/invalidation 和局限。实现确定性断言；错误/身份/每次调用等合同用 Rspack 对应测试覆盖。
4. `tests/rspack-smoke.mjs` 自动遍历登记的非 custom harness，以真实已构建产物校验；运行后核对资源释放。smoke 不设速度断言，也不声称收益。

优先按已发现的热点扩展配置转换、loader 回传、hook/TSFN、watch 失效等 harness；在真实机制可复现之前，不添加空壳 benchmark。更改共享 helper 会改变测量条件，已有 case 使用冻结的副本；显式同步后必须重建基线。
