#!/usr/bin/env python3
"""对 sftrace 的 Parquet 数据聚合；完整调用树计算完成后才按符号筛选。"""
import argparse
import json
import heapq
import re
from pathlib import Path
import polars as pl


def aggregate_flamegraph(frames, symtab, limit, focus=None):
    """同一线程、同一祖先路径下聚合同一函数；递归层级保持独立。"""
    symbols = {row['func_id']: row for row in symtab.iter_rows(named=True)}
    contexts, frame_context, nodes = {}, {}, []
    # sftrace frame IDs follow entry order, including equal timestamps.
    for frame in frames.sort(['tid', 'start', 'frame_id']).iter_rows(named=True):
        parent_id = frame_context.get((frame['tid'], frame['parent']))
        if frame['parent'] and parent_id is None:
            raise ValueError('无法重建完整祖先路径')
        key = (frame['tid'], parent_id, frame['func_id'])
        node_id = contexts.get(key)
        if node_id is None:
            node_id = len(nodes)
            contexts[key] = node_id
            symbol = symbols.get(frame['func_id'], {})
            nodes.append({'id': node_id, 'parentId': parent_id, 'tid': frame['tid'],
                          'func_id': frame['func_id'], 'name': symbol.get('name'),
                          'file': symbol.get('file'), 'calls': 0, 'totalNs': 0, 'selfNs': 0})
        node = nodes[node_id]
        node['calls'] += 1
        node['totalNs'] += frame['totalNs']
        node['selfNs'] += frame['selfNs']
        frame_context[(frame['tid'], frame['frame_id'])] = node_id
    kept = set(range(len(nodes)))
    if focus:
        pattern = re.compile(focus)
        matched = {n['id'] for n in nodes if pattern.search(n['name'] or '')}
        descendants = set()
        for node in nodes:
            if node['id'] in matched or node['parentId'] in descendants:
                descendants.add(node['id'])
        kept = descendants
        for node_id in matched:
            parent = nodes[node_id]['parentId']
            while parent is not None and parent not in kept:
                kept.add(parent)
                parent = nodes[parent]['parentId']
    children = {}
    for node in nodes:
        if node['id'] not in kept:
            continue
        children.setdefault(node['parentId'], []).append(node['id'])
    # Largest-first expansion retains parents, so bounded output remains a tree.
    pending = [(-nodes[i]['totalNs'], i) for i in children.get(None, [])]
    heapq.heapify(pending)
    selected = []
    while pending and len(selected) < limit:
        _, i = heapq.heappop(pending)
        selected.append(nodes[i])
        for child in children.get(i, []):
            heapq.heappush(pending, (-nodes[child]['totalNs'], child))
    return {'available': True, 'totalNodes': len(kept), 'unfilteredNodes': len(nodes), 'focus': focus, 'truncated': len(selected) < len(kept),
            'nodes': selected}


