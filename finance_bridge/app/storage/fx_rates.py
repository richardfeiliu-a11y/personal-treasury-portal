"""FX-rate repository.  Rate convention: 1 quote_currency = rate CNY."""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from finance_bridge.app.storage.sqlite import SQLiteStorage


def _global_storage() -> SQLiteStorage:
    from finance_bridge.app.state import get_storage
    return get_storage()


class FXRateRepository:
    def __init__(self, storage: SQLiteStorage | None = None):
        self._explicit = storage

    def _storage(self) -> SQLiteStorage:
        return self._explicit or _global_storage()

    @staticmethod
    def _validate(currency: str, rate: Decimal | str) -> tuple[str, str]:
        code = currency.strip().upper()
        if len(code) != 3 or not code.isalpha():
            raise ValueError("currency must be a three-letter ISO code")
        try:
            value = Decimal(str(rate))
        except InvalidOperation as exc:
            raise ValueError("rate must be a decimal") from exc
        if not value.is_finite() or value <= 0 or -value.as_tuple().exponent > 12:
            raise ValueError("rate must be positive with at most 12 decimal places")
        return code, format(value, "f")

    def upsert_market(self, currency: str, rate_to_cny: Decimal | str, rate_date: str,
                      source: str = "ECB") -> int:
        code, rate = self._validate(currency, rate_to_cny)
        if code == "CNY" and Decimal(rate) != Decimal(1):
            raise ValueError("CNY rate must equal 1")
        storage = self._storage()
        with storage._connection() as conn:
            conn.execute("""
                INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, rate_type,
                                      source, manual_override, created_at)
                VALUES ('CNY', ?, ?, ?, 'market', ?, 0, ?)
                ON CONFLICT(base_currency, quote_currency, rate_date, source) DO UPDATE SET
                    rate=excluded.rate, rate_type='market', manual_override=0,
                    created_at=excluded.created_at
            """, (code, rate, rate_date, source, _now()))
            row = conn.execute("""SELECT id FROM fx_rates WHERE base_currency='CNY'
                AND quote_currency=? AND rate_date=? AND source=?""", (code, rate_date, source)).fetchone()
            conn.commit()
            return int(row["id"])

    def set_manual(self, currency: str, rate_to_cny: Decimal | str, rate_date: str,
                   reason: str, actor: str = "hermes") -> dict[str, Any]:
        if not reason.strip():
            raise ValueError("reason is required for a manual FX rate")
        code, rate = self._validate(currency, rate_to_cny)
        if code == "CNY" and Decimal(rate) != Decimal(1):
            raise ValueError("CNY rate must equal 1")
        storage = self._storage()
        source = "manual"
        with storage._connection() as conn:
            old = conn.execute("""SELECT * FROM fx_rates WHERE base_currency='CNY' AND quote_currency=?
                AND rate_date=? AND source=?""", (code, rate_date, source)).fetchone()
            conn.execute("""INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, rate_type,
                source, manual_override, created_at) VALUES ('CNY', ?, ?, ?, 'manual', ?, 1, ?)
                ON CONFLICT(base_currency, quote_currency, rate_date, source) DO UPDATE SET
                    rate=excluded.rate, rate_type='manual', manual_override=1, created_at=excluded.created_at
            """, (code, rate, rate_date, source, _now()))
            row = conn.execute("""SELECT * FROM fx_rates WHERE base_currency='CNY' AND quote_currency=?
                AND rate_date=? AND source=?""", (code, rate_date, source)).fetchone()
            conn.commit()
        result = dict(row)
        storage.record_audit(actor, "set_manual_fx_rate", "fx_rate", result["id"],
                             dict(old) if old else None,
                             {**result, "reason": reason})
        return result

    def effective_rate(self, currency: str, as_of: str) -> dict[str, Any] | None:
        code = currency.strip().upper()
        if code == "CNY":
            return {"currency": "CNY", "rate": "1", "rate_date": as_of,
                    "source": "fixed", "manual_override": False}
        with self._storage()._connection() as conn:
            # 政策（fx-policy.md）：报表日用报表日最新汇率；手工价仅在同行日期内优先。
            # manual_override 不得排在 rate_date 之前，否则一条历史手工价会永久遮蔽新市场价。
            row = conn.execute("""SELECT * FROM fx_rates WHERE base_currency='CNY' AND quote_currency=?
                AND rate_date <= ? ORDER BY rate_date DESC, manual_override DESC, created_at DESC LIMIT 1""",
                (code, as_of)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["currency"] = result.pop("quote_currency")
        result["manual_override"] = bool(result["manual_override"])
        return result

    def latest_rate(self, currency: str) -> dict[str, Any] | None:
        """Return the latest effective stored rate, independent of transaction date."""
        code = currency.strip().upper()
        if code == "CNY":
            return {"currency": "CNY", "rate": "1", "rate_date": "current",
                    "source": "fixed", "manual_override": False}
        with self._storage()._connection() as conn:
            row = conn.execute("""SELECT * FROM fx_rates WHERE base_currency='CNY' AND quote_currency=?
                ORDER BY rate_date DESC, manual_override DESC, created_at DESC LIMIT 1""", (code,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["currency"] = result.pop("quote_currency")
        result["manual_override"] = bool(result["manual_override"])
        return result

    def historical_rate(self, currency: str, as_of: str) -> dict[str, Any] | None:
        """汇率：rate_date <= as_of 的最近一条（周末/节假日前向填充）。

        与 effective_rate 同一选择器（fx-policy.md：手工价仅在同行日期内优先）。
        historical_rate 曾有自己的选择器（rate_type='historical' 优先），CODE-01
        审计修复统一为日期优先后两者逐字重复，A19 消融合并为委托调用。
        """
        return self.effective_rate(currency, as_of)

    def upsert_historical(self, currency: str, rate_to_cny: Decimal | str, rate_date: str,
                          source: str = "ECB") -> int:
        code, rate = self._validate(currency, rate_to_cny)
        if code == "CNY" and Decimal(rate) != Decimal(1):
            raise ValueError("CNY rate must equal 1")
        storage = self._storage()
        with storage._connection() as conn:
            conn.execute("""
                INSERT INTO fx_rates (base_currency, quote_currency, rate, rate_date, rate_type,
                                      source, manual_override, created_at)
                VALUES ('CNY', ?, ?, ?, 'historical', ?, 0, ?)
                ON CONFLICT(base_currency, quote_currency, rate_date, source) DO UPDATE SET
                    rate=excluded.rate, rate_type='historical', manual_override=0,
                    created_at=excluded.created_at
            """, (code, rate, rate_date, source, _now()))
            row = conn.execute("""SELECT id FROM fx_rates WHERE base_currency='CNY'
                AND quote_currency=? AND rate_date=? AND source=?""", (code, rate_date, source)).fetchone()
            conn.commit()
            return int(row["id"])

    def currencies(self) -> list[str]:
        with self._storage()._connection() as conn:
            rows = conn.execute("SELECT DISTINCT quote_currency FROM fx_rates ORDER BY quote_currency").fetchall()
        return [str(row["quote_currency"]) for row in rows]

    def earliest_rate_date(self) -> str | None:
        """Return the earliest stored rate date (YYYY-MM-DD), or None when empty."""
        with self._storage()._connection() as conn:
            row = conn.execute("SELECT MIN(rate_date) AS d FROM fx_rates").fetchone()
        d = row["d"]
        return str(d) if d else None

    def latest_rate_date(self) -> str | None:
        """Return the newest stored rate date (YYYY-MM-DD) across all currencies/sources.

        表级 MAX：供健康检查判定「汇率库整体是否过期」（REL-02）。单币种缺率
        不走这里（那是 fx_complete 的行级裁决），因此本函数刻意不按 quote_currency
        或 rate_type/source 过滤 —— manual 与 historical 行同样证明库里有可用日期。
        """
        with self._storage()._connection() as conn:
            row = conn.execute("SELECT MAX(rate_date) AS d FROM fx_rates").fetchone()
        d = row["d"]
        return str(d) if d else None

    def latest_rate_date_for(self, currency: str) -> str | None:
        """单个币种的最新入库汇率日（AUD-26）。

        「表级 MAX」会掩盖局部停滞（生产观察到：多个零余额币种长期无新汇率，
        而表级 MAX 因为其他币种新鲜而一直是当天）。本函数让健康检查能按币种
        如实上报。与 `latest_rate_date` 同样不过滤 rate_type/source —— manual
        与 historical 行同样代表该币种有可用日期。
        """
        code = currency.strip().upper()
        with self._storage()._connection() as conn:
            row = conn.execute(
                "SELECT MAX(rate_date) AS d FROM fx_rates"
                " WHERE base_currency='CNY' AND quote_currency=?",
                (code,),
            ).fetchone()
        d = row["d"]
        return str(d) if d else None


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


fx_rates = FXRateRepository()
