#!/usr/bin/env python3
"""
scripts/ops/rehearse_runbook_scenarios.py

Offline reproducible rehearsal suite for production release runbook:
`docs/reports/2026-09-07-reliability-release-and-execution-runbook.md`

DIRECTLY executes and validates the unified production operations script:
`scripts/ops/release_ops.sh`

Validates all critical execution & rollback invariants in temporary sandboxes
using mock tools (git, docker, systemctl, python3):
1. Interrupted backup recovery & subsequent verification (locks original ID, heals missing tag from locked ID).
2. Frontend component rollback isolation & mutable tag drift resilience (strictly container-only, NO git, restores from locked ID).
3. Systemd Unit backup & restore (handles pre-existing vs non-pre-existing, fail-closed if .orig missing).
4. Backup failure fails closed (set -euo pipefail, no || true swallowing).
5. Digest receipt status machine (4-way taxonomy) & complete runbook case-statement caller branch execution.
6. Global rollback strict ordering, full final state verification, and service naming (hermes-gateway, config.yaml.bak).
7. Global rollback critical operation failure fails closed (probe replication: docker exit 9, systemctl stop/restart exit 9, final check fail).
"""

import os
import sys
import tempfile
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
RELEASE_OPS_SCRIPT = REPO_ROOT / "scripts/ops" / "release_ops.sh"


def run_ops(subcommand_args, env, cwd=None):
    """Executes scripts/ops/release_ops.sh directly with specified arguments."""
    cmd = ["bash", str(RELEASE_OPS_SCRIPT)] + subcommand_args
    return subprocess.run(
        cmd,
        env=env,
        cwd=cwd,
        capture_output=True,
        text=True
    )


def test_scenario_1_interrupted_backup_and_subsequent_verification(base_dir):
    """
    Scenario 1:
    - 1.1: Interruption window - ID written, but tag missing or failed.
      Re-run must verify tag, detect tag missing, and repair tag using locked ID (NOT current container).
    - 1.2: Subsequent execution preserves locked ID even after container image changes.
    """
    print("[Rehearsal 1] Testing interrupted backup recovery and subsequent verification...")
    sandbox = base_dir / "s1"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()
    manifest_dir = sandbox / "manifest"
    manifest_dir.mkdir()
    log_file = sandbox / "docker.log"

    docker_state_file = sandbox / "docker_tags.txt"

    # Mock docker tracking tags and inspect
    docker_mock = bin_dir / "docker"
    docker_mock.write_text(f"""#!/bin/bash
echo "docker $@" >> "{log_file}"
if [ "$1" = "inspect" ]; then
    target="$3"
    [ -n "$target" ] || target="$2"
    if [ "$target" = "personal-treasury-bridge-1" ]; then
        echo "$CURRENT_CONTAINER_IMG"
        exit 0
    elif [ "$target" = "personal-treasury-bridge:rollback-example" ]; then
        if grep -q "^personal-treasury-bridge:rollback-example=" "{docker_state_file}" 2>/dev/null; then
            grep "^personal-treasury-bridge:rollback-example=" "{docker_state_file}" | cut -d'=' -f2
            exit 0
        else
            exit 1
        fi
    fi
    exit 0
elif [ "$1" = "tag" ]; then
    src="$2"
    tgt="$3"
    if [ "$FAIL_TAG" = "1" ]; then
        exit 9
    fi
    echo "$tgt=$src" >> "{docker_state_file}"
    exit 0
fi
exit 0
""")
    docker_mock.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["DOCKER_BIN"] = str(docker_mock)
    env["CURRENT_CONTAINER_IMG"] = "sha256:ORIGINAL_BRIDGE_ID"
    env["FAIL_TAG"] = "1"

    # 1. Simulate interruption: docker tag fails on initial run
    res1 = run_ops(["backup_image", "bridge", "personal-treasury-bridge-1", "bridge", "personal-treasury-bridge:rollback-example"], env)
    assert res1.returncode != 0, f"Expected initial tag failure, got returncode 0: {res1.stderr}"
    assert (manifest_dir / "bridge_image.id").read_text().strip() == "sha256:ORIGINAL_BRIDGE_ID"
    assert not docker_state_file.exists() or "rollback-example" not in docker_state_file.read_text()

    # 2. Container changes to NEW_RELEASE before re-run
    env["CURRENT_CONTAINER_IMG"] = "sha256:NEW_RELEASE_BRIDGE_ID"
    env["FAIL_TAG"] = "0"

    # 3. Re-run: Must NOT use NEW_RELEASE; must detect missing tag and repair using locked ORIGINAL_BRIDGE_ID
    res2 = run_ops(["backup_image", "bridge", "personal-treasury-bridge-1", "bridge", "personal-treasury-bridge:rollback-example"], env)
    assert res2.returncode == 0, f"Re-run repair failed: {res2.stderr}"
    assert "Repairing rollback tag strictly from locked image ID" in res2.stderr

    # Verify state: tag points to ORIGINAL, not NEW_RELEASE
    state = docker_state_file.read_text()
    assert "personal-treasury-bridge:rollback-example=sha256:ORIGINAL_BRIDGE_ID" in state, f"Tag pointed to wrong image: {state}"
    assert (manifest_dir / "bridge_image.id").read_text().strip() == "sha256:ORIGINAL_BRIDGE_ID"

    # 4. Third run: tag exists and matches locked ID -> verify and skip
    res3 = run_ops(["backup_image", "bridge", "personal-treasury-bridge-1", "bridge", "personal-treasury-bridge:rollback-example"], env)
    assert res3.returncode == 0
    assert "already locked and verified" in res3.stderr

    print("  -> PASS: Interrupted backup recovery healed tag from locked ID and preserved initial backup.")


