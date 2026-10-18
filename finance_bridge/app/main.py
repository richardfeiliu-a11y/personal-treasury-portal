"""Finance Bridge FastAPI application."""
from __future__ import annotations

import logging
import secrets
import time
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from finance_bridge.app.account_groups import (
    AccountGroupConfigError,
    config_path_from_env,
    load_account_groups,
)
from finance_bridge.app.api.confirmations import router as confirmations_router
from finance_bridge.app.api.drafts import router as drafts_router
from finance_bridge.app.api.jobs import router as jobs_router
from finance_bridge.app.api.report_web import router as report_web_router
from finance_bridge.app.api.reports import router as reports_router
from finance_bridge.app.config import settings
from finance_bridge.app.state import close_storage, get_storage, init_storage
from finance_bridge.app.storage.job_runs import JobRunRepository

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("finance_bridge")
access_logger = logging.getLogger("finance_bridge.access")


async def access_log_middleware(request, call_next):
    """脱敏访问日志（WP10/R09）。

    只输出 route（不含 query string）/status/duration_ms/request_id；
    刻意不记录完整 URL 参数、请求/响应正文、金额或凭据——访问日志
    不能成为敏感数据的第二份拷贝。
    """
    request_id = str(uuid.uuid4())
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = round((time.perf_counter() - start) * 1000.0, 2)
    access_logger.info(
        "route=%s status=%s duration_ms=%s request_id=%s",
        request.url.path,
        response.status_code,
        duration_ms,
        request_id,
    )
    return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时校验账户分组配置：配置不合法直接拒绝启动，避免带病运行。
    try:
        load_account_groups(config_path_from_env())
    except AccountGroupConfigError as exc:
        logger.error("Account groups config invalid: %s", exc)
        raise SystemExit(f"Account groups config invalid: {exc}")
    # Warn early if production is missing Firefly credentials
    if settings.is_production and not settings.has_firefly_credentials:
        logger.critical(
            "FIREFLY_TOKEN not configured in production — "
            "confirm endpoint will refuse all requests (503)"
        )
    logger.info("Finance Bridge starting – initialising storage")
    init_storage()
    yield
    logger.info("Finance Bridge shutting down — closing storage")
    close_storage()


app = FastAPI(
    title="Finance Bridge",
    description="Deterministic financial control layer for Personal ERP",
    version="0.1.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def access_log_wrapper(request, call_next):
    async def _inner(req):
        return await require_internal_token(req, call_next)
    return await access_log_middleware(request, _inner)


async def require_internal_token(request, call_next):
    """Protect all /v1 endpoints with the Bridge-to-Hermes bearer token."""
    if request.url.path in ("/healthz", "/health/freshness") or not request.url.path.startswith("/v1/"):
        return await call_next(request)

    configured = settings.bridge_internal_token
    supplied = request.headers.get("authorization", "")
    expected = f"Bearer {configured}" if configured else ""
    if not configured or not secrets.compare_digest(supplied, expected):
        return JSONResponse(
            status_code=401,
            content={"detail": "Bridge authentication required"},
        )

    return await call_next(request)


@app.get("/healthz")
async def healthz():
    # Real SQLite connectivity check
    db_status = "ok"
    db_ok = True
    try:
        storage = get_storage()
        with storage._connection() as conn:
            conn.execute("SELECT 1")
    except Exception as e:
        db_ok = False
        db_status = "error"
        logger.error("healthz database check failed: %s", e)

    # Firefly API ping (lightweight, 3s timeout)
    firefly_status = "not_configured"
    if settings.has_firefly_credentials:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(
                    f"{settings.firefly_api_url}/about",
                    headers={"Authorization": f"Bearer {settings.firefly_token}"},
                )
                firefly_status = "ok" if resp.status_code == 200 else f"http_{resp.status_code}"
        except Exception as e:
            firefly_status = f"unreachable: {type(e).__name__}"

    overall = "ok" if db_ok else "degraded"
    payload = {
        "status": overall,
        "version": app.version,
        "database": db_status,
        "firefly": firefly_status,
    }
    if not db_ok:
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.get("/health/freshness")
async def freshness():
    return JobRunRepository().get_freshness_report()


app.include_router(drafts_router, prefix="/v1", tags=["drafts"])

app.include_router(confirmations_router, prefix="/v1", tags=["confirmations"])
app.include_router(reports_router, prefix="/v1", tags=["reports"])
app.include_router(report_web_router, prefix="/v1", tags=["report-web"])
app.include_router(jobs_router, prefix="/v1", tags=["jobs"])
