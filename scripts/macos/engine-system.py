#!/usr/bin/env python3
"""Prepare a unique Debug App, then explicitly run real launchd/CLI checks."""
import argparse
import http.server
import fcntl
import json
import os
from pathlib import Path
import plistlib
import pty
import shlex
import select
import signal
import socket
import sqlite3
import struct
import subprocess
import tempfile
import threading
import termios
import time
from concurrent.futures import ThreadPoolExecutor
from verify import environment, prepare_app, running, stop_engine, wait_line


def wait_for(check, seconds=25):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = check()
        if value: return value
        time.sleep(.05)
    raise TimeoutError('required lifecycle state did not arrive')


def active_work(app, room, control, cli, env):
    helper = app / 'Contents/Helpers/magic-runtime'
    marker = room / 'tool.pid'
    requests = []
    release = threading.Event()
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            if len(requests) % 2 == 0:
                self.wfile.write(b': waiting\n\n'); self.wfile.flush(); release.wait(120); return
            command = f'echo $$ > {shlex.quote(str(marker))}; /bin/sleep 120'
            delta = {'tool_calls': [{'index': 0, 'id': 'system-tool', 'type': 'function',
                     'function': {'name': 'exec', 'arguments': json.dumps({'cmd': command, 'background': True})}}]}
            frame = {'id': 'system-work', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': 'tool_calls'}]}
            self.wfile.write(('data: ' + json.dumps(frame) + '\n\ndata: [DONE]\n\n').encode()); self.wfile.flush()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    control('switch', '--parent', str(room))
    (room / '.magic/config.json').write_text(json.dumps({'workspaceRoots': [str(room)],
        'models': {choice: {'provider': 'local', 'model': 'probe'} for choice in ['default', 'cantrip', 'spell', 'arcane']},
        'providers': {'local': {'vendor': 'deepseek', 'apiKey': 'synthetic-only', 'baseURL': f'http://127.0.0.1:{server.server_port}/v1'}}}))
    clients = []
    try:
        for round in range(2):
            marker.unlink(missing_ok=True)
            cli('start'); record = control('status')['record']
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); clients.append(client)
            client.connect(record['socket']); client.settimeout(10)
            reader = client.makefile('rb')
            def send(value): client.sendall((json.dumps(value) + '\n').encode())
            send({'t': 'hello', 'role': 'client', **{key: record[key] for key in ['protocol', 'version', 'source']},
                  'cwd': str(room), 'allowAll': True})
            while json.loads(reader.readline())['t'] != 'welcome': pass
            send({'t': 'cmd', 'gen': None, 'environment': env, 'cmd': {'type': 'input.submit', 'text': 'Run the isolated system check.'}})
            wait_for(lambda: marker.exists() and len(requests) == (round + 1) * 2)
            tool = int(marker.read_text()); group = os.getpgid(tool)
            owned = [int(row.split()[0]) for row in subprocess.check_output(['ps', '-axo', 'pid=,pgid='], text=True).splitlines()
                     if len(row.split()) == 2 and int(row.split()[1]) == group]
            assert tool in owned
            client.shutdown(socket.SHUT_RDWR); reader.close(); client.close()
            assert running(tool)
            if round == 0:
                for flags in [[], ['--validation-quit']]:
                    process = subprocess.Popen([str(app / 'Contents/MacOS/MagicCode'), *flags], cwd=room, env=env,
                                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                    try:
                        event = wait_line(process)
                        assert json.loads(Path(event['host']).read_text())['serviceInstance'] == record['serviceInstance']
                        if not flags: process.kill()
                        process.wait(timeout=15)
                        assert running(tool) and running(record['pid'])
                    finally:
                        if process.poll() is None: process.kill(); process.wait(timeout=5)
                rejected = control('switch', '--parent', str(room / 'blocked'))
                assert rejected['state'] == 'failed' and rejected['record']['state'] == 'ready'
                assert control('status')['record']['serviceInstance'] == record['serviceInstance']
                os.kill(record['pid'], signal.SIGKILL)
                recovered = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' and
                                               value['record']['serviceInstance'] != record['serviceInstance'] else None))
                wait_for(lambda: not any(running(pid) for pid in owned))
                assert recovered['record']['base'] == record['base'] and len(requests) == 2
                cli('stop')
            else:
                os.kill(record['pid'], signal.SIGSTOP)
                assert control('status')['state'] == 'unreachable'
                master, slave = pty.openpty()
                process = subprocess.Popen([str(helper), 'engine', 'stop'], cwd=room, env=env,
                                           stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
                os.close(slave)
                try:
                    assert process.wait(timeout=60) == 0, os.read(master, 65536).decode(errors='replace')
                finally:
                    os.close(master)
                    if process.poll() is None: process.kill(); process.wait(timeout=5)
                assert control('status')['state'] == 'stopped'
                assert not running(record['pid']) and not any(running(pid) for pid in owned)
                assert len(requests) == 4
        return {'appExitPreservedActiveWork': True, 'busySwitchRejected': True, 'crashReclaimedOwnedGroup': True,
                'recoveryDidNotReplayWork': True, 'unresponsiveEngineTTYStop': True}
    finally:
        release.set()
        for client in clients: client.close()
        server.shutdown(); server.server_close()


def run(room):
    app = room / 'Magic Code.app'
    info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    assert info['CFBundleIdentifier'].startswith('com.magiccode.validation.')
    assert info['MagicSystemTestRoot'] == str(room)
    helper = app / 'Contents/Helpers/magic-runtime'
    native = app / 'Contents/MacOS/MagicCode'
    env = environment(room)
    # MAGIC_HOME is explicit only for the first default-instance checks.
    def control(action, *args):
        result = subprocess.run([str(native), '--internal-engine-control', action, '--validation-root', str(room), *args],
            cwd=room, env=env, text=True, capture_output=True, timeout=60)
        value = json.loads(result.stdout)
        assert result.returncode == (1 if value['state'] == 'failed' else 0), result.stdout + result.stderr
        return value
    def cli(action):
        result = subprocess.run([str(helper), 'engine', action], cwd=room, env=env, text=True, capture_output=True, timeout=60)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout
    try:
        assert control('status')['state'] == 'stopped'
        cli('status')
        assert control('status')['state'] == 'stopped'
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 200, 0, 0))
        terminal = subprocess.Popen([str(helper)], cwd=room, env={**env, 'TERM': 'xterm-256color'},
                                    stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        try:
            draft = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' else None))
            assert terminal.poll() is None
            output = bytearray()
            def rendered():
                if select.select([master], [], [], 0)[0]: output.extend(os.read(master, 65536))
                return 'ctrl+c 退出' in output.decode(errors='replace')
            wait_for(rendered)
            database = sqlite3.connect(f'file:{room}/.magic/records.db?mode=ro', uri=True)
            try: assert database.execute('SELECT count(*) FROM sessions').fetchone()[0] == 0
            finally: database.close()
            os.kill(terminal.pid, signal.SIGHUP)
            def exited():
                rendered()
                return terminal.poll() is not None
            wait_for(exited, seconds=10); assert terminal.returncode == 0
            assert control('status')['record']['serviceInstance'] == draft['record']['serviceInstance']
            cli('stop')
        finally:
            os.close(master)
            if terminal.poll() is None: terminal.kill(); terminal.wait(timeout=5)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(cli, ['start', 'start', 'start']))
        first = control('status'); assert first['state'] == 'ready'
        first = first['record']; assert first['base'] == str(room / '.magic')
        definition = plistlib.loads((room / 'Library/Application Support/Magic Code/runtime/engine.plist').read_bytes())
        assert definition['Label'] == info['CFBundleIdentifier'] + '.engine'
        assert definition['KeepAlive'] == {'SuccessfulExit': False}
        assert definition['ProgramArguments'][0] == str(helper)
        assert 'EnvironmentVariables' not in definition
        assert not (room / 'Library/LaunchAgents').exists()
        os.kill(first['pid'], signal.SIGKILL)
        recovered = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' and value['record']['serviceInstance'] != first['serviceInstance'] else None))
        assert recovered['record']['base'] == first['base']
        assert control('stop', '--expected', json.dumps({key: first[key] for key in ['protocol', 'version', 'source', 'serviceInstance', 'base']}))['state'] == 'failed'
        assert control('status')['record']['serviceInstance'] == recovered['record']['serviceInstance']
        cli('stop'); assert control('status')['state'] == 'stopped'
        assert not running(recovered['record']['pid'])
        cli('status'); assert control('status')['state'] == 'stopped'
        other = room / 'selected'; other.mkdir()
        switched = control('switch', '--parent', str(other))
        assert switched['state'] == 'stopped' and Path(switched['base']).resolve() == other / '.magic'
        env.pop('MAGIC_HOME')
        cli('start')
        selected = control('status')['record']; assert Path(selected['base']).resolve() == other / '.magic'
        definition = plistlib.loads((room / 'Library/Application Support/Magic Code/runtime/engine.plist').read_bytes())
        assert Path(definition['ProgramArguments'][definition['ProgramArguments'].index('--parent') + 1]).resolve() == other
        os.kill(selected['pid'], signal.SIGKILL)
        after = wait_for(lambda: (value if (value := control('status'))['state'] == 'ready' and value['record']['serviceInstance'] != selected['serviceInstance'] else None))
        assert after['record']['base'] == selected['base']
        cli('stop')
        config = other / '.magic/config.json'; config.write_text('{broken')
        failed = control('start'); assert failed['state'] == 'failed' and failed.get('error')
        pid = failed['record'].get('pid')
        if pid: wait_for(lambda: not running(pid))
        assert control('status')['state'] == 'failed'
        config.write_text('{}')
        cli('start'); assert control('status')['state'] == 'ready'
        cli('stop')
        work = active_work(app, room, control, cli, env)
        cli('start'); stranded = control('status')['record']
        os.kill(stranded['pid'], signal.SIGSTOP)
        caller = subprocess.Popen([str(helper), 'engine', 'stop'], cwd=room, env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            def detached_control():
                for row in subprocess.check_output(['ps', '-axo', 'pid=,pgid=,command='], text=True).splitlines():
                    fields = row.strip().split(None, 2)
                    if len(fields) == 3 and fields[2].startswith(str(native) + ' --internal-engine-control stop '):
                        assert int(fields[1]) != os.getpgid(caller.pid)
                        return int(fields[0])
            controller = wait_for(detached_control)
            caller.terminate(); caller.wait(timeout=5)
            wait_for(lambda: not running(controller), seconds=60)
            stopped = control('status')
            assert stopped['state'] == 'stopped' and stopped['record']['request']
            assert not running(stranded['pid'])
        finally:
            if caller.poll() is None: caller.kill(); caller.wait(timeout=5)
        print(json.dumps({'normalTTYEntry': True, 'parallelCLIStart': True, 'noGraphicalApp': True, 'idleCrashRecovery': True,
                          'oldGenerationRejected': True, 'nonDefaultInstanceRecovery': True,
                          'startupErrorAndRepair': True, 'explicitStop': True, 'stopSurvivedCallerExit': True, **work}))
    finally:
        stop_engine(app, room)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', metavar='DEBUG_APP'); mode.add_argument('--run', metavar='PREPARED_ROOT')
    args = parser.parse_args()
    if args.prepare:
        room = Path(tempfile.mkdtemp(prefix='magic-system-test-', dir='/tmp')).resolve()
        prepare_app(Path(args.prepare).resolve(), room)
        print(room)
    else:
        run(Path(args.run).resolve())
