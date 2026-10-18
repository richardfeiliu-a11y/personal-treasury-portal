"""个人口径资产负债表计算（门户面，只读；三总额聚合点亦被 Hermes 面复用）。

口径（实施文档 §5.2）：
- 资产使用 Firefly 原符号；负债在展示值中转为正数；
- 净资产 = 资产展示合计 - 负债展示合计；负债按**逐账户绝对值**（毛额）计入，
  不做同币种正负相抵；
- 三总额（含净资产）一律由 ``value_personal_scope`` 产出：逐账户按币种聚合后按
  币种折算，负债逐账户取绝对值（毛额）。Hermes 面资产负债表与本报表、净资产趋势
  共用这一唯一聚合点（CALC-01 / 审计计划 Batch 11）。
- include_net_worth=false 的账户不进入总额，也不出现在本报表（在账户页查看）；
- 停用且余额为零的账户默认剔除；停用但非零的账户保留并产生 warning；
- Firefly 类型与分组配置 side 不一致的账户并入该侧「待分类」组展示并产生 warning：
  进入总额的账户必须同时出现在展示里，否则页面与总额无法勾稽；
- 非零余额账户缺有效汇率时，该账户 balance_base 为 null，不得按零汇率或一比一汇率
  补齐，原币余额始终保留；``fx_complete`` 按**账户行**判定（比总额更严，Batch 11
  记录的可接受残差）。三总额是否一并 fail closed 由聚合点决定：该币种聚合后仍非零
  才为 null（同币种正负抵成 0 时总额照常），warning 文案按总额是否为 null 分级。
"""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Any

from finance_bridge.app.account_groups import AccountGroupsConfig
from finance_bridge.app.reporting.contracts import decimal_text
from finance_bridge.app.storage.fx_rates import FXRateRepository

PENDING_ASSET_GROUP = ("pending_asset", "待分类资产", "asset")
PENDING_LIABILITY_GROUP = ("pending_liability", "待分类负债", "liability")


def value_personal_scope(
    accounts: list[dict[str, Any]],
    as_of: str,
    base_currency: str,
    repository: FXRateRepository,
) -> dict[str, Any]:
    """个人口径汇总（Hermes 面资产负债表、门户面资产负债表与净资产趋势共用的唯一单点）：

    - 排除 include_net_worth=false 的账户（迁移清算等）；
    - 资产保留原符号，负债逐账户取绝对值（展示为正）；
    - 净资产 = 资产展示合计 - 负债展示合计；
    - 币种聚合后仍非零却缺有效汇率 -> 三个总额均为 null，原币不参与伪造
      （同币种正负抵成 0 的缺率币种不阻断总额）。
    """
    asset_by_currency: dict[str, Decimal] = defaultdict(Decimal)
    liability_by_currency: dict[str, Decimal] = defaultdict(Decimal)

    for account in accounts:
        attrs = account.get("attributes", {}) or {}
        acct_type = attrs.get("type", "")
        if acct_type not in ("asset", "liabilities", "liability"):
            continue
        if not bool(attrs.get("include_net_worth", True)):
            continue
        currency = (attrs.get("currency_code") or base_currency).upper()
        try:
            balance = Decimal(str(attrs.get("current_balance", "0")))
        except Exception:
            continue
        if acct_type == "asset":
            asset_by_currency[currency] += balance
        else:
            liability_by_currency[currency] += abs(balance)

    missing: set[str] = set()
    total_assets = Decimal(0)
    total_liabilities = Decimal(0)
    for currency, amount in asset_by_currency.items():
        if amount == 0:
            continue
        rate = repository.effective_rate(currency, as_of)
        if rate is None:
            missing.add(currency)
        else:
            total_assets += amount * Decimal(rate["rate"])
    for currency, amount in liability_by_currency.items():
        if amount == 0:
            continue
        rate = repository.effective_rate(currency, as_of)
        if rate is None:
            missing.add(currency)
        else:
            total_liabilities += amount * Decimal(rate["rate"])

    if missing:
        return {
            "fx_complete": False,
            "missing_currencies": sorted(missing),
            "total_assets_base": None,
            "total_liabilities_base": None,
            "net_worth_base": None,
        }
    return {
        "fx_complete": True,
        "missing_currencies": [],
        "total_assets_base": decimal_text(total_assets),
        "total_liabilities_base": decimal_text(total_liabilities),
        "net_worth_base": decimal_text(total_assets - total_liabilities),
    }


