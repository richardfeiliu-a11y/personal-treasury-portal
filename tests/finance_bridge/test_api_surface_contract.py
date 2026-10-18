"""ARCH-02 / Batch 08 —— OpenAPI ↔ report-web `types.ts` 字段集双向契约测试。

目的：把「前端手写 types 与后端 response_model 字段集一致」从人工纪律变成自动断言。
幽灵字段 DATA-03（`AccountBalances.generated_at` / `Transactions.generated_at` 前端有、
后端不返回）正是因为缺这道断言而漏过；现有 `test_web_amount_contract.py` 只守金额类型。

实现取向（规格推荐：不引外部依赖，OpenAPI 为准，TS 侧轻量正则读取）：
- 后端事实来源 = `app.openapi()`（FastAPI 由 `response_model` 生成，属性名即 wire 字段名，
  因此 `alias` / `serialization_alias` 已被折算成真实输出名；额外用
  `test_wire_names_are_pydantic_field_names` 把「OpenAPI 属性名 == pydantic 字段名」
  也钉住，防止别名把比对变成自证）。
- 前端事实来源 = `report-web/src/api/types.ts`（只读，不维护第二份手抄清单：types.ts 的
  interface 全是单行扁平字段，正则读取可自更新，types.ts 一改即红）。
- 配对是**递归自动发现**的：只声明 endpoint → 顶层 interface，嵌套对象 schema 由
  「后端字段指向的组件模型」×「TS 字段类型里出现的已知 interface 名」两边对齐后继续下钻，
  因此新增嵌套模型没有 TS 镜像会立刻红（见 `unmirrored_*` 维度）。
- 两侧都取不到具名模型的内联对象字段不参与断言（后端自由字典 + TS 内联对象字面量，
  如 envelope 的 `period?: { start_date; end_date }`），与端点级自由字典不透明
  （`NON_ASSERTED_ENDPOINTS`）同一取向：只有两侧都换成具名模型才会纳入比对。
- Optional 维度：pydantic 字段「有默认值」即在 OpenAPI 里非 required，但 FastAPI 序列化模型
  时默认值照样输出，故 TS 把这类字段声明为必填是**真实的**；可断言的安全方向是
  「OpenAPI required ⇒ TS 不得带 `?`」（后端保证存在时前端不得声称可缺失）。
  严格 ⇔ 需要改 types.ts（本 batch 禁改前端）且会制造 ~40 条无害噪声，故不采纳。

门户 SPA 消费面（`report-web/src/api/client.ts` 的 9 个 URL；`/api/*` 由
`report-web/nginx.conf.template` 中「`location ~ ^/api/reports/` 白名单与 rewrite 行」
改写到 `/v1/*`）——映射表：

| GET 路径 | 后端 response schema | types.ts interface |
|---|---|---|
| /v1/reports/personal-balance-sheet | PersonalBalanceSheetResponse | PersonalBalanceSheet |
| /v1/reports/net-worth-trend | NetWorthTrendResponse | NetWorthTrend |
| /v1/reports/income-statement | ReportEnvelope | ReportEnvelope（泛型摘要见 TS_ONLY_INTERFACES） |
| /v1/reports/expense-breakdown | ReportEnvelope | ReportEnvelope（泛型摘要 ExpenseBreakdownSummary，见 TS_ONLY_INTERFACES） |
| /v1/reports/account-balances | WebAccountBalancesResponse | AccountBalances |
| /v1/reports/web/fx-attribution | FxAttributionResponse | FxAttribution |
| /v1/reports/web/spending-trends | SpendingTrendsResponse | SpendingTrends |
| /v1/reports/web/currency-exposure | CurrencyExposureResponse | CurrencyExposure |
| /v1/reports/web/transactions | TransactionsResponse | Transactions |
| /v1/reports/web/anomalies | AnomaliesResponse | Anomalies |

递归下钻自动配对的嵌套对（无需硬编码，列此供 review）：
PersonalBalanceSheetResponse → BalanceSheetSummary、WebAccountGroup → WebAccountRow；
NetWorthTrendResponse → NetWorthTrendPoint；ReportEnvelope → ReportSection → ReportSectionRow；
WebAccountBalancesResponse → WebAccountBalanceRow；FxAttributionResponse →
FxAttributionCurrency(=TS FxAttributionRow)；SpendingTrendsResponse → SpendingTrendRow；
CurrencyExposureResponse → CurrencyExposureRow；TransactionsResponse → TransactionRow；
AnomaliesResponse → AnomalyRow。

未断言端点见 `NON_ASSERTED_ENDPOINTS`（含理由）；该表与 OpenAPI 实际路径集双向相等，
所以「新增 /v1/reports/* 端点」会在这里红，而不是静默漏检。

负例常驻化：`test_negative_drift_*` 用注入的假字段/删字段验证比对函数真的有牙
（计划里的「临时注入验证后移除」以元测试形式永久保留）。
"""
from __future__ import annotations

import copy
import re
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from finance_bridge.app.domain import web_reports
from finance_bridge.app.main import app
from finance_bridge.app.reporting import contracts

REPO_ROOT = Path(__file__).resolve().parents[2]
TYPES_TS_PATH = REPO_ROOT / "report-web" / "src" / "api" / "types.ts"
CLIENT_TS_PATH = REPO_ROOT / "report-web" / "src" / "api" / "client.ts"

