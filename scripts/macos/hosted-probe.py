#!/usr/bin/env python3
"""Signed Engine with a background tool and an in-flight model stream.

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
from verify import running
from probe_host import isolated_host


def probe(app):
    with tempfile.TemporaryDirectory(prefix='magic-hosted-probe-') as temporary:
        room = Path(temporary).resolve()
        marker = room / 'tool.pid'
        calls = []
        stream_started = threading.Event(); release = threading.Event()

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                if len(calls) > 1:
                    self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                    self.wfile.write(b': model-waiting\n\n'); self.wfile.flush()
                    stream_started.set()
                    release.wait(30)
                    return
                cmd = f'echo $$ > {shlex.quote(str(marker))}; echo native-hosted-tool-started; /bin/sleep 30'
                delta = {'tool_calls': [{'index': 0, 'id': 'hosted-call', 'type': 'function',
                         'function': {'name': 'exec', 'arguments': json.dumps({'cmd': cmd, 'background': True})}}]}
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
        client = None; reader = None; owned_pids = []
        try:
            with isolated_host(app / 'Contents/Helpers/magic-runtime', room, env) as discovery:
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.connect(discovery['socket'])
                reader = client.makefile('rb')
                def send(message): client.sendall((json.dumps(message)+'\n').encode())
                send({'t': 'hello', 'role': 'client', **{k: discovery[k] for k in ['protocol', 'version', 'source']},
                      'cwd': str(room), 'openRequest': 'hosted-probe-open', 'allowAll': True})
                client.settimeout(10)
                while json.loads(reader.readline())['t'] != 'welcome': pass
                send({'t': 'cmd', 'gen': None, 'environment': env,
                      'cmd': {'type': 'input.submit', 'text': 'Run the controlled lifecycle probe.'}})
                assert stream_started.wait(15), 'second model stream did not start'
                assert marker.exists(), 'owned tool did not start'
                tool_pid = int(marker.read_text()); group = os.getpgid(tool_pid)
                table = subprocess.check_output(['ps', '-axo', 'pid=,pgid='], text=True)
                owned_pids = [int(row.split()[0]) for row in table.splitlines() if len(row.split()) == 2 and int(row.split()[1]) == group]
                assert tool_pid in owned_pids and running(discovery['pid'])
                client.shutdown(socket.SHUT_RDWR); reader.close(); client.close(); client = None
                assert running(tool_pid), 'closing client stopped work'
            assert not running(discovery['pid']) and not any(running(pid) for pid in owned_pids)
            print(json.dumps({'compiledEngineStop': 'passed', 'modelRequests': len(calls),
                              'clientClosePreservedWork': True, 'streamAndOwnedGroupReclaimed': True}))
        finally:
            release.set()
            if client:
                client.close()
            if reader: reader.close()
            server.shutdown(); server.server_close()


if __name__ == '__main__': probe(Path(sys.argv[1]).resolve())
