FROM python:3.11-slim

# Install Node.js
RUN apt-get update && apt-get install -y curl gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean

WORKDIR /app

COPY . .

# ---------------- Frontend ----------------
WORKDIR /app/frontend

RUN npm install
RUN npm run build

# ---------------- Backend ----------------
WORKDIR /app/backend

RUN pip install --no-cache-dir -r requirements.txt

# ---------------- Final ----------------
WORKDIR /app

RUN chmod +x start.sh

EXPOSE 10000

CMD ["./start.sh"]