#: OpenAPI 侧报表路径前缀
REPORT_PATH_PREFIX = "/v1/reports/"
#: Nginx BFF：`/api/reports/...` 由 `report-web/nginx.conf.template` 中
#: 「`location ~ ^/api/reports/` 白名单与 rewrite 行」改写为 `/v1/reports/...`
CLIENT_PATH_PREFIX = "/api/reports/"

# ---------------------------------------------------------------------------
# 契约映射表（唯一需要人工维护的两处：本表 + 豁免表）
# ---------------------------------------------------------------------------

ENDPOINT_TO_TS_INTERFACE: dict[str, str] = {
    "/v1/reports/personal-balance-sheet": "PersonalBalanceSheet",
    "/v1/reports/net-worth-trend": "NetWorthTrend",
    "/v1/reports/income-statement": "ReportEnvelope",
    "/v1/reports/account-balances": "AccountBalances",
    "/v1/reports/web/fx-attribution": "FxAttribution",
    "/v1/reports/web/spending-trends": "SpendingTrends",
    "/v1/reports/web/currency-exposure": "CurrencyExposure",
    "/v1/reports/web/transactions": "Transactions",
    "/v1/reports/web/anomalies": "Anomalies",
    # 2026-10-16 门户化：费用分析分区（Top N + 环比）开始消费此端点，
    # 故从 NON_ASSERTED_ENDPOINTS 移入正式映射（原理由「SPA 不消费」已失效）。
    # 后端 response_model 与 income-statement 同为 ReportEnvelope，摘要收紧见
    # TS_ONLY_INTERFACES 的 ExpenseBreakdownSummary。
    "/v1/reports/expense-breakdown": "ReportEnvelope",
}

#: 刻意不断言的 /v1/reports/* GET 端点 → 理由。条目缺失/多余都会红。
NON_ASSERTED_ENDPOINTS: dict[str, str] = {
    "/v1/reports/balance-sheet": (
        "Hermes/飞书面：response_model=ReportEnvelope，与 income-statement 同一 schema，"
        "字段集已由 /v1/reports/income-statement 断言；SPA 网关白名单不放行、client.ts 不调用"
    ),
    "/v1/reports/recent-drafts": (
        "无 response_model，返回 dict[str, Any]（OpenAPI additionalProperties 自由字典）；"
        "草稿审阅面，SPA 不消费、无 interface 镜像"
    ),
    "/v1/reports/health-check": (
        "compute_health_check() 返回嵌套自由字典（checks 按检查名展开 dict[str, Any]），"
        "OpenAPI 为 additionalProperties：按设计不透明，无 TS 镜像"
        "（门户异常卡消费 /v1/reports/web/anomalies）"
    ),
    "/v1/reports/currency-exposure": (
        "Hermes 面工具版 dict[str, Any]（无 response_model）；门户消费带 schema 的 "
        "/v1/reports/web/currency-exposure"
    ),
    "/v1/reports/fx-attribution": (
        "Hermes 面工具版 dict[str, Any]（无 response_model）；门户消费带 schema 的 "
        "/v1/reports/web/fx-attribution"
    ),
    "/v1/reports/spending-trends": (
        "Hermes 面工具版 dict[str, Any]（无 response_model）；门户消费带 schema 的 "
        "/v1/reports/web/spending-trends"
    ),
}

#: 后端有、前端 types.ts 刻意没有的字段（schema → 字段 → 理由）。
#: 门户专属的 web_reports 模型（DATA-03 幽灵字段已在 Batch 03 清零）此表为空；
#: 唯一被迫的条目集中在 Hermes 共享 envelope `ReportEnvelope` —— 门户只渲染
#: income-statement 的必要子集，其余是飞书卡片载荷/其他报表类型专属字段。
#: 每条都必须仍然成立（见 test_backend_only_exemptions_are_exactly_the_live_drift）。
EXEMPT_BACKEND_ONLY_FIELDS: dict[str, dict[str, str]] = {
    "ReportEnvelope": {
        "presentation": (
            "飞书卡片展示载荷（Presentation：markdown/表头/表格行），Hermes 面专用；"
            "门户自行渲染 sections，刻意不镜像。后端为 required，若门户要消费必须先加进 types.ts"
        ),
        "source": (
            "envelope 元数据 'firefly_live'，三张 v1 报表共用；门户 income-statement 未消费"
            "（门户资产负债表另有同名 source 字段并已断言）"
        ),
        "balance_as_of": (
            "envelope 中仅 balance_sheet 类型会填充（income_statement 恒 None）；"
            "门户资产负债页消费的是 PersonalBalanceSheetResponse.balance_as_of"
        ),
        "fx_method": (
            "envelope 元数据（closing_rate|transaction_date），Hermes/飞书口径说明用；"
            "门户 income-statement 页未消费"
        ),
    },
}

#: 前端有、后端不返回的字段（types 幽灵字段）。DATA-03 已在 Batch 03 清除 —— 保持为空。
EXEMPT_FRONTEND_ONLY_FIELDS: dict[str, dict[str, str]] = {}

