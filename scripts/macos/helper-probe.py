#!/usr/bin/env python3
"""Signed standalone probe: loopback model + real tool, no credentials/user data."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from probe_host import isolated_host


def probe(helper):
    requests = []

    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            delta = {'content': 'native-helper-probe-complete'}
            finish = 'stop'
            if len(requests) == 1:
                delta = {'tool_calls': [{'index': 0, 'id': 'probe-call', 'type': 'function',
                         'function': {'name': 'exec', 'arguments': json.dumps({'cmd': 'echo native-helper-tool-ok'})}}]}
                finish = 'tool_calls'
            chunks = [{'id': 'probe', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                       'choices': [{'index': 0, 'delta': delta}]},
                      {'id': 'probe', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                       'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                       'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20}}]
            payload = ''.join('data: ' + json.dumps(x) + '\n\n' for x in chunks) + 'data: [DONE]\n\n'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload.encode())))
            self.end_headers()
            self.wfile.write(payload.encode())

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='magic-helper-probe-') as root:
            base = Path(root)
            (base / '.magic').mkdir(mode=0o700)
            (base / '.magic/config.json').write_text(json.dumps({
                'dataDir': str(base / 'data'), 'workspaceRoots': [root], 'models': {choice: {'provider': 'local', 'model': 'probe'} for choice in ['default', 'cantrip', 'spell', 'arcane']},
                'providers': {'local': {'baseURL': f'http://127.0.0.1:{server.server_port}/v1',
                    'apiKey': 'synthetic-probe-key', 'vendor': 'deepseek'}}}))
            script = base / 'probe.json'
            script.write_text(json.dumps({'inputs': ['Run the controlled native helper probe.'], 'decisions': []}))
            env = {'HOME': root, 'MAGIC_HOME': root, 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'en_US.UTF-8'}
            with isolated_host(helper, base, env):
                result = subprocess.run([str(helper), '--script', str(script)], cwd=root, env=env,
                                    text=True, capture_output=True, timeout=40)
            if result.returncode or len(requests) != 2 or 'native-helper-tool-ok' not in json.dumps(requests[-1]):
                raise RuntimeError(f'helper probe failed ({result.returncode}, requests={len(requests)}):\n{result.stdout}\n{result.stderr}')
            print(json.dumps({'signedStandaloneModelTool': 'passed', 'modelRequests': len(requests),
                              'globalBun': False, 'userData': False}))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    probe(Path(sys.argv[1]).resolve())
