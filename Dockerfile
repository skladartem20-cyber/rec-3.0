# StreamRec Cloud — посредник удалённого доступа.
# Базовый образ берётся с зеркала Timeweb (Docker Hub из РФ может быть недоступен),
# библиотеки ставятся из папки wheels без интернета — сборка не зависит от pypi.org.
FROM dockerhub.timeweb.cloud/library/python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY wheels ./wheels
COPY requirements.txt .
RUN pip install --no-cache-dir --no-index --find-links=./wheels -r requirements.txt \
    || pip install --no-cache-dir --timeout 60 -r requirements.txt

COPY relay.py .
COPY web ./web

EXPOSE 8080
CMD ["python", "relay.py"]
