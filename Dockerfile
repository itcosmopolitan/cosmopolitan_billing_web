FROM python:3.11-slim-bookworm

# Install Node.js
RUN apt-get update && apt-get install -y curl gnupg ca-certificates \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean

# Official wkhtmltopdf build with patched Qt (PDF rendering) plus Arial-metric fonts.
ARG WKHTMLTOPDF_VERSION=0.12.6.1-3
RUN ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL -o /tmp/wkhtmltox.deb \
       "https://github.com/wkhtmltopdf/packaging/releases/download/${WKHTMLTOPDF_VERSION}/wkhtmltox_${WKHTMLTOPDF_VERSION}.bookworm_${ARCH}.deb" \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/wkhtmltox.deb fontconfig fonts-liberation \
    && rm -f /tmp/wkhtmltox.deb \
    && fc-cache -f \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

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