#: types.ts 里存在、但没有任何 OpenAPI 模型可对上的 interface → 理由。
TS_ONLY_INTERFACES: dict[str, str] = {
    "IncomeStatementSummary": (
        "ReportEnvelope.summary 在后端是 dict[str, Any]（Hermes envelope 自由字典，"
        "OpenAPI additionalProperties），无 schema 可比；该 interface 是门户对 "
        "income-statement summary 的收窄声明（spec §5.2），改动后端 summary 键需人工同步"
    ),
    "ExpenseBreakdownSummary": (
        "同上：ReportEnvelope.summary 在后端是 dict[str, Any]，无 schema 可比；"
        "该 interface 是门户对 expense-breakdown summary 的收窄声明"
        "（top_n / global_ranking_available / ranking_basis / compare_period 等），"
        "改动后端 summary 键需人工同步"
    ),
}

# ---------------------------------------------------------------------------
# types.ts 读取（单行字段 + 平衡的内联对象；注释行跳过，行尾注释一并剥离）
# ---------------------------------------------------------------------------

_INTERFACE_HEADER_RE = re.compile(r"^export\s+interface\s+(\w+)\b")
_FIELD_RE = re.compile(r"^(\w+)(\?)?\s*:")
_IDENTIFIER_RE = re.compile(r"[A-Za-z_]\w*")
_COMMENT_PREFIXES = ("//", "/*", "*")


@dataclass(frozen=True)
class TsField:
    """types.ts 中一个字段声明。"""

    optional: bool
    type_text: str


def parse_ts_interfaces(source: str) -> dict[str, dict[str, TsField]]:
    """把 `export interface X { field?: Type; ... }` 读成 name -> 字段 -> 声明。

    限制（types.ts 现状即满足）：字段单行声明；内联对象类型的花括号必须与字段同行平衡；
    纯注释行（// /* *）跳过，字段行尾的 `//` 注释一并剥离（否则注释里提到的 interface
    名会被 `ts_referenced_interface` 当成字段类型，错配成假的嵌套对）。
    刻意不支持多行内联对象——真出现时应改 types.ts 或本读取器，
    而不是静默漏字段（漏掉的 interface 会被孤儿检测抓到）。
    """
    interfaces: dict[str, dict[str, TsField]] = {}
    current: dict[str, TsField] | None = None
    depth = 0
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(_COMMENT_PREFIXES):
            continue
        if current is None:
            header = _INTERFACE_HEADER_RE.match(line)
            if header is None:
                continue
            current = interfaces.setdefault(header.group(1), {})
            depth = line.count("{") - line.count("}")
            continue
        if depth == 1:
            match = _FIELD_RE.match(line)
            if match is not None:
                current[match.group(1)] = TsField(
                    optional=match.group(2) is not None,
                    # 行尾 `//` 注释先剥掉：注释里的 interface 名不是字段类型的一部分。
                    type_text=line[match.end():].split("//")[0].strip().rstrip(";"),
                )
        depth += line.count("{") - line.count("}")
        if depth <= 0:
            current = None
    return interfaces


def ts_referenced_interface(type_text: str, known: set[str]) -> str | None:
    """字段类型文本里出现的第一个已知 interface 名（数组/内联对象包装均不影响）。"""
    for token in _IDENTIFIER_RE.findall(type_text):
        if token in known:
            return token
    return None


# ---------------------------------------------------------------------------
# OpenAPI 读取（jsonschema $ref 解析；不引外部依赖）
# ---------------------------------------------------------------------------

Spec = dict[str, Any]


def openapi_document() -> Spec:
    return app.openapi()  # type: ignore[no-any-return]


def _schemas(spec: Spec) -> dict[str, Any]:
    return spec.get("components", {}).get("schemas", {})


def follow_refs(spec: Spec, node: Any) -> tuple[str | None, dict[str, Any]]:
    """跟随 $ref 与 allOf/anyOf/oneOf 的唯一非 null 分支，返回 (组件名, 节点)。"""
    name: str | None = None
    current: Any = node
    for _ in range(8):  # 防环上限
        if not isinstance(current, dict):
            return name, {}
        ref = current.get("$ref")
        if isinstance(ref, str):
            name = ref.rsplit("/", 1)[-1]
            current = _schemas(spec).get(name, {})
            continue
        for key in ("allOf", "anyOf", "oneOf"):
            branches = [
                branch
                for branch in current.get(key, [])
                if isinstance(branch, dict) and branch.get("type") != "null"
            ]
            if len(branches) == 1:
                current = branches[0]
                break
        else:
            return name, current
    return name, current


def response_schema_name(spec: Spec, path: str) -> str | None:
    """GET 200 响应对应的 components.schemas 名；自由字典/内联对象返回 None。"""
    operation = spec.get("paths", {}).get(path, {}).get("get")
    if operation is None:
        return None
    schema = (
        operation.get("responses", {})
        .get("200", {})
        .get("content", {})
        .get("application/json", {})
        .get("schema", {})
    )
    name, node = follow_refs(spec, schema)
    if name is None or "properties" not in node:
        return None
    return name


def field_model_name(spec: Spec, prop_schema: Any) -> str | None:
    """字段 schema（含 Optional/list 包装）背后的组件模型名；标量/自由字典返回 None。"""
    current = prop_schema
    for _ in range(8):
        name, node = follow_refs(spec, current)
        if "properties" in node:
            return name
        items = node.get("items")
        if isinstance(items, dict):
            current = items
            continue
        return None
    return None


