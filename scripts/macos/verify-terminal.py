#!/usr/bin/env python3
"""Explicit real Terminal test. --prepare does not launch apps or build TS.

--run opens one NEW Terminal for a new draft; existing work only displays a resume command.
Only its request-matched CLI receives SIGHUP. Existing windows are never addressed.
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import threading
import time
from probe_host import isolated_host
from verify import isolated_app, stop_engine


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def wait_for(predicate, seconds=25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = predicate()
        if result: return result
        time.sleep(0.05)
    raise TimeoutError('required evidence did not arrive')


def process_table():
    result = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True).splitlines():
        row = line.strip().split(None, 2)
        if len(row) == 3: result[int(row[0])] = {'parent': int(row[1]), 'command': row[2]}
    return result


def cli_pid(table, helper, request):
    matches = [pid for pid, row in table.items() if row['command'].startswith(str(helper) + ' ') and '--open-request ' + request in row['command']]
    assert len(matches) <= 1, 'duplicate CLI for one open request'
    return matches[0] if matches else None


def signal_cli(helper, request):
    pid = cli_pid(process_table(), helper, request)
    if pid: os.kill(pid, signal.SIGHUP)


def run_case(app, room, output, session):
    helper = app / 'Contents/Helpers/magic-runtime'
    args = [str(app / 'Contents/MacOS/MagicCode'), '--validation-root', str(room)]
    args += ['--validation-open-session', session] if session else ['--validation-open-terminal']
    environment = {'HOME': str(room), 'MAGIC_HOME': str(room), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'zh_CN.UTF-8'}
    events = []; request = None; manager = None
    with (output / 'app.stderr.log').open('w') as error, (output / 'app.stdout.jsonl').open('w') as log:
        process = subprocess.Popen(args, cwd=room, env=environment, stdout=subprocess.PIPE, stderr=error, text=True)
        def collect():
            for line in process.stdout:
                log.write(line); log.flush()
                try: events.append(json.loads(line))
                except ValueError: pass
        thread = threading.Thread(target=collect, daemon=True); thread.start()
        try:
            ready = wait_for(lambda: next((e for e in events if e.get('event') == 'app.ready'), None))
            discovery = json.loads(Path(ready['host']).read_text())
            assert Path(ready['host']).is_relative_to(room), 'discovery escaped validation home'
            assert discovery['app'] == str(app) and discovery['base'].startswith(str(room) + '/')
            manager = json.loads((Path(discovery['socket']).parent / 'manager.json').read_text())['pid']
            if session:
                command = wait_for(lambda: next((e for e in events if e.get('event') == 'resume.command'), None))['detail']
                assert " resume " in command and session in command
                assert '--open-request' not in command
                assert not any(e.get('event') == 'terminal.opened' for e in events)
                assert not list((room / 'terminal-evidence').glob('*/context.json'))
                result = {'appPID': process.pid, 'managerPID': manager, 'realTerminal': False,
                          'session': session, 'command': command, 'home': str(room),
                          'systemNotification': False, 'existingWindowsControlled': False}
                write(output / 'result.json', result)
                return result
            context_path = wait_for(lambda: next(iter((room / 'terminal-evidence').glob('*/context.json')), None))
            context = json.loads(context_path.read_text()); request = context['request']
            assert context['home'] == str(room) and context['session'] == session and context['helper'] == str(helper)
            opened = wait_for(lambda: next((e for e in events if e.get('event') == 'terminal.opened'), None))
            assert 'reused=false' in opened['detail'], 'Terminal reused an existing instance'
            terminal = int(re.search(r'pid=(\d+)', opened['detail'])[1])
            attached = wait_for(lambda: next((e for e in events if e.get('event') == 'terminal.attached' and 'request=' + request in e['detail']), None))
            assert 'session=' + (session or 'null') in attached['detail']
            pid = wait_for(lambda: cli_pid(process_table(), helper, request))
            table = process_table(); ancestry = []; cursor = pid
            while cursor in table and len(ancestry) < 20:
                ancestry.append({'pid': cursor, **table[cursor]})
                if cursor == terminal: break
                cursor = table[cursor]['parent']
            assert cursor == terminal, 'CLI is not descended from the newly opened Terminal instance'
            shell = int((context_path.parent / 'shell.pid').read_text())
            assert any(row['pid'] == shell for row in ancestry), 'launcher command shell not in CLI ancestry'
            # BSD script buffers its file until the PTY closes; inspect the final recording.
            transcript = context_path.parent / 'tty.log'
            wait_for(transcript.exists)
            time.sleep(1)
            signal_cli(helper, request)
            exit_file = context_path.parent / 'exit-code'
            wait_for(exit_file.exists, seconds=15)
            assert exit_file.read_text().strip() == '0', 'CLI did not exit cleanly through SIGHUP'
            wait_for(lambda: transcript.stat().st_size > 100)
            assert 'ctrl+c 退出' in transcript.read_text(), 'PTY transcript did not contain the actual TUI footer'
            wait_for(lambda: cli_pid(process_table(), helper, request) is None)
            assert process.poll() is None and manager in process_table(), 'closing Terminal client killed App/manager'
            shutil.copytree(context_path.parent, output / 'terminal', dirs_exist_ok=True)
            result = {'appPID': process.pid, 'managerPID': manager, 'realTerminal': True, 'terminalPID': terminal, 'cliPID': pid, 'request': request, 'session': session,
                      'attached': attached, 'focus': opened, 'ancestry': ancestry, 'cleanCLIExit': True,
                      'appAndManagerSurvivedClientClose': True, 'home': str(room), 'discovery': ready['host'],
                      'systemNotification': False, 'existingWindowsControlled': False}
            write(output / 'result.json', result)
            return result
        finally:
            if request: signal_cli(helper, request)
            if process.poll() is None: process.kill(); process.wait(timeout=5)
            thread.join(timeout=2)
            if manager:
                assert manager in process_table(), 'App exit stopped Engine'
                stop_engine(app, room)


def run(plan, output):
    app = Path(plan['app']).resolve()
    assert app.name == 'Magic Code.app', 'only the isolated Debug lifecycle supports this driver'
    calls = []
    class Model(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            chunk = {'id': 'native-terminal', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'probe',
                     'choices': [{'index': 0, 'delta': {'content': '隔离终端接回验收：已完成。'}, 'finish_reason': 'stop'}]}
            data = ('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode()
            self.send_response(200); self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        for case in ['draft', 'resume']:
            with isolated_app(Path(plan['app']).resolve()) as (app, room):
                evidence = output / case; evidence.mkdir(parents=True, exist_ok=True)
                write(room / '.magic/config.json', {'workspaceRoots': [str(room)],
                      'models': {choice: {'provider': 'local', 'model': 'probe'} for choice in ['default', 'cantrip', 'spell', 'arcane']}, 'providers': {'local': {'vendor': 'deepseek', 'apiKey': 'synthetic-only',
                      'baseURL': f'http://127.0.0.1:{server.server_port}/v1'}}})
                session = None
                if case == 'resume':
                    seed = room / 'seed.json'; write(seed, {'inputs': ['只回复隔离终端接回验收已完成。'], 'decisions': []})
                    env = {'HOME': str(room), 'MAGIC_HOME': str(room), 'PATH': '/usr/bin:/bin', 'SHELL': '/bin/zsh', 'LANG': 'zh_CN.UTF-8'}
                    with isolated_host(app / "Contents/Helpers/magic-runtime", room, env):
                        completed = subprocess.run([str(app / 'Contents/Helpers/magic-runtime'), '--script', str(seed)],
                                               cwd=room, env=env, capture_output=True, text=True, timeout=40)
                    (evidence / 'seed.stdout.log').write_text(completed.stdout)
                    (evidence / 'seed.stderr.log').write_text(completed.stderr)
                    assert completed.returncode == 0 and calls, 'isolated session seed failed'
                    match = re.search(r'—— 会话 (\S+) ·', completed.stdout)
                    assert match and match[1] != '未建立', 'seed did not identify a persisted session'
                    session = match[1]
                results.append(run_case(app, room, evidence, session))
        write(output / 'summary.json', {'results': results, 'loopbackModelRequests': len(calls), 'plan': plan})
    finally:
        server.shutdown(); server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--prepare', action='store_true'); mode.add_argument('--run', action='store_true')
    parser.add_argument('--app', default='.artifacts/macos/Magic Code.app')
    parser.add_argument('--output', default='.artifacts/macos/terminal-system-test')
    options = parser.parse_args(); output = Path(options.output).resolve(); output.mkdir(parents=True, exist_ok=True)
    path = output / 'plan.json'
    if options.prepare:
        assert not path.exists(), 'preserve the prior test plan; use a fresh output directory'
        write(path, {'app': str(Path(options.app).resolve()),
                     'state': 'prepared-only', 'realTerminalOpened': False, 'notificationsRequested': False})
        print(path)
    else: run(json.loads(path.read_text()), output)
