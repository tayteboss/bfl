#!/usr/bin/python3
"""Render a private candidate only; never replace the mounted/live Caddyfile."""
import os
from pathlib import Path
import re
import stat
import sys

if len(sys.argv) != 3:
    raise SystemExit('Usage: render-persistent-caddy.py PRIVATE_CARRIER_PATH_FILE NEW_OUTPUT')
source, destination = map(Path, sys.argv[1:])
info = source.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size != 79:
    raise SystemExit('Private callback file required')
callback = source.read_text()
if not re.fullmatch('/carrier/rates/[a-f0-9]{64}', callback):
    raise SystemExit('Callback path rejected')
body = Path(__file__).with_name('Caddyfile.persistent.in').read_text().replace('__PRIVATE_CARRIER_PATH__', callback)
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as stream:
    stream.write(body)
    stream.flush()
    os.fsync(stream.fileno())
