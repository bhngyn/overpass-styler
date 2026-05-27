### Stage 1 — build the frontend
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci || npm install
COPY frontend/ ./
RUN npm run build

### Stage 2 — runtime: Python 3.12, FastAPI, lxml
FROM python:3.12-slim AS runtime

# lxml prefers a system libxml2 / libxslt for fastest install on aarch64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libxml2 libxslt1.1 \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    OVERPASS_STYLER_DATA_DIR=/data

WORKDIR /app

# Install Python deps first for layer caching.
COPY backend/pyproject.toml ./
RUN pip install --upgrade pip \
 && pip install \
      "fastapi>=0.115" \
      "uvicorn[standard]>=0.32" \
      "lxml>=5.3" \
      "sqlalchemy>=2.0" \
      "aiosqlite>=0.20" \
      "pydantic>=2.9" \
      "python-multipart>=0.0.12" \
      "httpx>=0.27"

COPY backend/app ./app
COPY --from=frontend /build/dist ./static

VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
