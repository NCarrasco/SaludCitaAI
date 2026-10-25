FROM python:3.12.13-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install --root-user-action=ignore -r requirements.txt && useradd --create-home --uid 10001 app
COPY api_client.py app.py server.py ./
COPY assets ./assets
USER app
EXPOSE 7860
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860", "--no-proxy-headers", "--no-server-header"]
