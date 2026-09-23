import importlib.util
import tempfile
import unittest
from pathlib import Path
import polars as pl

script = Path(__file__).resolve().parents[1] / 'skills/rspack-binding-optimize/scripts/sftrace_summary.py'
spec = importlib.util.spec_from_file_location('sftrace_summary', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'sf.pola'

    def write(self, rows, file_column='file'):
        pl.DataFrame(rows, schema=['frame_id','parent','tid','func_id','time','kind'],orient='row').with_columns(
            pl.col('time').cast(pl.Duration('ns'))).write_parquet(self.path)
        pl.DataFrame({'func_id':[10,20,30], 'name':['root','conversion','worker'],
                      file_column:['a.rs:1','b.rs:2','c.rs:3']}).write_parquet(str(self.path)+'.symtab')

    def rows(self):
        return [(1,0,7,10,0,1),(2,1,7,20,10,1),(2,1,7,20,40,3),(1,0,7,10,100,2),
                (3,0,8,30,0,1),(3,0,8,30,50,2)]

    def test_nested_tail_call_and_threads(self):
        self.write(self.rows())
        result=module.summarize(self.path,tid=7)
        self.assertTrue(result['selfTimeReliable'])
        root=result['hotspots'][0]
        self.assertEqual((root['name'],root['totalNs'],root['selfNs']),('root',100,70))
        self.assertEqual(result['callers'][0]['caller'],'root')
        self.assertEqual(len(result['threads']),2)

    def test_filter_after_self_time_computation_and_legacy_symbol_path(self):
        self.write(self.rows(),'path')
        result=module.summarize(self.path,tid=7,symbol='root')
        self.assertEqual(len(result['hotspots']),1)
        self.assertEqual(result['hotspots'][0]['selfNs'],70)
        self.assertEqual(result['hotspots'][0]['file'],'a.rs:1')

    def test_unpaired_frames_invalidate_self_attribution(self):
        self.write(self.rows()+[(4,0,7,10,200,1)])
        result=module.summarize(self.path)
        self.assertEqual(result['discardedFrames'],1)
        self.assertFalse(result['selfTimeReliable'])
        self.assertIsNone(result['hotspots'][0]['selfNs'])

    def test_mismatched_function_and_empty_thread(self):
        rows=self.rows();rows[2]=(2,1,7,30,40,2)
        self.write(rows)
        self.assertEqual(module.summarize(self.path)['discardedFrames'],1)
        with self.assertRaisesRegex(ValueError,'没有完整调用帧'):
            module.summarize(self.path,tid=999)

    def test_invalid_parent_timing(self):
        rows=self.rows();rows[2]=(2,1,7,20,110,2)
        self.write(rows)
        result=module.summarize(self.path)
        self.assertFalse(result['selfTimeReliable'])
        self.assertEqual(result['invalidChildren'],1)

    def test_self_ranking_avoids_expensive_wrapper_and_keeps_frequency(self):
        rows=[(1,0,7,10,0,1),(1,0,7,10,100,2)]
        for i in range(5):
            rows += [(i+2,1,7,20,i*20,1),(i+2,1,7,20,i*20+18,2)]
        self.write(rows)
        result=module.summarize(self.path)
        self.assertEqual(result['hotspots'][0]['name'],'conversion')
        self.assertEqual(result['rankings']['byTotalNs'][0]['name'],'root')
        hot=result['rankings']['byCalls'][0]
        self.assertEqual((hot['calls'],hot['meanNs'],hot['selfSharePercent']),(5,18,90))
        nodes=result['flamegraph']['nodes']
        self.assertEqual(len(nodes),2)
        self.assertEqual(nodes[1]['calls'],5)
        self.assertEqual(nodes[1]['parentId'],nodes[0]['id'])

    def test_same_function_different_ancestor_paths_stay_separate(self):
        self.write([(1,0,7,10,0,1),(2,1,7,20,10,1),(2,1,7,20,30,2),(1,0,7,10,40,2),
                    (3,0,7,30,50,1),(4,3,7,20,60,1),(4,3,7,20,80,2),(3,0,7,30,90,2)])
        result=module.summarize(self.path)
        hot=next(r for r in result['hotspots'] if r['func_id']==20)
        self.assertEqual(hot['calls'],2)
        contexts=[n for n in result['flamegraph']['nodes'] if n['func_id']==20]
        self.assertEqual(len(contexts),2)
        self.assertNotEqual(contexts[0]['parentId'],contexts[1]['parentId'])

    def test_recursion_preserves_depth_and_does_not_double_count_self_share(self):
        self.write([(1,0,7,10,0,1),(2,1,7,10,10,1),(2,1,7,10,40,2),(1,0,7,10,100,2)])
        result=module.summarize(self.path)
        hot=result['hotspots'][0]
        self.assertEqual((hot['totalNs'],hot['selfNs'],hot['selfSharePercent']),(130,100,100))
        nodes=result['flamegraph']['nodes']
        self.assertEqual(len(nodes),2)
        self.assertEqual(nodes[1]['parentId'],nodes[0]['id'])

    def test_thread_budgets_are_not_merged_and_filter_keeps_denominator(self):
        self.write(self.rows())
        result=module.summarize(self.path,symbol='conversion')
        self.assertEqual(result['hotspots'][0]['selfSharePercent'],30)
        self.assertEqual({r['tid']:r['observedNs'] for r in result['threadBudgets']},{7:100,8:50})
        self.assertEqual(len(result['flamegraph']['nodes']),3)

    def test_window_clips_frames_after_pairing(self):
        self.write(self.rows())
        result=module.summarize(self.path,tid=7,start_ns=20,end_ns=50)
        by_id={r['func_id']:r for r in result['hotspots']}
        self.assertEqual((by_id[10]['totalNs'],by_id[10]['selfNs']),(30,10))
        self.assertEqual(by_id[20]['totalNs'],20)
        self.assertEqual(result['threadBudgets'][0]['observedNs'],30)
        with self.assertRaisesRegex(ValueError,'时间窗口'):
            module.summarize(self.path,start_ns=50,end_ns=20)

    def test_bounded_tree_keeps_ancestors_and_marks_truncation(self):
        self.write(self.rows())
        result=module.summarize(self.path,limit=1)
        tree=result['flamegraph']
        self.assertTrue(tree['truncated'])
        self.assertEqual(tree['totalNodes'],3)
        self.assertEqual(len(tree['nodes']),1)
        self.assertIsNone(tree['nodes'][0]['parentId'])

    def test_corrupt_trace_does_not_rank_self_or_export_flamegraph(self):
        self.write(self.rows()+[(4,0,7,10,200,1)])
        result=module.summarize(self.path)
        self.assertEqual(result['rankings']['bySelfNs'],[])
        self.assertEqual(result['threadBudgets'],[])
        self.assertFalse(result['flamegraph']['available'])
        self.assertTrue(all(r['selfSharePercent'] is None for r in result['hotspots']))

    def test_focused_tree_keeps_ancestors_and_excludes_unrelated_workers(self):
        self.write(self.rows())
        tree=module.summarize(self.path,focus='conversion')['flamegraph']
        self.assertEqual({node['name'] for node in tree['nodes']},{'root','conversion'})
        self.assertEqual((tree['totalNodes'],tree['unfilteredNodes']),(2,3))
        self.assertEqual(module.summarize(self.path,focus='missing')['flamegraph']['nodes'],[])

if __name__=='__main__':
    unittest.main()
