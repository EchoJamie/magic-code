#!/usr/bin/env python3
"""Real signed App -> manager -> compiled executor -> controlled model -> owned tool.

The protocol client is a collector, not Terminal.app. No user session or network key.
"""
import http.server
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from verify import wait_line, running


def probe(app, output):
    with tempfile.TemporaryDirectory(prefix='magic-hosted-probe-') as temporary:
        room = Path(temporary).resolve()
        marker = room / 'tool.pid'
        calls = []

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                cmd = f'echo $$ > {shlex.quote(str(marker))}; echo native-hosted-tool-started; /bin/sleep 30'
                delta = {'tool_calls': [{'index': 0, 'id': 'hosted-call', 'type': 'function',
                         'function': {'name': 'exec', 'arguments': json.dumps({'cmd': cmd})}}]}
                frames = [{'id': 'hosted', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                           'choices': [{'index': 0, 'delta': delta}]},
                          {'id': 'hosted', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                           'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]}]
                payload = ''.join('data: ' + json.dumps(x) + '\n\n' for x in frames) + 'data: [DONE]\n\n'
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload.encode())

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        (room / '.magic').mkdir()
        (room / '.magic/config.json').write_text(json.dumps({'workspaceRoots': [str(room)],
            'models': {choice: {'provider': 'local', 'model': 'probe'} for choice in ['default', 'cantrip', 'spell', 'arcane']}, 'providers': {'local': {'vendor': 'deepseek', 'apiKey': 'synthetic-only',
            'baseURL': f'http://127.0.0.1:{server.server_port}/v1'}}}))
        env = {'HOME': str(room), 'MAGIC_HOME': str(room), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'en_US.UTF-8'}
        manager_pid = None; tool_pid = None; client = None; reader = None; owned_pids = []
        with (output / 'hosted-app.stderr.log').open('w') as stderr:
            process = subprocess.Popen([str(app / 'Contents/MacOS/MagicCode'), '--validation-root', str(room)],
                cwd=room, env=env, stdout=subprocess.PIPE, stderr=stderr)
            messages = []
            try:
                ready = wait_line(process)
                discovery = json.loads(Path(ready['host']).read_text())
                manager_pid = json.loads((Path(discovery['socket']).parent / 'manager.json').read_text())['pid']
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.connect(discovery['socket'])
                welcome = threading.Event()
                reader = client.makefile('rb')

                def collect():
                    try:
                        for line in reader:
                            message = json.loads(line); messages.append(message)
                            if message['t'] == 'welcome': welcome.set()
                    except (OSError, ValueError): pass

                thread = threading.Thread(target=collect, daemon=True); thread.start()
                def send(message): client.sendall((json.dumps(message)+'\n').encode())
                send({'t': 'hello', 'role': 'client', **{k: discovery[k] for k in ['protocol', 'version', 'source']},
                      'cwd': str(room), 'environment': {'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'en_US.UTF-8'},
                      'openRequest': 'hosted-probe-open', 'allowAll': True})
                assert welcome.wait(10), 'client welcome missing'
                send({'t': 'cmd', 'gen': None, 'cmd': {'type': 'input.submit', 'text': 'Run the controlled native lifecycle probe.'}})
                deadline = time.monotonic() + 15
                while not marker.exists() and time.monotonic() < deadline: time.sleep(0.025)
                assert marker.exists(), f'owned tool did not start; messages={messages[-12:]}'
                tool_pid = int(marker.read_text())
                assert calls and running(tool_pid)
                group = os.getpgid(tool_pid)
                table = subprocess.check_output(['ps', '-axo', 'pid=,pgid='], text=True)
                owned_pids = [int(row.split()[0]) for row in table.splitlines() if len(row.split()) == 2 and int(row.split()[1]) == group]
                assert tool_pid in owned_pids and process.pid not in owned_pids
                # Closing a UI client must leave this actual tool running under the App.
                client.shutdown(socket.SHUT_RDWR); client.close(); thread.join(timeout=1); reader.close()
                assert running(tool_pid) and running(manager_pid) and process.poll() is None
                process.kill(); process.wait(timeout=5)
                deadline = time.monotonic() + 10
                while (running(manager_pid) or any(running(pid) for pid in owned_pids)) and time.monotonic() < deadline: time.sleep(0.05)
                assert not running(manager_pid), 'manager survived native App EOF'
                assert not running(tool_pid), 'owned tool survived native App EOF'
                assert not any(running(pid) for pid in owned_pids), 'owned tool group survived native App EOF'
                result = {'nativeApp': True, 'compiledExecutor': True, 'modelCalls': len(calls), 'toolPID': tool_pid,
                          'managerPID': manager_pid, 'ownedToolGroup': owned_pids, 'clientClosePreservedWork': True, 'appKillReapedManagerAndTool': True,
                          'systemNotification': False, 'realTerminalApp': False}
                (output / 'hosted-model-tool.json').write_text(json.dumps(result, indent=2)+'\n')
                (output / 'hosted-client.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False)+'\n' for x in messages))
                print(json.dumps(result))
            finally:
                if process.poll() is None: process.kill(); process.wait(timeout=5)
                if client:
                    try: client.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    client.close()
                for pid in [manager_pid, tool_pid] + owned_pids:
                    if pid and running(pid): os.kill(pid, signal.SIGTERM)
                (output / 'hosted-app.stdout.log').write_bytes(process.stdout.read())
                server.shutdown(); server.server_close()


if __name__ == '__main__': probe(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