def test_scenario_2_frontend_component_rollback_isolation(base_dir):
    """
    Scenario 2:
    Batch 5 Frontend rollback must strictly be container-isolated and immune to mutable tag drift:
    - Directly restores from locked ID in web_image.id (even if rollback tag drifted to wrong image).
    - Compose up starts container and verifies running image matches locked ID.
    - Git checkout is NEVER called.
    - Host scripts and Bridge container are completely untouched.
    """
    print("[Rehearsal 2] Testing frontend component rollback isolation & mutable tag drift defense...")
    sandbox = base_dir / "s2"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()
    manifest_dir = sandbox / "manifest"
    manifest_dir.mkdir()
    (manifest_dir / "web_image.id").write_text("sha256:ORIGINAL_WEB_ID\n")

    docker_log = sandbox / "docker.log"
    git_log = sandbox / "git.log"
    current_running_image = sandbox / "running_image.txt"
    current_running_image.write_text("sha256:RELEASE_WEB_ID\n")

    # Mock docker tracking tags and inspecting running container
    docker_mock = bin_dir / "docker"
    docker_mock.write_text(f"""#!/bin/bash
echo "docker $@" >> "{docker_log}"
if [ "$1" = "inspect" ]; then
    cat "{current_running_image}"
    exit 0
elif [ "$1" = "tag" ]; then
    src="$2"
    tgt="$3"
    # When compose up runs, it will run the image tagged as :latest
    if [ "$tgt" = "personal-treasury-report-web:latest" ]; then
        echo "$src" > "{current_running_image}"
    fi
    exit 0
elif [ "$1" = "compose" ]; then
    exit 0
fi
exit 0
""")
    docker_mock.chmod(0o755)

    git_mock = bin_dir / "git"
    git_mock.write_text(f"""#!/bin/bash
echo "git $@" >> "{git_log}"
exit 0
""")
    git_mock.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["DOCKER_BIN"] = str(docker_mock)
    env["GIT_BIN"] = str(git_mock)

    # Counterexample: Suppose rollback tag was drifted or corrupted
    # The script must NOT use the rollback tag; it must tag strictly from locked_id (sha256:ORIGINAL_WEB_ID)!
    res = run_ops(["rollback_frontend"], env)
    assert res.returncode == 0, f"rollback_frontend failed: {res.stderr}"

    d_log = docker_log.read_text()
    # Tagging must directly use locked ID sha256:ORIGINAL_WEB_ID
    assert "tag sha256:ORIGINAL_WEB_ID personal-treasury-report-web:latest" in d_log, f"Did not tag from locked ID: {d_log}"
    assert "compose -f /srv/treasury/infra/compose.yaml up -d --no-build --no-deps report-web" in d_log
    assert "bridge" not in d_log

    # Verify container running image was verified to be sha256:ORIGINAL_WEB_ID
    assert current_running_image.read_text().strip() == "sha256:ORIGINAL_WEB_ID"

    # Git must NEVER be touched during frontend component rollback
    assert not git_log.exists() or git_log.read_text().strip() == "", "Git was invoked during frontend rollback!"

    print("  -> PASS: Frontend component rollback is strictly container-isolated with zero host git touch.")


def test_scenario_3_unit_backup_restore_and_fail_closed(base_dir):
    """
    Scenario 3:
    - 3.1 Pre-existing unit backup (.meta with exists=true, .orig saved).
    - 3.2 Non-pre-existing unit backup (.meta with exists=false).
    - 3.3 Subsequent verification checks that .orig exists when exists=true.
    - 3.4 Missing .orig when exists=true causes fail-closed abort on verification.
    """
    print("[Rehearsal 3] Testing systemd unit backup, verification, and missing .orig fail-closed...")
    sandbox = base_dir / "s3"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()
    systemd_dir = sandbox / "systemd"
    systemd_dir.mkdir()
    manifest_dir = sandbox / "manifest"
    manifest_dir.mkdir()

    systemctl_mock = bin_dir / "systemctl"
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "is-enabled" ]; then
    echo "enabled"
    exit 0
elif [ "$1" = "is-active" ]; then
    echo "active"
    exit 0
fi
exit 0
""")
    systemctl_mock.chmod(0o755)

    # Unit 1 pre-exists
    pre_unit = systemd_dir / "personal-treasury-feishu-digest.service"
    pre_unit.write_text("[Unit]\nDescription=Pre-existing\n")

    # Unit 2 does NOT pre-exist (timer)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["SYSTEMD_DIR"] = str(systemd_dir)
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["SYSTEMCTL_BIN"] = str(systemctl_mock)

    # Backup both
    res = run_ops(["backup_units", "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer"], env)
    assert res.returncode == 0, f"backup_units failed: {res.stderr}"

    meta_svc = (manifest_dir / "units" / "personal-treasury-feishu-digest.service.meta").read_text()
    orig_svc = (manifest_dir / "units" / "personal-treasury-feishu-digest.service.orig").read_text()
    meta_tmr = (manifest_dir / "units" / "personal-treasury-feishu-digest.timer.meta").read_text()

    assert "exists=true" in meta_svc
    assert "enabled=enabled" in meta_svc
    assert "Pre-existing" in orig_svc
    assert "exists=false" in meta_tmr

    # Re-run verification succeeds
    res_recheck = run_ops(["backup_units", "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer"], env)
    assert res_recheck.returncode == 0
    assert "Unit personal-treasury-feishu-digest.service backup verified: exists=true and .orig present" in res_recheck.stderr

    # Probe Case: Query failure during backup must fail-closed and NOT create valid meta
    broken_unit = systemd_dir / "broken.service"
    broken_unit.write_text("[Unit]\nDescription=BrokenService\n")
    systemctl_mock.write_text("""#!/bin/bash
if [ "$2" = "broken.service" ]; then
    echo "Injected query failure" >&2
    exit 9
fi
if [ "$1" = "is-enabled" ]; then
    echo "enabled"
    exit 0
elif [ "$1" = "is-active" ]; then
    echo "active"
    exit 0
fi
exit 0
""")
    res_query_fail = run_ops(["backup_units", "broken.service"], env)
    assert res_query_fail.returncode != 0, "Expected backup_units failure on query failure, got success!"
    assert not (manifest_dir / "units" / "broken.service.meta").exists(), "Created .meta despite query failure!"

    # Simulate corrupted/missing .orig file when exists=true -> MUST FAIL-CLOSED
    (manifest_dir / "units" / "personal-treasury-feishu-digest.service.orig").unlink()
    res_corrupt = run_ops(["backup_units", "personal-treasury-feishu-digest.service"], env)
    assert res_corrupt.returncode != 0, "Expected fail-closed when .orig is missing, but got success!"
    assert "missing or empty" in res_corrupt.stderr

    print("  -> PASS: Unit metadata accurately recorded and missing .orig correctly failed closed.")


def test_scenario_4_backup_failure_fails_closed(base_dir):
    """
    Scenario 4:
    Failures in copying or missing configs must fail closed with non-zero exit code (no || true swallowing).
    """
    print("[Rehearsal 4] Testing backup failures fail closed (no || true swallowing)...")
    sandbox = base_dir / "s4"
    sandbox.mkdir()
    manifest_dir = sandbox / "manifest"
    hermes_dir = sandbox / "hermes_bak"

    env = os.environ.copy()
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["HERMES_BACKUP_DIR"] = str(hermes_dir)
    env["HERMES_CONFIG"] = str(sandbox / "non_existent_config.yaml")

    # Hermes config does not exist -> backup_hermes must fail with returncode != 0
    res = run_ops(["backup_hermes"], env)
    assert res.returncode != 0, "backup_hermes succeeded when config was missing!"
    assert "does not exist" in res.stderr

    print("  -> PASS: Backup failure aborts immediately under set -euo pipefail.")


def test_scenario_5_digest_receipt_verification_and_caller_dispatch(base_dir):
    """
    Scenario 5:
    Strict receipt 4-way taxonomy & runbook caller execution integration:
    - 5.1: Receipt file does not exist -> TRIGGER_AUTHORIZED -> Runbook caller executes systemctl start
    - 5.2: Valid current-day delivered -> SKIP_ALREADY_DELIVERED -> Runbook caller skips systemctl start
    - 5.3: Status 'sending' (same day) -> WAIT_OR_CHECK_RUNNING -> Runbook stops with exit 1, no start
    - 5.4: Status 'uncertain' -> STOP_MANUAL_AUDIT_REQUIRED -> Runbook stops with exit 1, no start
    - 5.5: Status 'failed' -> STOP_MANUAL_AUDIT_REQUIRED -> Runbook stops with exit 1, no start
    - 5.6: Date mismatch -> STOP_MANUAL_AUDIT_REQUIRED -> Runbook stops with exit 1, no start
    - 5.7: Corrupted JSON -> STOP_MANUAL_AUDIT_REQUIRED -> Runbook stops with exit 1, no start
    - 5.8: Probe Case: delivered but missing required channel/attempts -> STOP_MANUAL_AUDIT_REQUIRED
    - 5.9: Probe Case: delivered but channel is 'other' -> STOP_MANUAL_AUDIT_REQUIRED
    - 5.10: Probe Case: delivered but attempts is boolean True -> STOP_MANUAL_AUDIT_REQUIRED
    - 5.11: Probe Case: prior day 'sending' (business key mismatch) -> STOP_MANUAL_AUDIT_REQUIRED
    - 5.12: Probe Case: receipt path is a directory (path anomaly) -> STOP_MANUAL_AUDIT_REQUIRED
    - 5.13: Output cleanliness: stdout contains STRICTLY single-line token, no stderr log bleed.
    # 5.14: Key snippet existence and branch structure check: verifies Runbook markdown case structure aligns with tested caller script.
    """
    print("[Rehearsal 5] Testing digest receipt 4-way taxonomy and caller dispatch branch...")
    sandbox = base_dir / "s5"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()

    systemctl_call_log = sandbox / "systemctl_calls.log"
    systemctl_mock = bin_dir / "systemctl"
    systemctl_mock.write_text(f"""#!/bin/bash
