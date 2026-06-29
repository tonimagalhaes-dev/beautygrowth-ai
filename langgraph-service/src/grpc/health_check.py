"""Health Check handler for the LangGraph gRPC service.

Verifies connectivity with Redis and PostgreSQL dependencies and returns
service health status per Requirements 8.1, 8.2, 8.3, 8.4.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Dict

logger = logging.getLogger(__name__)

# Timeout for each individual dependency check (2 seconds per Requirement 8.3)
_DEPENDENCY_TIMEOUT_S = 2.0

# Overall health check response deadline (500ms per Requirement 8.1)
_OVERALL_TIMEOUT_S = 0.5


@dataclass
class HealthCheckResult:
    """Result of a health check operation.

    Attributes:
        status: "SERVICE_STATUS_SERVING" or "SERVICE_STATUS_NOT_SERVING"
        version: Deployed service version string.
        details: Per-dependency status map, e.g. {"redis": "healthy", "postgres": "healthy"}
    """

    status: str
    version: str
    details: Dict[str, str] = field(default_factory=dict)


class HealthCheckHandler:
    """Checks connectivity with Redis and PostgreSQL and reports service health.

    Args:
        redis_client: An async Redis client with a `ping()` method.
        pg_pool: An asyncpg pool with a `fetchval()` method.
        version: The deployed service version string.
    """

    def __init__(self, redis_client, pg_pool, version: str) -> None:
        self._redis_client = redis_client
        self._pg_pool = pg_pool
        self._version = version

    async def check_health(self) -> HealthCheckResult:
        """Check health of all dependencies and return aggregated result.

        Each dependency is checked with a 2s timeout. The overall check
        must complete within 500ms. If any dependency is unhealthy or an
        internal error occurs, returns SERVICE_STATUS_NOT_SERVING.

        Returns:
            HealthCheckResult with status, version, and per-dependency details.
        """
        try:
            result = await asyncio.wait_for(
                self._check_dependencies(),
                timeout=_OVERALL_TIMEOUT_S,
            )
            return result
        except asyncio.TimeoutError:
            logger.error("Health check exceeded 500ms overall timeout")
            return HealthCheckResult(
                status="SERVICE_STATUS_NOT_SERVING",
                version=self._version,
                details={"redis": "timeout", "postgres": "timeout"},
            )
        except Exception as exc:
            logger.error("Health check internal error: %s", exc)
            return HealthCheckResult(
                status="SERVICE_STATUS_NOT_SERVING",
                version=self._version,
                details={"error": str(exc)},
            )

    async def _check_dependencies(self) -> HealthCheckResult:
        """Run Redis and PostgreSQL checks concurrently."""
        redis_task = asyncio.create_task(self._check_redis())
        pg_task = asyncio.create_task(self._check_postgres())

        redis_status, pg_status = await asyncio.gather(redis_task, pg_task)

        details = {
            "redis": redis_status,
            "postgres": pg_status,
        }

        all_healthy = redis_status == "healthy" and pg_status == "healthy"
        status = (
            "SERVICE_STATUS_SERVING" if all_healthy else "SERVICE_STATUS_NOT_SERVING"
        )

        return HealthCheckResult(
            status=status,
            version=self._version,
            details=details,
        )

    async def _check_redis(self) -> str:
        """Check Redis connectivity with 2s timeout.

        Returns:
            "healthy" if Redis responds to ping, otherwise "unhealthy".
        """
        try:
            await asyncio.wait_for(
                self._redis_client.ping(),
                timeout=_DEPENDENCY_TIMEOUT_S,
            )
            return "healthy"
        except asyncio.TimeoutError:
            logger.warning("Redis health check timed out (>2s)")
            return "unhealthy"
        except Exception as exc:
            logger.warning("Redis health check failed: %s", exc)
            return "unhealthy"

    async def _check_postgres(self) -> str:
        """Check PostgreSQL connectivity with 2s timeout.

        Returns:
            "healthy" if PostgreSQL responds to SELECT 1, otherwise "unhealthy".
        """
        try:
            result = await asyncio.wait_for(
                self._pg_pool.fetchval("SELECT 1"),
                timeout=_DEPENDENCY_TIMEOUT_S,
            )
            if result == 1:
                return "healthy"
            return "unhealthy"
        except asyncio.TimeoutError:
            logger.warning("PostgreSQL health check timed out (>2s)")
            return "unhealthy"
        except Exception as exc:
            logger.warning("PostgreSQL health check failed: %s", exc)
            return "unhealthy"
