"""Deterministic, read-only matching for Finance Bridge account aliases.

This module deliberately ranks candidates only.  It never creates aliases or
selects an account on behalf of a caller.
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any

# These are language normalisations, not user-specific learned mappings.
# They make common Chinese bank abbreviations searchable without maintaining a
# mutable synonym table in production data.
ABBREVIATIONS = {
    "工行": "工商银行",
    "招行": "招商银行",
    "建行": "建设银行",
    "中行": "中国银行",
    "农行": "农业银行",
    "交行": "交通银行",
}


def normalize_search_text(value: str) -> str:
    """Normalise text for comparison while preserving the original alias."""
    text = unicodedata.normalize("NFKC", value or "").lower().strip()
    for short, full in ABBREVIATIONS.items():
        text = text.replace(short, full)
    return re.sub(r"[\s\-_/()\[\]{}，。,.!！:：]+", "", text)


def _score(query: str, alias: str) -> int:
    query_normalized = normalize_search_text(query)
    alias_normalized = normalize_search_text(alias)
    if not query_normalized:
        return 0
    if query_normalized == alias_normalized:
        return 100
    if query_normalized in alias_normalized:
        return 80
    if alias_normalized in query_normalized:
        return 70

    # Product words narrow a later human choice but should not prevent the
    # bank-name portion from surfacing candidates (for example: "工行卡").
    query_without_product_words = re.sub(
        r"(信用卡|储蓄卡|银行卡|账户|卡)$", "", query_normalized
    )
    if len(query_without_product_words) >= 2 and query_without_product_words in alias_normalized:
        return 60

    # A query such as "工商银行 信用卡" should find aliases containing both
    # concepts, but one weak shared character must not become a candidate.
    parts = [part for part in re.split(r"[\s，,]+", query.lower()) if len(part) >= 2]
    matched = sum(normalize_search_text(part) in alias_normalized for part in parts)
    return 40 + matched * 10 if matched >= 2 else 0


def find_account_candidates(
    aliases: Iterable[dict[str, Any]],
    query: str,
    account_types: list[str] | None = None,
    currency: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Return active-alias candidates ordered by deterministic relevance."""
    wanted_types = {item.strip().lower() for item in account_types or [] if item.strip()}
    wanted_currency = currency.upper().strip() if currency else None
    candidates: list[dict[str, Any]] = []

    for row in aliases:
        if not row.get("is_active", False):
            continue
        if wanted_types and row["account_type"].lower() not in wanted_types:
            continue
        if wanted_currency and row["currency"].upper() != wanted_currency:
            continue
        score = _score(query, row["alias"])
        if score:
            candidates.append({
                "alias": row["alias"],
                "account_type": row["account_type"],
                "currency": row["currency"],
                "match_score": score,
            })

    candidates.sort(key=lambda item: (-item["match_score"], item["alias"]))
    return candidates[:max(1, min(limit, 20))]