def summarize(path, tid=None, limit=20, symbol=None, start_ns=None, end_ns=None, focus=None, max_events=500000):
    if start_ns is not None and end_ns is not None and start_ns >= end_ns:
        raise ValueError('时间窗口必须满足 start-ns < end-ns')
    if pl.scan_parquet(path).select(pl.len()).collect().item() > max_events:
        raise ValueError('trace 超过内存分析事件预算；请用 sftrace_index.py prepare/overview/summary')
    events = pl.scan_parquet(path).filter(pl.col('kind').is_in([1, 2, 3]))
    threads = events.group_by('tid').agg(pl.len().alias('events')).sort('tid').collect().to_dicts()
    if tid is not None:
        events = events.filter(pl.col('tid') == tid)
    # Duration(ns) -> integer nanoseconds; no float precision loss while pairing.
    frames = events.group_by(['tid', 'frame_id']).agg(
        pl.col('parent').first(), pl.col('func_id').first(),
        pl.col('func_id').n_unique().alias('functions'),
        (pl.col('kind') == 1).sum().alias('entries'),
        pl.col('kind').is_in([2, 3]).sum().alias('exits'),
        pl.col('time').filter(pl.col('kind') == 1).first().cast(pl.Int64).alias('start'),
        pl.col('time').filter(pl.col('kind').is_in([2, 3])).last().cast(pl.Int64).alias('end'),
    ).collect()
    valid = frames.filter((pl.col('frame_id') != 0) & (pl.col('entries') == 1) &
                          (pl.col('exits') == 1) & (pl.col('functions') == 1) &
                          (pl.col('end') >= pl.col('start'))).with_columns(
        (pl.col('end') - pl.col('start')).alias('totalNs'))
    discarded = frames.height - valid.height
    # Pair complete frames before clipping. Ancestors overlapping the window remain.
    if start_ns is not None:
        valid = valid.filter(pl.col('end') > start_ns).with_columns(pl.col('start').clip(lower_bound=start_ns))
    if end_ns is not None:
        valid = valid.filter(pl.col('start') < end_ns).with_columns(pl.col('end').clip(upper_bound=end_ns))
    valid = valid.with_columns((pl.col('end') - pl.col('start')).alias('totalNs'))
    if valid.is_empty():
        raise ValueError('没有完整调用帧；检查线程、采集日志与转换错误')
    parents = valid.select('tid', pl.col('frame_id').alias('parent'),
                           pl.col('start').alias('parentStart'), pl.col('end').alias('parentEnd'),
                           pl.col('func_id').alias('callerId'))
    children = valid.filter(pl.col('parent') != 0).join(parents, on=['tid', 'parent'], how='left')
    invalid_children = children.filter(pl.col('parentStart').is_null() |
                                      (pl.col('start') < pl.col('parentStart')) |
                                      (pl.col('end') > pl.col('parentEnd'))).height
    child_times = children.filter(pl.col('parentStart').is_not_null()).group_by(['tid','parent']).agg(
        pl.col('totalNs').sum().alias('childNs')).rename({'parent':'frame_id'})
    valid = valid.join(child_times, on=['tid','frame_id'], how='left').with_columns(
        (pl.col('totalNs') - pl.col('childNs').fill_null(0)).alias('selfNs'))
    negative_self = valid.filter(pl.col('selfNs') < 0).height
    # Do not turn corrupt nesting into apparently precise attribution.
    attribution_valid = not (discarded or invalid_children or negative_self)
    symtab = pl.read_parquet(str(path) + '.symtab')
    if 'file' not in symtab.columns and 'path' in symtab.columns:
        symtab = symtab.rename({'path':'file'})
    symtab = symtab.select('func_id','name','file').unique(subset=['func_id'])
    budgets = valid.group_by('tid').agg(pl.col('selfNs').sum().alias('observedNs'))
    groups = valid.group_by(['tid','func_id']).agg(
        pl.len().alias('calls'), pl.col('totalNs').sum(), pl.col('selfNs').sum(),
        pl.col('totalNs').mean().alias('meanNs'),
        pl.col('totalNs').max().alias('maxNs')).join(symtab,on='func_id',how='left').join(
        budgets, on='tid', how='left').with_columns(
            pl.when(pl.col('observedNs') > 0).then(pl.col('selfNs') / pl.col('observedNs') * 100)
            .otherwise(None).alias('selfSharePercent'))
    # A symbol filter only narrows flat tables; preserve full ancestors in the tree.
    flamegraph = aggregate_flamegraph(valid, symtab, limit, focus) if attribution_valid else {
        'available': False, 'reason': '调用树不完整或时间异常，需补采集', 'nodes': []}
    if symbol:
        groups = groups.filter(pl.col('name').str.contains(symbol))
    if not attribution_valid:
        groups = groups.with_columns(pl.lit(None, dtype=pl.Int64).alias('selfNs'),
                                     pl.lit(None, dtype=pl.Float64).alias('selfSharePercent'))
    def ranking(column):
        return groups.sort([column, 'tid', 'func_id'], descending=[True, False, False]).head(limit).to_dicts()
    rankings = {'bySelfNs': ranking('selfNs') if attribution_valid else [],
                'byTotalNs': ranking('totalNs'), 'byCalls': ranking('calls')}
    hotspots = rankings['bySelfNs'] if attribution_valid else rankings['byTotalNs']
    edges = children.filter(pl.col('callerId').is_not_null()).group_by(['tid','callerId','func_id']).agg(
        pl.len().alias('calls'),pl.col('totalNs').sum()).join(symtab,on='func_id',how='left').join(
        symtab.select(pl.col('func_id').alias('callerId'),pl.col('name').alias('caller')),
        on='callerId',how='left')
    if symbol:
        edges = edges.filter(pl.col('name').str.contains(symbol) | pl.col('caller').str.contains(symbol))
    return {'schemaVersion':1,'kind':'sftrace-summary','source':str(Path(path).resolve()),
            'tid':tid,'threads':threads,'completeFrames':valid.height,'discardedFrames':discarded,
            'invalidChildren':invalid_children,'negativeSelfFrames':negative_self,
            'selfTimeReliable':attribution_valid,'hotspots':hotspots,
            'hotspotsOrder':'selfNs' if attribution_valid else 'totalNs',
            'window':{'startNs':start_ns,'endNs':end_ns},
            'rankings':rankings,'flamegraph':flamegraph,
            'threadBudgets':budgets.to_dicts() if attribution_valid else [],
            'callers':edges.sort('totalNs',descending=True).head(limit).to_dicts(),
            'notes':['仅统计已插桩的 Rust 帧；自身耗时含未插桩的子调用、等待和追踪开销。',
                     '含子调用耗时在递归/嵌套路径会重复计数，不可相加为项目总耗时。',
                     '线程由调用者确认；此摘要不推断主线程，不作为性能收益。',
                     'observedNs 是所选线程/窗口内已观测帧的覆盖时间，排除无帧间隙，不是项目总耗时。',
                     '窗口裁剪后的 calls 表示与窗口相交的调用次数；函数筛选不改变份额分母或完整路径聚合。',
                     '这些排名用于筛选；可消除比例、关键路径相关性和最终优先级需结合代码证据判断。']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path',type=Path)
    parser.add_argument('--tid',type=int)
    parser.add_argument('--limit',type=int,default=20)
    parser.add_argument('--focus', help='聚合树仅展示匹配符号的调用路径、祖先和子树')
    parser.add_argument('--start-ns', type=int, help='分析窗口起点，trace 相对纳秒')
    parser.add_argument('--end-ns', type=int, help='分析窗口终点，trace 相对纳秒')
    parser.add_argument('--symbol',help='聚合后筛选的符号正则')
    parser.add_argument('--output',type=Path,required=True)
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('--limit 应为 1..100')
    result = summarize(args.path,args.tid,args.limit,args.symbol,args.start_ns,args.end_ns,args.focus)
    with args.output.open('x') as stream:
        json.dump(result,stream,ensure_ascii=False,indent=2)
        stream.write('\n')
    print(json.dumps({'output':str(args.output),'hotspots':len(result['hotspots']),
                      'discardedFrames':result['discardedFrames']},ensure_ascii=False))

if __name__ == '__main__':
    main()