echo "$@" >> "{systemctl_call_log}"
exit 0
""")
    systemctl_mock.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    today = "2026-09-08"
    receipt_file = sandbox / "delivery.json"

    def run_runbook_caller(rcpt_path, exp_date):
        """Simulates the exact case-statement caller in the runbook."""
        caller_script = f"""
        set -e
        ACTION=$(bash "{RELEASE_OPS_SCRIPT}" verify_digest_receipt "{rcpt_path}" "{exp_date}")
        case "$ACTION" in
            "TRIGGER_AUTHORIZED")
                systemctl start personal-treasury-feishu-digest.service
                ;;
            "SKIP_ALREADY_DELIVERED")
                exit 0
                ;;
            "WAIT_OR_CHECK_RUNNING")
                echo "BRANCH_WAIT" >&2
                exit 1
                ;;
            "STOP_MANUAL_AUDIT_REQUIRED")
                echo "BRANCH_STOP_AUDIT" >&2
                exit 1
                ;;
            *)
                echo "BRANCH_UNEXPECTED: $ACTION" >&2
                exit 1
                ;;
        esac
        """
        return subprocess.run(
            ["bash", "-c", caller_script],
            env=env,
            capture_output=True,
            text=True
        )

    # Test 5.1: Missing receipt -> TRIGGER_AUTHORIZED -> systemctl start called exactly once
    systemctl_call_log.unlink(missing_ok=True)
    res1 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res1.returncode == 0
    assert res1.stdout.strip() == "TRIGGER_AUTHORIZED", f"Expected single line TRIGGER_AUTHORIZED, got: {res1.stdout!r}"
    caller1 = run_runbook_caller(str(receipt_file), today)
    assert caller1.returncode == 0
    assert systemctl_call_log.exists()
    calls1 = systemctl_call_log.read_text().splitlines()
    assert len(calls1) == 1
    assert calls1[0].strip() == "start personal-treasury-feishu-digest.service"

    # Test 5.2: Valid current-day delivered -> SKIP_ALREADY_DELIVERED -> zero systemctl calls
    systemctl_call_log.unlink(missing_ok=True)
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "feishu", "status": "delivered", "attempts": 1}')
    res2 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res2.returncode == 0
    assert res2.stdout.strip() == "SKIP_ALREADY_DELIVERED"
    caller2 = run_runbook_caller(str(receipt_file), today)
    assert caller2.returncode == 0
    assert not systemctl_call_log.exists(), "systemctl was unexpectedly called on SKIP_ALREADY_DELIVERED!"

    # Test 5.3: Status 'sending' -> WAIT_OR_CHECK_RUNNING -> caller exits 1, no systemctl call
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "feishu", "status": "sending", "attempts": 1}')
    res3 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res3.returncode == 0
    assert res3.stdout.strip() == "WAIT_OR_CHECK_RUNNING"
    caller3 = run_runbook_caller(str(receipt_file), today)
    assert caller3.returncode == 1
    assert "BRANCH_WAIT" in caller3.stderr
    assert not systemctl_call_log.exists()

    # Test 5.4: Status 'uncertain' -> STOP_MANUAL_AUDIT_REQUIRED -> caller exits 1
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "feishu", "status": "uncertain", "attempts": 1}')
    res4 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res4.returncode == 0
    assert res4.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED"
    caller4 = run_runbook_caller(str(receipt_file), today)
    assert caller4.returncode == 1
    assert "BRANCH_STOP_AUDIT" in caller4.stderr

    # Test 5.5: Status 'failed' -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "feishu", "status": "failed", "attempts": 1}')
    res5 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res5.returncode == 0
    assert res5.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED"
    caller5 = run_runbook_caller(str(receipt_file), today)
    assert caller5.returncode == 1

    # Test 5.6: Date mismatch -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-07", "channel": "feishu", "status": "delivered", "attempts": 1}')
    res6 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res6.returncode == 0
    assert res6.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED"
    caller6 = run_runbook_caller(str(receipt_file), today)
    assert caller6.returncode == 1

    # Test 5.7: Corrupted JSON -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('NOT_A_VALID_JSON{')
    res7 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res7.returncode == 0
    assert res7.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED"
    caller7 = run_runbook_caller(str(receipt_file), today)
    assert caller7.returncode == 1

    # Test 5.8: Probe Case - delivered but missing required channel/attempts -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-08", "status": "delivered"}')
    res8 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res8.returncode == 0
    assert res8.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED", f"Expected STOP_MANUAL_AUDIT_REQUIRED on missing fields, got: {res8.stdout}"
    caller8 = run_runbook_caller(str(receipt_file), today)
    assert caller8.returncode == 1

    # Test 5.9: Probe Case - delivered but channel='other' -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "other", "status": "delivered", "attempts": 1}')
    res9 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res9.returncode == 0
    assert res9.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED", f"Expected STOP_MANUAL_AUDIT_REQUIRED on channel mismatch, got: {res9.stdout}"
    caller9 = run_runbook_caller(str(receipt_file), today)
    assert caller9.returncode == 1

    # Test 5.10: Probe Case - delivered but attempts=true (boolean) -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-08", "channel": "feishu", "status": "delivered", "attempts": true}')
    res10 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res10.returncode == 0
    assert res10.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED", f"Expected STOP_MANUAL_AUDIT_REQUIRED on boolean attempts, got: {res10.stdout}"
    caller10 = run_runbook_caller(str(receipt_file), today)
    assert caller10.returncode == 1

    # Test 5.11: Probe Case - prior day 'sending' (business key mismatch) -> STOP_MANUAL_AUDIT_REQUIRED
    receipt_file.write_text('{"business_date": "2026-09-07", "channel": "feishu", "status": "sending", "attempts": 1}')
    res11 = run_ops(["verify_digest_receipt", str(receipt_file), today], env)
    assert res11.returncode == 0
    assert res11.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED", f"Expected STOP_MANUAL_AUDIT_REQUIRED on prior day sending, got: {res11.stdout}"
    caller11 = run_runbook_caller(str(receipt_file), today)
    assert caller11.returncode == 1

    # Test 5.12: Probe Case - receipt path is a directory -> STOP_MANUAL_AUDIT_REQUIRED
    dir_receipt = sandbox / "dir_receipt"
    dir_receipt.mkdir(exist_ok=True)
    res12 = run_ops(["verify_digest_receipt", str(dir_receipt), today], env)
    assert res12.returncode == 0
    assert res12.stdout.strip() == "STOP_MANUAL_AUDIT_REQUIRED", f"Expected STOP_MANUAL_AUDIT_REQUIRED on directory receipt, got: {res12.stdout}"
    caller12 = run_runbook_caller(str(dir_receipt), today)
    assert caller12.returncode == 1

    # Test 5.13: Output cleanliness: stdout contains exactly 1 line, no log bleed
    lines = res2.stdout.splitlines()
    assert len(lines) == 1, f"stdout polluted with multiple lines: {lines}"
    assert "[release_ops]" not in res2.stdout, "Diagnostic log leaked into stdout!"

    # Test 5.14: Key snippet existence and branch structure check in Runbook markdown
    runbook_md = (REPO_ROOT / "docs/reports/2026-09-07-reliability-release-and-execution-runbook.md").read_text(encoding="utf-8")
    assert 'case "$ACTION" in' in runbook_md
    assert '"TRIGGER_AUTHORIZED")' in runbook_md
    assert '"SKIP_ALREADY_DELIVERED")' in runbook_md
    assert '"WAIT_OR_CHECK_RUNNING")' in runbook_md
    assert '"STOP_MANUAL_AUDIT_REQUIRED")' in runbook_md
    assert 'systemctl start personal-treasury-feishu-digest.service' in runbook_md

    print("  -> PASS: Receipt verification correctly executes 4-way taxonomy, contract validation, and verified caller dispatch.")


def test_scenario_6_global_rollback_ordering_and_consistency(base_dir):
    """
    Scenario 6:
    Global rollback end-to-end happy path & ordering:
    - 6.1: Pre-flight check fails closed if any required backup material is missing.
    - 6.2: Tag drift resilience: Even if rollback tag was modified, rollback uses locked ID.
    - 6.3: Strict sequence: Stop -> Git checkout -> daemon-reload -> Start/Restart (hermes-gateway).
    - 6.4: Full final state verification: Git HEAD, container running images, Hermes config, Systemd units.
    - 6.5: Stateful systemctl restoration: Units restored in both directions (enable/disable, start/stop).
    - 6.6: Static/failed baseline: new service running -> full rollback -> inactive final state passes
           (batch-0 field truth: watchdog.service/feishu-digest.service = static/failed; failed baseline
           allows inactive OR failed final state, rejects active; preserves historical failed record).
    """
    print("[Rehearsal 6] Testing full release global rollback ordering, material checks, and service naming...")
    sandbox = base_dir / "s6"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()
    manifest_dir = sandbox / "manifest"
    manifest_dir.mkdir()
    (manifest_dir / "units").mkdir()
    systemd_dir = sandbox / "systemd"
    systemd_dir.mkdir()
    hermes_dir = sandbox / "hermes_bak"
    hermes_dir.mkdir()
    hermes_config = sandbox / "hermes_config.yaml"
    hermes_config.write_text("hermes: candidate\n")
    repo_dir = sandbox / "repo"
    repo_dir.mkdir()

    call_seq_file = sandbox / "call_sequence.log"
    systemctl_state_dir = sandbox / "systemctl_state"
    systemctl_state_dir.mkdir()

    bridge_running_img = sandbox / "bridge_running_img.txt"
    bridge_running_img.write_text("sha256:PREV_BRIDGE\n")
    web_running_img = sandbox / "web_running_img.txt"
    web_running_img.write_text("sha256:PREV_WEB\n")

    docker_mock = bin_dir / "docker"
    docker_mock.write_text(f"""#!/bin/bash
