FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Runtime-upload root (UPLOADS_DIR in compose/k8s). Pre-create it owned by
# nobody so fresh named volumes initialize writable by the app user.
RUN mkdir -p /uploads && chown nobody:nogroup /uploads

EXPOSE 8080
USER nobody
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
