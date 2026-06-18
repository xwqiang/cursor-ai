#!/usr/bin/env python3
"""macOS 电源策略：关屏后尽量保持程序继续运行。

独立使用:
  python3 scripts/mac_server_power.py apply
  python3 scripts/mac_server_power.py ensure
  python3 scripts/mac_server_power.py status

由 start.sh 在 Darwin 上按 MAC_SERVER_POWER 环境变量调用。
"""

from __future__ import annotations

import argparse
import os
import platform
import plistlib
import subprocess
import sys
import textwrap
from pathlib import Path

AGENT_LABEL = "com.local.cursor-ai.mac-server-power"
DEFAULT_LOG_FILE = "/tmp/mac-server-power-test.log"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=True,
    )


def is_darwin() -> bool:
    return platform.system() == "Darwin"


def agent_plist_path() -> Path:
    return Path.home() / "Library" / "LaunchAgents" / f"{AGENT_LABEL}.plist"


def parse_pmset_custom() -> dict[str, dict[str, str]]:
    """解析 ``pmset -g custom`` 为 {AC Power|Battery Power: {key: value}}。"""
    try:
        out = _run(["pmset", "-g", "custom"]).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {}
    sections: dict[str, dict[str, str]] = {}
    current: str | None = None
    for line in out.splitlines():
        stripped = line.strip()
        if stripped in ("AC Power:", "Battery Power:"):
            current = stripped.replace(":", "")
            sections[current] = {}
            continue
        if current and stripped:
            parts = stripped.split()
            if len(parts) >= 2:
                key = parts[0]
                value = parts[-1]
                sections[current][key] = value
    return sections


def ac_power_configured(
    *,
    display_sleep: int,
    require_sleep_zero: bool = True,
) -> bool:
    sections = parse_pmset_custom()
    ac = sections.get("AC Power", {})
    if not ac:
        return False
    try:
        ds = int(ac.get("displaysleep", "-1"))
        sl = int(ac.get("sleep", "-1"))
    except ValueError:
        return False
    if ds != display_sleep:
        return False
    if require_sleep_zero and sl != 0:
        return False
    return True


def need_sudo(*, interactive: bool) -> bool:
    try:
        _run(["sudo", "-n", "true"])
        return True
    except subprocess.CalledProcessError:
        if not interactive or not sys.stdin.isatty():
            return False
        print("需要管理员权限，请输入本机登录密码：")
        try:
            _run(["sudo", "-v"])
            return True
        except subprocess.CalledProcessError:
            return False


def sudo_pmset(args: list[str], *, interactive: bool) -> bool:
    if not need_sudo(interactive=interactive):
        print("[mac-power] 跳过：无免密 sudo 且非交互终端", file=sys.stderr)
        return False
    cmd = ["sudo", "pmset", *args]
    try:
        subprocess.run(cmd, check=True)
        return True
    except subprocess.CalledProcessError as e:
        print(f"[mac-power] 命令失败: {' '.join(cmd)} ({e})", file=sys.stderr)
        return False


def apply_settings(*, interactive: bool, quiet: bool) -> bool:
    display_sleep = _env_int("MAC_SERVER_POWER_DISPLAY_SLEEP_MINUTES", 10)
    battery_sleep = _env_int("MAC_SERVER_POWER_BATTERY_SLEEP_MINUTES", 30)

    if not quiet:
        print(
            f"[mac-power] AC: displaysleep={display_sleep}min, sleep=0; "
            f"Battery: sleep={battery_sleep}min"
        )

    ac_steps = [
        ["-c", "displaysleep", str(display_sleep)],
        ["-c", "sleep", "0"],
        ["-c", "disksleep", "0"],
        ["-c", "powernap", "0"],
        ["-c", "standby", "0"],
        ["-c", "autopoweroff", "0"],
        ["-c", "tcpkeepalive", "1"],
        ["-c", "womp", "1"],
        ["-c", "ttyskeepawake", "1"],
    ]
    bat_steps = [
        ["-b", "displaysleep", str(display_sleep)],
        ["-b", "sleep", str(battery_sleep)],
        ["-b", "disksleep", "0"],
        ["-b", "powernap", "0"],
        ["-b", "standby", "0"],
        ["-b", "ttyskeepawake", "1"],
    ]

    ok = True
    for step in ac_steps + bat_steps:
        if not sudo_pmset(step, interactive=interactive):
            if step[-2:] == ["autopoweroff", "0"]:
                continue
            ok = False
    if ok and not quiet:
        print("[mac-power] 电源策略已应用")
    return ok


def restore_defaults(*, interactive: bool) -> bool:
    ok = sudo_pmset(["-c", "restoredefaults"], interactive=interactive)
    ok = sudo_pmset(["-b", "restoredefaults"], interactive=interactive) and ok
    if ok:
        print("[mac-power] 已恢复系统默认电源策略")
    return ok


