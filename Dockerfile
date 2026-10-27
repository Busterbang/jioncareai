FROM node:22-bookworm-slim AS frontend-build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend ./frontend
RUN pnpm build

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=3000
WORKDIR /app
COPY backend/requirements-prod.txt /app/backend/requirements-prod.txt
RUN python -m pip install --no-cache-dir -r /app/backend/requirements-prod.txt
COPY backend /app/backend
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist
EXPOSE 3000
CMD ["sh", "-c", "exec uvicorn backend.app:app --host 0.0.0.0 --port ${PORT:-3000}"]