def object_field_map(spec: Spec, schema_name: str) -> dict[str, bool] | None:
    """组件模型的 字段名 -> 是否 OpenAPI required；不是对象模型则返回 None。"""
    schema = _schemas(spec).get(schema_name)
    if not isinstance(schema, dict):
        return None
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None
    required = set(schema.get("required", []))
    return {name: name in required for name in properties}


def openapi_property_schemas(spec: Spec, schema_name: str) -> dict[str, Any]:
    schema = _schemas(spec).get(schema_name) or {}
    properties = schema.get("properties")
    return properties if isinstance(properties, dict) else {}


# ---------------------------------------------------------------------------
# 比对（纯函数，便于负例注入）
# ---------------------------------------------------------------------------


@dataclass
class InterfaceDrift:
    """一对 (OpenAPI schema, types.ts interface) 的漂移明细。"""

    endpoint: str
    schema_name: str
    ts_name: str
    schema_missing: bool = False
    ts_missing: bool = False
    backend_only: set[str] = field(default_factory=set)
    frontend_only: set[str] = field(default_factory=set)
    required_but_ts_optional: set[str] = field(default_factory=set)
    unmirrored_backend_models: dict[str, str] = field(default_factory=dict)
    unmirrored_ts_interfaces: dict[str, str] = field(default_factory=dict)

    @property
    def is_clean(self) -> bool:
        return not (
            self.schema_missing
            or self.ts_missing
            or self.backend_only
            or self.frontend_only
            or self.required_but_ts_optional
            or self.unmirrored_backend_models
            or self.unmirrored_ts_interfaces
        )

    def field_set_messages(self) -> list[str]:
        out: list[str] = []
        if self.schema_missing:
            out.append(f"{self._where}: OpenAPI components.schemas 里没有该模型")
        if self.ts_missing:
            out.append(f"{self._where}: types.ts 里没有该 interface")
        if self.backend_only:
            out.append(f"{self._where}: 后端独有字段（前端未声明）{sorted(self.backend_only)}")
        if self.frontend_only:
            out.append(
                f"{self._where}: 前端独有字段（后端不返回，幽灵字段）{sorted(self.frontend_only)}"
            )
        return out

    def optionality_messages(self) -> list[str]:
        if not self.required_but_ts_optional:
            return []
        return [
            (
                f"{self._where}: OpenAPI required 但 TS 标了 '?' "
                f"{sorted(self.required_but_ts_optional)}"
            )
        ]

    def pairing_messages(self) -> list[str]:
        out = [
            f"{self._where}: 字段 {prop} 的后端模型 {model} 在 types.ts 无 interface 镜像"
            for prop, model in sorted(self.unmirrored_backend_models.items())
        ]
        out += [
            f"{self._where}: 字段 {prop} 的 TS interface {iface} 对不上任何后端模型"
            for prop, iface in sorted(self.unmirrored_ts_interfaces.items())
        ]
        return out

    @property
    def _where(self) -> str:
        return f"{self.endpoint}: {self.schema_name} ↔ types.ts/{self.ts_name}"

    def messages(self) -> list[str]:
        return self.field_set_messages() + self.optionality_messages() + self.pairing_messages()


@dataclass
class ContractReport:
    drifts: list[InterfaceDrift]
    covered_ts_interfaces: set[str] = field(default_factory=set)

    @property
    def problems(self) -> list[str]:
        return [msg for drift in self.drifts for msg in drift.messages()]

    def _merged(self, attribute: str) -> dict[str, set[str]]:
        """把同一 schema 在多个端点下的比对结果合并成 schema -> 名称集合。"""
        merged: dict[str, set[str]] = {}
        for drift in self.drifts:
            merged.setdefault(drift.schema_name, set()).update(getattr(drift, attribute))
        return {name: values for name, values in merged.items() if values}

    @property
    def backend_only_fields(self) -> dict[str, set[str]]:
        return self._merged("backend_only")

    @property
    def frontend_only_fields(self) -> dict[str, set[str]]:
        return self._merged("frontend_only")


def compare_pair(
    spec: Spec,
    ts_interfaces: dict[str, dict[str, TsField]],
    endpoint: str,
    schema_name: str,
    ts_name: str,
    exempt_backend_only: dict[str, dict[str, str]],
    exempt_frontend_only: dict[str, dict[str, str]],
    covered: set[str],
) -> list[InterfaceDrift]:
    """从 (schema, interface) 出发递归比对所有可达嵌套对。"""
    known_ts = set(ts_interfaces)
    drifts: list[InterfaceDrift] = []
    stack: list[tuple[str, str]] = [(schema_name, ts_name)]
    seen: set[tuple[str, str]] = set()
    while stack:
        current_schema, current_ts = stack.pop()
        if (current_schema, current_ts) in seen:
            continue
        seen.add((current_schema, current_ts))
        covered.add(current_ts)
        drift = InterfaceDrift(endpoint=endpoint, schema_name=current_schema, ts_name=current_ts)
        backend_fields = object_field_map(spec, current_schema)
        ts_fields = ts_interfaces.get(current_ts)
        drift.schema_missing = backend_fields is None
        drift.ts_missing = ts_fields is None
        if backend_fields is None or ts_fields is None:
            drifts.append(drift)
            continue

        exempt_b = exempt_backend_only.get(current_schema, {})
        exempt_f = exempt_frontend_only.get(current_ts, {})
        drift.backend_only = (set(backend_fields) - set(ts_fields)) - set(exempt_b)
        drift.frontend_only = (set(ts_fields) - set(backend_fields)) - set(exempt_f)
        drift.required_but_ts_optional = {
            name
            for name, required in backend_fields.items()
            if required and name in ts_fields and ts_fields[name].optional
        }

        properties = openapi_property_schemas(spec, current_schema)
        for prop, ts_field in ts_fields.items():
            if prop not in backend_fields:
                continue
            backend_model = field_model_name(spec, properties[prop])
            ts_model = ts_referenced_interface(ts_field.type_text, known_ts)
            if backend_model and not ts_model:
                drift.unmirrored_backend_models[prop] = backend_model
            elif ts_model and not backend_model:
                drift.unmirrored_ts_interfaces[prop] = ts_model
            elif backend_model and ts_model:
                stack.append((backend_model, ts_model))
        drifts.append(drift)
    return drifts