def compute_personal_balance_sheet(
    accounts: list[dict[str, Any]],
    as_of: str,
    base_currency: str,
    repository: FXRateRepository,
    groups: AccountGroupsConfig,
) -> dict[str, Any]:
    """由 Firefly 账户列表计算个人口径资产负债表。

    accounts 为 Firefly envelope 列表（含 id 与 attributes），必须已按 as_of
    取好历史余额（调用方负责传 date=as_of 给 Firefly）。
    """
    warnings: list[str] = []
    missing_currencies: set[str] = set()

    # 按分组收集账户行：group_key -> list[dict]
    asset_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    liability_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    included_count = 0
    pending_count = 0

    for account in accounts:
        attrs = account.get("attributes", {}) or {}
        acct_type = attrs.get("type", "")
        if acct_type not in ("asset", "liabilities", "liability"):
            continue

        account_id = str(account.get("id", ""))
        name = attrs.get("name", "未知账户")
        active = bool(attrs.get("active", True))
        include_net_worth = bool(attrs.get("include_net_worth", True))
        currency = (attrs.get("currency_code") or base_currency).upper()

        try:
            balance = Decimal(str(attrs.get("current_balance", "0")))
        except Exception:
            continue

        # 不进入个人净资产口径的账户（迁移清算等）：本报表不展示，账户页可查。
        if not include_net_worth:
            continue
        # 停用且余额为零：默认剔除。
        if not active and balance == 0:
            continue
        # 停用但余额非零：保留并告警。
        if not active:
            warnings.append(
                f"停用但余额非零的账户已计入：{name}（ID {account_id}，"
                f"原币余额 {decimal_text(balance)} {currency}）"
            )

        is_liability = acct_type in ("liabilities", "liability")
        # 展示口径：资产原符号；负债转正数。
        display_balance = balance if not is_liability else abs(balance)
        display_text = decimal_text(display_balance)

        # 折算：非零余额币种必须有汇率；零余额不需要汇率。
        balance_base: str | None = None
        if display_balance != 0:
            rate = repository.effective_rate(currency, as_of)
            if rate is None:
                missing_currencies.add(currency)
            else:
                balance_base = decimal_text(display_balance * Decimal(rate["rate"]))
        else:
            balance_base = "0"

        row = {
            "id": account_id,
            "name": name,
            "currency": currency,
            "balance_native": display_text,
            "balance_base": balance_base,
            "active": active,
            "include_net_worth": True,
        }

        group = groups.group_for(account_id)
        if group is None:
            pending_count += 1
            warnings.append(f"账户缺少分组配置（待分类）：{name}（ID {account_id}）")
            if is_liability:
                liability_groups[PENDING_LIABILITY_GROUP[0]].append(row)
            else:
                asset_groups[PENDING_ASSET_GROUP[0]].append(row)
        elif is_liability:
            liability_groups[group.key].append(row)
        else:
            asset_groups[group.key].append(row)

        included_count += 1

    # 三总额取自 value_personal_scope（CALC-01 / Batch11 单点）：与 Hermes 面、
    # 净资产趋势同源，顺序为「逐账户按币种聚合后按币种折算」。
    # 分组小计 subtotal_base 仍由展示行相加（_safe_sum）产出，只用于展示。
    scope_totals = value_personal_scope(accounts, as_of, base_currency, repository)

    # 响应的 fx_complete 按**账户行**判定（行级折算不出即 false；Batch11 记录的可接受
    # 残差：Hermes 面按币种聚合判定）。警示语则按「三总额是否真的为 null」分级：同币种
    # 正负抵成 0 的缺率币种不阻断聚合点，此时总额非 null，只能陈述行级事实。
    fx_complete = not missing_currencies
    if not fx_complete:
        if scope_totals["total_assets_base"] is None:
            warnings.append("存在非零余额币种缺少汇率，相关折算金额与汇总总额为 null。")
        else:
            warnings.append(
                "存在非零余额币种缺少汇率，相关账户折算为 null；汇总总额不受影响。"
            )

    asset_titles = {g.key: g.title for g in groups.groups.values() if g.side == "asset"}
    liability_titles = {g.key: g.title for g in groups.groups.values() if g.side == "liability"}
    _route_orphan_buckets("asset", asset_groups, asset_titles, warnings)
    _route_orphan_buckets("liability", liability_groups, liability_titles, warnings)
    asset_group_list = _build_groups("asset", asset_groups, asset_titles)
    liability_group_list = _build_groups("liability", liability_groups, liability_titles)

    summary = {
        "total_assets_base": scope_totals["total_assets_base"],
        "total_liabilities_base": scope_totals["total_liabilities_base"],
        "net_worth_base": scope_totals["net_worth_base"],
        "included_account_count": included_count,
        "pending_mapping_count": pending_count,
    }

    return {
        "groups": asset_group_list + liability_group_list,
        "fx_complete": fx_complete,
        "missing_currencies": sorted(missing_currencies),
        "warnings": warnings,
        "summary": summary,
    }


