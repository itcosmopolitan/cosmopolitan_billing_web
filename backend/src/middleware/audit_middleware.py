from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class AuditContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        forwarded_for = request.headers.get("X-Forwarded-For")
        request.state.ip_address = (
            forwarded_for.split(",")[0].strip() if forwarded_for
            else (request.client.host if request.client else None)
        )
        request.state.device_info = request.headers.get("User-Agent", "")[:200]
        return await call_next(request)
