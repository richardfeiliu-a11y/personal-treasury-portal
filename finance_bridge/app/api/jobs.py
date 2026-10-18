"""Job run recording API endpoints.

Used by external job runners (e.g. the cron container) to report
success/failure so /health/freshness can track real freshness.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter
from finance_bridge.app.storage.job_runs import JobRunRepository
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()


class JobRecordRequest(BaseModel):
    """Report the outcome of a background job run."""
    job_name: str = Field(..., min_length=1, max_length=100)
    status: str = Field(..., pattern="^(success|failure)$")
    reason: str | None = Field(None, max_length=500)


@router.post("/jobs/record")
async def record_job(request: JobRecordRequest) -> dict[str, Any]:
    """Record a background job run outcome into job_runs (for freshness tracking)."""
    repository = JobRunRepository()
    if request.status == "success":
        repository.record_success(request.job_name)
    else:
        repository.record_failure(request.job_name, request.reason or "unspecified failure")
    return {"job_name": request.job_name, "status": request.status, "recorded": True}