echo "docker $@" >> "{call_seq_file}"
if [ "$1" = "inspect" ]; then
    target="$3"
    [ -n "$target" ] || target="$2"
    if [ "$target" = "personal-treasury-bridge" ]; then
        cat "{bridge_running_img}"
    elif [ "$target" = "personal-treasury-report-web" ]; then
        cat "{web_running_img}"
    else
        echo "sha256:MOCK_IMG"
    fi
    exit 0
elif [ "$1" = "tag" ]; then
    src="$2"
    tgt="$3"
    if [ "$tgt" = "personal-treasury-bridge:latest" ]; then
        echo "$src" > "{bridge_running_img}"
    elif [ "$tgt" = "personal-treasury-report-web:latest" ]; then
        echo "$src" > "{web_running_img}"
    fi
    exit 0
elif [ "$1" = "compose" ]; then
    exit 0
fi
exit 0
""")
    docker_mock.chmod(0o755)

    git_mock = bin_dir / "git"
    git_mock.write_text(f"""#!/bin/bash
echo "git $@" >> "{call_seq_file}"
if [ "$1" = "rev-parse" ]; then
    echo "c0ffee0000000000000000000000000000000000"
    exit 0
fi
exit 0
""")
    git_mock.chmod(0o755)

    # Stateful systemctl mock that tracks enabled/disabled and active/inactive state
    systemctl_mock = bin_dir / "systemctl"
    systemctl_mock.write_text(f"""#!/bin/bash
