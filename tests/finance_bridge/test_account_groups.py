"""账户分组配置：加载、校验与待分类回退（实施文档 §5.4 / §9.1）。"""
from __future__ import annotations

import textwrap

import pytest

from finance_bridge.app.account_groups import (
    AccountGroupConfigError,
    load_account_groups,
)


def _write(tmp_path, body: str):
    path = tmp_path / "account_groups.yaml"
    path.write_text(textwrap.dedent(body), encoding="utf-8")
    return path


VALID_CONFIG = """
    version: 1
    asset_groups:
      cash: 现金
      bank: 银行及电子钱包
    liability_groups:
      credit_cards: 信用卡
    account_groups:
      "7": bank
      "14": cash
      "4": credit_cards
"""


def test_valid_config_loads(tmp_path):
    cfg = load_account_groups(_write(tmp_path, VALID_CONFIG))
    assert cfg.version == 1
    assert cfg.group_for("7").key == "bank"
    assert cfg.group_for("14").title == "现金"
    assert cfg.group_for("4").side == "liability"
    # 未配置账户 -> 待分类（返回 None，由调用方归入 pending）
    assert cfg.group_for("999") is None


def test_duplicate_account_id_rejected(tmp_path):
    path = _write(tmp_path, """
        version: 1
        asset_groups:
          cash: 现金
          bank: 银行
        account_groups:
          "7": bank
          "7": cash
    """)
    with pytest.raises(AccountGroupConfigError, match="重复的配置键"):
        load_account_groups(path)


def test_unknown_group_key_rejected(tmp_path):
    path = _write(tmp_path, """
        version: 1
        asset_groups:
          cash: 现金
        account_groups:
          "7": no_such_group
    """)
    with pytest.raises(AccountGroupConfigError, match="未知分组"):
        load_account_groups(path)


def test_non_string_account_id_rejected(tmp_path):
    path = _write(tmp_path, """
        version: 1
        asset_groups:
          cash: 现金
        account_groups:
          7: cash
    """)
    with pytest.raises(AccountGroupConfigError, match="字符串账户 ID"):
        load_account_groups(path)


def test_unsupported_version_rejected(tmp_path):
    path = _write(tmp_path, """
        version: 2
        asset_groups:
          cash: 现金
    """)
    with pytest.raises(AccountGroupConfigError, match="版本"):
        load_account_groups(path)


def test_missing_file_rejected(tmp_path):
    with pytest.raises(AccountGroupConfigError, match="不存在"):
        load_account_groups(tmp_path / "nope.yaml")


def test_default_config_is_valid():
    """随仓库分发的示例配置必须能通过校验（各资产/负债分组均有代表账户）。"""
    cfg = load_account_groups()
    assert cfg.version == 1
    assert cfg.group_for("7").key == "bank"      # Bank A
    assert cfg.group_for("121").key == "consumer_credit"  # 信用钱包甲
    assert cfg.group_for("126").key == "other_assets"     # 迁移清算 CNY
    # 资产/负债两侧分组标题齐全
    sides = {g.side for g in cfg.groups.values()}
    assert sides == {"asset", "liability"}
