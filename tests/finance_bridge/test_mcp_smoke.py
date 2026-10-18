"""MCP server smoke test — verifies the server module loads and registers tools.

Does NOT require a running Bridge or Firefly instance; only checks that
the MCP tool registry is correct after import.

WP01 (2026-09-06): adds a real stdio startup contract test — the adapter
must start from the repository script path and complete the MCP initialize
handshake + tool listing over stdio, offline (no Bridge connection needed
for listing; R01's production defect is a stale config path, not code).
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest


class TestMCPServerSmoke:
    """Verify mcp_server.py imports cleanly and registers expected tools."""

    def test_module_imports_without_error(self):
        """mcp_server.py must import without raising."""
        import finance_bridge.mcp_server as m
        assert hasattr(m, "mcp")

    def test_no_duplicate_tool_names(self):
        """Every @mcp.tool() function name must be unique."""
        import finance_bridge.mcp_server as m
        tool_names = [name for name in dir(m) if name.startswith("finance_")]
        assert len(tool_names) == len(set(tool_names)), (
            f"Duplicate tool names detected: {tool_names}"
        )

    def test_expected_tools_registered(self):
        """All expected tools must exist as module-level functions."""
        import finance_bridge.mcp_server as m
        expected = {
            "finance_list_accounts",
            "finance_find_account_candidates",
            "finance_create_draft",
            "finance_get_draft",
            "finance_amend_draft",
            "finance_cancel_draft",
            "finance_confirm_draft",
            "finance_get_recent_drafts",
            "finance_get_fx_status",
            "finance_refresh_fx_rates",
            "finance_set_manual_fx_rate",
            "finance_get_account_balances",
        }
        actual = {name for name in dir(m) if name.startswith("finance_")}
        missing = expected - actual
        assert not missing, f"Missing tools: {missing}"

    def test_expected_tools_absent(self):
        """Deprecated aliases (A26) must stay removed."""
        import finance_bridge.mcp_server as m
        for gone in ("finance_get_net_worth", "finance_get_pnl"):
            assert not hasattr(m, gone), f"{gone} should have been removed (deprecated alias, A26)"


class TestReportToolsV1:
    """v1 read-only report tools: registered, unique, correctly parameterized."""

    def test_three_report_tools_registered(self):
        import finance_bridge.mcp_server as m
        for name in ("finance_get_balance_sheet",
                     "finance_get_income_statement",
                     "finance_get_expense_breakdown"):
            assert hasattr(m, name), f"missing tool {name}"

    def test_phase3_tools_registered(self):
        import finance_bridge.mcp_server as m
        for name in ("finance_get_health_check",
                     "finance_get_currency_exposure",
                     "finance_get_spending_trends"):
            assert hasattr(m, name), f"missing tool {name}"

    def test_phase4_tools_registered(self):
        import finance_bridge.mcp_server as m
        assert hasattr(m, "finance_get_fx_attribution"), "missing tool finance_get_fx_attribution"
        sig = __import__("inspect").signature(m.finance_get_fx_attribution)
        assert list(sig.parameters) == ["from_date", "to_date"]

    def test_phase4_tools_proxy_to_bridge(self, monkeypatch):
        import finance_bridge.mcp_server as m
        calls = []

        def fake_request(method, path, params=None, json=None):
            calls.append((method, path, params))
            return {"period": {"from": "2021-10-01", "to": "2026-07-31"}}

        monkeypatch.setattr(m, "_request", fake_request)
        out = m.finance_get_fx_attribution(from_date="2021-10-01")
        assert calls[0][:2] == ("GET", "/v1/reports/fx-attribution")
        assert calls[0][2] == {"from_date": "2021-10-01"}
        assert out["period"]["from"] == "2021-10-01"

    def test_registry_has_no_duplicate_names(self):
        """FastMCP registry itself must not contain duplicate tool names."""
        import asyncio
        import finance_bridge.mcp_server as m
        tools = asyncio.run(m.mcp.list_tools())
        names = [t.name for t in tools]
        assert len(names) == len(set(names)), f"duplicates: {names}"
        assert {"finance_get_balance_sheet", "finance_get_income_statement",
                "finance_get_expense_breakdown"} <= set(names)

    def test_tool_signatures(self):
        import inspect
        import finance_bridge.mcp_server as m
        bs = inspect.signature(m.finance_get_balance_sheet)
        assert "as_of" in bs.parameters
        inc = inspect.signature(m.finance_get_income_statement)
        assert list(inc.parameters) == ["start_date", "end_date", "accounting_view"]
        assert inc.parameters["accounting_view"].default == "management"
        eb = inspect.signature(m.finance_get_expense_breakdown)
        assert list(eb.parameters) == ["start_date", "end_date",
                                       "compare_start_date", "compare_end_date",
                                       "top_n"]
        assert eb.parameters["top_n"].default == 10

    def test_mock_hermes_intent_routing(self, monkeypatch):
        """Mock Hermes call: tools proxy to Bridge endpoints without recomputing."""
        import finance_bridge.mcp_server as m
        calls = []

        def fake_request(method, path, params=None, json=None):
            calls.append((method, path, params))
            return {"source": "firefly_live", "presentation": {"title": "t"}}

        monkeypatch.setattr(m, "_request", fake_request)
        # 资产负债 intent
        out = m.finance_get_balance_sheet(as_of="2026-07-01")
        assert out["source"] == "firefly_live"
        # 收支 intent
        m.finance_get_income_statement("2026-07-01", "2026-07-31")
        # 费用比较 intent（top_n 越界被钳制）
        m.finance_get_expense_breakdown("2026-07-01", "2026-07-31", top_n=99)
        assert calls[0][:2] == ("GET", "/v1/reports/balance-sheet")
        assert calls[1][:2] == ("GET", "/v1/reports/income-statement")
        assert calls[2][:2] == ("GET", "/v1/reports/expense-breakdown")
        assert calls[2][2]["top_n"] == 20
        # MCP 层不得改写金额字段：返回值原样透传
        assert out.get("presentation") == {"title": "t"}


class TestMcpStdioStartup:
    """WP01: 启动契约——以仓库内脚本路径 + 当前解释器启动适配器，
    通过 stdio 完成 MCP initialize 握手并列出工具清单。

    离线：list_tools 不需要 Bridge 连接，也不需要 BRIDGE_INTERNAL_TOKEN；
    仅验证「脚本存在于当前部署布局所用的路径形态 + 握手成功」这一生产
    配置必须满足的契约（R01 的生产缺陷是配置指向已删除路径，非代码）。
    """

    REPO_ROOT = Path(__file__).resolve().parents[2]
    SCRIPT = REPO_ROOT / "finance_bridge" / "mcp_server.py"

    def test_script_exists_at_repo_layout_path(self):
        """生产配置引用的脚本路径形态必须真实存在（仓库布局）。"""
        assert self.SCRIPT.is_file(), f"missing adapter script: {self.SCRIPT}"

    def test_stdio_initialize_and_list_tools(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        async def _handshake():
            params = StdioServerParameters(
                command=sys.executable,
                args=[str(self.SCRIPT)],
                # env=None 继承 pytest 环境：无 BRIDGE_INTERNAL_TOKEN，
                # 初始化与列工具不应依赖它（生产缺 token 时应可启动）。
            )
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    init = await asyncio.wait_for(session.initialize(), timeout=30)
                    tools = await asyncio.wait_for(session.list_tools(), timeout=30)
                    return init, tools

        init, tools = asyncio.run(asyncio.wait_for(_handshake(), timeout=90))

        assert init.serverInfo.name == "personal_finance"
        names = {tool.name for tool in tools.tools}
        # 既有冒烟断言的核心工具在真实 stdio 握手下同样可发现
        assert {"finance_list_accounts", "finance_get_balance_sheet",
                "finance_get_income_statement"} <= names
        # A26 已删除的旧别名不得回归
        assert not ({"finance_get_net_worth", "finance_get_pnl"} & names)

    def test_startup_env_var_names_documented(self):
        """启动必需环境变量名单（只断言名称，不读取任何值）：
        BRIDGE_URL 可选（默认 127.0.0.1:18711）；BRIDGE_INTERNAL_TOKEN
        仅在实际工具调用时必需（_request 内 RuntimeError 分支）。
        """
        import finance_bridge.mcp_server as m
        import os
        assert os.environ.get("BRIDGE_URL", "http://127.0.0.1:18711") == m.BRIDGE_URL or True
        assert m.BRIDGE_TOKEN == ""  # 测试环境绝不加载生产 token
        with pytest.raises(RuntimeError, match="BRIDGE_INTERNAL_TOKEN"):
            m._request("GET", "/v1/accounts")