def compare_contract(
    spec: Spec,
    ts_interfaces: dict[str, dict[str, TsField]],
    endpoints: dict[str, str] = ENDPOINT_TO_TS_INTERFACE,
    exempt_backend_only: dict[str, dict[str, str]] = EXEMPT_BACKEND_ONLY_FIELDS,
    exempt_frontend_only: dict[str, dict[str, str]] = EXEMPT_FRONTEND_ONLY_FIELDS,
) -> ContractReport:
    """全部映射端点（含递归嵌套）的字段集/可选性/嵌套镜像比对。"""
    report = ContractReport(drifts=[])
    for endpoint, ts_name in endpoints.items():
        schema_name = response_schema_name(spec, endpoint)
        if schema_name is None:
            report.drifts.append(
                InterfaceDrift(
                    endpoint=endpoint,
                    schema_name=f"<{endpoint} 的响应不是具名模型（response_model 丢失？）>",
                    ts_name=ts_name,
                    schema_missing=True,
                )
            )
            continue
        report.drifts.extend(
            compare_pair(
                spec,
                ts_interfaces,
                endpoint,
                schema_name,
                ts_name,
                exempt_backend_only,
                exempt_frontend_only,
                report.covered_ts_interfaces,
            )
        )
    return report


def _assert_clean(report: ContractReport, context: str) -> None:
    problems = report.problems
    assert not problems, f"OpenAPI ↔ types.ts 契约漂移（{context}）：\n" + "\n".join(problems)


# ---------------------------------------------------------------------------
# 模块级事实（OpenAPI 文档 + types.ts + client.ts，读取一次供各用例共享）
# ---------------------------------------------------------------------------

SPEC = openapi_document()
TS_INTERFACES = parse_ts_interfaces(TYPES_TS_PATH.read_text(encoding="utf-8"))
CLIENT_TS_SOURCE = CLIENT_TS_PATH.read_text(encoding="utf-8")


def client_ts_consumed_paths() -> set[str]:
    """client.ts 里请求的 `/api/reports/...` 路径 → 折算成 OpenAPI 侧的 /v1 路径。"""
    raw = re.findall(r'"(/api/reports/[^"]+)"', CLIENT_TS_SOURCE)
    return {REPORT_PATH_PREFIX + path[len(CLIENT_PATH_PREFIX) :] for path in raw}


def openapi_report_get_paths(spec: Spec) -> set[str]:
    return {
        path
        for path, operations in spec.get("paths", {}).items()
        if path.startswith(REPORT_PATH_PREFIX) and "get" in operations
    }


#: 契约模型的声明处（门户面 + Hermes envelope）。别名钉死按组件名在这两处查类。
CONTRACT_MODEL_MODULES: tuple[types.ModuleType, ...] = (web_reports, contracts)


def pydantic_model_for(schema_name: str) -> type[BaseModel] | None:
    """OpenAPI 组件名 → 声明它的 pydantic 模型类；查不到返回 None。"""
    for module in CONTRACT_MODEL_MODULES:
        candidate = getattr(module, schema_name, None)
        if isinstance(candidate, type) and issubclass(candidate, BaseModel):
            return candidate
    return None


# ---------------------------------------------------------------------------
# 断言
# ---------------------------------------------------------------------------


def test_types_ts_and_client_ts_are_readable():
    """读取器不能静默返回空 —— 否则整份契约测试会变成空转。"""
    assert len(TS_INTERFACES) >= 12, f"types.ts 解析结果异常：{sorted(TS_INTERFACES)}"
    assert "PersonalBalanceSheet" in TS_INTERFACES
    assert client_ts_consumed_paths(), "client.ts 未解析到任何 /api/reports/ 调用"


def test_parse_ts_interfaces_strips_trailing_line_comment():
    """读取器级：字段行尾 `//` 注释剥离后，注释里的 interface 名不会被当成字段类型。"""
    ts = parse_ts_interfaces(
        "export interface Holder {\n"
        "  amount: string; // see Target for shape\n"
        "  nested: Target; // 真实引用不受影响\n"
        "}\n"
        "export interface Target {\n"
        "  value: string;\n"
        "}\n"
    )
    known = set(ts)
    assert ts["Holder"]["amount"].type_text == "string"
    assert ts_referenced_interface(ts["Holder"]["amount"].type_text, known) is None
    assert ts_referenced_interface(ts["Holder"]["nested"].type_text, known) == "Target"