def _route_orphan_buckets(side: str, buckets: dict[str, list[dict[str, Any]]],
                          group_titles: dict[str, str],
                          warnings: list[str]) -> None:
    """把「标题表里没有的桶键」并入该侧待分类组，并点名告警（就地修改 buckets）。

    产生条件：账户的 Firefly type 与 YAML 分组配置的 side 不一致（例如配置里挂在
    负债侧 credit_cards、Firefly 却返回 type=asset）。这类账户照常进入三总额
    （value_personal_scope 只看 Firefly type），若不成组就从展示里彻底消失，
    页面与总额无法勾稽；待分类组是门户面上唯一「可见但不归类」的落点。
    """
    pending_key, pending_title, _side = (
        PENDING_ASSET_GROUP if side == "asset" else PENDING_LIABILITY_GROUP
    )
    orphan_keys = sorted(
        key for key in buckets if key != pending_key and key not in group_titles
    )
    for key in orphan_keys:
        rows = buckets.pop(key)
        buckets.setdefault(pending_key, []).extend(rows)
        names = "、".join(f"{row['name']}（ID {row['id']}）" for row in rows)
        warnings.append(
            f"账户分组配置与账户类型不一致（配置分组 {key} 属另一侧），"
            f"已并入{pending_title}展示：{names}"
        )


def _build_groups(side: str, buckets: dict[str, list[dict[str, Any]]],
                  group_titles: dict[str, str]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for key, title in group_titles.items():
        rows = buckets.get(key)
        if not rows:
            continue
        result.append(_make_group(key, title, side, rows))
    # 待分类组固定放在最后（若存在）
    pending_key = PENDING_ASSET_GROUP[0] if side == "asset" else PENDING_LIABILITY_GROUP[0]
    pending_title = PENDING_ASSET_GROUP[1] if side == "asset" else PENDING_LIABILITY_GROUP[1]
    if buckets.get(pending_key):
        result.append(_make_group(pending_key, pending_title, side, buckets[pending_key]))
    return result


def _make_group(key: str, title: str, side: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    subtotals = [row["balance_base"] for row in rows]
    return {
        "key": key,
        "title": title,
        "side": side,
        "subtotal_base": _safe_sum(subtotals),
        "accounts": rows,
    }


def _safe_sum(values: list[str | None]) -> str | None:
    """对折算金额求和；任一为 null 时整体为 null（避免不完整汇率的虚假小计）。"""
    if not values:
        return "0"
    if any(v is None for v in values):
        return None
    total = sum((Decimal(v) for v in values if v is not None), Decimal(0))
    return decimal_text(total)
