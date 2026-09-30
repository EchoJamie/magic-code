#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
U109 ③ · 测试副本隔离的**反向判据**（红/绿两侧）——原件。

## 要证的那一件事

**测试副本一个字节都没碰用户真实 `~/.magic`（读与写两面）**，而且这条判据
**抓得住**「真去碰它」的那种行为（不是空集相等那种假过 —— `empty-result-equals-is-not-evidence`）。

## 装置：把判据落在**行为**上，不落在日志上

`sandbox-exec` 给被测进程套一层「拒绝对**某个路径**的读与写」。于是：

| 组 | 沙箱里被拒的路径 | 期望 | 它证什么 |
| --- | --- | --- | --- |
| **绿** | 真实 `~/.magic` | 副本甲**照常起到 `app.ready`** | 它**没读**那儿 —— 读了当场被拒、起不来 |
| **红** | 隔离根里的 `Library/Application Support/Magic Code/runtime` | 副本甲**起不到 `app.ready`** | 同一份包、同一套装置，**只换被拒的路径** ⇒ 这层沙箱真管得住它的文件访问 |
| **闸的真身** | 真实 `~/.magic` | 一个**故意的读者/写者**当场被拒 | 那层拒绝不是空设置 |

判据落在「起没起到 ready」上，而不是去 grep 沙箱日志：实测本机 `sandbox-exec` 的
file-read 拒绝**不落**统一日志（`log show` 里查不到），拿日志当证据会得到一片空白
——而空白跟「没有违规」长得一模一样。

## 另外两条

- **写面**：真实 `~/.magic` 的**前后快照**逐条比对（相对路径 · 大小 · mtime · 权限 · SHA256）；
  比对之前**先证快照非空**（空集相等不算证据）。
- **正控**：隔离根里**确实落了东西**（宿主发现记录 ＋ 记录库）—— 否则「什么都没发生」
  与「它对哪儿都没写」也分不开。

## 用法

    python3 隔离反向判据.py --app "<.artifacts/macos/Magic Code.app>" --out <证据目录>