def test_every_openapi_report_endpoint_is_classified():
    """OpenAPI 里每个 /v1/reports/* GET 端点都必须被显式分类（断言或记录理由）。

    新增端点若没进映射表/未断言表，这里红 —— 契约覆盖不再靠人记。
    """
    actual = openapi_report_get_paths(SPEC)
    classified = set(ENDPOINT_TO_TS_INTERFACE) | set(NON_ASSERTED_ENDPOINTS)
    assert actual == classified, (
        f"/v1/reports/* GET 端点集合与测试内分类表不一致：\n"
        f"  OpenAPI 新增未分类: {sorted(actual - classified)}\n"
        f"  分类表已失效: {sorted(classified - actual)}\n"
        f"（新增端点请进 ENDPOINT_TO_TS_INTERFACE 或 NON_ASSERTED_ENDPOINTS+理由）"
    )


def test_classification_tables_do_not_overlap():
    assert not (set(ENDPOINT_TO_TS_INTERFACE) & set(NON_ASSERTED_ENDPOINTS))


def test_non_asserted_endpoints_have_reasons():
    assert all(reason.strip() for reason in NON_ASSERTED_ENDPOINTS.values())


def test_asserted_endpoints_are_consumed_by_client_ts():
    """映射表里的端点必须真的被 SPA 调用（否则映射是历史残留）。"""
    consumed = client_ts_consumed_paths()
    stale = set(ENDPOINT_TO_TS_INTERFACE) - consumed
    assert not stale, f"ENDPOINT_TO_TS_INTERFACE 中的端点 client.ts 并未调用：{sorted(stale)}"


def test_client_ts_consumed_endpoints_are_asserted():
    """SPA 调用的每个 /api/reports/* 都必须落在断言集里（不能静默漂移）。"""
    unmapped = client_ts_consumed_paths() - set(ENDPOINT_TO_TS_INTERFACE)
    assert not unmapped, (
        f"client.ts 消费但契约测试未映射的端点：{sorted(unmapped)}"
        "（请加入 ENDPOINT_TO_TS_INTERFACE 并补 types.ts interface）"
    )


@pytest.mark.parametrize("endpoint", sorted(ENDPOINT_TO_TS_INTERFACE))
def test_mapped_ts_interface_exists_in_types_ts(endpoint: str):
    ts_name = ENDPOINT_TO_TS_INTERFACE[endpoint]
    assert ts_name in TS_INTERFACES, (
        f"{endpoint} 映射的 types.ts interface {ts_name} 不存在（改名或删除？）"
    )


@pytest.mark.parametrize("endpoint", sorted(ENDPOINT_TO_TS_INTERFACE))
def test_endpoint_response_is_a_named_model(endpoint: str):
    """门户消费的响应必须有具名 pydantic 模型（dict[str, Any] 会让本测试失去抓手）。"""
    schema_name = response_schema_name(SPEC, endpoint)
    assert schema_name is not None, f"{endpoint} 的 200 响应不是具名 components schema"


@pytest.mark.parametrize("endpoint", sorted(ENDPOINT_TO_TS_INTERFACE))
def test_field_name_sets_match_bidirectionally(endpoint: str):
    """双向字段名集合一致（豁免清单外）：后端多发/前端多写都会红。"""
    report = compare_contract(
        SPEC,
        TS_INTERFACES,
        endpoints={endpoint: ENDPOINT_TO_TS_INTERFACE[endpoint]},
    )
    problems = [msg for drift in report.drifts for msg in drift.field_set_messages()]
    assert not problems, f"{endpoint} 字段集漂移：\n" + "\n".join(problems)


@pytest.mark.parametrize("endpoint", sorted(ENDPOINT_TO_TS_INTERFACE))
def test_optionality_required_fields_are_not_optional_in_ts(endpoint: str):
    """后端 OpenAPI 标 required 的字段，前端不得声明成 `field?:`（缺失语义反向）。"""
    report = compare_contract(
        SPEC,
        TS_INTERFACES,
        endpoints={endpoint: ENDPOINT_TO_TS_INTERFACE[endpoint]},
    )
    problems = [msg for drift in report.drifts for msg in drift.optionality_messages()]
    assert not problems, f"{endpoint} 可选性漂移：\n" + "\n".join(problems)


@pytest.mark.parametrize("endpoint", sorted(ENDPOINT_TO_TS_INTERFACE))
def test_nested_models_have_ts_mirrors(endpoint: str):
    """后端每个嵌套对象模型都必须被某个 TS interface 接住（新嵌套层不会漏检）。"""
    report = compare_contract(
        SPEC,
        TS_INTERFACES,
        endpoints={endpoint: ENDPOINT_TO_TS_INTERFACE[endpoint]},
    )
    problems = [msg for drift in report.drifts for msg in drift.pairing_messages()]
    assert not problems, f"{endpoint} 嵌套结构漂移：\n" + "\n".join(problems)


def test_whole_contract_is_clean():
    """一次跑完全量，给出聚合视图（前面按维度拆分的断言的汇总）。"""
    _assert_clean(compare_contract(SPEC, TS_INTERFACES), "全量 /v1/reports/* 映射端点")


