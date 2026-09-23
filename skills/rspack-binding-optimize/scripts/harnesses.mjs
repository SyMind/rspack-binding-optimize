// 每个 harness 拷贝成独立 case；新增条目必须提供真实产物 smoke 和合同说明。
export const harnesses = {
  custom: {description:'自行实现真实边界调用；默认模板会失败', file:'case.mjs', helpers:[]},
  'assets-read': {description:'processAssets 内 getAssets + source 物化，重复读取', file:'harnesses/assets-read.mjs', helpers:['harnesses/compiler.mjs']},
  'assets-update': {description:'updateAsset 后读取 source，每次操作触发失效', file:'harnesses/assets-update.mjs', helpers:['harnesses/compiler.mjs']},
  'module-graph': {description:'真实模块图中 modules/identifier/chunkGraph 查询', file:'harnesses/module-graph.mjs', helpers:['harnesses/compiler.mjs']},
  'stats-json': {description:'固定字段的 Stats.toJson 转换与结果物化', file:'harnesses/stats-json.mjs', helpers:['harnesses/compiler.mjs']},
};
