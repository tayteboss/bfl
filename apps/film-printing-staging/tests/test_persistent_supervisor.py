import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).parents[1] / 'hosting/persistent-supervisor.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
CID = 'a' * 64
IMAGE = 'sha256:' + 'b' * 64


def container(data):
    return {'Id': CID, 'Name': s.NAME, 'Image': IMAGE,
            'Config': {'Hostname': CID[:12], 'Entrypoint': ['node', 'backend/staging-main.mjs'], 'User': 'node',
                       'Cmd': ['serve', '/run/staging/service.json', 'd' * 64]},
            'HostConfig': {'RestartPolicy': {'Name': 'no'}, 'ReadonlyRootfs': True},
            'Mounts': [{'Source': str(data), 'Destination': '/data', 'RW': True}],
            'State': {'Status': 'exited', 'Pid': 0, 'Running': False, 'Paused': False, 'Restarting': False,
                      'StartedAt': '2026-10-30T00:00:00Z', 'FinishedAt': '2026-10-30T00:01:00Z'}}


def manifest(row):
    return {'container_id': CID, 'image': IMAGE, 'configuration_sha256': s.fingerprint(row)}


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.row = container(self.data)
        self.lock = self.data / 'runtime.lock'
        self.lock.mkdir(mode=0o700)
        self.owner = {'token': '11111111-1111-4111-8111-111111111111', 'pid': 1, 'host': CID[:12]}
        self.write_owner()
        self.rows = [self.row]
        self.calls = []

    def write_owner(self):
        (self.lock / 'owner.json').write_text(json.dumps(self.owner))
        (self.lock / 'owner.json').chmod(0o600)

    def docker(self, *args):
        self.calls.append(args)
        if args[:2] == ('ps', '-aq'):
            return '\n'.join(row['Id'] for row in self.rows)
        if args[0] == 'inspect':
            return json.dumps(self.rows)
        raise AssertionError('No Docker mutation is allowed during lock recovery')

    def recover(self):
        return s.recover_lock(manifest(self.row), run=self.docker, data=self.data, expected_uid=os.getuid())

    def test_exact_dead_container_releases_only_its_lock(self):
        (self.data / 'jobs.sqlite').write_bytes(b'unchanged database and unknown-operation history')
        self.assertTrue(self.recover())
        self.assertFalse(self.lock.exists())
        self.assertEqual((self.data / 'jobs.sqlite').read_bytes(), b'unchanged database and unknown-operation history')
        self.assertEqual(len(self.calls), 4)

    def test_running_container_never_releases(self):
        self.row['State'].update(Running=True, Pid=123, Status='running')
        with self.assertRaisesRegex(s.Unsafe, 'WRITER_STILL_ALIVE'):
            self.recover()
        self.assertTrue((self.lock / 'owner.json').exists())

    def test_other_rw_ancestor_mount_blocks_release(self):
        other = copy.deepcopy(self.row)
        other.update(Id='c' * 64, Name='/other')
        other['Mounts'][0]['Source'] = str(self.data.parent)
        other['State'].update(Running=True, Pid=123, Status='running')
        self.rows.append(other)
        with self.assertRaisesRegex(s.Unsafe, 'ANOTHER_WRITER'):
            self.recover()
        self.assertTrue(self.lock.exists())

    def test_other_readonly_observer_does_not_claim_writer(self):
        other = copy.deepcopy(self.row)
        other.update(Id='c' * 64, Name='/observer')
        other['Mounts'][0]['RW'] = False
        other['State'].update(Running=True, Pid=123, Status='running')
        self.rows.append(other)
        self.assertTrue(self.recover())

    def test_old_writer_hostname_is_not_assumed_dead(self):
        self.owner['host'] = 'historical-h'
        self.write_owner()
        with self.assertRaisesRegex(s.Unsafe, 'LOCK_OWNER'):
            self.recover()
        self.assertTrue(self.lock.exists())

    def test_restart_between_observations_blocks_release(self):
        def changing(*args):
            if len(self.calls) == 2:
                self.row['State']['StartedAt'] = '2026-10-30T00:02:00Z'
                self.row['State'].update(Running=True, Pid=321, Status='running')
            return self.docker(*args)
        with self.assertRaisesRegex(s.Unsafe, 'WRITER_CHANGED'):
            s.recover_lock(manifest(self.row), run=changing, data=self.data, expected_uid=os.getuid())
        self.assertTrue(self.lock.exists())

    def test_lock_token_change_blocks_release(self):
        def changing(*args):
            if len(self.calls) == 2:
                self.owner['token'] = '22222222-2222-4222-8222-222222222222'
                self.write_owner()
            return self.docker(*args)
        with self.assertRaisesRegex(s.Unsafe, 'LOCK_CHANGED'):
            s.recover_lock(manifest(self.row), run=changing, data=self.data, expected_uid=os.getuid())
        self.assertTrue(self.lock.exists())

    def test_created_container_cannot_inherit_previous_lock(self):
        self.row['State']['Status'] = 'created'
        with self.assertRaisesRegex(s.Unsafe, 'WRITER_CHANGED'):
            self.recover()
        self.assertTrue(self.lock.exists())

    def test_extra_lock_content_is_preserved(self):
        (self.lock / 'unknown').write_text('retain')
        with self.assertRaisesRegex(s.Unsafe, 'LOCK_CONTENTS'):
            self.recover()
        self.assertTrue((self.lock / 'unknown').exists())

    def test_configuration_change_is_rejected(self):
        saved = manifest(self.row)
        self.row['HostConfig']['RestartPolicy']['Name'] = 'always'
        with self.assertRaisesRegex(s.Unsafe, 'CONTAINER_CHANGED'):
            s.target(self.rows, saved, self.data)

    def test_lock_symlink_is_rejected(self):
        (self.lock / 'owner.json').unlink()
        self.lock.rmdir()
        target = self.data / 'elsewhere'
        target.mkdir()
        self.lock.symlink_to(target)
        with self.assertRaisesRegex(s.Unsafe, 'PRIVATE_LOCK'):
            self.recover()
        self.assertTrue(self.lock.is_symlink())


    def test_explicit_null_oom_matches_original_false_pin_without_mutation(self):
        self.row['HostConfig']['OomKillDisable'] = False
        saved = manifest(self.row)
        legacy = __import__('hashlib').sha256(json.dumps({key: self.row[key] for key in ('Config', 'HostConfig', 'Mounts')}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(saved['configuration_sha256'], legacy)
        self.row['HostConfig']['OomKillDisable'] = None
        original = copy.deepcopy(self.row)
        self.assertEqual(s.fingerprint(self.row), legacy)
        self.assertIs(s.target(self.rows, saved, self.data), self.row)
        self.assertEqual(self.row, original)

    def test_true_missing_and_nonboolean_oom_remain_distinct(self):
        self.row['HostConfig']['OomKillDisable'] = False
        saved = manifest(self.row)
        for value in (True, 'false', 0):
            self.row['HostConfig']['OomKillDisable'] = value
            with self.subTest(value=value), self.assertRaisesRegex(s.Unsafe, 'CONTAINER_CHANGED'):
                s.target(self.rows, saved, self.data)
        del self.row['HostConfig']['OomKillDisable']
        with self.assertRaisesRegex(s.Unsafe, 'CONTAINER_CHANGED'):
            s.target(self.rows, saved, self.data)

    def test_oom_normalization_does_not_hide_other_host_or_config_changes(self):
        self.row['HostConfig'].update(OomKillDisable=False, Memory=0)
        saved = manifest(self.row)
        self.row['HostConfig'].update(OomKillDisable=None, Memory=None)
        with self.assertRaisesRegex(s.Unsafe, 'CONTAINER_CHANGED'):
            s.target(self.rows, saved, self.data)
        self.row['HostConfig']['Memory'] = 0
        self.row['Config']['User'] = 'root'
        with self.assertRaisesRegex(s.Unsafe, 'CONTAINER_CHANGED'):
            s.target(self.rows, saved, self.data)


if __name__ == '__main__':
    unittest.main()