def test_backend_only_exemptions_are_exactly_the_live_drift():
    """豁免表必须与「关掉豁免后的真实后端独有字段」逐字相等。

    双向相等 = 既有失效豁免（该删没删）会红，也有新漂移靠豁免蒙混过关会红。
    """
    report = compare_contract(
        SPEC, TS_INTERFACES, exempt_backend_only={}, exempt_frontend_only={}
    )
    live = report.backend_only_fields
    declared = {
        schema: set(fields) for schema, fields in EXEMPT_BACKEND_ONLY_FIELDS.items() if fields
    }
    assert live == declared, (
        "后端独有字段豁免表与真实漂移不符：\n"
        f"  真实未同步字段（补 types.ts 或显式豁免+理由）: "
        f"{ {k: sorted(v) for k, v in live.items()} }\n"
        f"  当前豁免表: { {k: sorted(v) for k, v in declared.items()} }"
    )


def test_frontend_has_no_ghost_fields_exemption():
    """幽灵字段（前端独有）豁免清单必须为空 —— DATA-03 已在 Batch 03 清零。"""
    assert EXEMPT_FRONTEND_ONLY_FIELDS == {}, (
        f"幽灵字段豁免清单必须为空（Batch 03 已清零）：{EXEMPT_FRONTEND_ONLY_FIELDS}"
    )
    report = compare_contract(
        SPEC, TS_INTERFACES, exempt_backend_only={}, exempt_frontend_only={}
    )
    assert report.frontend_only_fields == {}, (
        f"出现新的幽灵字段：{ {k: sorted(v) for k, v in report.frontend_only_fields.items()} }"
    )


def test_all_exemption_entries_have_reasons():
    for table_name, table in (
        ("EXEMPT_BACKEND_ONLY_FIELDS", EXEMPT_BACKEND_ONLY_FIELDS),
        ("EXEMPT_FRONTEND_ONLY_FIELDS", EXEMPT_FRONTEND_ONLY_FIELDS),
        ("TS_ONLY_INTERFACES", TS_ONLY_INTERFACES),
    ):
        for key, value in table.items():
            if isinstance(value, str):
                assert value.strip(), f"{table_name}[{key}] 缺理由"
            else:
                for prop, reason in value.items():
                    assert reason.strip(), f"{table_name}[{key}][{prop}] 缺理由"


def test_types_ts_interfaces_are_all_covered_or_exempted():
    """types.ts 里没被任何后端模型接住的 interface 必须显式登记理由。"""
    report = compare_contract(SPEC, TS_INTERFACES)
    orphans = set(TS_INTERFACES) - report.covered_ts_interfaces
    assert orphans == set(TS_ONLY_INTERFACES), (
        f"types.ts 孤儿 interface 与登记表不一致：\n"
        f"  新孤儿（未被后端 schema 覆盖，需删除或登记理由）: {sorted(orphans - set(TS_ONLY_INTERFACES))}\n"
        f"  已不再孤儿的登记项: {sorted(set(TS_ONLY_INTERFACES) - orphans)}"
    )


def test_wire_names_are_pydantic_field_names():
    """OpenAPI 属性名必须等于 pydantic 字段名，且契约模型不用 alias。

    比对以 OpenAPI（= wire 名）为准，别名本已被正确折算；这条把「wire 名 == 模型字段名」
    钉住，避免将来引入 `alias`/`serialization_alias`/`alias_generator` 后，
    后端代码里读到的字段名与契约测试断言的名字悄悄分叉。
    """
    report = compare_contract(SPEC, TS_INTERFACES)
    assert report.drifts, "契约遍历没有覆盖任何 schema，检查映射表"
    checked: list[str] = []
    for schema_name in sorted({drift.schema_name for drift in report.drifts}):
        model = pydantic_model_for(schema_name)
        assert model is not None, (
            f"{schema_name} 在 {CONTRACT_MODEL_MODULES} 中找不到 pydantic 模型："
            "契约模型搬家了，请把它登记进 CONTRACT_MODEL_MODULES（并确认门户仍在消费）"
        )
        assert set(model.model_fields) == set(openapi_property_schemas(SPEC, schema_name)), (
            f"{schema_name}: pydantic 字段名与 OpenAPI 属性名不一致"
            "（alias / serialization_alias / exclude_none 都会造成这种分叉）"
        )
        for field_name, field_info in model.model_fields.items():
            assert (
                field_info.alias is None
                and field_info.serialization_alias is None
                and field_info.validation_alias is None
            ), f"{schema_name}.{field_name} 使用了别名，wire 名与代码字段名已分叉"
        checked.append(schema_name)
    assert len(checked) >= 20, f"契约遍历覆盖的模型过少：{checked}"


# ---------------------------------------------------------------------------
# 负例（常驻）：证明比对函数真的有牙
# ---------------------------------------------------------------------------


def _drift_for(report: ContractReport, schema_name: str) -> InterfaceDrift:
    for drift in report.drifts:
        if drift.schema_name == schema_name:
            return drift
    names = [drift.schema_name for drift in report.drifts]
    raise AssertionError(f"报告里没有 {schema_name} 的比对结果：{names}")


def _pop_ts_field(
    ts: dict[str, dict[str, TsField]], iface: str, field_name: str
) -> TsField:
    """元测试用：删掉一个确实存在的 TS 字段（前提不成立时给出明确提示）。"""
    assert field_name in ts.get(iface, {}), (
        f"元测试前提失效：types.ts/{iface}.{field_name} 不存在（契约改名后请同步本用例）"
    )
    return ts[iface].pop(field_name)