state_dir="{systemctl_state_dir}"
mkdir -p "$state_dir"
echo "systemctl $@" >> "{call_seq_file}"
cmd="$1"
shift
case "$cmd" in
    enable)
        for u in "$@"; do
            echo "enabled" > "$state_dir/${{u}}.enabled"
        done
        exit 0
        ;;
    disable)
        now=0
        for arg in "$@"; do
            if [ "$arg" = "--now" ]; then
                now=1
            else
                echo "disabled" > "$state_dir/${{arg}}.enabled"
                if [ "$now" = "1" ]; then
                    echo "inactive" > "$state_dir/${{arg}}.active"
                fi
            fi
        done
        exit 0
        ;;
    start)
        for u in "$@"; do
            echo "active" > "$state_dir/${{u}}.active"
        done
        exit 0
        ;;
    stop)
        for u in "$@"; do
            echo "inactive" > "$state_dir/${{u}}.active"
        done
        exit 0
        ;;
    is-enabled)
        u="$1"
        st=$(cat "$state_dir/${{u}}.enabled" 2>/dev/null || echo "disabled")
        if [ "$st" = "enabled" ]; then
            echo "enabled"
            exit 0
        else
            echo "disabled"
            exit 1
        fi
        ;;
    is-active)
        u="$1"
        st=$(cat "$state_dir/${{u}}.active" 2>/dev/null || echo "inactive")
        if [ "$st" = "active" ]; then
            echo "active"
            exit 0
        else
            echo "inactive"
            exit 3
        fi
        ;;
    restart|daemon-reload)
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
""")
    systemctl_mock.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["REPO_DIR"] = str(repo_dir)
    env["HERMES_CONFIG"] = str(hermes_config)
    env["HERMES_BACKUP_DIR"] = str(hermes_dir)
    env["SYSTEMD_DIR"] = str(systemd_dir)
    env["DOCKER_BIN"] = str(docker_mock)
    env["GIT_BIN"] = str(git_mock)
    env["SYSTEMCTL_BIN"] = str(systemctl_mock)

    # 6.1 Test pre-flight failure: missing prev_head.commit
    res_fail1 = run_ops(["rollback_global"], env)
    assert res_fail1.returncode != 0, "Expected failure when prev_head.commit missing"
    assert "Git HEAD backup missing" in res_fail1.stderr

    # Provide prev_head.commit
    (manifest_dir / "prev_head.commit").write_text("c0ffee0000000000000000000000000000000000\n")

    # Missing bridge_image.id
    res_fail2 = run_ops(["rollback_global"], env)
    assert res_fail2.returncode != 0
    assert "Bridge rollback image ID missing" in res_fail2.stderr

    # Provide bridge_image.id
    (manifest_dir / "bridge_image.id").write_text("sha256:PREV_BRIDGE\n")
    (manifest_dir / "web_image.id").write_text("sha256:PREV_WEB\n")

    # Missing hermes backup
    res_fail3 = run_ops(["rollback_global"], env)
    assert res_fail3.returncode != 0
    assert "Hermes backup config missing" in res_fail3.stderr

    # Provide hermes backup
    (hermes_dir / "config.yaml.bak").write_text("hermes: original_good\n")

    # Setup unit meta: feishu-digest.service was pre-existing (exists=true), recorded as disabled/inactive
    # This precisely validates restoring into disabled / inactive baseline state!
    (manifest_dir / "units" / "personal-treasury-feishu-digest.service.meta").write_text("exists=true\nenabled=disabled\nactive=inactive\n")
    res_fail4 = run_ops(["rollback_global"], env)
    assert res_fail4.returncode != 0
    assert ".orig file missing or empty" in res_fail4.stderr

    # Now provide .orig file
    (manifest_dir / "units" / "personal-treasury-feishu-digest.service.orig").write_text("[Unit]\nDescription=RestoredService\n")

    # Setup patrol.timer as newly added (exists=false)
    (manifest_dir / "units" / "personal-treasury-patrol.timer.meta").write_text("exists=false\nenabled=not_present\nactive=not_present\n")
    (systemd_dir / "personal-treasury-patrol.timer").write_text("[Timer]\nDescription=ToBeDeleted\n")

    # Pre-seed simulated site runtime state:
    # Set feishu-digest.service currently ENABLED and ACTIVE in mock systemctl
    # Global rollback must actively call disable and stop to restore it to disabled/inactive!
    (systemctl_state_dir / "personal-treasury-feishu-digest.service.enabled").write_text("enabled")
    (systemctl_state_dir / "personal-treasury-feishu-digest.service.active").write_text("active")

    # Clear log before happy path run
    call_seq_file.unlink(missing_ok=True)

    # 6.2 Happy path global rollback execution
    res_success = run_ops(["rollback_global"], env)
    assert res_success.returncode == 0, f"rollback_global failed: {res_success.stderr}"

    # Verify Hermes config was restored from config.yaml.bak
    assert hermes_config.read_text().strip() == "hermes: original_good"

    # Verify unit restoration: service restored, new timer deleted
    assert (systemd_dir / "personal-treasury-feishu-digest.service").read_text().strip() == "[Unit]\nDescription=RestoredService"
    assert not (systemd_dir / "personal-treasury-patrol.timer").exists()

    # Verify unit runtime states were restored to baseline (disabled / inactive)
    assert (systemctl_state_dir / "personal-treasury-feishu-digest.service.enabled").read_text().strip() == "disabled"
    assert (systemctl_state_dir / "personal-treasury-feishu-digest.service.active").read_text().strip() == "inactive"

    # Verify execution sequence from call_seq_file
    calls = call_seq_file.read_text().splitlines()

    stop_idx = -1
    reload_idx = -1
    disable_svc_idx = -1
    hermes_restart_idx = -1
    git_checkout_idx = -1

    for i, call in enumerate(calls):
        if "systemctl disable --now personal-treasury-patrol.timer" in call:
            if stop_idx == -1:
                stop_idx = i
        elif "systemctl daemon-reload" in call:
            reload_idx = i
        elif "systemctl disable personal-treasury-feishu-digest.service" in call:
            disable_svc_idx = i
        elif "systemctl restart hermes-gateway" in call:
            hermes_restart_idx = i
        elif "git checkout c0ffee0000000000000000000000000000000000" in call:
            git_checkout_idx = i

    assert stop_idx != -1, "Stop service call missing"
    assert git_checkout_idx != -1, "Git checkout call missing"
    assert reload_idx != -1, "daemon-reload call missing"
    assert disable_svc_idx != -1, "Disable service call missing"
    assert hermes_restart_idx != -1, "Restart hermes-gateway call missing"

    # Sequence validation: Stop -> Git checkout -> daemon-reload -> Disable/Start
    assert stop_idx < git_checkout_idx < reload_idx < disable_svc_idx, (
        f"Incorrect sequence: stop={stop_idx}, git={git_checkout_idx}, "
        f"reload={reload_idx}, disable_svc={disable_svc_idx}"
    )
    assert reload_idx < hermes_restart_idx, "hermes-gateway restarted before daemon-reload"

    print("  -> PASS: Global rollback executed in strict verified sequence with full material validation.")

    # 6.3 Static/failed baseline: new service running -> full rollback -> inactive final state passes
    # Mirrors batch-0 field truth: watchdog.service/feishu-digest.service = static/failed (pre-existing, failed)
    # Newly-added *.timer = enabled/active (running).
    # Uses stateful systemctl mock that actually transitions state on start/stop/enable/disable.
    # Uses real file comparison (cmp) instead of no-op stub.
    print("  [Rehearsal 6.3] Testing static/failed baseline: running -> rollback -> inactive passes...")
    s63 = base_dir / "s63"
    s63.mkdir()
    bin_dir = s63 / "bin"; bin_dir.mkdir()
    manifest_dir = s63 / "manifest"; manifest_dir.mkdir()
    systemd_dir = s63 / "systemd"; systemd_dir.mkdir()
    units_dir = manifest_dir / "units"; units_dir.mkdir()
    repo_dir = s63 / "repo"; repo_dir.mkdir()
    hermes_dir = s63 / "hermes"; hermes_dir.mkdir()
    hermes_bak_dir = s63 / "hermes_bak"; hermes_bak_dir.mkdir()
    state_dir = s63 / "state"; state_dir.mkdir()

    # Stateful systemctl mock: reads/writes persistent state files per unit
    systemctl_mock = bin_dir / "systemctl"
    systemctl_mock.write_text(f"""#!/bin/bash
