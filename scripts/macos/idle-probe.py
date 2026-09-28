#!/usr/bin/env python3
"""Bounded real-App idle and duplicate-launch observation; no UI/system integration."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from verify import wait_line, running


def children(pid):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True).splitlines()
    return [int(row.split()[0]) for row in rows if len(row.split()) == 2 and int(row.split()[1]) == pid]


def cpu(pid):
    value = subprocess.check_output(['ps', '-o', 'time=', '-p', str(pid)], text=True).strip()
    parts = value.split(':')
    return sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))


output = Path('.artifacts/macos/idle-duplicate'); output.mkdir(parents=True, exist_ok=True)
app = Path('.artifacts/macos/Magic Code Dev.app').resolve()
with tempfile.TemporaryDirectory(prefix='magic-native-idle-') as temporary:
    room = Path(temporary).resolve()
    env = {'HOME': str(room), 'MAGIC_HOME': str(room), 'PATH': '/usr/bin:/bin', 'LANG': 'zh_CN.UTF-8'}
    args = [str(app / 'Contents/MacOS/MagicCode'), '--validation-root', str(room)]
    with (output / 'app.stderr.log').open('w') as error, (output / 'duplicate.stderr.log').open('w') as duplicate_error:
        process = subprocess.Popen(args, cwd=room, env=env, stdout=subprocess.PIPE, stderr=error)
        duplicate = None; observer = None; manager = None
        try:
            ready = wait_line(process)
            discovery = json.loads(Path(ready['host']).read_text())
            manager = json.loads((Path(discovery['socket']).parent / 'manager.json').read_text())['pid']
            duplicate = subprocess.Popen(args, cwd=room, env=env, stdout=subprocess.PIPE, stderr=duplicate_error)
            try:
                wait_line(duplicate)
                raise AssertionError('duplicate App unexpectedly became ready')
            except RuntimeError as failure:
                assert '运行' in str(failure), failure
                duplicate_reason = str(failure)
            assert children(duplicate.pid) == [], 'duplicate App spawned another manager'
            assert json.loads(Path(ready['host']).read_text()) == discovery
            duplicate.kill(); duplicate.wait(timeout=5)
            assert running(manager), 'duplicate exit stopped the real host'
            observer = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); observer.settimeout(5); observer.connect(discovery['socket'])
            observer.sendall((json.dumps({'t': 'hello', 'role': 'observer', **{k: discovery[k] for k in ['protocol', 'version', 'source', 'dataDir']}}) + '\n').encode())
            stream = observer.makefile('rb'); welcome = json.loads(stream.readline())
            assert welcome['t'] == 'native.welcome' and welcome['projection']['works'] == []
            started = time.monotonic(); initial = {pid: cpu(pid) for pid in [process.pid, manager]}; samples = []
            for _ in range(9):
                time.sleep(10)
                assert process.poll() is None and running(manager)
                assert children(process.pid) == [manager] and children(manager) == []
                samples.append({'elapsed': time.monotonic() - started, 'appCPU': cpu(process.pid), 'managerCPU': cpu(manager)})
            delta = {str(pid): cpu(pid) - value for pid, value in initial.items()}
            assert all(value < 2 for value in delta.values()), 'idle CPU budget exceeded: ' + str(delta)
            observer.sendall(b'{"t":"native.refresh"}\n')
            projection = json.loads(stream.readline())
            assert projection['t'] == 'native.projection' and projection['projection']['works'] == []
            evidence = {'seconds': time.monotonic() - started, 'appPID': process.pid, 'managerPID': manager,
                        'duplicateRejected': duplicate_reason, 'duplicateStartedNoManager': True,
                        'zeroWorkBeforeAndAfter': True, 'zeroExecutorsAllSamples': True, 'cpuSecondsDelta': delta, 'samples': samples}
            (output / 'result.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2))
        finally:
            if observer: observer.close()
            if duplicate and duplicate.poll() is None: duplicate.kill(); duplicate.wait(timeout=5)
            if process.poll() is None: process.kill(); process.wait(timeout=5)
            deadline = time.monotonic() + 10
            while manager and running(manager) and time.monotonic() < deadline: time.sleep(.05)
            assert manager is None or not running(manager), 'idle manager survived App EOF'
            (output / 'app.stdout.log').write_bytes(process.stdout.read())