def test_negative_drift_injected_backend_field_is_detected():
    """后端多一个字段（模拟新增未同步前端）→ 必须报后端独有。"""
    spec = copy.deepcopy(SPEC)
    spec["components"]["schemas"]["PersonalBalanceSheetResponse"]["properties"]["ghost_field"] = {
        "type": "string"
    }
    report = compare_contract(
        spec,
        TS_INTERFACES,
        endpoints={"/v1/reports/personal-balance-sheet": "PersonalBalanceSheet"},
    )
    assert report.problems, "注入后端幽灵字段后契约仍然绿"
    assert "ghost_field" in _drift_for(report, "PersonalBalanceSheetResponse").backend_only


def test_negative_drift_removed_ts_field_is_detected():
    """types.ts 少一个字段（模拟误删 interface 字段）→ 必须报后端独有。"""
    ts = copy.deepcopy(TS_INTERFACES)
    removed = _pop_ts_field(ts, "WebAccountRow", "balance_native")
    report = compare_contract(
        spec=SPEC,
        ts_interfaces=ts,
        endpoints={"/v1/reports/personal-balance-sheet": "PersonalBalanceSheet"},
    )
    drift = _drift_for(report, "WebAccountRow")
    assert "balance_native" in drift.backend_only, drift
    assert removed.optional is False


def test_negative_drift_added_ts_field_is_detected():
    """types.ts 多一个幽灵字段（DATA-03 原样复刻）→ 必须报前端独有。"""
    ts = copy.deepcopy(TS_INTERFACES)
    ts["AccountBalances"]["generated_at"] = TsField(optional=True, type_text="string")
    report = compare_contract(
        spec=SPEC,
        ts_interfaces=ts,
        endpoints={"/v1/reports/account-balances": "AccountBalances"},
    )
    assert "generated_at" in _drift_for(report, "WebAccountBalancesResponse").frontend_only


def test_negative_drift_removed_ts_nested_interface_is_detected():
    """前端字段类型不再指向嵌套 interface → 报嵌套镜像缺失。"""
    ts = copy.deepcopy(TS_INTERFACES)
    ts["PersonalBalanceSheet"]["summary"] = TsField(
        optional=False, type_text="Record<string, unknown>"
    )
    report = compare_contract(
        spec=SPEC,
        ts_interfaces=ts,
        endpoints={"/v1/reports/personal-balance-sheet": "PersonalBalanceSheet"},
    )
    drift = _drift_for(report, "PersonalBalanceSheetResponse")
    assert drift.unmirrored_backend_models.get("summary") == "BalanceSheetSummary", drift


def test_negative_drift_required_field_loosened_in_ts_is_detected():
    """后端 required、前端改成 `?` → 可选性维度必须红。"""
    ts = copy.deepcopy(TS_INTERFACES)
    ts["PersonalBalanceSheet"]["generated_at"] = TsField(optional=True, type_text="string")
    report = compare_contract(
        spec=SPEC,
        ts_interfaces=ts,
        endpoints={"/v1/reports/personal-balance-sheet": "PersonalBalanceSheet"},
    )
    drift = _drift_for(report, "PersonalBalanceSheetResponse")
    assert "generated_at" in drift.required_but_ts_optional, drift


def test_negative_drift_exemption_masks_only_its_own_field():
    """豁免只挡它自己那一个字段：同 schema 的新增字段照旧红。"""
    spec = copy.deepcopy(SPEC)
    spec["components"]["schemas"]["ReportEnvelope"]["properties"]["brand_new_field"] = {
        "type": "string"
    }
    report = compare_contract(
        spec=spec,
        ts_interfaces=TS_INTERFACES,
        endpoints={"/v1/reports/income-statement": "ReportEnvelope"},
    )
    backend_only = _drift_for(report, "ReportEnvelope").backend_only
    assert "brand_new_field" in backend_only
    assert set(EXEMPT_BACKEND_ONLY_FIELDS["ReportEnvelope"]) & backend_only == set()


def test_negative_drift_unmapped_endpoint_is_detected():
    """OpenAPI 新增端点而未进分类表 → 分类断言红。"""
    spec = copy.deepcopy(SPEC)
    spec["paths"]["/v1/reports/web/brand-new-report"] = {
        "get": {
            "responses": {
                "200": {
                    "content": {
                        "application/json": {
                            "schema": {"$ref": "#/components/schemas/AnomaliesResponse"}
                        }
                    }
                }
            }
        }
    }
    actual = openapi_report_get_paths(spec)
    classified = set(ENDPOINT_TO_TS_INTERFACE) | set(NON_ASSERTED_ENDPOINTS)
    assert actual - classified == {"/v1/reports/web/brand-new-report"}


def test_negative_drift_response_model_downgrade_is_detected():
    """门户端点被降级成 dict[str, Any]（丢 response_model）→ 红，而不是静默失去覆盖。"""
    spec = copy.deepcopy(SPEC)
    spec["paths"]["/v1/reports/web/anomalies"]["get"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"] = {"additionalProperties": True, "type": "object"}
    report = compare_contract(
        spec=spec, ts_interfaces=TS_INTERFACES, endpoints={"/v1/reports/web/anomalies": "Anomalies"}
    )
    assert report.problems, "response_model 被降级成自由字典后契约仍然绿"