只跑一次大约 1 分钟。**不碰**用户真实数据：真实 `~/.magic` 全程只读（快照），
且被测进程那一侧被沙箱挡住了写。
"""

from __future__ import annotations  # 本机 python3 是 3.9（Xcode 那份）：`X | None` 这类写法靠它才成

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REAL_MAGIC = Path.home() / ".magic"
REAL_SUPPORT = Path.home() / "Library/Application Support/Magic Code"
SANDBOX_EXEC = "/usr/bin/sandbox-exec"


# ── 快照：真实目录的只读底片 ────────────────────────────────────────────────
def snapshot(root: Path) -> dict:
    """逐条量一份目录：相对路径 · 类型 · 大小 · mtime(ns) · 权限 · SHA256（常规文件且不太大）。"""
    out: dict[str, dict] = {}
    if not root.exists():
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(dirnames):
            p = Path(dirpath) / name
            st = p.lstat()
            out[str(p.relative_to(root))] = {"kind": "dir", "mode": oct(st.st_mode), "mtime": st.st_mtime_ns}
        for name in sorted(filenames):
            p = Path(dirpath) / name
            st = p.lstat()
            entry = {"kind": "file", "size": st.st_size, "mode": oct(st.st_mode), "mtime": st.st_mtime_ns}
            if not p.is_symlink() and st.st_size <= 8 * 1024 * 1024:
                h = hashlib.sha256()
                try:
                    with p.open("rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            h.update(chunk)
                    entry["sha256"] = h.hexdigest()
                except OSError as error:
                    entry["sha256"] = f"<unreadable:{error.errno}>"
            out[str(p.relative_to(root))] = entry
    return out


def diff_snapshots(before: dict, after: dict) -> list[str]:
    changes: list[str] = []
    for key in sorted(set(before) | set(after)):
        a, b = before.get(key), after.get(key)
        if a is None:
            changes.append(f"+ 新增 {key}")
        elif b is None:
            changes.append(f"- 消失 {key}")
        elif a != b:
            fields = [f for f in ("size", "mtime", "mode", "sha256") if a.get(f) != b.get(f)]
            changes.append(f"~ 变了 {key}（{','.join(fields)}）")
    return changes


# ── 沙箱：拒绝对某个路径的读与写，其余照旧 ────────────────────────────────
def profile(denied: list[Path]) -> str:
    rules = "".join(
        f'(deny file-read* file-write* (subpath "{p}"))\n' for p in denied
    )
    return f"(version 1)\n(allow default)\n{rules}"


def run(argv: list[str], denied: list[Path], timeout: float = 90.0) -> tuple[int, str, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".sb", delete=False) as fh:
        fh.write(profile(denied))
        sb = fh.name
    try:
        proc = subprocess.run(
            [SANDBOX_EXEC, "-f", sb, *argv],
            capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as error:
        # 超时那一支给回来的是 **bytes**（不是 text）——这里照实解回字符串，别让下游去猜。
        def text(value: object) -> str:
            if value is None:
                return ""
            return value.decode("utf-8", "replace") if isinstance(value, bytes) else str(value)
        return -9, text(error.stdout), text(error.stderr) + "\n<超时>"
    finally:
        os.unlink(sb)


# ── 副本：同一份二进制，只换身份与隔离根 ──────────────────────────────────
def make_copy(source: Path, dest: Path, bundle_id: str, root: Path | None) -> None:
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest, symlinks=True)
    plist_path = dest / "Contents/Info.plist"
    with plist_path.open("rb") as fh:
        info = plistlib.load(fh)
    info["CFBundleIdentifier"] = bundle_id
    if root is None:
        info.pop("MagicSystemTestRoot", None)
    else:
        info["MagicSystemTestRoot"] = str(root)
    with plist_path.open("wb") as fh:
        plistlib.dump(info, fh)
    # 改过 Info.plist ⇒ 重签（外层 App；内层 helper 没动，原签名仍成立）
    subprocess.run(["codesign", "--force", "--options", "runtime", "--sign", "-", str(dest)],
                   check=True, capture_output=True)


def run_app(app: Path, denied: list[Path], extra: list[str] | None = None, timeout: float = 90.0) -> dict:
    """起一份副本跑一趟：到 ready 就报 ready，随后自己退场（`--validation-quit`）。

    红那一侧**本来就不会到 ready**，故它必然跑到超时（应用自己的起手闸是 20 秒——
    到点它落 `.fault` 并打出 `app.error`）。那一趟给 40 秒：够它把失败缘由说出来。
    """
    binary = app / "Contents/MacOS/MagicCode"
    argv = [str(binary), "--validation-quit", *(extra or [])]
    started = time.time()
    code, out, err = run(argv, denied, timeout=timeout)
    events = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return {
        "argv": argv,
        "denied": [str(p) for p in denied],
        "exit": code,
        "seconds": round(time.time() - started, 1),
        "ready": any(e.get("event") == "app.ready" for e in events),
        "events": events,
        "stderr_tail": err[-2000:],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, help="构建出来的 Magic Code.app")
    parser.add_argument("--out", required=True, help="证据落点")
    args = parser.parse_args()

    source = Path(args.app).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert source.is_dir(), f"没有这个 App：{source}"

    report: dict = {
        "app": str(source),
        "real_magic": str(REAL_MAGIC),
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }

    # 0 · 真实目录的前置快照（先证非空——空集相等不算证据）
    before = snapshot(REAL_MAGIC)
    report["real_magic_before"] = {"entries": len(before), "nonempty": len(before) > 0}

    # 1 · 造副本：同一份二进制，只换身份与隔离根
    #
    # ⚠️ **根必须落在 `/private/tmp` 底下**（不是 `mkdtemp` 缺省那个 `/var/folders/…`）：
    #    `AppModel.systemTestRoot` 认的就是「父目录 ∈ {/tmp, /private/tmp} 且末段以
    #    `magic-system-test-` 起头」——落在 `/var/folders` 底下时它判「隔离根无效」、
    #    应用 **exit 78 拒绝启动**（第一趟就是这么红的，判据本身没毛病）。
    root = Path(tempfile.mkdtemp(prefix="magic-system-test-u109iso-", dir="/private/tmp"))
    token = hashlib.sha256(str(root).encode()).hexdigest()[:32]
    copy_a = root / "Magic Code 隔离副本.app"
    make_copy(source, copy_a, f"com.magiccode.validation.{token}.dev", root)
    report["copy"] = {"path": str(copy_a), "root": str(root), "bundle": f"com.magiccode.validation.{token}.dev"}

    runtime = root / "Library/Application Support/Magic Code/runtime"

    # 2 · **绿**：只拒真实 ~/.magic ⇒ 照常起到 ready
    green = run_app(copy_a, [REAL_MAGIC])
    report["green"] = green

    # 3 · **红**：同一份包、同一套装置，只把「隔离根里的运行目录」拒掉 ⇒ 起不到 ready
    red = run_app(copy_a, [runtime], timeout=40.0)
    report["red_same_subject"] = red

    # 4 · **闸的真身**：沙箱里故意读/写真实 ~/.magic ⇒ 当场被拒
    probe_read = run(["/bin/cat", str(REAL_MAGIC / "config.json")], [REAL_MAGIC])
    probe_write = run(["/usr/bin/touch", str(REAL_MAGIC / "u109-不许写")], [REAL_MAGIC])
    report["tripwire"] = {
        "read_exit": probe_read[0], "read_err": probe_read[2][-300:],
        "write_exit": probe_write[0], "write_err": probe_write[2][-300:],
        "read_blocked": probe_read[0] != 0, "write_blocked": probe_write[0] != 0,
    }

    # 5 · 正控：它**确实在隔离根里落了东西**（否则「一个字节没碰真实目录」与
    #     「它压根什么都没发生」分不开）。判据取自应用自己交出来的读数：
    #     `host.response` 那一行的 dataDir / base / config 与 `app.ready` 的 discovery
    #     路径——**四件都得在隔离根底下**。这才是「隔离到位」的正身，不只是「文件在不在」。
    def under_root(text: str) -> bool:
        return isinstance(text, str) and text.startswith(str(root))

    ready_detail = next((e.get("detail", "") for e in green["events"] if e.get("event") == "host.response"), "")
    discovery = next((e.get("host", "") for e in green["events"] if e.get("event") == "app.ready"), "")
    # `host.response` 那一行是 `ready(identity: …dataDir: "X", socket: "Y", base: "Z", config: "W")`
    # ——把四个路径抠出来，逐个数它们在不在这儿。
    landed = re.findall(r'(?:dataDir|socket|base|config): "([^"]+)"', ready_detail)
    outside = [p for p in landed if not under_root(p)]
    report["positive_control"] = {
        "root_exists": root.exists(),
        "host_ready_paths": landed,
        "paths_outside_root": outside,
        "discovery": discovery,
        "discovery_under_root": under_root(discovery),
        "records": any(root.rglob("records.db")),
        "entries_under_root": sum(1 for _ in root.rglob("*")),
    }

    # 6 · 真实目录的后置快照 ＋ 比对
    after = snapshot(REAL_MAGIC)
    changes = diff_snapshots(before, after)
    report["real_magic_after"] = {"entries": len(after)}
    report["real_magic_diff"] = changes
    report["real_magic_untouched"] = len(changes) == 0

    # 7 · 尺子自检：比较器对「改一个字节」当场报红
    scratch = Path(tempfile.mkdtemp(prefix="u109-snapshot-selftest-"))
    (scratch / "a").mkdir()
    (scratch / "a" / "one").write_text("甲")
    (scratch / "a" / "two").write_text("乙")
    s1 = snapshot(scratch)
    (scratch / "a" / "two").write_text("丙")
    (scratch / "a" / "three").write_text("丁")
    s2 = snapshot(scratch)
    reported = diff_snapshots(s1, s2)
    # 改内容要按 **SHA256** 被抓到（不是只靠 mtime 那种会同刻撞车的量），加文件要被抓到。
    # 目录 `a` 自己的 mtime 也会跟着变，那一条是**顺带**，不计入判据。
    report["snapshot_self_test"] = {
        "reported": reported,
        "caught_content": any("a/two" in line and "sha256" in line for line in reported),
        "caught_addition": any(line.startswith("+ 新增 a/three") for line in reported),
        "sensitive": any("a/two" in line and "sha256" in line for line in reported)
        and any(line.startswith("+ 新增 a/three") for line in reported),
    }
    shutil.rmtree(scratch, ignore_errors=True)

    # 8 · 判定
    verdict = {
        "绿：带隔离根的副本在「拒真实 ~/.magic」下起到 ready": green["ready"],
        "红：只把隔离根里的运行目录拒掉就起不到 ready": not red["ready"],
        "闸：沙箱里读真实 ~/.magic 被拒": report["tripwire"]["read_blocked"],
        "闸：沙箱里写真实 ~/.magic 被拒": report["tripwire"]["write_blocked"],
        "写面：真实 ~/.magic 前后逐条一致": report["real_magic_untouched"],
        "快照非空（不是空集相等）": before and len(before) > 0,
        "正控：宿主读数（数据目录/基础目录/配置/发现记录）全落在隔离根底下": report["positive_control"]["discovery_under_root"]
        and len(report["positive_control"]["host_ready_paths"]) >= 4
        and not report["positive_control"]["paths_outside_root"]
        and report["positive_control"]["records"],
        "尺子自检：比较器抓得住改一个字节": report["snapshot_self_test"]["sensitive"],
    }
    report["verdict"] = verdict
    report["all_green"] = all(verdict.values())

    (out / "isolation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

    for key, value in verdict.items():
        print(f"{'✓' if value else '✗'} {key}")
    print(f"\n证据：{out / 'isolation.json'}")
    print(f"真实目录条目数：{len(before)} → {len(after)}；改动 {len(changes)} 条")
    return 0 if report["all_green"] else 1


if __name__ == "__main__":
    sys.exit(main())
