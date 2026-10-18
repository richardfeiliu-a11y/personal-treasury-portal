#!/usr/bin/env python3
"""运行时入口检查器（WP03 任务 3，D02 产物）——只读。

动机（R03）：a28c299 以「全仓零引用」删除 watchdog.sh，但生产 timer 仍在
调用——仅搜 Git 内部引用会漏掉「生产仍在消费」的漂移。本检查器读取
**脱敏部署清单**（infra/runtime-entrypoints.json，不含凭据/主机名/密钥），
校验四要素：文件存在性、解释器声明、仓库根、unit 调度归属（timer 文件
存在 + OnCalendar 与清单一致）。清单中记录的是「外部消费者期望的入口」，
仓库文件不再存在即报 drift（退出码 1），供巡检/发布前检索复用。

只读保证：只打开文件读取，不写任何路径、不重启服务、不修改配置。

用法：
    python3 scripts/tools/check_runtime_entrypoints.py \
        [--manifest infra/runtime-entrypoints.json] [--repo-root .] [--json]

退出码：0 清洁；1 发现漂移/缺失；2 用法/清单错误。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

DEFAULT_MANIFEST = Path("infra/runtime-entrypoints.json")


def _parse_unit_execs(unit_path: Path, declared_root: str) -> list[dict[str, Any]]:
    """从 unit 文件提取 ExecStart*/ExecStartPost 的解释器与脚本相对路径。

    兼容三种形态：`interpreter script`、`/usr/bin/env bash script`、
    `flock -n lock script`、以及无解释器直执行 `script`；以清单声明的
    repo_root（生产路径）识别脚本片段，剥离为仓库相对路径。
    """
    entries: list[dict[str, Any]] = []
    for line in unit_path.read_text(encoding="utf-8").splitlines():
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key not in ("ExecStart", "ExecStartPost", "ExecStartPre"):
            continue
        value = line.split("=", 1)[1].strip()
        parts = value.split()
        # 自右向左找引用声明 repo_root 的片段作为脚本（flock/env/解释器前缀均兼容）
        script_abs = ""
        for part in reversed(parts):
            if declared_root and part.startswith(declared_root):
                script_abs = part
                break
        script_rel = ""
        if script_abs:
            script_rel = script_abs[len(declared_root):].lstrip("/")
        interpreter = parts[0] if parts else ""
        if Path(interpreter).name == "env" and len(parts) > 1:
            interpreter = f"env {parts[1]}"
        entries.append({
            "directive": key,
            "interpreter": interpreter,
            "script_abs": script_abs,
            "script_rel": script_rel,
        })
    return entries


def _check_unit(name: str, spec: dict[str, Any], repo_root: Path,
                declared_root: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    unit_file = repo_root / "infra" / "systemd" / name
    if not unit_file.is_file():
        findings.append({"severity": "error", "kind": "missing_unit_file",
                         "unit": name, "path": str(unit_file.relative_to(repo_root))})
        return findings

    # AUD-27：unit 可以不通过仓库脚本暴露入口。两种显式豁免形态：
    #  - exec_container_module：ExecStart 经 docker compose exec 调用容器内模块，
    #    命令行里出现的仓库路径是 compose 文件本身（非被测脚本），因此不做脚本比对；
    #  - retired=True：已退役但生产仍安装的 unit，只要求 timer 声明可核验，不要求
    #    仓库保留被执行的脚本（本例 watchdog.sh 已随 D02 删除）。
    # 二者都必须在清单里显式声明，避免「未登记」被默认放行。
    exec_via_container = bool(spec.get("exec_container_module"))
    retired = bool(spec.get("retired"))
    if not exec_via_container:
        spec_with_name = {**spec, "_unit_name": name}
        for entry in _parse_unit_execs(unit_file, declared_root):
            findings.extend(_check_exec_entry(entry, spec_with_name, repo_root))
    if retired and not spec.get("timer"):
        findings.append({"severity": "warn", "kind": "retired_without_timer",
                         "unit": name})

    timer = spec.get("timer")
    if timer:
        timer_file = repo_root / "infra" / "systemd" / timer
        if not timer_file.is_file():
            findings.append({"severity": "error", "kind": "missing_timer_file",
                             "unit": name, "path": timer})
        else:
            calendar = spec.get("on_calendar")
            if calendar:
                text = timer_file.read_text(encoding="utf-8")
                if calendar not in text:
                    findings.append({"severity": "error", "kind": "on_calendar_mismatch",
                                     "unit": name, "expected": calendar})
    elif not retired:
        findings.append({"severity": "warn", "kind": "no_timer_declared", "unit": name})
    return findings


def _check_exec_entry(entry: dict[str, Any], spec: dict[str, Any],
                      repo_root: Path) -> list[dict[str, Any]]:
    """校验单条 Exec* 条目（AUD-27 从 _check_unit 抽出，供豁免形态复用）。"""
    findings: list[dict[str, Any]] = []
    unit = spec.get("_unit_name", "")
    declared_exec = spec.get("exec") if entry["directive"] == "ExecStart" else spec.get("exec_post")
    if not entry["script_rel"]:
        # RV-08：清单已声明此入口必须运行仓库脚本，实际却指向声明根之外
        # （如旧根 /srv/legacy-app）→ 错误根漂移，判 error。
        # 清单无声明的纯系统命令入口 → 仍 warn，不判错。
        if declared_exec:
            findings.append({"severity": "error", "kind": "exec_root_mismatch",
                             "unit": unit, "directive": entry["directive"],
                             "expected": declared_exec})
        else:
            findings.append({"severity": "warn", "kind": "exec_outside_repo",
                             "unit": unit, "directive": entry["directive"]})
        return findings
    target = repo_root / entry["script_rel"]
    if not target.is_file():
        # R03 漂移形态：Git 已无引用但外部 timer 仍调用
        findings.append({"severity": "error", "kind": "missing_exec_file",
                         "unit": unit, "directive": entry["directive"],
                         "path": entry["script_rel"]})
    elif declared_exec and entry["script_rel"] != declared_exec:
        findings.append({"severity": "error", "kind": "exec_mismatch",
                         "unit": unit, "expected": declared_exec,
                         "actual": entry["script_rel"]})
    return findings


def run_check(manifest_path: Path, repo_root: Path) -> tuple[int, list[dict[str, Any]]]:
    """执行只读检查。返回 (exit_code, findings)。"""
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return 2, [{"severity": "error", "kind": "manifest_unreadable", "detail": str(exc)}]

    declared_root = manifest.get("repo_root", "")
    findings: list[dict[str, Any]] = []
    if not declared_root:
        findings.append({"severity": "error", "kind": "repo_root_undeclared"})
    units = manifest.get("units") or {}
    if not units:
        findings.append({"severity": "error", "kind": "no_units_declared"})
    for name, spec in units.items():
        findings.extend(_check_unit(name, spec, repo_root, declared_root))
    for consumer, spec in (manifest.get("external_consumers") or {}).items():
        script = spec.get("script") if isinstance(spec, dict) else None
        if script and not (repo_root / script).is_file():
            findings.append({"severity": "error", "kind": "missing_external_script",
                             "consumer": consumer, "path": script})

    code = 1 if any(f["severity"] == "error" for f in findings) else 0
    return code, findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读运行时入口检查器（漂移检测）")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST,
                        help="脱敏部署清单 JSON（默认 infra/runtime-entrypoints.json）")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd())
    parser.add_argument("--json", action="store_true", help="输出结构化 JSON")
    args = parser.parse_args(argv)

    repo_root = args.repo_root.resolve()
    code, findings = run_check(args.manifest, repo_root)
    if args.json:
        print(json.dumps({"exit_code": code, "repo_root": str(repo_root),
                          "findings": findings}, ensure_ascii=False, indent=2))
    else:
        status = "CLEAN" if code == 0 else ("DRIFT" if code == 1 else "ERROR")
        print(f"=== runtime entrypoint check: {status} ({len(findings)} findings) ===")
        for f in findings:
            print(f"  [{f['severity']}] {f['kind']}: {json.dumps(f, ensure_ascii=False)}")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
