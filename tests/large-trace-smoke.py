"""可选压力检查：合成大量调用，验证落盘、完整归因和有界查询；不是性能收益证据。"""
import argparse
import json
import sys
import tempfile
import threading
from pathlib import Path
import duckdb
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'skills/rspack-binding-optimize/scripts'))
import sftrace_index as trace

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--frames',type=int,default=1000000)
a=p.parse_args()
assert a.frames>=1000
n=a.frames
with tempfile.TemporaryDirectory(prefix='rspack-trace-stress-') as tmp:
    root=Path(tmp); path=root/'sf.pola'; index=root/'index'
    # SQL range produces fixture without holding millions of Python objects.
    with duckdb.connect() as c:
        c.execute('''CREATE TABLE events AS SELECT 1::UBIGINT AS frame_id,0::UBIGINT AS parent,7::UINTEGER AS tid,
          10::UBIGINT AS func_id,0::BIGINT AS time,1::UINTEGER AS kind
          UNION ALL SELECT 1,0,7,10,?,2
          UNION ALL SELECT i+2,1,7,20,i*10+1,1 FROM range(?) t(i)
          UNION ALL SELECT i+2,1,7,20,i*10+9,2 FROM range(?) t(i)''',[n*10+20,n,n])
        c.execute("COPY (SELECT frame_id::UBIGINT AS frame_id,parent::UBIGINT AS parent,tid::UINTEGER AS tid,func_id::UBIGINT AS func_id,time::BIGINT AS time,kind::UINTEGER AS kind FROM events) TO '"+str(path).replace("'","''")+"' (FORMAT PARQUET)")
        c.execute("COPY (SELECT * FROM (VALUES (10,'root','root.rs'),(20,'conversion','binding.rs')) AS t(func_id,name,file)) TO '"+str(path).replace("'","''")+".symtab' (FORMAT PARQUET)")
    stop=threading.Event(); peak=[0]
    def watch():
        while not stop.wait(0.01):
            size=0
            for f in index.glob('*.tmp/*'):
                try:size+=f.stat().st_size
                except FileNotFoundError:pass
            peak[0]=max(peak[0],size)
    thread=threading.Thread(target=watch);thread.start()
    try:
        trace.prepare(path,index,memory_mb=64,threads=1,temp_gb=2)
        result=trace.summarize(index,memory_mb=64,threads=1,temp_gb=2,max_tree_frames=100)
        assert result['completeFrames']==n+1
        assert result['selfTimeReliable']
        costs={r['func_id']:r for r in result['hotspots']}
        assert costs[20]['calls']==n and costs[20]['selfNs']==8*n
        assert costs[10]['selfNs']==2*n+20
        assert not result['flamegraph']['available']
        window=trace.summarize(index,tid=7,start_ns=100,end_ns=200,memory_mb=64,threads=1,max_tree_frames=100)
        assert window['completeFrames']==11 and window['flamegraph']['available']
        assert window['threadBudgets'][0]['observedNs']==100
        assert len(json.dumps(result))<20000
    finally:stop.set();thread.join()
    print(json.dumps({'events':2*(n+1),'frames':n+1,'memoryLimitMB':64,'observedPeakSpillBytes':peak[0],
                      'boundedSummaryBytes':len(json.dumps(result)),'attribution':'passed','windowTree':'passed'}))
