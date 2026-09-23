import sys
import json
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch
import test_sftrace as fixtures
small = fixtures.module
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'skills/rspack-binding-optimize/scripts'))
import sftrace_index as disk


class IndexTests(fixtures.SummaryTests):
    # Run the same semantic suite against both engines, including malformed traces.
    def setUp(self):
        super().setUp()
        self.original = small.summarize
        self.sequence = 0
        def indexed(path,*args,**kwargs):
            self.sequence += 1
            index=Path(self.temp.name)/f'index-{self.sequence}'
            disk.prepare(path,index,memory_mb=64,threads=1)
            result=disk.summarize(index,*args,**kwargs,memory_mb=64,threads=1)
            result['threads']=disk.overview(index)['threads']
            return result
        replacement=patch.object(small,'summarize',indexed)
        replacement.start()
        self.addCleanup(replacement.stop)

    def test_tree_budget_does_not_drop_flat_costs(self):
        self.write(self.rows())
        index=Path(self.temp.name)/'bounded'
        disk.prepare(self.path,index)
        full=disk.summarize(index,tid=7)
        bounded=disk.summarize(index,tid=7,max_tree_frames=1)
        self.assertEqual(full['rankings'],bounded['rankings'])
        self.assertFalse(bounded['flamegraph']['available'])
        clipped=disk.summarize(index,tid=7,start_ns=50,end_ns=90,max_tree_frames=1)
        self.assertTrue(clipped['flamegraph']['available'])
        self.assertEqual(clipped['hotspots'][0]['selfNs'],40)

    def test_overview_is_bounded_and_cache_rejects_changes(self):
        self.write(self.rows())
        index=Path(self.temp.name)/'overview'
        disk.prepare(self.path,index)
        result=disk.overview(index,tid=7,limit=1,buckets=2)
        self.assertEqual(len(result['threads']),1)
        self.assertTrue(result['threadsTruncated'])
        self.assertLessEqual(len(result['buckets']),2)
        with self.assertRaises(FileExistsError):disk.prepare(self.path,index)
        self.path.touch()
        with self.assertRaisesRegex(ValueError,'已改变'):disk.summarize(index)

    def test_cli_pipeline(self):
        self.write(self.rows())
        index=Path(self.temp.name)/'cli-index'
        script=Path(disk.__file__)
        subprocess.run([sys.executable,str(script),'prepare','--path',str(self.path),'--index',str(index)],check=True,capture_output=True)
        for command in ['overview','summary']:
            out=Path(self.temp.name)/(command+'.json')
            subprocess.run([sys.executable,str(script),command,'--index',str(index),'--tid','7','--output',str(out)],check=True,capture_output=True)
            result=json.loads(out.read_text())
            self.assertEqual(result['kind'],'sftrace-'+command)
        self.assertEqual(result['hotspots'][0]['selfNs'],70)

    def test_small_analyzer_refuses_unbounded_input(self):
        self.write(self.rows())
        with self.assertRaisesRegex(ValueError,'事件预算'):
            self.original(self.path,max_events=2)

    def test_failed_index_is_not_reused(self):
        self.write(self.rows())
        index=Path(self.temp.name)/'failed'
        with self.assertRaises(ValueError):disk.prepare(self.path,index,memory_mb=1)
        self.assertEqual(json.loads((index/'metadata.json').read_text())['status'],'failed')
        with self.assertRaisesRegex(ValueError,'未完成'):disk.overview(index)

if __name__=='__main__':unittest.main()
