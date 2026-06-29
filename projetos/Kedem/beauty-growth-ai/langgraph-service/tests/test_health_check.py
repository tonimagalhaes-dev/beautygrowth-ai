"""Unit tests for HealthCheckHandler.

Tests cover Requirements 8.1, 8.2, 8.3, 8.4:
- Returns SERVING when both deps healthy
- Returns NOT_SERVING when Redis unhealthy
- Returns NOT_SERVING when PostgreSQL unhealthy
- Details map includes per-dependency status
- Version is included in response
- Timeout handling (if a dependency hangs, still responds)
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

# Set up module loading for src.grpc.health_check
_service_root = Path(__file__).parent.parent

if "src" not in sys.modules:
    src_pkg = types.ModuleType("src")
    src_pkg.__path__ = [str(_service_root / "src")]
    sys.modules["src"] = src_pkg

if "src.grpc" not in sys.modules:
    grpc_pkg = types.ModuleType("src.grpc")
    grpc_pkg.__path__ = [str(_service_root / "src" / "grpc")]
    sys.modules["src.grpc"] = grpc_pkg

_spec = importlib.util.spec_from_file_location(
    "src.grpc.health_check",
    _service_root / "src" / "grpc" / "health_check.py",
)
_module = importlib.util.module_from_spec(_spec)
_module.__package__ = "src.grpc"
_spec.loader.exec_module(_module)

HealthCheckHandler = _module.HealthCheckHandler
HealthCheckResult = _module.HealthCheckResult


# --- Fixtures ---


class FakeRedisHealthy:
    """Fake Redis that always responds to ping successfully."""

    async def ping(self) -> bool:
        return True


class FakeRedisUnhealthy:
    """Fake Redis that raises on ping (simulates connection failure)."""

    async def ping(self) -> bool:
        raise ConnectionError("Connection refused")


class FakeRedisSlow:
    """Fake Redis that hangs on ping (simulates timeout)."""

    async def ping(self) -> bool:
        await asyncio.sleep(5.0)  # Way over 2s timeout
        return True


class FakePgPoolHealthy:
    """Fake asyncpg pool that returns 1 on fetchval."""

    async def fetchval(self, query: str):
        return 1


class FakePgPoolUnhealthy:
    """Fake asyncpg pool that raises on fetchval."""

    async def fetchval(self, query: str):
        raise ConnectionError("PostgreSQL connection refused")


class FakePgPoolSlow:
    """Fake asyncpg pool that hangs on fetchval (simulates timeout)."""

    async def fetchval(self, query: str):
        await asyncio.sleep(5.0)  # Way over 2s timeout
        return 1


@pytest.fixture
def healthy_redis():
    return FakeRedisHealthy()


@pytest.fixture
def unhealthy_redis():
    return FakeRedisUnhealthy()


@pytest.fixture
def slow_redis():
    return FakeRedisSlow()


@pytest.fixture
def healthy_pg():
    return FakePgPoolHealthy()


@pytest.fixture
def unhealthy_pg():
    return FakePgPoolUnhealthy()


@pytest.fixture
def slow_pg():
    return FakePgPoolSlow()


SERVICE_VERSION = "1.2.3"


# --- Tests ---


class TestHealthCheckServing:
    """Tests for SERVICE_STATUS_SERVING when both dependencies are healthy."""

    async def test_returns_serving_when_both_healthy(
        self, healthy_redis, healthy_pg
    ):
        """Requirement 8.2: SERVING when Redis and PostgreSQL accessible."""
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=healthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_SERVING"

    async def test_details_show_both_healthy(self, healthy_redis, healthy_pg):
        """Requirement 8.1: details map contains redis and postgres keys."""
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=healthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.details["redis"] == "healthy"
        assert result.details["postgres"] == "healthy"

    async def test_version_included_in_response(self, healthy_redis, healthy_pg):
        """Requirement 8.1: version string is included in response."""
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=healthy_pg,
            version="2.0.0-beta",
        )

        result = await handler.check_health()

        assert result.version == "2.0.0-beta"


class TestHealthCheckNotServingRedis:
    """Tests for NOT_SERVING when Redis is unhealthy."""

    async def test_returns_not_serving_when_redis_unhealthy(
        self, unhealthy_redis, healthy_pg
    ):
        """Requirement 8.3: NOT_SERVING when Redis inaccessible."""
        handler = HealthCheckHandler(
            redis_client=unhealthy_redis,
            pg_pool=healthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"

    async def test_details_indicate_redis_unhealthy(
        self, unhealthy_redis, healthy_pg
    ):
        """Requirement 8.3: details field indicates which dep is unavailable."""
        handler = HealthCheckHandler(
            redis_client=unhealthy_redis,
            pg_pool=healthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.details["redis"] == "unhealthy"
        assert result.details["postgres"] == "healthy"


class TestHealthCheckNotServingPostgres:
    """Tests for NOT_SERVING when PostgreSQL is unhealthy."""

    async def test_returns_not_serving_when_pg_unhealthy(
        self, healthy_redis, unhealthy_pg
    ):
        """Requirement 8.3: NOT_SERVING when PostgreSQL inaccessible."""
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=unhealthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"

    async def test_details_indicate_pg_unhealthy(
        self, healthy_redis, unhealthy_pg
    ):
        """Requirement 8.3: details field indicates postgres unavailable."""
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=unhealthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.details["redis"] == "healthy"
        assert result.details["postgres"] == "unhealthy"


class TestHealthCheckBothUnhealthy:
    """Tests when both dependencies are unhealthy."""

    async def test_returns_not_serving_when_both_unhealthy(
        self, unhealthy_redis, unhealthy_pg
    ):
        """Both deps down results in NOT_SERVING."""
        handler = HealthCheckHandler(
            redis_client=unhealthy_redis,
            pg_pool=unhealthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"
        assert result.details["redis"] == "unhealthy"
        assert result.details["postgres"] == "unhealthy"


class TestHealthCheckTimeout:
    """Tests for timeout handling (Requirement 8.3: 2s per dependency)."""

    async def test_redis_timeout_results_in_not_serving(
        self, slow_redis, healthy_pg
    ):
        """Requirement 8.3: Redis not responding within 2s -> NOT_SERVING.

        The overall 500ms deadline may fire before the per-dep 2s timeout,
        so the details value can be "unhealthy" or "timeout" — both indicate
        the dependency is not available.
        """
        handler = HealthCheckHandler(
            redis_client=slow_redis,
            pg_pool=healthy_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"
        assert result.details.get("redis") in ("unhealthy", "timeout")

    async def test_pg_timeout_results_in_not_serving(
        self, healthy_redis, slow_pg
    ):
        """Requirement 8.3: PostgreSQL not responding within 2s -> NOT_SERVING.

        The overall 500ms deadline may fire before the per-dep 2s timeout,
        so the details value can be "unhealthy" or "timeout" — both indicate
        the dependency is not available.
        """
        handler = HealthCheckHandler(
            redis_client=healthy_redis,
            pg_pool=slow_pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"
        assert result.details.get("postgres") in ("unhealthy", "timeout")


class TestHealthCheckResponseTime:
    """Tests for overall response time (Requirement 8.1: < 500ms)."""

    async def test_responds_within_500ms_even_with_slow_deps(
        self, slow_redis, slow_pg
    ):
        """Requirement 8.1: Must respond in max 500ms even if deps hang."""
        handler = HealthCheckHandler(
            redis_client=slow_redis,
            pg_pool=slow_pg,
            version=SERVICE_VERSION,
        )

        import time

        start = time.monotonic()
        result = await handler.check_health()
        elapsed_ms = (time.monotonic() - start) * 1000

        assert result.status == "SERVICE_STATUS_NOT_SERVING"
        # Allow some tolerance for test execution overhead (600ms)
        assert elapsed_ms < 600, f"Health check took {elapsed_ms:.0f}ms, expected <500ms"


class TestHealthCheckInternalError:
    """Tests for internal error handling (Requirement 8.4)."""

    async def test_internal_error_returns_not_serving(self):
        """Requirement 8.4: Internal error -> NOT_SERVING with error in details."""
        # A Redis client that raises an unexpected error type
        redis = AsyncMock()
        redis.ping.side_effect = RuntimeError("Unexpected internal error")

        pg = FakePgPoolHealthy()

        handler = HealthCheckHandler(
            redis_client=redis,
            pg_pool=pg,
            version=SERVICE_VERSION,
        )

        result = await handler.check_health()

        assert result.status == "SERVICE_STATUS_NOT_SERVING"
        assert result.details["redis"] == "unhealthy"


class TestHealthCheckResult:
    """Tests for HealthCheckResult dataclass."""

    def test_dataclass_default_values(self):
        """HealthCheckResult can be created with minimal arguments."""
        result = HealthCheckResult(
            status="SERVICE_STATUS_SERVING",
            version="1.0.0",
        )

        assert result.status == "SERVICE_STATUS_SERVING"
        assert result.version == "1.0.0"
        assert result.details == {}

    def test_dataclass_with_details(self):
        """HealthCheckResult holds details map correctly."""
        result = HealthCheckResult(
            status="SERVICE_STATUS_NOT_SERVING",
            version="0.1.0",
            details={"redis": "unhealthy", "postgres": "healthy"},
        )

        assert result.details["redis"] == "unhealthy"
        assert result.details["postgres"] == "healthy"
