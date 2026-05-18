#!/usr/bin/env bash
# Cosmopolitan Pro — One-click launcher
# Usage: ./run.sh

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║       Cosmopolitan Pro — Launcher        ║${RESET}"
echo -e "${BOLD}${CYAN}║   Multi-Branch Retail Management Platform ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Check prerequisites ──────────────────────────────────────────────────────
echo -e "${YELLOW}Checking prerequisites...${RESET}"

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "❌ Node.js v18+ required. Found: $(node -v)"
  exit 1
fi

if ! command -v python3 &>/dev/null; then
  echo "❌ Python 3 not found. Install from https://python.org (3.10+)"
  exit 1
fi

echo -e "${GREEN}✓ Node.js $(node -v)${RESET}"
echo -e "${GREEN}✓ Python $(python3 --version)${RESET}"
echo ""

# ─── Install frontend dependencies ───────────────────────────────────────────
echo -e "${YELLOW}Installing frontend dependencies...${RESET}"
cd "$ROOT_DIR/frontend"
npm install --silent
echo -e "${GREEN}✓ Frontend dependencies installed${RESET}"

# ─── Install backend dependencies ────────────────────────────────────────────
echo -e "${YELLOW}Installing backend dependencies...${RESET}"
cd "$ROOT_DIR/backend"
pip3 install -r requirements.txt -q
echo -e "${GREEN}✓ Backend dependencies installed${RESET}"

# ─── Seed database ────────────────────────────────────────────────────────────
if [ ! -f "$ROOT_DIR/backend/retailos.db" ]; then
  echo -e "${YELLOW}Seeding demo database...${RESET}"
  python3 src/seed.py
  echo -e "${GREEN}✓ Database seeded with demo data${RESET}"
else
  echo -e "${GREEN}✓ Database exists (run 'python src/seed.py' to reseed)${RESET}"
fi

echo ""
echo -e "${BOLD}Starting services...${RESET}"

# ─── Start backend ────────────────────────────────────────────────────────────
cd "$ROOT_DIR/backend"
echo -e "${YELLOW}▶ Starting FastAPI backend on port 8080...${RESET}"
uvicorn src.main:app --host 0.0.0.0 --port 8080 --reload &
BACKEND_PID=$!

sleep 2

# ─── Start frontend ───────────────────────────────────────────────────────────
cd "$ROOT_DIR/frontend"
echo -e "${YELLOW}▶ Starting React frontend on port 3000...${RESET}"
npm run dev &
FRONTEND_PID=$!

sleep 3

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║       Cosmopolitan Pro is running!        ║${RESET}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════╣${RESET}"
echo -e "${BOLD}${GREEN}║  App:      http://localhost:3000          ║${RESET}"
echo -e "${BOLD}${GREEN}║  API Docs: http://localhost:8080/api/docs ║${RESET}"
echo -e "${BOLD}${GREEN}╠══════════════════════════════════════════╣${RESET}"
echo -e "${BOLD}${GREEN}║  Login: suresh@srimurugan.com             ║${RESET}"
echo -e "${BOLD}${GREEN}║  Pass:  admin123                          ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${RESET}"
echo ""
echo "Press Ctrl+C to stop both services"
echo ""

# ─── Cleanup on exit ──────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "Stopping services..."
  kill $BACKEND_PID 2>/dev/null || true
  kill $FRONTEND_PID 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

wait
