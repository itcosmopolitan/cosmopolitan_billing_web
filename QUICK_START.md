# Quick Reference Card

**Cosmopolitan Pro** - Multi-branch retail billing, POS, inventory system

---

## 🚀 Quick Start (5 minutes)

### macOS / Linux
```bash
chmod +x run.sh && ./run.sh
```

### Windows
```bash
run.bat
```

**Open**: http://localhost:5173 (Frontend) | http://localhost:8080 (Backend)

---

## 🔓 Demo Login

| User | Email | Password |
|------|-------|----------|
| Admin | suresh@srimurugan.com | admin123 |
| Manager | kavitha@srimurugan.com | kavitha123 |
| Cashier | arjun@srimurugan.com | arjun123 |
| Inventory | deepa@srimurugan.com | deepa123 |

---

## 📚 Documentation Guide

### I Want To...

- **Understand the system** → Read [FEATURES.md](./FEATURES.md)
- **Install locally** → Read [INSTALLATION.md](./INSTALLATION.md)
- **Setup development** → Read [SETUP_GUIDE.md](./SETUP_GUIDE.md)
- **Learn architecture** → Read [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Call an API** → Read [API.md](./API.md)
- **Develop frontend** → Read [FRONTEND.md](./FRONTEND.md)
- **Develop backend** → Read [BACKEND.md](./BACKEND.md)
- **Understand database** → Read [DATABASE.md](./DATABASE.md)
- **Deploy to production** → Read [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Write tests** → Read [TESTING.md](./TESTING.md)
- **Contribute code** → Read [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Manage users/roles** → Read [USERS_AND_ROLES.md](./USERS_AND_ROLES.md)
- **Troubleshoot issues** → Read [ISSUES.md](./ISSUES.md)

---

## 💻 Development Commands

### Backend

```bash
cd backend

# Setup
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Database
alembic upgrade head  # Apply migrations
python src/seed.py    # Load demo data

# Development
uvicorn src.main:app --reload --port 8080

# Tests
pytest -v

# Linting
ruff check src/
```

### Frontend

```bash
cd frontend

# Setup
npm install

# Development
npm run dev  # Runs on http://localhost:5173

# Build
npm run build

# Tests
npm test

# Linting
npm run lint
```

---

## 🏗️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | React 18 + Vite + Tailwind CSS + Zustand |
| Backend | Python 3.11 + FastAPI + SQLAlchemy |
| Database | PostgreSQL 12+ |
| Deployment | Docker, AWS ECS, Heroku |

---

## 📖 Documentation Index

| Level | Purpose | Read Time |
|-------|---------|-----------|
| **Overview** | [README.md](../README.md) | 10 min |
| **Reference** | [INDEX.md](./INDEX.md) | 5 min |
| **Getting Started** | [INSTALLATION.md](./INSTALLATION.md) | 20 min |
| | [SETUP_GUIDE.md](./SETUP_GUIDE.md) | 30 min |
| **Understanding** | [FEATURES.md](./FEATURES.md) | 30 min |
| | [ARCHITECTURE.md](./ARCHITECTURE.md) | 1 hour |
| | [DATABASE.md](./DATABASE.md) | 1 hour |
| **Development** | [FRONTEND.md](./FRONTEND.md) | 2 hours |
| | [BACKEND.md](./BACKEND.md) | 2 hours |
| | [API.md](./API.md) | 1 hour |
| **Operations** | [DEPLOYMENT.md](./DEPLOYMENT.md) | 2 hours |
| | [TESTING.md](./TESTING.md) | 1 hour |
| **Contribution** | [CONTRIBUTING.md](./CONTRIBUTING.md) | 1 hour |
| **Admin** | [USERS_AND_ROLES.md](./USERS_AND_ROLES.md) | 30 min |
| **Support** | [ISSUES.md](./ISSUES.md) | 15 min |

---

## 🆘 Troubleshooting

### Frontend won't connect to backend
**Error**: CORS error or "Cannot connect to backend"  
**Fix**: 
```bash
# Check backend is running
lsof -i :8080

# Check FRONTEND_URL in backend .env
# Should be http://localhost:5173 for dev
```

### Module not found errors
**Fix**:
```bash
cd backend && pip install -r requirements.txt
cd frontend && npm install
```

### Port already in use
**Fix**: 
```bash
# Kill process
kill $(lsof -t -i:8080)   # Backend
kill $(lsof -t -i:5173)   # Frontend
```

### Database connection error
**Fix**:
```bash
# Check PostgreSQL is running
psql -U postgres -c "SELECT 1"

# Check DATABASE_URL in .env
```

### Permission denied on run.sh
**Fix**:
```bash
chmod +x run.sh
```

---

## 🔑 Key Keyboard Shortcuts (POS)

| Shortcut | Action |
|----------|--------|
| `F2` | Search products |
| `F4` | Hold bill |
| `F8` | Complete sale |
| `Esc` | Cancel |
| `Enter` | Confirm |
| `Tab` | Next field |

---

## 🎯 API Endpoints Summary

### Authentication
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh` - Refresh token

### Sales
- `GET /api/sales/invoices` - List invoices
- `POST /api/sales/invoices` - Create invoice
- `GET /api/sales/invoices/{id}` - Get invoice details
- `PUT /api/sales/invoices/{id}` - Update invoice

### Inventory
- `GET /api/inventory/items` - List items
- `POST /api/inventory/items` - Create item
- `GET /api/inventory/stock` - Get stock levels

### Transfers
- `GET /api/transfers` - List transfers
- `POST /api/transfers` - Create transfer request

### Reports
- `GET /api/reports/sales-register` - Sales report
- `GET /api/reports/inventory` - Inventory report
- `GET /api/reports/gst-summary` - Tax report

See [API.md](./API.md) for complete reference.

---

## 📊 Project Structure

```
cosmopolitan_billing_web/
├── frontend/               # React application
│   ├── src/
│   │   ├── pages/         # Page components
│   │   ├── components/    # Reusable components
│   │   ├── store/         # Zustand state
│   │   ├── api/           # API clients
│   │   └── hooks/         # Custom hooks
│   └── package.json
│
├── backend/               # FastAPI application
│   ├── src/
│   │   ├── main.py        # App entry
│   │   ├── models.py      # Database models
│   │   ├── routes/        # API routes
│   │   ├── services/      # Business logic
│   │   └── security.py    # Authentication
│   ├── requirements.txt
│   └── pyproject.toml
│
├── docs/                  # Documentation
│   ├── README.md
│   ├── INSTALLATION.md
│   ├── SETUP_GUIDE.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   ├── FRONTEND.md
│   ├── BACKEND.md
│   ├── DATABASE.md
│   ├── API.md
│   ├── DEPLOYMENT.md
│   ├── TESTING.md
│   ├── CONTRIBUTING.md
│   ├── USERS_AND_ROLES.md
│   └── ISSUES.md
│
├── run.sh                 # Start script (macOS/Linux)
└── run.bat                # Start script (Windows)
```

---

## ✅ Verification Checklist

### After Installation
- [ ] Backend runs on port 8080
- [ ] Frontend runs on port 5173
- [ ] Can login with demo credentials
- [ ] Database migrations applied
- [ ] No error in browser console
- [ ] API docs available at localhost:8080/docs

### Before First Commit
- [ ] Code follows style guide
- [ ] Tests pass: `npm test` (frontend), `pytest` (backend)
- [ ] No console errors or warnings
- [ ] All linters pass: `npm run lint`, `ruff check`
- [ ] New feature documented in FEATURES.md
- [ ] PR description follows template

### Before Production
- [ ] All tests pass with coverage > 80%
- [ ] Security scan completed
- [ ] Environment variables configured
- [ ] Database backups tested
- [ ] SSL/TLS certificates in place
- [ ] Monitoring and logging configured
- [ ] Load testing completed

---

## 🚀 Quick Deployment

### Docker
```bash
docker-compose up -d
```

### Heroku
```bash
git push heroku main
```

### AWS
```bash
# See DEPLOYMENT.md for full instructions
aws ecs update-service --cluster cosmo-prod --service cosmo-app --force-new-deployment
```

---

## 📞 Getting Help

1. **Documentation**: Check [INDEX.md](./INDEX.md) for topic
2. **Issues**: Search [ISSUES.md](./ISSUES.md) for known problems
3. **GitHub**: Open issue or discussion
4. **Email**: dev-team@example.com

---

## 🔗 Important Links

- **Source**: [GitHub Repository](https://github.com/yourrepo)
- **Issues**: [GitHub Issues](https://github.com/yourrepo/issues)
- **API Docs**: http://localhost:8080/docs (when running)
- **Live Demo**: [https://cosmo-demo.example.com](https://cosmo-demo.example.com)
- **Website**: [https://cosmopolitan-pro.example.com](https://cosmopolitan-pro.example.com)

---

## 📅 Release Schedule

| Version | Date | Features |
|---------|------|----------|
| 1.0.0 | Jan 2024 | Core features, API, multi-branch |
| 1.1.0 | Mar 2024 | Advanced reports, mobile preview |
| 1.2.0 | Jun 2024 | Multi-currency, integrations |
| 2.0.0 | Dec 2024 | Mobile app, analytics, AI features |

---

## 💡 Pro Tips

1. **Use Swagger UI**: Visit http://localhost:8080/docs to test APIs
2. **Enable debug mode**: Set `DEBUG=true` in backend `.env`
3. **Use Redux DevTools**: Install browser extension for state debugging
4. **Watch tests**: Use `pytest --watch` for auto-running tests
5. **Hot reload**: Both frontend and backend support hot reloading in dev
6. **Database GUI**: Use pgAdmin for visual database management
7. **API monitoring**: Use Postman collection for API testing
8. **Performance**: Check Network tab in DevTools for slow requests

---

**Version**: 1.0.0 | **Last Updated**: January 2024 | **Status**: ✅ Production Ready

For complete documentation, visit [INDEX.md](./INDEX.md)
