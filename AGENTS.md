# AGENTS.md

> **公开代码展示副本说明**：本仓库是脱敏后的代码展示副本。私有运维文档
> （`docs/`）、Playwright e2e 套件与截图基线未包含在内；文中若出现指向
> `docs/...` 的链接，其目标文件属于未公开的私有文档。测试夹具全部为合成数据。


## Verification Commands

| Change area | Required command |
|---|---|
| `finance_bridge/` | `python -m pytest tests/ -q --tb=short` |
| `report-web/` | `cd report-web && npx tsc --noEmit && npm test -- --run && npm run build` |
| docs only | none (optionally check relative links) |

`report-web/e2e/` Playwright tests use stateful screenshot comparison and are reviewed by hand; they are not part of the completion gate.

## Definition of Done

Report work as done only when all of the following hold:

- the required command for the changed area above ran and exited 0
- `git diff` was reviewed and contains only changes the request asked for
- behavior you added or changed has a test; failures caused by your change are fixed
- no new warnings or failing tests are left behind; unrelated failures are reported with their exact output

If any of these cannot be met, do not claim completion — report what is not done, the failing output, what you tried, and your recommended next step, then stop.

Prefer exit codes over judgment: compiler > type checker > tests > lint > your own review. "Looks fine" is not evidence.

## Stop and Ask

Work autonomously otherwise — running local tests, fixing failures caused by your change, and rerunning affected checks need no per-step approval. Stop and ask before:

- production writes: deploy, restart, or live edits through `infra/`, Cloudflare Access, or the Firefly/VPS endpoints
- credentials: Firefly token, bank API keys, backup targets
- changes to FX rate handling (fail-closed policy) or the accounting currency semantics
- updating `report-web/e2e/` screenshot baselines
- `git push`, merge, tag, release, deleting data, resetting branches
- the same failure survives two repair attempts, or the same file fails three times
- the request has two readings that would lead to different changes

When you stop: state current status, what you ruled out, and the options that need a decision.

## Financial Invariants (Stop and Ask level)

Violating any rule below means stop and ask before writing code; full semantics live in
[docs/architecture/financial-semantics.md](docs/architecture/financial-semantics.md) (§1.6, §1.3 and §1.1).

- **Single net-worth/total aggregation point**: no second implementation of net-worth or total aggregation may be added. All three totals (Hermes `compute_balance_sheet`, portal summary, `net_worth_trend._point_totals`) come only from `finance_bridge/app/reporting/personal_balance_sheet.py:value_personal_scope`; changing the caliber = edit that function first plus its reconciliation tests.
- **Single business-day source**: backend "today" comes only from `finance_bridge/app/reporting/tools.py:business_today()` (Europe/Berlin); frontend financial date parameters come only from the `berlin*` helpers in `report-web/src/utils/dates.ts`. New financial date parameters must not use `date.today()` or host-timezone values.
- **Percentage unit caliber**: 百分比字段在线缆上按「12.3 = 12.3%」口径流转（禁止 0–1 比例形态）；乘 100 与量化（0.1）只在各后端产出点做一次（`reporting/income_statement.py:359`、`reporting/tools.py:327,556`、`reporting/presentation.py:76,139`、`reporting/expense_breakdown.py:93,101`、`reporting/fx_attribution.py:146`；`contracts.py:format_pct` 为现无调用方的备用口径函数），`%` 后缀只出现在面向用户的文案里（后端预格式化文案 `presentation.py`、`anomaly_detection.py:50`、`contracts.py:format_pct`，前端 `report-web/src/utils/format.ts:formatPct`），下游任何一层都不得二次乘 100（见 [docs/architecture/financial-semantics.md](docs/architecture/financial-semantics.md) §1.1）。

## Locate Before Edit

Read the file you are about to change and its direct callers first. Never write from an assumption about how the code is probably shaped.

## Memory Workflow

Durable context (decisions, architecture, checkpoints) lives in OpenViking. The OpenViking plugin
auto-recalls relevant memories at session start and on each prompt, so read the injected
`<openviking-context>` block before starting substantial work. When it is not enough, retrieve with
the OpenViking MCP tools (`search`, `find`, `read`) — see the `openviking-memory` skill for when to
use each. You rarely need to save anything by hand: the plugin captures and commits the conversation
automatically and OpenViking extracts long-term memories in the background.

This repository's imported notes live under `viking://user/default/resources/dev-memory/personal-treasury`
(architecture, decisions, checkpoints). Repository-specific conventions are documented in the root
README "仓库规范" section and docs/INDEX.md.
