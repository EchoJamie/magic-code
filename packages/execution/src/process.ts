import { closeSync, readSync } from 'node:fs'
import type { OwnedProcess, ProcessLedger } from '@magic/contracts'
import { signalGroup, startTimeOf } from './groups.ts'

type Output = 'pipe' | 'ignore' | number

/** 固定启动屏障只消费一行；exec 保持 PID，剩余 stdin 留给实际程序。 */
const BARRIER = 'IFS= read -r magic_start && [ "$magic_start" = MAGIC_START ] || exit 125; exec "$@"'

/**
 * 命令组长保留到最后一个普通后代退出。fd 3 只回传业务退出码，stdin 只管宿主寿命。
 * 使用系统 Perl 的 select / waitpid，避免 shell 的 wait 被 TERM 打断或读超时与 EOF 混淆。
 * 用户命令继承原 cwd/env，stdin 为 /dev/null，控制 fd 不传给它。
 */
const COMMAND_GROUP = String.raw`
use strict;
use POSIX qw(WNOHANG);
my $start = '';
while ($start !~ /\n$/) {
  my $n = sysread(STDIN, my $byte, 1);
  exit 125 unless defined($n) && $n == 1;
  $start .= $byte;
}
exit 125 unless $start eq "MAGIC_START\n";
$SIG{TERM} = sub {};
open(my $result, '>&=3') or exit 125;
my $child = fork();
exit 125 unless defined $child;
if ($child == 0) {
  $SIG{TERM} = 'DEFAULT';
  close($result);
  open(STDIN, '<', '/dev/null') or exit 125;
  exec { $ARGV[0] } @ARGV;
  exit 127;
}
close(STDOUT);
close(STDERR);
my $exit;
while (1) {
  if (!defined $exit && waitpid($child, WNOHANG) == $child) {
    $exit = ($? & 127) ? 128 + ($? & 127) : $? >> 8;
    print $result "$exit\n";
    close($result);
  }
  if (defined $exit) {
    my $others = 0;
    my $probe = open(my $members, '-|', '/bin/ps', '-axo', 'pid=,pgid=');
    if ($probe) {
      while (<$members>) {
        my ($pid, $group) = /^\s*(\d+)\s+(\d+)/;
        $others++ if defined($group) && $group == $$ && $pid != $$ && $pid != $probe;
      }
      my $readable = close($members);
      exit $exit if $readable && !$others;
    }
  }
  my $read = '';
  vec($read, fileno(STDIN), 1) = 1;
  if (select($read, undef, undef, 0.05) > 0) {
    my $n = sysread(STDIN, my $byte, 1);
    if (defined($n) && $n == 0) {
      # 宿主通道已关闭。组长仍是自己，先给后代 TERM，再有界升级整组。
      kill 'TERM', -$$;
      select(undef, undef, undef, 1.5);
      kill 'KILL', -$$;
      exit 125;
    }
  }
}
`

/** 额外 fd 为非阻塞 socket；只读一行，不与 stdout/stderr 或包装退出码混用。 */
async function commandResult(proc: Bun.Subprocess, fd: number): Promise<number | null> {
  const bytes = Buffer.alloc(32)
  let text = ''
  try {
    for (;;) {
      try {
        const length = readSync(fd, bytes, 0, bytes.length, null)
        if (length === 0) return null
        text += bytes.toString('utf8', 0, length)
        if (text.includes('\n')) return /^\d+\n$/.test(text) ? Number(text.trim()) : null
        if (text.length > 16) return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') return null
      }
      if (proc.exitCode !== null) return null
      await Bun.sleep(10)
    }
  } finally {
    closeSync(fd)
  }
}

export async function spawnOwned<O extends Output, E extends Output>(argv: readonly string[], options: {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdout: O
  readonly stderr: E
  readonly keepStdin?: boolean
  readonly signal?: AbortSignal
  readonly ledger?: ProcessLedger
  readonly kind: OwnedProcess['kind']
  readonly what: string
}): Promise<{ readonly process: Bun.Subprocess<'pipe', O, E>; readonly startedAt: number; readonly commandExited: Promise<number | null> }> {
  const finish = options.ledger?.beginSpawn?.()
  try {
    options.signal?.throwIfAborted()
    const command = argv[0]
    const executable = command && Bun.which(command, { cwd: options.cwd, PATH: options.env?.PATH ?? (options.env ? '' : process.env.PATH) })
    if (!executable) throw Object.assign(new Error('找不到可执行文件'), { code: 'ENOENT' })
    const commandGroup = options.kind !== 'mcp'
    const child = Bun.spawn(commandGroup
      ? ['/usr/bin/perl', '-e', COMMAND_GROUP, '--', executable, ...argv.slice(1)]
      : ['/bin/sh', '-c', BARRIER, 'magic-tool', executable, ...argv.slice(1)], {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env, ...(options.cwd ? { PWD: options.cwd } : {}) },
      stdio: commandGroup ? ['pipe', options.stdout, options.stderr, 'socket-fd'] : ['pipe', options.stdout, options.stderr], detached: true,
    }) as Bun.Subprocess<'pipe', O, E>
    const commandExited = commandGroup ? commandResult(child, child.stdio[3] as number) : child.exited
    // 普通工具返回不关闭控制通道；本组结束才释放父端。
    if (commandGroup) void child.exited.then(() => { child.stdin.end() })
    try {
      const startedAt = await startTimeOf(child.pid)
      if (startedAt === undefined) throw new Error(`无法核对工具进程 ${child.pid} 的启动身份，未放行`)
      options.signal?.throwIfAborted()
      await options.ledger?.add({ pgid: child.pid, startedAt, kind: options.kind, what: options.what })
      options.signal?.throwIfAborted()
      child.stdin.write('MAGIC_START\n')
      await child.stdin.flush()
      if (!commandGroup && !options.keepStdin) child.stdin.end()
      return { process: child, startedAt, commandExited }
    } catch (error) {
      child.stdin.end()
      signalGroup(child.pid, 'SIGKILL')
      await child.exited
      throw error
    }
  } finally { finish?.() }
}
