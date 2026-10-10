#!/usr/bin/env python3
"""Explicit isolated App/launchd idle check. Requires system-operation authorization."""
import json
from pathlib import Path
import subprocess
import sys
import time
from verify import environment, isolated_app, running, wait_line


def children(pid):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True).splitlines()
    return [int(row.split()[0]) for row in rows if len(row.split()) == 2 and int(row.split()[1]) == pid]


def cpu(pid):
    value = subprocess.check_output(['ps', '-o', 'time=', '-p', str(pid)], text=True).strip()
    return sum(float(part) * 60 ** index for index, part in enumerate(reversed(value.split(':'))))


with isolated_app(Path(sys.argv[1]).resolve()) as (app, room):
    process = subprocess.Popen([str(app / 'Contents/MacOS/MagicCode')], cwd=room, env=environment(room), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        record = json.loads(Path(wait_line(process)['host']).read_text())
        engine = record['pid']
        initial = {pid: cpu(pid) for pid in [process.pid, engine]}
        for _ in range(9):
            time.sleep(10)
            assert process.poll() is None and running(engine)
            assert engine not in children(process.pid) and children(engine) == []
        delta = {str(pid): cpu(pid) - value for pid, value in initial.items()}
        assert all(value < 2 for value in delta.values()), delta
        print(json.dumps({'seconds': 90, 'independentEngine': True, 'idleCPUSeconds': delta}))
    finally:
        if process.poll() is None: process.kill(); process.wait(timeout=5)
