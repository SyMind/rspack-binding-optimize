#!/usr/bin/env python3
"""sftrace 磁盘索引：prepare → overview → summary；只把有界结果交给 Agent。"""
import argparse
import json
from pathlib import Path
import duckdb
import polars as pl
from sftrace_summary import aggregate_flamegraph

SCHEMA = 1


def fingerprint(path):
    result = []
    for p in (Path(path).resolve(), Path(str(Path(path).resolve()) + '.symtab')):
        st = p.stat()
        result.append({'path': str(p), 'size': st.st_size, 'mtimeNs': st.st_mtime_ns})
    return result


def connect(path, memory_mb=512, temp_gb=8, threads=2, read_only=False):
    if memory_mb < 32 or temp_gb <= 0 or not 1 <= threads <= 32:
        raise ValueError('memory-mb >= 32、temp-gb > 0、threads 为 1..32')
    c = duckdb.connect(str(path), read_only=read_only)
    c.execute(f"SET memory_limit='{int(memory_mb)}MB'")
    c.execute(f"SET max_temp_directory_size='{float(temp_gb)}GB'")
    c.execute(f'SET threads={int(threads)}')
    c.execute('SET preserve_insertion_order=false')
    return c


def rows(c, sql, args=None):
    q = c.execute(sql, args or [])
    names = [x[0] for x in q.description]
    return [dict(zip(names, r)) for r in q.fetchall()]


def prepare(path, index, **budget):
    path, index = Path(path).resolve(), Path(index).resolve()
    source = fingerprint(path)
    index.mkdir(parents=True, exist_ok=False)
    metadata = {'schemaVersion': SCHEMA, 'source': str(path), 'fingerprint': source,
                'fingerprintMethod': 'path-size-mtime_ns', 'budget': budget, 'status': 'building'}
    meta_path = index / 'metadata.json'
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    try:
        with connect(index / 'frames.duckdb', **budget) as c:
            c.execute('''CREATE TABLE threads AS SELECT tid, count(*) AS events,
              min(time)::BIGINT AS startNs, max(time)::BIGINT AS endNs
              FROM read_parquet(?) WHERE kind IN (1,2,3) GROUP BY tid''', [str(path)])
            # Complete pairing precedes all time filtering, including cross-window ancestors.
            # min/max avoid order-dependent first/last and unbounded list aggregates.
            pair_sql = """SELECT tid, frame_id, min(parent) AS parent,
              min(func_id) AS func_id, min(func_id)=max(func_id) AND min(parent)=max(parent) AS consistent,
              count(*) FILTER (kind=1) AS entries, count(*) FILTER (kind IN (2,3)) AS exits,
              min(time) FILTER (kind=1)::BIGINT AS start,
              max(time) FILTER (kind IN (2,3))::BIGINT AS finish
              FROM read_parquet(?) WHERE kind IN (1,2,3) AND frame_id>=? AND frame_id<? GROUP BY tid,frame_id"""
            c.execute('CREATE TABLE paired AS '+pair_sql, [str(path),0,0])
            bounds=c.execute('SELECT min(frame_id),max(frame_id) FROM read_parquet(?) WHERE kind IN (1,2,3)',[str(path)]).fetchone()
            # Range partitions preserve every entry/exit pair. sftrace assigns global
            # monotonic IDs; Parquet statistics can prune unrelated row groups.
            width=max(1024,int(budget.get('memory_mb',512))*256)
            metadata['pairChunkIds']=width
            if bounds[0] is not None:
                if (bounds[1]-bounds[0])//width>10000:
                    raise ValueError('frame ID 跨度超过分片预算；缩短采集或在更大预算的机器建立索引')
                for low in range(bounds[0],bounds[1]+1,width):
                    c.execute('INSERT INTO paired '+pair_sql,[str(path),low,min(low+width,bounds[1]+1)])
                c.execute('CHECKPOINT')
            valid = 'frame_id<>0 AND consistent AND entries=1 AND exits=1 AND finish>=start'
            c.execute(f'''CREATE TABLE quality AS SELECT tid, count(*) FILTER (WHERE NOT coalesce({valid},false)) AS discarded
              FROM paired GROUP BY tid''')
            c.execute(f'''CREATE TABLE frames AS SELECT tid,frame_id,parent,func_id,start,finish
              FROM paired WHERE {valid} ORDER BY tid,start,frame_id''')
            c.execute('DROP TABLE paired')
            cols = {r[0] for r in c.execute('DESCRIBE SELECT * FROM read_parquet(?)', [str(path)+'.symtab']).fetchall()}
            file_col = 'file' if 'file' in cols else 'path'
            c.execute(f'''CREATE TABLE symbols AS SELECT func_id, min(name) AS name, min("{file_col}") AS file
              FROM read_parquet(?) GROUP BY func_id''', [str(path)+'.symtab'])
            metadata['frames'] = c.execute('SELECT count(*) FROM frames').fetchone()[0]
            metadata['events'] = c.execute('SELECT coalesce(sum(events),0) FROM threads').fetchone()[0]
            c.execute('CHECKPOINT')
        if source != fingerprint(path):
            raise ValueError('源 trace 在索引期间发生变化，需重新创建索引')
        metadata['status'] = 'ready'
    except Exception as error:
        metadata.update(status='failed', error=str(error))
        raise
    finally:
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    return metadata


