#!/usr/bin/python3
"""Supervise one pinned container; release only its proven abandoned SQLite lock."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

DATA = Path('/var/lib/bfl-staging/data')
MANIFEST = Path('/etc/bfl-staging/persistent-supervisor.json')
GUARD = Path('/run/lock/bfl-persistent-supervisor.lock')
NAME = '/bfl-staging-runtime'


class Unsafe(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise Unsafe(code)


def docker(*args, timeout=20):
    # Never emit inspect/environment/lock content, even when Docker fails.
    result = subprocess.run(['/usr/bin/docker', *args], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=True, text=True)
    return result.stdout.strip()


def fingerprint(container):
    host = dict(container['HostConfig'])
    # Docker may expose the same disabled setting as false before start and
    # explicit null while running. Preserve every other field and value.
    if 'OomKillDisable' in host and host['OomKillDisable'] is None:
        host['OomKillDisable'] = False
    value = {'Config': container['Config'], 'HostConfig': host, 'Mounts': container['Mounts']}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inspect_all(run=docker):
    ids = run('ps', '-aq', '--no-trunc').splitlines()
    need(ids and all(re.fullmatch('[a-f0-9]{64}', cid) for cid in ids), 'CONTAINER_INVENTORY')
    rows = json.loads(run('inspect', *ids))
    need(len(rows) == len(ids) and {row['Id'] for row in rows} == set(ids), 'CONTAINER_INVENTORY')
    return rows


def stopped(row):
    state = row['State']
    return (state.get('Status') in ('exited', 'dead', 'created') and state.get('Pid') == 0
            and state.get('Running') is False and state.get('Paused') is False
            and state.get('Restarting') is False)


def data_access(row, data=DATA):
    data = data.resolve()
    # Also catch a container mounting an ancestor of /data, or a DB subpath.
    for mount in row.get('Mounts', []):
        if mount.get('RW') is not True:
            continue
        source = Path(mount.get('Source', '/__missing__')).resolve()
        if source == data or source in data.parents or data in source.parents:
            return True
    return False


def target(rows, manifest, data=DATA):
    selected = [row for row in rows if row.get('Name') == NAME]
    need(len(selected) == 1, 'CONTAINER_IDENTITY')
    row = selected[0]
    need(row['Id'] == manifest['container_id'] and row['Image'] == manifest['image']
         and fingerprint(row) == manifest['configuration_sha256'], 'CONTAINER_CHANGED')
    need(row['Config']['Hostname'] == row['Id'][:12], 'CONTAINER_HOSTNAME')
    need(row['Config']['Entrypoint'] == ['node', 'backend/staging-main.mjs']
         and row['Config'].get('User') in ('node', '1000', '1000:1000'), 'CONTAINER_ENTRYPOINT')
    args = row['Config'].get('Cmd')
    need(isinstance(args, list) and len(args) == 3 and args[:2] == ['serve', '/run/staging/service.json']
         and re.fullmatch('[a-f0-9]{64}', args[2]), 'CONTAINER_ARGUMENTS')
    need(row['HostConfig']['RestartPolicy']['Name'] == 'no'
         and row['HostConfig']['ReadonlyRootfs'] is True, 'CONTAINER_POLICY')
    need(any(m.get('Source') == str(data) and m.get('Destination') == '/data' and m.get('RW') is True
             for m in row['Mounts']), 'CONTAINER_DATA_MOUNT')
    need(all(other['Id'] == row['Id'] or not data_access(other, data) or stopped(other)
             for other in rows), 'ANOTHER_WRITER')
    return row


def read_manifest(path=MANIFEST):
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == 0
         and info.st_mode & 0o077 == 0 and info.st_size <= 1024, 'PRIVATE_MANIFEST')
    value = json.loads(path.read_text())
    need(set(value) == {'container_id', 'image', 'configuration_sha256'}
         and re.fullmatch('[a-f0-9]{64}', value['container_id'])
         and re.fullmatch('sha256:[a-f0-9]{64}', value['image'])
         and re.fullmatch('[a-f0-9]{64}', value['configuration_sha256']), 'MANIFEST_SHAPE')
    return value


def recover_lock(manifest, run=docker, data=DATA, expected_uid=1000):
    info = data.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == expected_uid and info.st_mode & 0o077 == 0, 'PRIVATE_DATA')
    row = target(inspect_all(run), manifest, data)
    need(stopped(row), 'WRITER_STILL_ALIVE')
    lock = data / 'runtime.lock'
    try:
        info = lock.lstat()
    except FileNotFoundError:
        return False
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == expected_uid and info.st_mode & 0o077 == 0,
         'PRIVATE_LOCK')
    dfd = os.open(lock, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        need(os.listdir(dfd) == ['owner.json'], 'LOCK_CONTENTS')
        fd = os.open('owner.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
        try:
            owner_stat = os.fstat(fd)
            need(stat.S_ISREG(owner_stat.st_mode) and owner_stat.st_nlink == 1
                 and owner_stat.st_uid == expected_uid and owner_stat.st_mode & 0o077 == 0
                 and owner_stat.st_size <= 1024, 'PRIVATE_LOCK')
            raw = os.read(fd, 1025)
        finally:
            os.close(fd)
        owner = json.loads(raw)
        need(set(owner) == {'token', 'host', 'pid'} and owner['pid'] == 1
             and owner['host'] == row['Id'][:12]
             and re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', owner['token']), 'LOCK_OWNER')
        # Re-observe ALL containers immediately before exact-token release.
        current = target(inspect_all(run), manifest, data)
        need(stopped(current) and current['State']['StartedAt'] == row['State']['StartedAt']
             and current['State']['FinishedAt'] == row['State']['FinishedAt']
             and current['State']['Status'] in ('exited', 'dead'), 'WRITER_CHANGED')
        current_info = os.stat('owner.json', dir_fd=dfd, follow_symlinks=False)
        need((current_info.st_dev, current_info.st_ino, current_info.st_size, current_info.st_mtime_ns)
             == (owner_stat.st_dev, owner_stat.st_ino, owner_stat.st_size, owner_stat.st_mtime_ns)
             and (lock / 'owner.json').read_bytes() == raw, 'LOCK_CHANGED')
        need((lock.stat().st_dev, lock.stat().st_ino) == (info.st_dev, info.st_ino), 'LOCK_CHANGED')
        os.unlink('owner.json', dir_fd=dfd)
        os.rmdir(lock)
        parent = os.open(data, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        return True
    finally:
        os.close(dfd)


def pin(image, run=docker, destination=MANIFEST):
    need(re.fullmatch('sha256:[a-f0-9]{64}', image), 'IMAGE_PIN')
    need(not destination.exists() and not (DATA / 'runtime.lock').exists(), 'EXISTING_CUSTODY')
    rows = inspect_all(run)
    matches = [row for row in rows if row.get('Name') == NAME]
    need(len(matches) == 1, 'CONTAINER_IDENTITY')
    row = matches[0]
    manifest = {'container_id': row['Id'], 'image': image, 'configuration_sha256': fingerprint(row)}
    need(stopped(target(rows, manifest)), 'WRITER_STILL_ALIVE')
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(manifest, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    os.umask(0o077)
    need(os.geteuid() == 0, 'ROOT_REQUIRED')
    action = sys.argv[1] if len(sys.argv) > 1 else ''
    if action == 'pin':
        need(len(sys.argv) == 3, 'ARGUMENTS')
        pin(sys.argv[2])
        return 0
    need(action in ('run', 'stop', 'recover') and len(sys.argv) == 2, 'ARGUMENTS')
    manifest = read_manifest()
    if action == 'stop':
        row = target(inspect_all(), manifest)
        if not stopped(row):
            docker('stop', '--time', '35', row['Id'], timeout=45)
        need(stopped(target(inspect_all(), manifest)), 'WRITER_STILL_ALIVE')
        return 0
    guard_fd = os.open(GUARD, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(guard_fd, 'r+') as guard:
        info = os.fstat(guard.fileno())
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and info.st_mode & 0o077 == 0, 'PRIVATE_SUPERVISOR_LOCK')
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        row = target(inspect_all(), manifest)
        if action == 'recover':
            recover_lock(manifest)
            return 0
        if stopped(row):
            recover_lock(manifest)
            target(inspect_all(), manifest)  # Preserve identity up to start.
            docker('start', row['Id'])
        else:
            need(row['State'].get('Running') is True and row['State'].get('Paused') is False
                 and row['State'].get('Restarting') is False, 'CONTAINER_STATE')
        # Adopting an already-running identical container never starts another
        # writer or releases its lock. A lost Docker connection can be retried.
        subprocess.run(['/usr/bin/docker', 'attach', '--no-stdin', '--sig-proxy=false', row['Id']],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ended = target(inspect_all(), manifest)
        if stopped(ended) and ended['State'].get('ExitCode') == 78:
            return 78  # Backend has a durable hold requiring operator review.
        return 1  # Runtime exit is unexpected except systemctl stop.


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Unsafe as error:
        print('BFL supervisor stopped: ' + str(error), file=sys.stderr)
        sys.exit(78)  # Invariant failures require operator inspection.
    except Exception:
        print('BFL supervisor unavailable; no recovery outcome assumed', file=sys.stderr)
        sys.exit(1)
