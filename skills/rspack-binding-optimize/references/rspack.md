# Rspack 接入

以下映射已按 Rspack 2.2.6 工作树检查；命令和路径以当前目标仓库为准。

## 发现与构建

阅读目标仓库的 `AGENTS.md`、`.agents/BINDING.md` 和 `.agents/DEVELOPMENT.md`。ownership/lifetime 改动再读 JS API architecture；涉及并行或缓存时按仓库规则阅读对应文档。检查 `packages/rspack/src/`、`crates/rspack_binding_api/`、`crates/rspack_napi/` 和 `crates/node_binding/`，把 trace 符号定位到公共 API 和 JS 插件/loader 调用者。

| 环节 | 当前命令/位置 |
| --- | --- |
| sftrace 诊断构建 | `SFTRACE=1 pnpm run build:binding:profiling`；JS 需要更新时运行 `pnpm run build:js` |
| 已有接入 | `crates/node_binding/scripts/build.mjs` 加 feature 和 XRay flag；`crates/rspack_binding_api/src/lib.rs` 已有初始化入口，无需新增 ctor |
| JS 正确性产物 | `pnpm run build:js` |
| Rust 正确性产物 | `pnpm run build:binding:dev` |
| 两端正确性产物 | `pnpm run build:cli:dev` |
| 优化测量产物 | 清除 SFTRACE 等诊断构建开关后 `pnpm run build:cli:release`；纯 Rust 改动可复用固定 JS 产物并 `pnpm run build:binding:release` |
| 实际包入口 | `packages/rspack/dist/index.js`；native loader 在 `crates/node_binding/binding.js` |

构建脚本按环境变量是否非空判断 SFTRACE，`SFTRACE=0` 仍会启用，应取消设置。诊断和测量构建必须使用独立产物路径或工作树；仅更换 `CARGO_TARGET_DIR` 不保证输出 `.node` 不被覆盖。诊断使用 profiling profile，普通测量优先 release；其他优化 profile 要明确配置、保持两端一致并声明 `optimized:true`。

macOS 的 sftrace 仍受上游 LLDB/ptrace 限制。已有 Linux/远程 runner 就复用，并记录工具链/架构；无法采集时使用已保存 trace，不虚构一次成功采集。

## 从什么地方找 case

| 热点 | JS 侧 | Rust 侧与应验证的行为 |
| --- | --- | --- |
| Compilation/getAssets/依赖集合 | `Compilation.ts` | `compilation/`、`source.rs`；返回规模、快照/重复物化、惰性 source 是否被真正读取 |
| Module/Chunk/Graph | `Module.ts`、`Chunk.ts`、`ModuleGraph.ts`、`ChunkGraph.ts` | 对应 binding 文件；identifier 重解析、对象身份、代次/失效与有效 hook 阶段 |
| 插件 hooks/loaders | `taps/`、`loader-runner/` | `plugins/js_hooks_plugin.rs`、`plugins/js_loader/`、`rspack_napi`；参数/返回转换、TSFN、callback 生命周期 |
| 配置/stats | `config/adapter.ts`、`Stats.ts` | `raw_options/`、`stats.rs`；配置转换、按需读取、结构化结果体积 |

同步 tap 的 native-backed 对象必须在 callback 返回前完成访问；Promise tap 必须把工作连接到返回的 Promise。不要把 Module 等保存到 `setup` 返回后，再在脱离 hook 的计时循环里调用。Compilation 的跨 rebuild 行为与其他 wrapper 不同，遵守当前 `.agents/BINDING.md`，不要套用统一的“旧对象都失效”假设。

## 使用真实编译上下文，同时排除整次构建噪音

先创建有真实 trace 依据的 case，再采用 [harness 合同](harnesses.md) 的 `withContext` 模式：构造最小 compiler → 在 processAssets 同步 tap 内 `measure(compilation)` → 完成编译与 close。初始化与 cleanup 在计时外，run/verify 在有效 callback 内。

例如 `assets-read` 演示 `getAssets` 和 source 物化，不表示它已被证明是热点。应按 trace 替换 API、数据规模及语义断言，并在 manifest 登记映射。它测的是 hook 内的 getter 路径，不是 hook 的 Rust→JS 调度成本；后者需要 case 的 run 实际触发 native callback bridge。若该桥无法独立调用，提取使用相同转换与 TSFN 实现的最小 crate，并在真实项目验证同步回去的补丁。

`--base`/`--head` 指向各自工作树的 `packages/rspack/dist/index.js`，`--artifacts` 文件示例：

```json
{
  "base": ["/base/packages/rspack/dist", "/base/crates/node_binding/binding.js", "/base/crates/node_binding/rspack.PLATFORM.node"],
  "head": ["/head/packages/rspack/dist", "/head/crates/node_binding/binding.js", "/head/crates/node_binding/rspack.PLATFORM.node"]
}
```

将 PLATFORM 替换为实际平台，检查 pnpm 链接解析到对应工作树。runner 会移除继承的 `NAPI_RS_NATIVE_LIBRARY_PATH`/`NAPI_RS_FORCE_WASI`，并核对实际加载的 `.node`；如果确需覆盖加载路径，在 case 中依据当前 bindingPath 在 import 之前设置，base/head 必须各自独立。其他性能诊断变量（例如 `RSPACK_PROFILE`、项目自定义 profile 标志）通过 `--unset-env` 清理。不要把诊断 .node 当作测量产物。

独立 case 的输入/helper/锁文件列入 manifest 的 `fixtureFiles`；产物快照已经包含两端 JS/native 输出，无需把不同版本的产物混入共享 fixture。

## 项目验证

- 按改变的层先构建，再运行现有 focused integration runner，例如 `pnpm --dir tests/rspack-test run test -t "configCases/<目标 case>"`；按需要执行 unit/type/native/WASI 检查。
- 新 JS case 放在 `tests/rspack-test/{type}Cases/`，不新增顶层 runner；不新增普通 inline Rust 单元测试。
- 覆盖相关的首次访问、重复访问、watch rebuild、mutation/invalidation、target removal、compiler.close、own/prototype descriptor 与 callback/Promise 完成顺序。
- 独立 case 稳定改善后，固定实际 fixture 验证无回退；不要求完整构建测出微小加速。公共行为/API 改动遵守仓库的英中文档规则。

可选的工具集成检查（只验证 runner 与现有产物，不是优化证据）：

```sh
node tests/rspack-smoke.mjs --entry /project/packages/rspack/dist/index.js \
  --native /project/crates/node_binding/rspack.PLATFORM.node
```

在本工具仓库根目录执行。它遍历内置 harness，使用临时输出目录并关闭 compiler；不会修改目标项目。