state_dir="{state_dir}"
case "$1" in
  is-enabled)
    u="$2"
    if [ -f "$state_dir/$u.enabled" ]; then
      cat "$state_dir/$u.enabled"
    else
      case "$u" in
        *.service) echo "static"; exit 0 ;;
        *.timer)  echo "enabled"; exit 0 ;;
      esac
    fi
    exit 0
    ;;
  is-active)
    u="$2"
    if [ -f "$state_dir/$u.active" ]; then
      st=$(cat "$state_dir/$u.active")
      echo "$st"
      [ "$st" = "active" ] && exit 0
      [ "$st" = "inactive" ] && exit 3
      [ "$st" = "failed" ] && exit 3
      exit 0
    else
      case "$u" in
        *.service) echo "failed"; exit 3 ;;
        *.timer)  echo "active"; exit 0 ;;
      esac
    fi
    ;;
  start)
    for u in "$@"; do
      [ "$u" = "start" ] && continue
      echo "active" > "$state_dir/$u.active"
    done
    exit 0
    ;;
  stop)
    for u in "$@"; do
      [ "$u" = "stop" ] && continue
      echo "inactive" > "$state_dir/$u.active"
    done
    exit 0
    ;;
  enable)
    for u in "$@"; do
      [ "$u" = "enable" ] && continue
      echo "enabled" > "$state_dir/$u.enabled"
    done
    exit 0
    ;;
  disable)
    now=0
    for arg in "$@"; do
      if [ "$arg" = "--now" ]; then
        now=1
      elif [ "$arg" != "disable" ]; then
        echo "disabled" > "$state_dir/$arg.enabled"
        if [ "$now" = "1" ]; then
          echo "inactive" > "$state_dir/$arg.active"
        fi
      fi
    done
    exit 0
    ;;
  daemon-reload|restart) exit 0 ;;
esac
exit 0
""")
    systemctl_mock.chmod(0o755)

    # Mock docker: inspect returns locked bridge/web image IDs; tag/compose succeed
    (bin_dir / "docker").write_text("""#!/bin/bash
if [ "$1" = "inspect" ]; then
  echo "sha256:BRIDGEORIG"
  exit 0
fi
if [ "$1" = "tag" ] || [ "$1" = "compose" ]; then exit 0; fi
exit 0
""")
    (bin_dir / "docker").chmod(0o755)

    # Use real cmp instead of no-op mock
    real_cmp = __import__("shutil").which("cmp")
    (bin_dir / "cmp").write_text(f"#!/bin/bash\nexec {real_cmp} \"$@\"\n")
    (bin_dir / "cmp").chmod(0o755)

    # Real git forwarding for checkout/rev-parse
    real_git = __import__("shutil").which("git")
    (bin_dir / "git").write_text(f"#!/bin/bash\nexec {real_git} \"$@\"\n")
    (bin_dir / "git").chmod(0o755)

    # Real git repo at repo_dir
    import subprocess as _sp
    _sp.run(["git", "init", "-q", "-b", "master"], cwd=repo_dir)
    _sp.run(["git", "config", "user.email", "test@local"], cwd=repo_dir)
    _sp.run(["git", "config", "user.name", "test"], cwd=repo_dir)
    (repo_dir / "README.md").write_text("init")
    _sp.run(["git", "add", "."], cwd=repo_dir)
    _sp.run(["git", "commit", "-q", "-m", "init"], cwd=repo_dir)
    target_head = _sp.run(["git", "rev-parse", "HEAD"], cwd=repo_dir, capture_output=True, text=True).stdout.strip()

    # Pre-existing units in systemd and their original content
    for u in ["personal-treasury-watchdog.service", "personal-treasury-watchdog.timer",
              "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer"]:
        (systemd_dir / u).write_text(f"# pre-existing {u}\n")

    # Newly added patrol.timer is NOT present initially (it will be added during deployment)
    # (systemd_dir / "personal-treasury-patrol.timer") does not exist at backup time

    # Hermes original and candidate
    (hermes_bak_dir / "config.yaml.bak").write_text("# hermes original config\n")
    (hermes_dir / "config.yaml").write_text("# hermes modified candidate\n")

    env_s63 = os.environ.copy()
    env_s63["PATH"] = str(bin_dir) + ":" + env_s63.get("PATH", "")
    env_s63["MANIFEST_DIR"] = str(manifest_dir)
    env_s63["SYSTEMD_DIR"] = str(systemd_dir)
    env_s63["REPO_DIR"] = str(repo_dir)
    env_s63["HERMES_CONFIG"] = str(hermes_dir / "config.yaml")
    env_s63["HERMES_BACKUP_DIR"] = str(hermes_bak_dir)

    # --- Test 6.3a: Initial backup creation (first-run backup) ---
    r_bak1 = run_ops(["backup_units",
                      "personal-treasury-watchdog.service", "personal-treasury-watchdog.timer",
                      "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer",
                      "personal-treasury-patrol.timer"], env_s63)
    assert r_bak1.returncode == 0, f"initial backup_units failed: {r_bak1.stderr}"
    assert "Backed up pre-existing unit personal-treasury-watchdog.service (enabled: static, active: failed)" in r_bak1.stderr
    assert (units_dir / "personal-treasury-watchdog.service.orig").read_text() == "# pre-existing personal-treasury-watchdog.service\n"
    assert "enabled=static" in (units_dir / "personal-treasury-watchdog.service.meta").read_text()
    assert "active=failed" in (units_dir / "personal-treasury-watchdog.service.meta").read_text()
    assert "exists=false" in (units_dir / "personal-treasury-patrol.timer.meta").read_text()

    # --- Test 6.3b: Subsequent backup verification (re-run verification, non-overwriting) ---
    r_bak2 = run_ops(["backup_units",
                      "personal-treasury-watchdog.service", "personal-treasury-watchdog.timer",
                      "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer",
                      "personal-treasury-patrol.timer"], env_s63)
    assert r_bak2.returncode == 0, f"re-check backup_units failed: {r_bak2.stderr}"
    assert "backup verified: exists=true and .orig present" in r_bak2.stderr
    assert "backup verified: exists=false" in r_bak2.stderr

    # --- Simulate deployment: patrol.timer is added, services/timers are RUNNING ---
    (systemd_dir / "personal-treasury-patrol.timer").write_text("# newly added patrol.timer by release\n")
    (state_dir / "personal-treasury-watchdog.service.active").write_text("active")
    (state_dir / "personal-treasury-feishu-digest.service.active").write_text("active")
    (state_dir / "personal-treasury-feishu-digest.timer.active").write_text("active")
    (state_dir / "personal-treasury-patrol.timer.active").write_text("active")

    # Provide rollback prerequisites
    (manifest_dir / "prev_head.commit").write_text(target_head)
    (manifest_dir / "bridge_image.id").write_text("sha256:BRIDGEORIG")

    # --- Test 6.3c: Full rollback from running state -> services stopped to inactive -> passes ---
    r_rb = run_ops(["rollback_global"], env_s63)
    assert r_rb.returncode == 0, f"rollback_global failed: {r_rb.stderr}"
    assert "Full Release Global Rollback Successfully Completed" in r_rb.stderr
    assert "recorded_baseline=failed" in r_rb.stderr

    # Verify stateful transitions actually happened:
    # stop command wrote 'inactive' into state files for the services
    assert (state_dir / "personal-treasury-watchdog.service.active").read_text().strip() == "inactive"
    assert (state_dir / "personal-treasury-feishu-digest.service.active").read_text().strip() == "inactive"
    # Unit files restored to original content (verified by real cmp)
    for u in ["personal-treasury-watchdog.service", "personal-treasury-watchdog.timer",
              "personal-treasury-feishu-digest.service", "personal-treasury-feishu-digest.timer"]:
        assert (systemd_dir / u).exists(), f"restored unit {u} missing"
        assert (systemd_dir / u).read_text() == (units_dir / f"{u}.orig").read_text(), f"{u} differs from .orig"
    # Newly added patrol.timer was removed
    assert not (systemd_dir / "personal-treasury-patrol.timer").exists(), "patrol.timer not removed"
    # Hermes config restored and matches original (real cmp verified)
    assert (hermes_dir / "config.yaml").read_text() == (hermes_bak_dir / "config.yaml.bak").read_text()
    # Git HEAD restored
    head = _sp.run(["git", "rev-parse", "HEAD"], cwd=repo_dir, capture_output=True, text=True).stdout.strip()
    assert head == target_head, f"HEAD {head} != target {target_head}"
    print("  -> PASS: running -> rollback -> inactive final state accepted & verified.")

    # --- Test 6.3d: Negative probe: stop failed / unit stays active -> rollback MUST FAIL ---
    print("  [Rehearsal 6.3d] Testing negative probe: unit stays active after stop -> fails closed...")
    # Inject a stubborn mock that keeps watchdog.service 'active' despite stop
    stubborn_systemctl = bin_dir / "systemctl"
    stubborn_systemctl.write_text(f"""#!/bin/bash