def show_status() -> None:
    print("=== 系统 ===")
    try:
        print(_run(["sw_vers"]).stdout, end="")
    except subprocess.CalledProcessError:
        pass
    try:
        sp = _run(
            [
                "system_profiler",
                "SPHardwareDataType",
            ]
        ).stdout
        for line in sp.splitlines():
            if any(k in line for k in ("Model Name", "Model Identifier", "Chip", "Memory")):
                print(line.strip())
    except subprocess.CalledProcessError:
        pass
    print("\n=== pmset -g ===")
    try:
        subprocess.run(["pmset", "-g"], check=False)
    except FileNotFoundError:
        print("(pmset 不可用)")
    print("\n=== pmset -g custom ===")
    try:
        subprocess.run(["pmset", "-g", "custom"], check=False)
    except FileNotFoundError:
        pass
    plist = agent_plist_path()
    print(f"\n=== LaunchAgent ({AGENT_LABEL}) ===")
    if plist.is_file():
        print(f"plist: {plist}")
        uid = os.getuid()
        try:
            subprocess.run(
                ["launchctl", "print", f"gui/{uid}/{AGENT_LABEL}"],
                check=False,
            )
        except FileNotFoundError:
            pass
    else:
        print("未安装")


def run_test() -> None:
    log_file = os.environ.get("MAC_SERVER_POWER_LOG_FILE", DEFAULT_LOG_FILE)
    script = textwrap.dedent(
        f"""
        import time
        from datetime import datetime
        path = {log_file!r}
        while True:
            with open(path, "a", encoding="utf-8") as f:
                f.write(datetime.now().strftime("%Y-%m-%d %H:%M:%S") + "\\n")
            time.sleep(10)
        """
    ).strip()
    proc = subprocess.Popen(
        [sys.executable, "-c", script],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    print(f"[mac-power] 测试进程 PID={proc.pid}, 日志={log_file}")
    print(f"  验证: sleep 120 && tail -3 {log_file}")


def install_agent(*, quiet: bool) -> bool:
    plist_path = agent_plist_path()
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "Label": AGENT_LABEL,
        "ProgramArguments": ["/usr/bin/caffeinate", "-dims"],
        "RunAtLoad": True,
        "KeepAlive": True,
    }
    with plist_path.open("wb") as f:
        plistlib.dump(data, f)
    uid = os.getuid()
    domain = f"gui/{uid}"
    subprocess.run(
        ["launchctl", "bootout", domain, str(plist_path)],
        capture_output=True,
    )
    r = subprocess.run(
        ["launchctl", "bootstrap", domain, str(plist_path)],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        print(f"[mac-power] launchctl bootstrap 失败: {r.stderr.strip()}", file=sys.stderr)
        return False
    if not quiet:
        print(f"[mac-power] LaunchAgent 已安装: {plist_path}")
    return True


def uninstall_agent() -> bool:
    plist_path = agent_plist_path()
    uid = os.getuid()
    subprocess.run(
        ["launchctl", "bootout", f"gui/{uid}/{AGENT_LABEL}"],
        capture_output=True,
    )
    if plist_path.is_file():
        plist_path.unlink()
    print("[mac-power] LaunchAgent 已移除")
    return True


def agent_installed() -> bool:
    return agent_plist_path().is_file()


def ensure(*, interactive: bool, quiet: bool, with_agent: bool) -> bool:
    """已配置则跳过；否则 apply（及可选 install-agent）。"""
    display_sleep = _env_int("MAC_SERVER_POWER_DISPLAY_SLEEP_MINUTES", 10)
    if ac_power_configured(display_sleep=display_sleep):
        if not quiet:
            print("[mac-power] AC 策略已满足，跳过 apply")
    else:
        if not apply_settings(interactive=interactive, quiet=quiet):
            return False

    if with_agent:
        if agent_installed():
            if not quiet:
                print("[mac-power] LaunchAgent 已存在，跳过 install-agent")
        elif not install_agent(quiet=quiet):
            return False
    return True


def cmd_both(args: argparse.Namespace) -> bool:
    interactive = not args.non_interactive
    ok = apply_settings(interactive=interactive, quiet=args.quiet)
    if not ok:
        return False
    return install_agent(quiet=args.quiet)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="macOS 关屏/合盖时保持程序运行（pmset + 可选 caffeinate LaunchAgent）",
    )
    p.add_argument(
        "command",
        nargs="?",
        default="ensure",
        choices=[
            "apply",
            "ensure",
            "both",
            "status",
            "test",
            "restore",
            "install-agent",
            "uninstall-agent",
        ],
        help="默认 ensure：仅在未配置时 apply",
    )
    p.add_argument("-q", "--quiet", action="store_true", help="减少输出")
    p.add_argument(
        "--no-agent",
        action="store_true",
        help="ensure/both 时不安装 LaunchAgent",
    )
    p.add_argument(
        "--non-interactive",
        action="store_true",
        help="无免密 sudo 时不提示密码，直接跳过需 sudo 的步骤",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    if not is_darwin():
        print("[mac-power] 仅支持 macOS，已跳过", file=sys.stderr)
        return 0

    args = build_parser().parse_args(argv)
    interactive = not args.non_interactive
    with_agent = not args.no_agent and os.environ.get(
        "MAC_SERVER_POWER_AGENT", ""
    ).strip().lower() in ("1", "true", "yes", "on")

    cmd = args.command
    ok = True
    if cmd == "apply":
        ok = apply_settings(interactive=interactive, quiet=args.quiet)
    elif cmd == "ensure":
        ok = ensure(
            interactive=interactive,
            quiet=args.quiet,
            with_agent=with_agent,
        )
    elif cmd == "both":
        ok = cmd_both(args)
    elif cmd == "status":
        show_status()
    elif cmd == "test":
        run_test()
    elif cmd == "restore":
        ok = restore_defaults(interactive=interactive)
    elif cmd == "install-agent":
        ok = install_agent(quiet=args.quiet)
    elif cmd == "uninstall-agent":
        ok = uninstall_agent()
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        ok = False

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
