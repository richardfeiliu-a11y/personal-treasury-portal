# Finance Bridge Docker Image
# Base image pinned by digest for reproducible builds (captured 2026-07-25)
FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

WORKDIR /app

# Install Python dependencies from pinned requirements
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy all files into /app/finance_bridge/ (build context IS the finance_bridge dir)
COPY . /app/finance_bridge/

# Create non-root user and prepare /data volume mount point
RUN groupadd -r bridge && useradd -r -g bridge -d /app -s /sbin/nologin bridge \
    && mkdir -p /data \
    && chown -R bridge:bridge /app /data

USER bridge

EXPOSE 8711

CMD ["python", "-m", "uvicorn", "finance_bridge.app.main:app", "--host", "0.0.0.0", "--port", "8711"]