def open_index(index, **budget):
    index = Path(index).resolve()
    meta = json.loads((index / 'metadata.json').read_text())
    if meta['status'] != 'ready' or meta['schemaVersion'] != SCHEMA:
        raise ValueError('索引未完成或版本不兼容')
    if meta['fingerprint'] != fingerprint(meta['source']):
        raise ValueError('源 trace 已改变；请创建新索引')
    return meta, connect(index / 'frames.duckdb', read_only=True, **budget)


def overview(index, tid=None, limit=20, buckets=32, **budget):
    if not 1 <= limit <= 100 or not 1 <= buckets <= 100:
        raise ValueError('limit/buckets 为 1..100')
    meta, c = open_index(index, **budget)
    try:
        total = c.execute('SELECT count(*) FROM threads').fetchone()[0]
        inventory = rows(c, 'SELECT * FROM threads ORDER BY events DESC,tid LIMIT ?', [limit])
        result = {'kind':'sftrace-overview', 'source':meta['source'], 'frames':meta['frames'],
                  'events':meta['events'], 'threadCount':total, 'threads':inventory,
                  'threadsTruncated':total > limit, 'buckets':[],
                  'notes':['线程按事件数排列；事件密度不等于耗时或优化收益。用工作负载日志确认线程与阶段。']}
        if tid is not None:
            thread = rows(c, 'SELECT * FROM threads WHERE tid=?', [tid])
            if not thread:
                raise ValueError('线程不存在')
            result['selectedThread'] = thread[0]
            start, end = thread[0]['startNs'], thread[0]['endNs']
            width = max(1, (end-start+1+buckets-1)//buckets)
            result['buckets'] = rows(c, '''SELECT ((start-?)//?)::BIGINT AS bucket, count(*) AS calls,
              min(start) AS firstStartNs,max(finish) AS lastEndNs FROM frames WHERE tid=? GROUP BY bucket ORDER BY bucket''', [start,width,tid])
            for row in result['buckets']:
                row.update(startNs=start+row['bucket']*width, endNs=min(end+1,start+(row['bucket']+1)*width))
        return result
    finally:
        c.close()


def summarize(index, tid=None, limit=20, symbol=None, start_ns=None, end_ns=None,
              focus=None, max_tree_frames=100000, **budget):
    if not 1 <= limit <= 100 or not 0 <= max_tree_frames <= 1000000:
        raise ValueError('limit 为 1..100，max-tree-frames 为 0..1000000')
    if start_ns is not None and end_ns is not None and start_ns >= end_ns:
        raise ValueError('时间窗口必须满足 start-ns < end-ns')
    meta, c = open_index(index, **budget)
    try:
        predicates, params = ['true'], []
        if tid is not None:
            predicates.append('tid=?'); params.append(tid)
        if start_ns is not None:
            predicates.append('finish>?'); params.append(start_ns)
        if end_ns is not None:
            predicates.append('start<?'); params.append(end_ns)
        c.execute('''CREATE TEMP TABLE selected AS SELECT tid,frame_id,parent,func_id,
          greatest(start,coalesce(?,start)) AS start, least(finish,coalesce(?,finish)) AS finish
          FROM frames WHERE ''' + ' AND '.join(predicates), [start_ns,end_ns]+params)
        count = c.execute('SELECT count(*) FROM selected').fetchone()[0]
        if not count:
            raise ValueError('没有完整调用帧；检查线程/窗口/采集日志')
        discarded = c.execute('SELECT coalesce(sum(discarded),0) FROM quality WHERE (? IS NULL OR tid=?)', [tid,tid]).fetchone()[0]
        invalid = c.execute('''SELECT count(*) FROM selected s LEFT JOIN selected p ON s.tid=p.tid AND s.parent=p.frame_id
          WHERE s.parent<>0 AND (p.frame_id IS NULL OR s.start<p.start OR s.finish>p.finish OR s.frame_id<=p.frame_id)''').fetchone()[0]
        c.execute('''CREATE TEMP TABLE costs AS SELECT s.*, s.finish-s.start AS totalNs,
          (s.finish-s.start)-coalesce(ch.childNs,0) AS selfNs FROM selected s LEFT JOIN
          (SELECT tid,parent,sum(finish-start) AS childNs FROM selected WHERE parent<>0 GROUP BY tid,parent) ch
          ON s.tid=ch.tid AND s.frame_id=ch.parent''')
        negative = c.execute('SELECT count(*) FROM costs WHERE selfNs<0').fetchone()[0]
        reliable = not (discarded or invalid or negative)
        c.execute('CREATE TEMP TABLE budgets AS SELECT tid,sum(selfNs) AS observedNs FROM costs GROUP BY tid')
        c.execute('''CREATE TEMP TABLE groups AS SELECT g.*,s.name,s.file,b.observedNs,
          CASE WHEN b.observedNs>0 THEN 100.0*g.selfNs/b.observedNs END AS selfSharePercent FROM
          (SELECT tid,func_id,count(*) AS calls,sum(totalNs) AS totalNs,sum(selfNs) AS selfNs,
          avg(totalNs) AS meanNs,max(totalNs) AS maxNs FROM costs GROUP BY tid,func_id) g
          LEFT JOIN symbols s USING(func_id) LEFT JOIN budgets b USING(tid)''')
        def ranking(column):
            found = rows(c, f'''SELECT * FROM groups WHERE (? IS NULL OR regexp_matches(name,?))
              ORDER BY {column} DESC,tid,func_id LIMIT ?''', [symbol,symbol,limit])
            if not reliable:
                for row in found:
                    row.update(selfNs=None,selfSharePercent=None)
            return found
        rankings = {'bySelfNs':ranking('selfNs') if reliable else [],
                    'byTotalNs':ranking('totalNs'),'byCalls':ranking('calls')}
        tree = {'available':False,'nodes':[], 'selectedFrames':count, 'maxTreeFrames':max_tree_frames,
                'reason':'所选调用帧超过树预算；缩小 tid/时间窗口，flat 排名仍可用' if reliable else '调用树不完整或时间异常，需补采集'}
        if reliable and count <= max_tree_frames:
            # Only bounded frames and their symbols cross the Python boundary.
            frames = pl.DataFrame(rows(c, 'SELECT *,finish AS "end" FROM costs'))
            symtab = pl.DataFrame(rows(c, 'SELECT s.* FROM symbols s WHERE func_id IN (SELECT func_id FROM selected)'))
            if symtab.is_empty():
                symtab = pl.DataFrame(schema={'func_id':pl.UInt64,'name':pl.String,'file':pl.String})
            tree = aggregate_flamegraph(frames,symtab,limit,focus)
        callers = rows(c, '''SELECT e.*,s.name,s.file,p.name AS caller FROM
          (SELECT a.tid,b.func_id AS callerId,a.func_id,count(*) AS calls,sum(a.totalNs) AS totalNs
          FROM costs a JOIN costs b ON a.tid=b.tid AND a.parent=b.frame_id GROUP BY a.tid,b.func_id,a.func_id) e
          LEFT JOIN symbols s ON e.func_id=s.func_id LEFT JOIN symbols p ON e.callerId=p.func_id
          WHERE (? IS NULL OR regexp_matches(s.name,?) OR regexp_matches(p.name,?))
          ORDER BY totalNs DESC,e.tid,callerId,e.func_id LIMIT ?''', [symbol,symbol,symbol,limit])
        return {'schemaVersion':1,'kind':'sftrace-summary','source':meta['source'],'index':str(Path(index).resolve()),
                'tid':tid,'window':{'startNs':start_ns,'endNs':end_ns},'completeFrames':count,'discardedFrames':discarded,
                'invalidChildren':invalid,'negativeSelfFrames':negative,'selfTimeReliable':reliable,
                'hotspots':rankings['bySelfNs'] if reliable else rankings['byTotalNs'],
                'hotspotsOrder':'selfNs' if reliable else 'totalNs','rankings':rankings,'flamegraph':tree,
                'threadBudgets':rows(c,'SELECT * FROM budgets ORDER BY observedNs DESC,tid LIMIT ?', [limit]) if reliable else [],
                'threadBudgetsTruncated':c.execute('SELECT count(*) FROM budgets').fetchone()[0] > limit,
                'callers':callers,'notes':['仅已插桩 Rust 帧；self 包含等待、未插桩调用和追踪开销，不是 CPU 时间或收益。',
                'total 在嵌套/递归中重复计数；不跨线程相加。observedNs 是帧覆盖时间，不是项目总耗时。',
                '先配对再裁剪；calls 是与窗口相交的调用数。symbol/focus 不减少配对开销。',
                '不同窗口聚合不能直接相加 calls；跨窗口长帧会重复出现。',
                '原始文件用路径/大小/mtime 检查变化；需不可变归档，不是内容校验和。']}
    finally:
        c.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['prepare','overview','summary'])
    p.add_argument('--path',type=Path)
    p.add_argument('--index',type=Path,required=True)
    p.add_argument('--output',type=Path)
    p.add_argument('--memory-mb',type=int,default=512)
    p.add_argument('--temp-gb',type=float,default=8)
    p.add_argument('--threads',type=int,default=2)
    p.add_argument('--tid',type=int)
    p.add_argument('--limit',type=int,default=20)
    p.add_argument('--buckets',type=int,default=32)
    p.add_argument('--start-ns',type=int)
    p.add_argument('--end-ns',type=int)
    p.add_argument('--symbol')
    p.add_argument('--focus')
    p.add_argument('--max-tree-frames',type=int,default=100000)
    a=p.parse_args()
    budget=dict(memory_mb=a.memory_mb,temp_gb=a.temp_gb,threads=a.threads)
    if a.command=='prepare':
        if not a.path: p.error('prepare 需要 --path')
        result=prepare(a.path,a.index,**budget)
    else:
        if not a.output: p.error('overview/summary 需要 --output')
        if a.output.exists(): p.error('输出已存在，请用新路径')
        result=overview(a.index,a.tid,a.limit,a.buckets,**budget) if a.command=='overview' else summarize(
            a.index,a.tid,a.limit,a.symbol,a.start_ns,a.end_ns,a.focus,a.max_tree_frames,**budget)
        with a.output.open('x') as f:
            json.dump(result,f,ensure_ascii=False,indent=2)
    print(json.dumps({'command':a.command,'index':str(a.index),'output':str(a.output) if a.output else None,
                      'status':result.get('status','ready')},ensure_ascii=False))

if __name__=='__main__':
    main()
