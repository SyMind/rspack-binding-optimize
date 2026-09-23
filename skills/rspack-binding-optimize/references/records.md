# 会话记录

```sh
node "$SKILL/scripts/cli.mjs" session-init --dir /path/bench/session \
  --baseline BASE_COMMIT --max-rounds 10
node "$SKILL/scripts/cli.mjs" session-record --dir /path/bench/session \
  --result /path/bench/iteration.json
```

路径用绝对路径。源码标识使用不可变 commit；有未提交变更时先保存可恢复快照和校验和。会话的原始 baseline 不变，只在接受一轮后前移 comparisonPoint。每个固定 case 一个会话；换 case/输入合同后新建会话，以最新已接受源码作为基线并关联前一会话。串行写同一个会话。

接受的记录：

```json
{
  "schemaVersion": 1,
  "round": 1,
  "hypothesis": "减少重复的对象物化",
  "baseRevision": "BASE_COMMIT",
  "candidateRevision": "HEAD_COMMIT",
  "decision": "accepted",
  "correctness": {"status": "passed", "evidencePath": "/path/correctness.log"},
  "bench": {
    "evidencePath": "/path/round-01/result.json",
    "confirmationPath": "/path/round-01-confirm/result.json"
  },
  "project": {
    "status": "passed",
    "noRegression": true,
    "evidencePath": "/path/project-comparison.json"
  }
}
```

工具从首次测量及独立复测的原始样本分别重新计算收益和区间，不信任手填的 `reproducibleImprovement`，要求不同 runId、相同版本/产物和固定测量条件；不按收益幅度拒绝稳定的改善。正确性、真实项目和回退证据文件必须存在且非空；内容需要 Agent 审阅，布尔字段本身不能证明验收通过。

未接受的记录（决定可为 `rejected-performance`、`rejected-correctness`、`inconclusive`）：

```json
{
  "schemaVersion": 1,
  "round": 1,
  "hypothesis": "减少重复的对象物化",
  "baseRevision": "BASE_COMMIT",
  "candidateRevision": "HEAD_COMMIT",
  "decision": "rejected-performance",
  "notes": "独立 case 的改善无法稳定复现；已撤销本轮实现并重建验证",
  "rollback": {
    "status": "reverted",
    "revision": "BASE_COMMIT",
    "evidencePath": "/path/rollback-check.log"
  }
}
```

先回退再记录；未回退不能结束本轮。回退日志包括精确撤销的文件/提交、源码差异和重建后的验证结果。保留失败轮次，不让后续 Agent 重复尝试相同假设。
