"""版本化账户分组配置（report-web 专用，不改动现有报表口径）。

规则（见实施文档 §5.4）：
- 以 Firefly account ID 为键，账户改名不影响分类；
- 初始配置必须覆盖全部启用且 include_net_worth=true 的资产/负债账户；
- 未配置的新账户进入 pending_mapping，接口照常返回并产生 warning；
- 配置错误（重复 ID、未知 group key、非字符串 ID）在启动时明确报错。

不根据账户名称在每次请求中动态改分类。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "account_groups.yaml"


class AccountGroupConfigError(ValueError):
    """配置不合法：启动时抛出，阻止服务带病启动。"""


class _UniqueKeyLoader(yaml.SafeLoader):
    """YAML loader：遇到重复键直接报错（默认行为是静默覆盖，财务分类不允许）。"""


def _construct_mapping(loader: _UniqueKeyLoader, node: yaml.nodes.MappingNode,
                       deep: bool = False) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise AccountGroupConfigError(f"重复的配置键：{key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping
)


@dataclass(frozen=True)
class AccountGroup:
    """一个业务分组的定义。"""

    key: str
    title: str
    side: str  # "asset" | "liability"


@dataclass(frozen=True)
class AccountGroupsConfig:
    """解析并校验后的账户分组配置。"""

    version: int
    groups: dict[str, AccountGroup]                              # group key -> 分组
    account_to_group: dict[str, str] = field(default_factory=dict)  # account_id -> group key

    def group_for(self, account_id: str) -> AccountGroup | None:
        key = self.account_to_group.get(str(account_id))
        return self.groups.get(key) if key else None

    def group_key_for(self, account_id: str) -> str | None:
        return self.account_to_group.get(str(account_id))


def load_account_groups(path: str | Path | None = None) -> AccountGroupsConfig:
    """加载并校验 account_groups.yaml。

    任何配置问题（重复 ID、未知分组、非字符串 ID、结构缺失）都会抛出
    AccountGroupConfigError，由启动流程决定是否拒绝启动。
    """
    config_path = Path(path) if path else DEFAULT_CONFIG_PATH
    if not config_path.is_file():
        raise AccountGroupConfigError(f"账户分组配置文件不存在：{config_path}")

    with open(config_path, "r", encoding="utf-8") as fh:
        raw = yaml.load(fh, Loader=_UniqueKeyLoader)

    if not isinstance(raw, dict):
        raise AccountGroupConfigError("账户分组配置必须是顶层映射（version/asset_groups/...）")

    version = raw.get("version")
    if version != 1:
        raise AccountGroupConfigError(f"不支持的配置版本：{version!r}，当前仅支持 version: 1")

    asset_groups = _parse_group_section(raw.get("asset_groups"), "asset", "asset_groups")
    liability_groups = _parse_group_section(raw.get("liability_groups"), "liability", "liability_groups")
    groups = {**asset_groups, **liability_groups}

    account_groups_raw = raw.get("account_groups")
    if account_groups_raw is None:
        account_groups_raw = {}
    if not isinstance(account_groups_raw, dict):
        raise AccountGroupConfigError("account_groups 必须是 account_id -> group_key 的映射")

    account_to_group: dict[str, str] = {}
    for account_id, group_key in account_groups_raw.items():
        if not isinstance(account_id, str) or not account_id.strip():
            raise AccountGroupConfigError(f"account_groups 的键必须是字符串账户 ID，实际为 {account_id!r}")
        if not isinstance(group_key, str) or not group_key.strip():
            raise AccountGroupConfigError(f"账户 {account_id} 的分组值必须是字符串，实际为 {group_key!r}")
        if group_key not in groups:
            raise AccountGroupConfigError(
                f"账户 {account_id} 引用了未知分组 {group_key!r}（不在 asset_groups/liability_groups 中）"
            )
        account_to_group[account_id.strip()] = group_key.strip()

    return AccountGroupsConfig(
        version=version,
        groups=groups,
        account_to_group=account_to_group,
    )


def _parse_group_section(raw: Any, side: str, section_name: str) -> dict[str, AccountGroup]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise AccountGroupConfigError(f"{section_name} 必须是 key -> title 的映射")
    result: dict[str, AccountGroup] = {}
    for key, title in raw.items():
        if not isinstance(key, str) or not key.strip():
            raise AccountGroupConfigError(f"{section_name} 的键必须是字符串，实际为 {key!r}")
        if not isinstance(title, str) or not title.strip():
            raise AccountGroupConfigError(f"分组 {key!r} 的标题必须是字符串，实际为 {title!r}")
        result[key.strip()] = AccountGroup(key=key.strip(), title=title.strip(), side=side)
    return result


_config: AccountGroupsConfig | None = None


def get_account_groups() -> AccountGroupsConfig:
    """返回进程级配置单例；未加载时按默认路径加载。"""
    global _config
    if _config is None:
        _config = load_account_groups()
    return _config


def reload_account_groups(path: str | Path | None = None) -> AccountGroupsConfig:
    """测试/运维用：重新加载并替换单例。"""
    global _config
    _config = load_account_groups(path)
    return _config


def reset_account_groups() -> None:
    """测试用：清空单例，下次访问时重新从默认路径加载。"""
    global _config
    _config = None


def config_path_from_env() -> Path:
    """允许用环境变量覆盖配置文件路径（生产默认为包内默认路径）。"""
    override = os.getenv("ACCOUNT_GROUPS_CONFIG")
    return Path(override) if override else DEFAULT_CONFIG_PATH
