#!/usr/bin/env bash
# ==============================================================================
# scripts/ops/release_ops.sh
#
# 个人财务系统 0906 可靠性发布运维管理与回滚原子操作脚本
#
# 本脚本为生产发布执行单（docs/reports/2026-09-07-reliability-release-and-execution-runbook.md）
# 的唯一可执行实现，供生产部署与离线演练套件（scripts/ops/rehearse_runbook_scenarios.py）
# 共同调用，确保文档、演练与生产执行严格保持一致。
#
# 遵循的核心原则：
# 1. 首次创建、后续核验、中断自愈、严禁覆盖（Create once, verify subsequently, heal interruptions, never overwrite）；
# 2. 异常严格中断（Fail-closed under set -euo pipefail，彻底消除 || true，关键失败绝不掩盖）；
# 3. 前端单组件回滚与宿主机代码检出严格解耦；
# 4. 回滚直接依据锁定的镜像 ID 恢复，绝不直接信任可变标签（防止标签漂移）；
# 5. 回滚完成执行全量终态核验（Git HEAD、运行容器镜像 ID、配置一致性、Unit 状态）；
# 6. 所有诊断与跟踪日志输出至 stderr（>&2），标准输出严格保留给单行机器可读结果；
# 7. 回执状态机严格实现四路分流（TRIGGER_AUTHORIZED, SKIP_ALREADY_DELIVERED, WAIT_OR_CHECK_RUNNING, STOP_MANUAL_AUDIT_REQUIRED）。
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# 环境变量与路径配置（支持演练环境注入隔离路径与 Mock 二进制）
# ------------------------------------------------------------------------------
MANIFEST_DIR="${MANIFEST_DIR:-/var/backups/personal-treasury/release_3d1564d}"
REPO_DIR="${REPO_DIR:-/opt/personal-treasury}"
HERMES_CONFIG="${HERMES_CONFIG:-/root/.hermes/config.yaml}"
HERMES_BACKUP_DIR="${HERMES_BACKUP_DIR:-/root/.hermes/backups_release_3d1564d}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
DOCKER_BIN="${DOCKER_BIN:-docker}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/personal-treasury/infra/compose.yaml}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
GIT_BIN="${GIT_BIN:-git}"

# ------------------------------------------------------------------------------
# 子命令：backup_head
# 记录发布前宿主机仓库的实际 Git HEAD（作为全局回滚唯一可恢复版本标识）
# ------------------------------------------------------------------------------
cmd_backup_head() {
    mkdir -p "$MANIFEST_DIR"
    local head_file="$MANIFEST_DIR/prev_head.commit"
    if [ ! -f "$head_file" ]; then
        cd "$REPO_DIR"
        local current_head
        current_head=$("$GIT_BIN" rev-parse HEAD)
        [ -n "$current_head" ] || { echo "ERROR: Cannot determine current git HEAD in $REPO_DIR" >&2; exit 1; }
        echo "$current_head" > "$head_file"
        echo "[release_ops] Recorded initial Git HEAD: $current_head" >&2
    else
        local locked_head
        locked_head=$(cat "$head_file")
        [ -n "$locked_head" ] || { echo "ERROR: Existing head_file $head_file is empty!" >&2; exit 1; }
        echo "[release_ops] Git HEAD already locked: $locked_head (verified)" >&2
    fi
}

