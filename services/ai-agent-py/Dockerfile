FROM python:3.12-slim@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de

WORKDIR /app

COPY requirements.txt requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock

RUN groupadd --gid 10001 ai-agent \
    && useradd --no-log-init --uid 10001 --gid ai-agent \
        --home-dir /home/ai-agent --create-home \
        --shell /usr/sbin/nologin ai-agent

COPY --chown=ai-agent:ai-agent . .

USER ai-agent
CMD ["python", "agent.py", "start"]
