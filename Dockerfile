FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY db.py server.py index.html styles.css app.js ./

RUN mkdir -p /app/data

ENV PADEL_DB_PATH=/app/data/padel.db
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