# ------------------------------------------------------------------------------
# 子命令：backup_image <component_name> <container_name> <compose_service> <tag_name>
# 记录并打标容器镜像原件，提供断点中断自愈与后续核验
# ------------------------------------------------------------------------------
cmd_backup_image() {
    local component="${1:-}"
    local container_name="${2:-}"
    local compose_service="${3:-}"
    local tag_name="${4:-}"

    [ -n "$component" ] && [ -n "$container_name" ] && [ -n "$tag_name" ] || {
        echo "Usage: $0 backup_image <component> <container_name> <compose_service> <tag_name>" >&2
        exit 1
    }

    mkdir -p "$MANIFEST_DIR"
    local id_file="$MANIFEST_DIR/${component}_image.id"

    if [ ! -f "$id_file" ]; then
        # 首次执行：检测当前运行容器镜像 ID 并写入清单
        local current_img
        current_img=$("$DOCKER_BIN" inspect --format="{{.Image}}" "$container_name" 2>/dev/null || true)
        if [ -z "$current_img" ] && [ -n "$compose_service" ]; then
            current_img=$("$DOCKER_BIN" compose -f "$COMPOSE_FILE" images -q "$compose_service" 2>/dev/null || true)
        fi
        [ -n "$current_img" ] || {
            echo "ERROR: Cannot detect running image for container $container_name" >&2
            exit 1
        }
        echo "$current_img" > "$id_file"
        echo "[release_ops] Recorded initial image for $component: $current_img" >&2

        # 打标回滚标签并强校验
        "$DOCKER_BIN" tag "$current_img" "$tag_name"
        local inspected_tag
        inspected_tag=$("$DOCKER_BIN" inspect --format="{{.Id}}" "$tag_name" 2>/dev/null || true)
        [ -n "$inspected_tag" ] || {
            echo "ERROR: Failed to create or verify rollback tag $tag_name" >&2
            exit 1
        }
        echo "[release_ops] Locked and verified rollback tag: $tag_name -> $current_img" >&2
    else
        # 后续重试/核验：严禁重新采集当前容器镜像，严格核验已锁定的镜像 ID 与标签
        local locked_id
        locked_id=$(cat "$id_file")
        [ -n "$locked_id" ] || { echo "ERROR: Locked image ID file $id_file is empty!" >&2; exit 1; }

        local tag_img
        tag_img=$("$DOCKER_BIN" inspect --format="{{.Id}}" "$tag_name" 2>/dev/null || true)

        if [ -z "$tag_img" ] || [ "$tag_img" != "$locked_id" ]; then
            echo "[release_ops] WARNING: Rollback tag $tag_name is missing or mismatched (tag: $tag_img, locked: $locked_id)." >&2
            echo "[release_ops] Repairing rollback tag strictly from locked image ID: $locked_id" >&2
            # 补建标签必须使用 locked_id，绝不重新 inspect 当前容器
            "$DOCKER_BIN" tag "$locked_id" "$tag_name"
            tag_img=$("$DOCKER_BIN" inspect --format="{{.Id}}" "$tag_name" 2>/dev/null || true)
            [ "$tag_img" = "$locked_id" ] || {
                echo "ERROR: Failed to repair rollback tag $tag_name from locked ID $locked_id" >&2
                exit 1
            }
            echo "[release_ops] Successfully repaired rollback tag $tag_name" >&2
        else
            echo "[release_ops] Image $component already locked and verified: $locked_id ($tag_name present)" >&2
        fi
    fi
}

# ------------------------------------------------------------------------------
# 子命令：backup_hermes
# 备份 Hermes 配置文件（固定备份名为 config.yaml.bak，支持重跑核验）
# ------------------------------------------------------------------------------
cmd_backup_hermes() {
    mkdir -p "$HERMES_BACKUP_DIR"
    local bak_file="$HERMES_BACKUP_DIR/config.yaml.bak"

    if [ ! -f "$bak_file" ]; then
        if [ -f "$HERMES_CONFIG" ]; then
            cp -p "$HERMES_CONFIG" "$bak_file"
            [ -s "$bak_file" ] || { echo "ERROR: Backed up config $bak_file is empty!" >&2; exit 1; }
            echo "[release_ops] Hermes config backed up to: $bak_file" >&2
        else
            echo "ERROR: Hermes config does not exist at $HERMES_CONFIG" >&2
            exit 1
        fi
    else
        [ -s "$bak_file" ] || { echo "ERROR: Existing Hermes backup $bak_file is empty!" >&2; exit 1; }
        echo "[release_ops] Hermes backup already exists and is non-empty: $bak_file (verified)" >&2
    fi
}

# ------------------------------------------------------------------------------
# 辅助函数：query_unit_enabled <unit>
# 严格捕获并核验 is-enabled 状态（明确区分已识别状态与查询异常，彻底消除 || true）
# 规则：仅当输出为 enabled (rc 0) 或 disabled (rc 0/1) 时成功返回并打印状态；
# 空输出或查询异常（如 rc 9）均非零退出；static/masked 为合法已识别状态，如实返回。
# 注：脚本未设显式查询超时，D-Bus 永久挂起会阻塞等待而非在确定时限内报错退出；
# 本函数只对"已结束并返回非零 rc/异常输出"的查询做 Fail-Closed，不承诺自动处理挂起。
# ------------------------------------------------------------------------------
query_unit_enabled() {
    local u="$1"
    local raw_out
    local rc=0
    raw_out=$("$SYSTEMCTL_BIN" is-enabled "$u" 2>&1) || rc=$?
    local out
    out=$(echo "$raw_out" | tr -d '\r' | head -n1 | tr -d '[:space:]')
    if [ "$out" = "enabled" ] && [ "$rc" -eq 0 ]; then
        echo "enabled"
        return 0
    elif [ "$out" = "disabled" ] && [ "$rc" -le 1 ]; then
        echo "disabled"
        return 0
    elif [ "$out" = "static" ] && [ "$rc" -eq 0 ]; then
        # static: 单元无 [Install] 段，不可手动 enable/disable；属正常已识别状态，如实返回
        echo "static"
        return 0
    fi
    # masked/unknown 不在此自动识别：masked 是管理员明确禁用的特殊态，回滚不应静默处理，保持 fail-closed
    echo "ERROR: Failed to query is-enabled for $u: output='$out', rc=$rc, raw='$raw_out'" >&2
    return 1
}