state_dir="{state_dir}"
case "$1" in
  is-enabled)
    echo "static"; exit 0
    ;;
  is-active)
    u="$2"
    if [ "$u" = "personal-treasury-watchdog.service" ]; then
      echo "active"  # STUBBORN: refuses to report inactive
      exit 0
    fi
    echo "inactive"; exit 3
    ;;
  *) exit 0 ;;
esac
""")
    stubborn_systemctl.chmod(0o755)

    r_stubborn = run_ops(["rollback_global"], env_s63)
    assert r_stubborn.returncode != 0, "Expected failure when unit stays active despite failed baseline, got 0!"
    assert "must be inactive/failed" in r_stubborn.stderr or "FATAL" in r_stubborn.stderr
    assert "Full Release Global Rollback Successfully Completed" not in r_stubborn.stderr
    print("  -> PASS: negative probe correctly failed closed when unit remained active.")


def test_scenario_7_global_rollback_critical_failures_fail_closed(base_dir):
    """
    Scenario 7 (Probe Failure Replication):
    Validates that when critical operations fail (exit code 9), rollback_global
    MUST FAIL CLOSED with non-zero exit code, and MUST NOT report false success:
    - 7.1: docker compose up failure -> aborts (exit != 0)
    - 7.2: systemctl stop failure -> aborts (exit != 0)
    - 7.3: systemctl restart hermes-gateway failure -> aborts (exit != 0)
    - 7.4: Final running container check failure -> aborts (exit != 0)
    - 7.5: Probe Case: Unit runtime state divergence (enabled state mismatch) -> aborts (exit != 0)
    - 7.6: Probe Case: is-enabled query failure (exit 9) -> aborts (exit != 0)
    - 7.7: Probe Case: is-active query failure (exit 9) -> aborts (exit != 0)
    - 7.8: Probe Case: Empty unit status output -> aborts (exit != 0)
    - 7.9: Probe Case: Unknown unit status output (e.g. masked) -> aborts (exit != 0)
    """
    print("[Rehearsal 7] Testing global rollback critical operation failures fail closed (probe replication)...")
    sandbox = base_dir / "s7"
    sandbox.mkdir()
    bin_dir = sandbox / "bin"
    bin_dir.mkdir()
    manifest_dir = sandbox / "manifest"
    manifest_dir.mkdir()
    (manifest_dir / "units").mkdir()
    systemd_dir = sandbox / "systemd"
    systemd_dir.mkdir()
    hermes_dir = sandbox / "hermes_bak"
    hermes_dir.mkdir()
    hermes_config = sandbox / "hermes_config.yaml"
    hermes_config.write_text("hermes: candidate\n")
    repo_dir = sandbox / "repo"
    repo_dir.mkdir()

    # Setup complete valid backup materials
    (manifest_dir / "prev_head.commit").write_text("c0ffee0000000000000000000000000000000000\n")
    (manifest_dir / "bridge_image.id").write_text("sha256:PREV_BRIDGE\n")
    (hermes_dir / "config.yaml.bak").write_text("hermes: original_good\n")
    (manifest_dir / "units" / "personal-treasury-feishu-digest.service.meta").write_text("exists=true\nenabled=disabled\nactive=inactive\n")
    (manifest_dir / "units" / "personal-treasury-feishu-digest.service.orig").write_text("[Unit]\nDescription=RestoredService\n")
    (systemd_dir / "personal-treasury-feishu-digest.service").write_text("[Unit]\nDescription=Current\n")

    git_mock = bin_dir / "git"
    git_mock.write_text("""#!/bin/bash
if [ "$1" = "rev-parse" ]; then
    echo "c0ffee0000000000000000000000000000000000"