# ------------------------------------------------------------------------------
# 辅助函数：query_unit_active <unit>
# 严格捕获并核验 is-active 状态（明确区分已识别状态与查询异常，彻底消除 || true）
# 规则：识别 active (rc 0) / inactive (rc 0/3) / failed (rc 3) / activating (rc 0)；
# 空输出或查询异常（如 rc 9）均非零退出；failed 为合法已识别状态，如实返回。
# 注：与 query_unit_enabled 相同，脚本未设显式查询超时；永久挂起不在此函数承诺范围内。
# ------------------------------------------------------------------------------
query_unit_active() {
    local u="$1"
    local raw_out
    local rc=0
    raw_out=$("$SYSTEMCTL_BIN" is-active "$u" 2>&1) || rc=$?
    local out
    out=$(echo "$raw_out" | tr -d '\r' | head -n1 | tr -d '[:space:]')
    if [ "$out" = "active" ] && [ "$rc" -eq 0 ]; then
        echo "active"
        return 0
    elif [ "$out" = "inactive" ] && ( [ "$rc" -eq 3 ] || [ "$rc" -eq 0 ] ); then
        echo "inactive"
        return 0
    elif [ "$out" = "failed" ] && [ "$rc" -eq 3 ]; then
        # failed: 服务启动失败（如底层脚本缺失 exit 69）；属合法已识别状态，如实返回
        echo "failed"
        return 0
    fi
    # activating/unknown 不在此自动识别：activating 是瞬态，回滚不应依赖瞬态判断，保持 fail-closed
    echo "ERROR: Failed to query is-active for $u: output='$out', rc=$rc, raw='$raw_out'" >&2
    return 1
}

# ------------------------------------------------------------------------------
# 子命令：backup_units <unit1> <unit2> ...
# 现场客观核验并备份 Systemd 单元（严禁 || true 降级，基线查询失败严格阻断）
# ------------------------------------------------------------------------------
cmd_backup_units() {
    [ $# -ge 1 ] || { echo "Usage: $0 backup_units <unit1> [unit2 ...]" >&2; exit 1; }
    mkdir -p "$MANIFEST_DIR/units"

    for u in "$@"; do
        local meta_file="$MANIFEST_DIR/units/${u}.meta"
        local orig_file="$MANIFEST_DIR/units/${u}.orig"
        local unit_file="$SYSTEMD_DIR/${u}"

        if [ ! -f "$meta_file" ]; then
            if [ -f "$unit_file" ]; then
                cp -p "$unit_file" "$orig_file"
                [ -s "$orig_file" ] || { echo "ERROR: Backup of $unit_file created empty file!" >&2; exit 1; }
                local en ac
                en=$(query_unit_enabled "$u") || {
                    echo "ERROR: Failed to query enabled state for $u during backup, aborting!" >&2
                    exit 1
                }
                ac=$(query_unit_active "$u") || {
                    echo "ERROR: Failed to query active state for $u during backup, aborting!" >&2
                    exit 1
                }
                cat <<EOF > "$meta_file"
exists=true
enabled=$en
active=$ac
EOF
                echo "[release_ops] Backed up pre-existing unit $u (enabled: $en, active: $ac)" >&2
            else
                cat <<EOF > "$meta_file"
exists=false
enabled=not_present
active=not_present
EOF
                echo "[release_ops] Recorded that unit $u does not pre-exist" >&2
            fi
        else
            # 重跑时校验备份材料完整性
            local exists_val
            exists_val=$(grep "^exists=" "$meta_file" | cut -d'=' -f2)
            if [ "$exists_val" = "true" ]; then
                [ -f "$orig_file" ] && [ -s "$orig_file" ] || {
                    echo "ERROR: Unit $u has exists=true in meta, but $orig_file is missing or empty!" >&2
                    exit 1
                }
                echo "[release_ops] Unit $u backup verified: exists=true and .orig present" >&2
            else
                echo "[release_ops] Unit $u backup verified: exists=false" >&2
            fi
        fi
    done
}

# ------------------------------------------------------------------------------
# 子命令：rollback_frontend
# 前端组件级独立回滚（纯容器镜像回滚，直接依据锁定 ID 恢复，严禁 git checkout）
# ------------------------------------------------------------------------------
cmd_rollback_frontend() {
    echo "[release_ops] Executing frontend component-isolated rollback..." >&2
    local id_file="$MANIFEST_DIR/web_image.id"
    [ -f "$id_file" ] || { echo "ERROR: Frontend rollback image ID file $id_file missing!" >&2; exit 1; }
    local locked_id
    locked_id=$(cat "$id_file")
    [ -n "$locked_id" ] || { echo "ERROR: Frontend rollback image ID is empty!" >&2; exit 1; }

    # 直接使用锁定的镜像 ID 恢复，绝不盲目信任可变标签
    echo "[release_ops] Tagging :latest strictly from locked ID: $locked_id" >&2
    "$DOCKER_BIN" tag "$locked_id" "personal-treasury-report-web:latest"
    "$DOCKER_BIN" compose -f "$COMPOSE_FILE" up -d --no-build --no-deps report-web

    # 启动后核验容器运行镜像 ID
    local running_img
    running_img=$("$DOCKER_BIN" inspect --format="{{.Image}}" personal-treasury-report-web 2>/dev/null || true)
    if [ -z "$running_img" ]; then
        running_img=$("$DOCKER_BIN" compose -f "$COMPOSE_FILE" images -q report-web 2>/dev/null || true)
    fi
    [ "$running_img" = "$locked_id" ] || {
        echo "FATAL: Frontend container running image ($running_img) does not match locked ID ($locked_id)!" >&2
        exit 1
    }
    echo "[release_ops] Frontend container smoothly rolled back and verified at locked ID: $locked_id" >&2
}

# ------------------------------------------------------------------------------
# 子命令：rollback_global
# 全量整批发布回滚（严格逆序：材料预检 -> 停止任务 -> 恢复文件/镜像/源码 -> reload -> 恢复服务 -> 全面终态核验）
# 关键操作严禁 || true，失败立即 fail-closed 中断
# ------------------------------------------------------------------------------
cmd_rollback_global() {
    echo "=== [release_ops] Starting Full Release Global Rollback ===" >&2

    # 1. 严格预检全部已变更组件的回滚材料完整性（Fail-closed，缺材料立即终止）
    echo "[release_ops] Step 1: Pre-flight validating rollback materials..." >&2
    local head_file="$MANIFEST_DIR/prev_head.commit"
    [ -f "$head_file" ] && [ -s "$head_file" ] || {
        echo "FATAL: Pre-release Git HEAD backup missing at $head_file" >&2
        exit 1
    }
    local prev_head
    prev_head=$(cat "$head_file")

    local bridge_id_file="$MANIFEST_DIR/bridge_image.id"
    [ -f "$bridge_id_file" ] && [ -s "$bridge_id_file" ] || {
        echo "FATAL: Bridge rollback image ID missing at $bridge_id_file" >&2
        exit 1
    }
    local bridge_locked_id
    bridge_locked_id=$(cat "$bridge_id_file")
    [ -n "$bridge_locked_id" ] || { echo "FATAL: Bridge locked image ID in $bridge_id_file is empty!" >&2; exit 1; }

    local hermes_bak="$HERMES_BACKUP_DIR/config.yaml.bak"
    [ -f "$hermes_bak" ] && [ -s "$hermes_bak" ] || {
        echo "FATAL: Hermes backup config missing at $hermes_bak" >&2
        exit 1
    }

    # 预检所有 Unit 备份材料
    local units_to_check=(
        "personal-treasury-patrol.timer"
        "personal-treasury-patrol.service"
        "personal-treasury-feishu-digest.timer"
        "personal-treasury-feishu-digest.service"
        "personal-treasury-watchdog.timer"
        "personal-treasury-watchdog.service"
    )
    for u in "${units_to_check[@]}"; do
        local m="$MANIFEST_DIR/units/${u}.meta"
        if [ -f "$m" ]; then
            local ex
            ex=$(grep "^exists=" "$m" | cut -d'=' -f2)
            if [ "$ex" = "true" ]; then
                local o="$MANIFEST_DIR/units/${u}.orig"
                [ -f "$o" ] && [ -s "$o" ] || {
                    echo "FATAL: Unit $u has exists=true but .orig file missing or empty at $o!" >&2
                    exit 1
                }
            fi
        fi
    done
    echo "[release_ops] Step 1 PASSED: All rollback materials verified." >&2

    # 2. 逆序停用相关定时器与服务，并确认停止（对存在的单元严禁 || true 吞错）
    echo "[release_ops] Step 2: Stopping and disabling active timers and services..." >&2
    for u in "personal-treasury-patrol.timer" "personal-treasury-feishu-digest.timer"; do
        if [ -f "$SYSTEMD_DIR/$u" ]; then
            "$SYSTEMCTL_BIN" disable --now "$u"
            echo "[release_ops] Disabled and stopped timer: $u" >&2
        else
            echo "[release_ops] Timer $u does not exist on disk, skipping stop/disable" >&2
        fi
    done
    for u in "personal-treasury-patrol.service" "personal-treasury-feishu-digest.service"; do
        if [ -f "$SYSTEMD_DIR/$u" ]; then
            "$SYSTEMCTL_BIN" stop "$u"
            echo "[release_ops] Stopped service: $u" >&2
        else
            echo "[release_ops] Service $u does not exist on disk, skipping stop" >&2
        fi
    done

    # 3. 恢复文件、容器镜像与宿主机源码
    echo "[release_ops] Step 3: Restoring files, Docker images, and Git repo..." >&2
    # 3.1 恢复/清理 Systemd 单元文件
    for u in "${units_to_check[@]}"; do
        local m="$MANIFEST_DIR/units/${u}.meta"
        local o="$MANIFEST_DIR/units/${u}.orig"
        local target="$SYSTEMD_DIR/${u}"
        if [ -f "$m" ]; then
            local ex
            ex=$(grep "^exists=" "$m" | cut -d'=' -f2)
            if [ "$ex" = "true" ]; then
                cp -p "$o" "$target"
                echo "[release_ops] Restored original unit file: $u" >&2
            else
                rm -f "$target"
                echo "[release_ops] Removed newly added unit file: $u" >&2
            fi
        fi
    done

    # 3.2 恢复 Hermes 配置文件
    cp -p "$hermes_bak" "$HERMES_CONFIG"
    echo "[release_ops] Restored Hermes config from $hermes_bak" >&2

    # 3.3 恢复 Docker 容器镜像（直接依据锁定 ID 恢复，严禁依赖可变标签，无 || true）
    echo "[release_ops] Restoring Bridge container strictly from locked ID: $bridge_locked_id" >&2
    "$DOCKER_BIN" tag "$bridge_locked_id" "personal-treasury-bridge:latest"
    "$DOCKER_BIN" compose -f "$COMPOSE_FILE" up -d --no-build --no-deps bridge

    local web_id_file="$MANIFEST_DIR/web_image.id"
    local web_locked_id=""
    if [ -f "$web_id_file" ]; then
        web_locked_id=$(cat "$web_id_file")
        [ -n "$web_locked_id" ] || { echo "FATAL: Web rollback image ID in $web_id_file is empty!" >&2; exit 1; }
        echo "[release_ops] Restoring Web container strictly from locked ID: $web_locked_id" >&2
        "$DOCKER_BIN" tag "$web_locked_id" "personal-treasury-report-web:latest"
        "$DOCKER_BIN" compose -f "$COMPOSE_FILE" up -d --no-build --no-deps report-web
    fi

    # 3.4 全仓库代码检出至发布前 HEAD
    cd "$REPO_DIR"
    "$GIT_BIN" checkout "$prev_head"
    echo "[release_ops] Git repository checked out to pre-release HEAD: $prev_head" >&2

    # 4. Systemd 守护进程重载
    echo "[release_ops] Step 4: Systemd daemon-reload..." >&2
    "$SYSTEMCTL_BIN" daemon-reload

    # 5. 按原状态恢复服务与定时器（无 || true 吞错，失败立即中止）
    echo "[release_ops] Step 5: Restoring services and timers according to recorded state..." >&2
    # 重启 Hermes 网关服务（服务名为 hermes-gateway）
    "$SYSTEMCTL_BIN" restart hermes-gateway
    echo "[release_ops] Restarted hermes-gateway service" >&2

    # 恢复 Unit 启用与运行状态（精确双向恢复，含 static/failed 基线：不清失败状态绕过）
    for u in "${units_to_check[@]}"; do
        local m="$MANIFEST_DIR/units/${u}.meta"
        if [ -f "$m" ]; then
            local ex en ac
            ex=$(grep "^exists=" "$m" | cut -d'=' -f2)
            en=$(grep "^enabled=" "$m" | cut -d'=' -f2)
            ac=$(grep "^active=" "$m" | cut -d'=' -f2)
            if [ "$ex" = "true" ]; then
                # enabled 状态：仅对可变更的 enabled/disabled 执行对应操作；static/masked 不可手动启停，保持原状
                if [ "$en" = "enabled" ]; then
                    "$SYSTEMCTL_BIN" enable "$u"
                    echo "[release_ops] Enabled unit: $u" >&2
                elif [ "$en" = "disabled" ]; then
                    "$SYSTEMCTL_BIN" disable "$u"
                    echo "[release_ops] Disabled unit: $u" >&2
                else
                    echo "[release_ops] Unit $u enabled=$en (static/masked, no change)" >&2
                fi
                # active 状态：active 才 start；inactive/failed/activating 均 stop 安全停止
                # 注：failed 基线 stop 后 systemd 报告为 inactive（瞬态 failed 在 stop 时被清除），
                # 终态核验允许 failed 基线的终态为 inactive 或 failed（见步骤 6.5 分层判定）
                if [ "$ac" = "active" ]; then
                    "$SYSTEMCTL_BIN" start "$u"
                    echo "[release_ops] Started unit: $u" >&2
                else
                    "$SYSTEMCTL_BIN" stop "$u"
                    echo "[release_ops] Stopped unit: $u (recorded active=$ac, safely stopped)" >&2
                fi
                echo "[release_ops] Unit $u state restored (enabled=$en, active=$ac)" >&2
            fi
        fi
    done

    # 6. 全量终态核验（Git HEAD、Docker 容器镜像、配置一致性、Systemd 单元文件与启停状态）
    echo "[release_ops] Step 6: Verifying final state and rollback invariants..." >&2
    # 6.1 核验 Git HEAD
    local final_head
    final_head=$("$GIT_BIN" rev-parse HEAD)
    [ "$final_head" = "$prev_head" ] || {
        echo "FATAL: Final git HEAD ($final_head) does not match expected rollback HEAD ($prev_head)!" >&2
        exit 1
    }
    echo "[release_ops] Final Git HEAD verified: $final_head" >&2

    # 6.2 核验 Bridge 容器实际运行镜像 ID
    local running_bridge_img
    running_bridge_img=$("$DOCKER_BIN" inspect --format="{{.Image}}" personal-treasury-bridge 2>/dev/null || true)
    if [ -z "$running_bridge_img" ]; then
        running_bridge_img=$("$DOCKER_BIN" compose -f "$COMPOSE_FILE" images -q bridge 2>/dev/null || true)
    fi
    [ "$running_bridge_img" = "$bridge_locked_id" ] || {
        echo "FATAL: Bridge container running image ($running_bridge_img) does not match locked rollback ID ($bridge_locked_id)!" >&2
        exit 1
    }
    echo "[release_ops] Bridge running image verified at locked ID: $bridge_locked_id" >&2

    # 6.3 核验 Web 容器实际运行镜像 ID（若有记录）
    if [ -n "$web_locked_id" ]; then
        local running_web_img
        running_web_img=$("$DOCKER_BIN" inspect --format="{{.Image}}" personal-treasury-report-web 2>/dev/null || true)
        if [ -z "$running_web_img" ]; then
            running_web_img=$("$DOCKER_BIN" compose -f "$COMPOSE_FILE" images -q report-web 2>/dev/null || true)
        fi
        [ "$running_web_img" = "$web_locked_id" ] || {
            echo "FATAL: Web container running image ($running_web_img) does not match locked rollback ID ($web_locked_id)!" >&2
            exit 1
        }
        echo "[release_ops] Web running image verified at locked ID: $web_locked_id" >&2
    fi

    # 6.4 核验 Hermes 配置文件与原件一致性
    cmp -s "$HERMES_CONFIG" "$hermes_bak" || {
        echo "FATAL: Hermes config $HERMES_CONFIG does not match original backup $hermes_bak!" >&2
        exit 1
    }
    echo "[release_ops] Hermes config verified matching original backup" >&2

    # 6.5 核验 Systemd Unit 文件还原、清理及实际启停状态终态
    for u in "${units_to_check[@]}"; do
        local m="$MANIFEST_DIR/units/${u}.meta"
        if [ -f "$m" ]; then
            local ex en ac
            ex=$(grep "^exists=" "$m" | cut -d'=' -f2)
            en=$(grep "^enabled=" "$m" | cut -d'=' -f2)
            ac=$(grep "^active=" "$m" | cut -d'=' -f2)
            local target="$SYSTEMD_DIR/${u}"
            if [ "$ex" = "true" ]; then
                local o="$MANIFEST_DIR/units/${u}.orig"
                [ -f "$target" ] || { echo "FATAL: Restored unit file $target missing!" >&2; exit 1; }
                cmp -s "$target" "$o" || { echo "FATAL: Restored unit file $target differs from $o!" >&2; exit 1; }

                # 终态实际启停状态严格断言（查询失败一律阻断；active 状态按基线分层判定）
                local cur_en cur_ac
                cur_en=$(query_unit_enabled "$u") || {
                    echo "FATAL: Failed to query runtime enabled state for unit $u!" >&2
                    exit 1
                }
                cur_ac=$(query_unit_active "$u") || {
                    echo "FATAL: Failed to query runtime active state for unit $u!" >&2
                    exit 1
                }
                [ "$cur_en" = "$en" ] || {
                    echo "FATAL: Unit $u enabled state ($cur_en) does not match recorded baseline ($en)!" >&2
                    exit 1
                }
                # active 分层判定：
                #   基线 active=active  → 终态必须 active（运行态严格恢复）
                #   基线 active=inactive → 终态必须 inactive
                #   基线 active=failed  → 终态允许 inactive 或 failed（历史失败安全停止为 inactive，
                #                          或保持 failed）；拒绝 active（不应恢复运行态）
                case "$ac" in
                    active)
                        [ "$cur_ac" = "active" ] || {
                            echo "FATAL: Unit $u recorded active baseline, final=$cur_ac (must be active)!" >&2
                            exit 1
                        }
                        ;;
                    inactive)
                        [ "$cur_ac" = "inactive" ] || {
                            echo "FATAL: Unit $u recorded inactive baseline, final=$cur_ac (must be inactive)!" >&2
                            exit 1
                        }
                        ;;
                    failed)
                        case "$cur_ac" in
                            inactive|failed) ;;
                            *) echo "FATAL: Unit $u recorded failed baseline, final=$cur_ac (must be inactive/failed)!" >&2
                               exit 1 ;;
                        esac
                        ;;
                    *)
                        echo "FATAL: Unknown recorded active baseline '$ac' for $u!" >&2
                        exit 1
                        ;;
                esac
                echo "[release_ops] Unit $u file and runtime state verified (enabled=$cur_en, active=$cur_ac, recorded_baseline=$ac)" >&2
            else
                [ ! -f "$target" ] || { echo "FATAL: Newly added unit file $target was not removed!" >&2; exit 1; }
            fi
        fi
    done
    echo "[release_ops] Systemd unit files and states verified" >&2

    echo "=== [release_ops] Full Release Global Rollback Successfully Completed ===" >&2
}