fi
exit 0
""")
    git_mock.chmod(0o755)

    # 7.1 Docker compose up returns 9
    docker_mock = bin_dir / "docker"
    docker_mock.write_text("""#!/bin/bash
if [ "$1" = "compose" ]; then
    exit 9
fi
exit 0
""")
    docker_mock.chmod(0o755)

    systemctl_mock = bin_dir / "systemctl"
    systemctl_mock.write_text("""#!/bin/bash
exit 0
""")
    systemctl_mock.chmod(0o755)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env['PATH']}"
    env["MANIFEST_DIR"] = str(manifest_dir)
    env["REPO_DIR"] = str(repo_dir)
    env["HERMES_CONFIG"] = str(hermes_config)
    env["HERMES_BACKUP_DIR"] = str(hermes_dir)
    env["SYSTEMD_DIR"] = str(systemd_dir)
    env["DOCKER_BIN"] = str(docker_mock)
    env["GIT_BIN"] = str(git_mock)
    env["SYSTEMCTL_BIN"] = str(systemctl_mock)

    res_fail_docker = run_ops(["rollback_global"], env)
    assert res_fail_docker.returncode != 0, "Expected failure when docker compose returns 9, got 0!"
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_docker.stderr, "Falsely reported success on docker failure!"

    # 7.2 Systemctl stop returns 9
    docker_mock.write_text("""#!/bin/bash
exit 0
""")
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "stop" ]; then
    exit 9
fi
exit 0
""")
    res_fail_stop = run_ops(["rollback_global"], env)
    assert res_fail_stop.returncode != 0, "Expected failure when systemctl stop returns 9, got 0!"
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_stop.stderr

    # 7.3 Systemctl restart hermes-gateway returns 9
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "restart" ] && [ "$2" = "hermes-gateway" ]; then
    exit 9
fi
exit 0
""")
    res_fail_hermes = run_ops(["rollback_global"], env)
    assert res_fail_hermes.returncode != 0, "Expected failure when hermes-gateway restart returns 9, got 0!"
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_hermes.stderr

    # 7.4 Final running container check fails
    systemctl_mock.write_text("""#!/bin/bash
exit 0
""")
    docker_mock.write_text("""#!/bin/bash
if [ "$1" = "inspect" ]; then
    echo "sha256:WRONG_UNEXPECTED_IMG"
    exit 0
fi
exit 0
""")
    res_fail_verify = run_ops(["rollback_global"], env)
    assert res_fail_verify.returncode != 0, "Expected failure when final container check fails, got 0!"
    assert "does not match locked rollback ID" in res_fail_verify.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_verify.stderr

    # 7.5 Probe Case: Unit runtime state divergence fails closed
    # Reset docker to pass inspect
    docker_mock.write_text("""#!/bin/bash
if [ "$1" = "inspect" ]; then
    echo "sha256:PREV_BRIDGE"
fi
exit 0
""")
    # systemctl simulates unit being active/enabled when .meta says disabled/inactive
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "is-enabled" ]; then
    echo "enabled"
    exit 0
fi
if [ "$1" = "is-active" ]; then
    echo "inactive"
    exit 3
fi
exit 0
""")
    res_fail_unit_state = run_ops(["rollback_global"], env)
    assert res_fail_unit_state.returncode != 0, "Expected failure when unit runtime state diverges, got 0!"
    assert "enabled state (enabled) does not match recorded baseline (disabled)" in res_fail_unit_state.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_unit_state.stderr

    # 7.6 Probe Case: is-enabled query failure (exit 9) must fail closed
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "is-enabled" ]; then
    echo "Injected query failure" >&2
    exit 9
fi
if [ "$1" = "is-active" ]; then
    echo "inactive"
    exit 3
fi
exit 0
""")
    res_fail_query_en = run_ops(["rollback_global"], env)
    assert res_fail_query_en.returncode != 0, "Expected failure on is-enabled query failure, got 0!"
    assert "Failed to query runtime enabled state" in res_fail_query_en.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_query_en.stderr

    # 7.7 Probe Case: is-active query failure (exit 9) must fail closed
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "is-enabled" ]; then
    echo "disabled"
    exit 1
fi
if [ "$1" = "is-active" ]; then
    echo "Injected query failure" >&2
    exit 9
fi
exit 0
""")
    res_fail_query_ac = run_ops(["rollback_global"], env)
    assert res_fail_query_ac.returncode != 0, "Expected failure on is-active query failure, got 0!"
    assert "Failed to query runtime active state" in res_fail_query_ac.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_query_ac.stderr

    # 7.8 Probe Case: Empty unit status output must fail closed
    systemctl_mock.write_text("""#!/bin/bash
exit 0
""")
    res_fail_empty = run_ops(["rollback_global"], env)
    assert res_fail_empty.returncode != 0, "Expected failure on empty unit status output, got 0!"
    assert "Failed to query runtime enabled state" in res_fail_empty.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_empty.stderr

    # 7.9 Probe Case: Unsupported/unknown status (e.g. masked) must fail closed
    systemctl_mock.write_text("""#!/bin/bash
if [ "$1" = "is-enabled" ]; then
    echo "masked"
    exit 0
fi
if [ "$1" = "is-active" ]; then
    echo "inactive"
    exit 3
fi
exit 0
""")
    res_fail_unknown = run_ops(["rollback_global"], env)
    assert res_fail_unknown.returncode != 0, "Expected failure on unknown unit status (masked), got 0!"
    assert "Failed to query runtime enabled state" in res_fail_unknown.stderr
    assert "Full Release Global Rollback Successfully Completed" not in res_fail_unknown.stderr

    print("  -> PASS: All critical failure probes fail closed immediately without false success.")


def main():
    print("=================================================================")
    print("Starting Offline Runbook Scenarios Rehearsal Suite (release_ops)")
    print("=================================================================")

    with tempfile.TemporaryDirectory() as temp_dir_str:
        base_dir = Path(temp_dir_str)
        try:
            test_scenario_1_interrupted_backup_and_subsequent_verification(base_dir)
            test_scenario_2_frontend_component_rollback_isolation(base_dir)
            test_scenario_3_unit_backup_restore_and_fail_closed(base_dir)
            test_scenario_4_backup_failure_fails_closed(base_dir)
            test_scenario_5_digest_receipt_verification_and_caller_dispatch(base_dir)
            test_scenario_6_global_rollback_ordering_and_consistency(base_dir)
            test_scenario_7_global_rollback_critical_failures_fail_closed(base_dir)
        except AssertionError as e:
            print(f"\n[REHEARSAL FAILURE] Assertion failed: {e}", file=sys.stderr)
            sys.exit(1)
        except Exception as e:
            print(f"\n[REHEARSAL ERROR] Unexpected error: {e}", file=sys.stderr)
            sys.exit(1)

    print("=================================================================")
    print("ALL 7 REHEARSAL SCENARIOS PASSED SUCCESSFULLY!")
    print("=================================================================")


if __name__ == "__main__":
    main()