# ------------------------------------------------------------------------------
# 子命令：verify_digest_receipt <receipt_path> <expected_business_date> [expected_channel]
# 验证飞书日报回执状态机（严格四路分流，深度契约对齐 RRV-03）
# 日志输出至 stderr；stdout 严格输出单行机器可读 Action Token：
#   - TRIGGER_AUTHORIZED: 回执确实不存在，允许执行单次已授权受控触发
#   - SKIP_ALREADY_DELIVERED: 合法、完整契约且业务键匹配的 delivered，跳过触发
#   - WAIT_OR_CHECK_RUNNING: 合法契约且业务日匹配的 status 为 sending，处于正在执行态
#   - STOP_MANUAL_AUDIT_REQUIRED: 缺字段、错误类型、渠道不匹配、日期不匹配、状态不确定或路径异常，阻断并要求人工核查
# ------------------------------------------------------------------------------
cmd_verify_digest_receipt() {
    local receipt_path="${1:-}"
    local expected_date="${2:-}"
    local expected_channel="${3:-feishu}"
    [ -n "$receipt_path" ] && [ -n "$expected_date" ] || {
        echo "Usage: $0 verify_digest_receipt <receipt_path> <expected_business_date> [expected_channel]" >&2
        exit 1
    }

    # 1. 路径存在性与类型检查
    # 只有路径确实不存在（且不是软链接或目录），才进入 TRIGGER_AUTHORIZED
    if [ ! -e "$receipt_path" ] && [ ! -L "$receipt_path" ]; then
        echo "[release_ops] Receipt path does not exist: $receipt_path -> ACTION: TRIGGER_AUTHORIZED" >&2
        echo "TRIGGER_AUTHORIZED"
        return 0
    fi

    # 若路径存在但不是普通文件（例如目录、套接字、设备文件等）或不可读，属于路径异常，绝不进入 TRIGGER_AUTHORIZED
    if [ -d "$receipt_path" ] || [ ! -f "$receipt_path" ] || [ ! -r "$receipt_path" ]; then
        echo "[release_ops] Receipt path is a directory, not a regular file, or not readable: $receipt_path -> ACTION: STOP_MANUAL_AUDIT_REQUIRED" >&2
        echo "STOP_MANUAL_AUDIT_REQUIRED"
        return 0
    fi

    # 2. 安全读取与深度结构校验（对齐 RRV-03 投递回执契约）
    # 必需字段校验：status, business_date, channel, attempts
    # 类型白名单校验：attempts 必须为 int 且排除 bool，且 attempts >= 1
    # 状态白名单校验：status 属于 ("delivered", "uncertain", "sending")
    # 业务键匹配校验：business_date 必须严格等于 expected_date，channel 必须严格等于 expected_channel
    local status_token
    status_token=$(python3 -c "
import json, sys

try:
    with open('$receipt_path', 'r', encoding='utf-8') as f:
        data = json.load(f)
    if not isinstance(data, dict):
        sys.exit(2)

    # 必需字段检查（RRV-03 契约）
    for k in ('status', 'business_date', 'channel', 'attempts'):
        if k not in data:
            sys.exit(3)

    st = data['status']
    b_date = data['business_date']
    ch = data['channel']
    att = data['attempts']

    # 状态白名单校验
    if st not in ('delivered', 'uncertain', 'sending'):
        sys.exit(4)

    # 业务键匹配：业务日严格匹配
    if b_date != '$expected_date':
        sys.exit(5)

    # 渠道匹配：渠道严格匹配
    if ch != '$expected_channel':
        sys.exit(6)

    # attempts 类型校验：必须为正整数，且在 Python 中布尔值 True/False 不是合法整数计数
    if isinstance(att, bool) or not isinstance(att, int) or att < 1:
        sys.exit(7)

    print(st)
except Exception:
    sys.exit(1)
" 2>/dev/null || true)

    if [ -z "$status_token" ]; then
        echo "[release_ops] Receipt at $receipt_path failed contract validation (missing fields/bad type/channel mismatch/date mismatch/corrupted) -> ACTION: STOP_MANUAL_AUDIT_REQUIRED" >&2
        echo "STOP_MANUAL_AUDIT_REQUIRED"
        return 0
    fi

    # 3. 状态分流（基于已完全通过结构与业务键校验的 status_token）
    if [ "$status_token" = "delivered" ]; then
        echo "[release_ops] Valid delivered receipt for $expected_date ($expected_channel) verified -> ACTION: SKIP_ALREADY_DELIVERED" >&2
        echo "SKIP_ALREADY_DELIVERED"
    elif [ "$status_token" = "sending" ]; then
        echo "[release_ops] Valid receipt status is 'sending' for $expected_date ($expected_channel) -> ACTION: WAIT_OR_CHECK_RUNNING" >&2
        echo "WAIT_OR_CHECK_RUNNING"
    else
        # status_token 为 uncertain 或其他受控状态，要求人工介入核查
        echo "[release_ops] Validated receipt status is '$status_token' -> ACTION: STOP_MANUAL_AUDIT_REQUIRED" >&2
        echo "STOP_MANUAL_AUDIT_REQUIRED"
    fi
}

# ------------------------------------------------------------------------------
# 主入口路由
# ------------------------------------------------------------------------------
case "${1:-}" in
    backup_head)
        cmd_backup_head
        ;;
    backup_image)
        shift
        cmd_backup_image "$@"
        ;;
    backup_hermes)
        cmd_backup_hermes
        ;;
    backup_units)
        shift
        cmd_backup_units "$@"
        ;;
    rollback_frontend)
        cmd_rollback_frontend
        ;;
    rollback_global)
        cmd_rollback_global
        ;;
    verify_digest_receipt)
        shift
        cmd_verify_digest_receipt "$@"
        ;;
    *)
        echo "Usage: $0 {backup_head|backup_image|backup_hermes|backup_units|rollback_frontend|rollback_global|verify_digest_receipt} [args...]" >&2
        exit 1
        ;;
esac
