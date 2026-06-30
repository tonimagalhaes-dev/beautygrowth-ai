"""Unit tests for RedisStateManager."""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Direct import of state_manager module to avoid src/core/__init__.py
# which imports graph_builder (requires Python 3.10+ match/case syntax)
_service_root = Path(__file__).parent.parent
sys.path.insert(0, str(_service_root))

import importlib.util

import types

# Set up package structure in sys.modules so relative imports work
if "src" not in sys.modules:
    src_pkg = types.ModuleType("src")
    src_pkg.__path__ = [str(_service_root / "src")]
    sys.modules["src"] = src_pkg

if "src.core" not in sys.modules:
    core_pkg = types.ModuleType("src.core")
    core_pkg.__path__ = [str(_service_root / "src" / "core")]
    sys.modules["src.core"] = core_pkg

# Load exceptions module first (state_manager depends on it)
_exc_spec = importlib.util.spec_from_file_location(
    "src.core.exceptions",
    _service_root / "src" / "core" / "exceptions.py",
)
_exc_module = importlib.util.module_from_spec(_exc_spec)
_exc_module.__package__ = "src.core"
sys.modules["src.core.exceptions"] = _exc_module
_exc_spec.loader.exec_module(_exc_module)

# Now load state_manager with proper package context
_spec = importlib.util.spec_from_file_location(
    "src.core.state_manager",
    _service_root / "src" / "core" / "state_manager.py",
)
_module = importlib.util.module_from_spec(_spec)
_module.__package__ = "src.core"
_spec.loader.exec_module(_module)

RedisStateManager = _module.RedisStateManager

# Import exceptions for test assertions
StateManagerError = _exc_module.StateManagerError
RedisUnavailableError = _exc_module.RedisUnavailableError
PersistenceError = _exc_module.PersistenceError

import redis.asyncio as redis_lib


class FakeRedis:
    """Fake Redis implementation for unit tests.

    Simulates async Redis behavior with in-memory storage,
    including TTL tracking and pipeline/transaction support.
    """

    def __init__(self):
        self._store: dict[str, str] = {}
        self._ttls: dict[str, int] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._store[key] = value
        if ex is not None:
            self._ttls[key] = ex

    async def get(self, key: str) -> str | None:
        return self._store.get(key)

    def pipeline(self, transaction: bool = False) -> "FakePipeline":
        return FakePipeline(self)


class FakeRedisUnavailable:
    """Fake Redis that simulates connection failure on all operations."""

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        raise redis_lib.ConnectionError("Connection refused")

    async def get(self, key: str) -> str | None:
        raise redis_lib.ConnectionError("Connection refused")

    def pipeline(self, transaction: bool = False) -> "FakePipelineUnavailable":
        return FakePipelineUnavailable()


class FakePipelineUnavailable:
    """Fake pipeline that raises ConnectionError on enter."""

    async def __aenter__(self):
        raise redis_lib.ConnectionError("Connection refused")

    async def __aexit__(self, *args):
        pass


class FakePipeline:
    """Fake Redis pipeline supporting WATCH/MULTI/EXEC semantics."""

    def __init__(self, redis_instance: FakeRedis):
        self._redis = redis_instance
        self._commands: list[tuple] = []
        self._in_multi = False

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def watch(self, key: str) -> None:
        pass

    async def unwatch(self) -> None:
        pass

    async def get(self, key: str) -> str | None:
        return self._redis._store.get(key)

    def multi(self) -> None:
        self._in_multi = True
        self._commands = []

    def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._commands.append(("set", key, value, ex))

    async def execute(self) -> list:
        results = []
        for cmd in self._commands:
            if cmd[0] == "set":
                _, key, value, ex = cmd
                self._redis._store[key] = value
                if ex is not None:
                    self._redis._ttls[key] = ex
                results.append(True)
        self._commands = []
        self._in_multi = False
        return results


@pytest.fixture
def fake_redis() -> FakeRedis:
    """Provide a fake Redis instance for testing."""
    return FakeRedis()


@pytest.fixture
def fake_redis_unavailable() -> FakeRedisUnavailable:
    """Provide a fake Redis that always fails."""
    return FakeRedisUnavailable()


@pytest.fixture
def state_manager(fake_redis: FakeRedis) -> RedisStateManager:
    """Provide a RedisStateManager with fake Redis."""
    return RedisStateManager(redis_client=fake_redis, ttl=3600)


@pytest.fixture
def state_manager_custom_ttl(fake_redis: FakeRedis) -> RedisStateManager:
    """Provide a RedisStateManager with custom TTL."""
    return RedisStateManager(redis_client=fake_redis, ttl=7200)


@pytest.fixture
def state_manager_unavailable(fake_redis_unavailable: FakeRedisUnavailable) -> RedisStateManager:
    """Provide a RedisStateManager with unavailable Redis."""
    return RedisStateManager(redis_client=fake_redis_unavailable, ttl=3600)


class TestKeyPattern:
    """Tests for Redis key pattern with tenant isolation."""

    def test_build_key_includes_tenant_id(self, state_manager: RedisStateManager):
        key = state_manager._build_key("tenant-123", "exec-456")
        assert key == "tenant:tenant-123:exec:exec-456"

    def test_build_key_different_tenants_produce_different_keys(
        self, state_manager: RedisStateManager
    ):
        key_a = state_manager._build_key("tenant-a", "exec-1")
        key_b = state_manager._build_key("tenant-b", "exec-1")
        assert key_a != key_b

    def test_build_key_uses_uuid_format(
        self,
        state_manager: RedisStateManager,
        sample_tenant_id: str,
        sample_execution_id: str,
    ):
        key = state_manager._build_key(sample_tenant_id, sample_execution_id)
        assert key == f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"


class TestCreateState:
    """Tests for create_state operation."""

    async def test_create_state_stores_data(
        self,
        state_manager: RedisStateManager,
        fake_redis: FakeRedis,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        key = f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"
        stored = fake_redis._store.get(key)
        assert stored is not None

        parsed = json.loads(stored)
        assert parsed["user_input"] == sample_initial_state["user_input"]
        assert parsed["tenant_id"] == sample_tenant_id
        assert parsed["agent_id"] == sample_initial_state["agent_id"]
        assert parsed["execution_id"] == sample_execution_id
        assert parsed["workflow_id"] == "wf-001"
        assert parsed["status"] == "pending"
        assert "created_at" in parsed

    async def test_create_state_sets_ttl(
        self,
        state_manager: RedisStateManager,
        fake_redis: FakeRedis,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        key = f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"
        assert fake_redis._ttls[key] == 3600

    async def test_create_state_custom_ttl(
        self,
        state_manager_custom_ttl: RedisStateManager,
        fake_redis: FakeRedis,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager_custom_ttl.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        key = f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"
        assert fake_redis._ttls[key] == 7200

    async def test_create_state_includes_mandatory_fields(
        self,
        state_manager: RedisStateManager,
        fake_redis: FakeRedis,
        sample_execution_id: str,
        sample_tenant_id: str,
    ):
        minimal_state = {
            "user_input": "test input",
            "tenant_id": sample_tenant_id,
            "agent_id": "agent-1",
            "conversation_id": "conv-1",
        }

        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=minimal_state,
        )

        key = f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"
        parsed = json.loads(fake_redis._store[key])

        assert parsed["user_input"] == "test input"
        assert parsed["tenant_id"] == sample_tenant_id
        assert parsed["agent_id"] == "agent-1"
        assert parsed["conversation_id"] == "conv-1"
        assert parsed["status"] == "pending"
        assert parsed["created_at"] is not None


class TestGetState:
    """Tests for get_state operation."""

    async def test_get_state_returns_none_for_nonexistent_key(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
    ):
        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
        )
        assert result is None

    async def test_get_state_returns_stored_data(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
        )

        assert result is not None
        assert result["user_input"] == sample_initial_state["user_input"]
        assert result["tenant_id"] == sample_tenant_id
        assert result["status"] == "pending"

    async def test_get_state_tenant_isolation(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id="different-tenant-id",
        )
        assert result is None


class TestUpdateState:
    """Tests for update_state operation."""

    async def test_update_state_preserves_existing_fields(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        await state_manager.update_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            state_update={"status": "running", "current_node": "node_1"},
        )

        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
        )

        assert result["user_input"] == sample_initial_state["user_input"]
        assert result["tenant_id"] == sample_tenant_id
        assert result["agent_id"] == sample_initial_state["agent_id"]
        assert result["workflow_id"] == "wf-001"
        assert result["status"] == "running"
        assert result["current_node"] == "node_1"

    async def test_update_state_resets_ttl(
        self,
        fake_redis: FakeRedis,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        manager = RedisStateManager(redis_client=fake_redis, ttl=1800)

        await manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        key = f"tenant:{sample_tenant_id}:exec:{sample_execution_id}"
        assert fake_redis._ttls[key] == 1800

        await manager.update_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            state_update={"status": "running"},
        )

        assert fake_redis._ttls[key] == 1800

    async def test_update_state_no_op_for_nonexistent_key(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
    ):
        await state_manager.update_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            state_update={"status": "running"},
        )

        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
        )
        assert result is None

    async def test_update_state_multiple_updates_merge_correctly(
        self,
        state_manager: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        await state_manager.create_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            workflow_id="wf-001",
            initial_state=sample_initial_state,
        )

        await state_manager.update_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            state_update={"status": "running", "current_node": "node_1"},
        )

        await state_manager.update_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
            state_update={"current_node": "node_2", "steps": [{"node_id": "node_1"}]},
        )

        result = await state_manager.get_state(
            execution_id=sample_execution_id,
            tenant_id=sample_tenant_id,
        )

        assert result["status"] == "running"
        assert result["current_node"] == "node_2"
        assert result["steps"] == [{"node_id": "node_1"}]
        assert result["user_input"] == sample_initial_state["user_input"]


class TestTenantIsolation:
    """Tests for multi-tenant isolation via key pattern."""

    async def test_different_tenants_cannot_access_each_others_state(
        self,
        state_manager: RedisStateManager,
    ):
        tenant_a = "tenant-aaaa-aaaa"
        tenant_b = "tenant-bbbb-bbbb"
        exec_id = "exec-shared-id"

        await state_manager.create_state(
            execution_id=exec_id,
            tenant_id=tenant_a,
            workflow_id="wf-001",
            initial_state={
                "user_input": "Tenant A data",
                "tenant_id": tenant_a,
                "agent_id": "agent-a",
                "conversation_id": "conv-a",
            },
        )

        await state_manager.create_state(
            execution_id=exec_id,
            tenant_id=tenant_b,
            workflow_id="wf-002",
            initial_state={
                "user_input": "Tenant B data",
                "tenant_id": tenant_b,
                "agent_id": "agent-b",
                "conversation_id": "conv-b",
            },
        )

        state_a = await state_manager.get_state(exec_id, tenant_a)
        assert state_a is not None
        assert state_a["user_input"] == "Tenant A data"

        state_b = await state_manager.get_state(exec_id, tenant_b)
        assert state_b is not None
        assert state_b["user_input"] == "Tenant B data"

    async def test_update_one_tenant_does_not_affect_another(
        self,
        state_manager: RedisStateManager,
    ):
        tenant_a = "tenant-aaaa"
        tenant_b = "tenant-bbbb"
        exec_id = "exec-shared"

        for tenant in [tenant_a, tenant_b]:
            await state_manager.create_state(
                execution_id=exec_id,
                tenant_id=tenant,
                workflow_id="wf-001",
                initial_state={
                    "user_input": f"Input for {tenant}",
                    "tenant_id": tenant,
                    "agent_id": "agent-1",
                    "conversation_id": "conv-1",
                },
            )

        await state_manager.update_state(
            execution_id=exec_id,
            tenant_id=tenant_a,
            state_update={"status": "completed"},
        )

        state_b = await state_manager.get_state(exec_id, tenant_b)
        assert state_b["status"] == "pending"


class TestRedisErrorHandling:
    """Tests for Redis unavailability error handling (Requirement 4.7)."""

    async def test_create_state_raises_redis_unavailable_error(
        self,
        state_manager_unavailable: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        """Redis connection error in create_state raises RedisUnavailableError."""
        with pytest.raises(RedisUnavailableError) as exc_info:
            await state_manager_unavailable.create_state(
                execution_id=sample_execution_id,
                tenant_id=sample_tenant_id,
                workflow_id="wf-001",
                initial_state=sample_initial_state,
                trace_id="trace-abc-123",
            )

        error = exc_info.value
        assert error.trace_id == "trace-abc-123"
        assert error.execution_id == sample_execution_id
        assert "Redis unavailable" in str(error)
        assert error.__cause__ is not None

    async def test_get_state_raises_redis_unavailable_error(
        self,
        state_manager_unavailable: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
    ):
        """Redis connection error in get_state raises RedisUnavailableError."""
        with pytest.raises(RedisUnavailableError) as exc_info:
            await state_manager_unavailable.get_state(
                execution_id=sample_execution_id,
                tenant_id=sample_tenant_id,
                trace_id="trace-def-456",
            )

        error = exc_info.value
        assert error.trace_id == "trace-def-456"
        assert error.execution_id == sample_execution_id
        assert error.__cause__ is not None

    async def test_update_state_raises_redis_unavailable_error(
        self,
        state_manager_unavailable: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
    ):
        """Redis connection error in update_state raises RedisUnavailableError."""
        with pytest.raises(RedisUnavailableError) as exc_info:
            await state_manager_unavailable.update_state(
                execution_id=sample_execution_id,
                tenant_id=sample_tenant_id,
                state_update={"status": "running"},
                trace_id="trace-ghi-789",
            )

        error = exc_info.value
        assert error.trace_id == "trace-ghi-789"
        assert error.execution_id == sample_execution_id
        assert error.__cause__ is not None

    async def test_redis_error_is_subclass_of_state_manager_error(
        self,
        state_manager_unavailable: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        """RedisUnavailableError should be catchable as StateManagerError."""
        with pytest.raises(StateManagerError):
            await state_manager_unavailable.create_state(
                execution_id=sample_execution_id,
                tenant_id=sample_tenant_id,
                workflow_id="wf-001",
                initial_state=sample_initial_state,
            )

    async def test_redis_error_logs_with_trace_id(
        self,
        state_manager_unavailable: RedisStateManager,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
        caplog,
    ):
        """Redis errors should be logged with trace_id context."""
        import logging

        with caplog.at_level(logging.ERROR):
            with pytest.raises(RedisUnavailableError):
                await state_manager_unavailable.create_state(
                    execution_id=sample_execution_id,
                    tenant_id=sample_tenant_id,
                    workflow_id="wf-001",
                    initial_state=sample_initial_state,
                    trace_id="trace-log-test",
                )

        assert len(caplog.records) >= 1
        record = caplog.records[0]
        assert record.levelname == "ERROR"
        assert "Redis unavailable" in record.message

    async def test_redis_error_does_not_affect_postgres(
        self,
        fake_redis_unavailable: FakeRedisUnavailable,
        sample_execution_id: str,
        sample_tenant_id: str,
        sample_initial_state: dict,
    ):
        """Redis failure should not compromise PostgreSQL state."""
        mock_pg_pool = AsyncMock()
        manager = RedisStateManager(
            redis_client=fake_redis_unavailable,
            pg_pool=mock_pg_pool,
            ttl=3600,
        )

        # Redis fails on create_state
        with pytest.raises(RedisUnavailableError):
            await manager.create_state(
                execution_id=sample_execution_id,
                tenant_id=sample_tenant_id,
                workflow_id="wf-001",
                initial_state=sample_initial_state,
            )

        # PostgreSQL pool was never touched
        mock_pg_pool.acquire.assert_not_called()


class FakeAsyncContextManager:
    """Helper for mocking async context managers."""

    def __init__(self, return_value):
        self._return_value = return_value

    async def __aenter__(self):
        return self._return_value

    async def __aexit__(self, *args):
        pass


class FakePgPool:
    """Fake asyncpg pool that returns a mock connection via acquire()."""

    def __init__(self, mock_conn):
        self._mock_conn = mock_conn
        # Ensure conn.transaction() returns an async context manager
        # (tenant_connection wraps queries in a transaction)
        mock_conn.transaction = MagicMock(
            return_value=FakeAsyncContextManager(None)
        )

    def acquire(self):
        return FakeAsyncContextManager(self._mock_conn)


class TestPostgresRetryAndPersistenceError:
    """Tests for PostgreSQL persistence with retry and backoff (Requirement 4.9)."""

    def _make_pool(self, mock_conn):
        """Create a fake pool that returns mock_conn via acquire()."""
        return FakePgPool(mock_conn)

    async def test_persist_final_state_succeeds_on_first_try(self):
        """persist_final_state should succeed without retries when PG is healthy."""
        fake_redis = FakeRedis()
        mock_conn = AsyncMock()
        mock_pool = self._make_pool(mock_conn)

        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=mock_pool,
            ttl=3600,
        )

        final_state = {
            "workflow_id": "wf-001",
            "agent_id": "agent-1",
            "status": "completed",
            "user_input": "test",
            "output": "result",
            "steps": [],
            "tokens_input": 10,
            "tokens_output": 20,
        }

        await manager.persist_final_state(
            execution_id="exec-001",
            tenant_id="tenant-001",
            final_state=final_state,
            trace_id="trace-001",
        )

        # Two execute calls: set_config (RLS) + INSERT
        assert mock_conn.execute.call_count == 2
        # First call should be set_config for RLS
        first_call_args = mock_conn.execute.call_args_list[0]
        assert "set_config" in first_call_args[0][0]
        assert "app.current_tenant" in first_call_args[0][0]

    async def test_persist_final_state_retries_on_failure_then_succeeds(self):
        """persist_final_state retries on PG failure and succeeds on second try."""
        fake_redis = FakeRedis()
        mock_conn = AsyncMock()
        # First attempt: set_config succeeds but INSERT fails
        # Second attempt: set_config succeeds and INSERT succeeds
        mock_conn.execute.side_effect = [
            None,  # set_config attempt 1
            Exception("Connection reset"),  # INSERT attempt 1 fails
            None,  # set_config attempt 2
            None,  # INSERT attempt 2 succeeds
        ]
        mock_pool = self._make_pool(mock_conn)

        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=mock_pool,
            ttl=3600,
            max_retries=3,
            base_backoff=0.01,  # Fast for tests
        )

        final_state = {
            "workflow_id": "wf-001",
            "agent_id": "agent-1",
            "status": "completed",
            "user_input": "test",
            "output": "result",
            "steps": [],
        }

        await manager.persist_final_state(
            execution_id="exec-001",
            tenant_id="tenant-001",
            final_state=final_state,
            trace_id="trace-retry",
        )

        # 2 attempts: first fails on INSERT (2 calls), second succeeds (2 calls)
        assert mock_conn.execute.call_count == 4

    async def test_persist_final_state_raises_persistence_error_after_max_retries(
        self,
    ):
        """After max retries exhausted, PersistenceError is raised."""
        fake_redis = FakeRedis()
        mock_conn = AsyncMock()
        mock_conn.execute.side_effect = Exception("Database unavailable")
        mock_pool = self._make_pool(mock_conn)

        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=mock_pool,
            ttl=3600,
            max_retries=3,
            base_backoff=0.01,
        )

        final_state = {
            "workflow_id": "wf-001",
            "agent_id": "agent-1",
            "status": "failed",
            "user_input": "test",
        }

        with pytest.raises(PersistenceError) as exc_info:
            await manager.persist_final_state(
                execution_id="exec-fail",
                tenant_id="tenant-fail",
                final_state=final_state,
                trace_id="trace-fail",
            )

        error = exc_info.value
        assert error.trace_id == "trace-fail"
        assert error.execution_id == "exec-fail"
        assert "3 attempts" in str(error)
        assert error.__cause__ is not None
        assert mock_conn.execute.call_count == 3

    async def test_persist_final_state_logs_warnings_on_retry(self, caplog):
        """Each retry attempt should log a warning with execution_id and trace_id."""
        import logging

        fake_redis = FakeRedis()
        mock_conn = AsyncMock()
        # Attempt 1: set_config ok, INSERT fails
        # Attempt 2: set_config ok, INSERT fails
        # Attempt 3: set_config ok, INSERT ok
        mock_conn.execute.side_effect = [
            None,  # set_config attempt 1
            Exception("Timeout"),  # INSERT attempt 1 fails
            None,  # set_config attempt 2
            Exception("Timeout"),  # INSERT attempt 2 fails
            None,  # set_config attempt 3
            None,  # INSERT attempt 3 succeeds
        ]
        mock_pool = self._make_pool(mock_conn)

        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=mock_pool,
            ttl=3600,
            max_retries=3,
            base_backoff=0.01,
        )

        final_state = {"workflow_id": "wf-001", "agent_id": "a-1", "user_input": "x"}

        with caplog.at_level(logging.WARNING):
            await manager.persist_final_state(
                execution_id="exec-retry-log",
                tenant_id="tenant-log",
                final_state=final_state,
                trace_id="trace-log",
            )

        warning_records = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warning_records) == 2  # Two retries before success
        for record in warning_records:
            assert "PostgreSQL persistence failed" in record.message

    async def test_persist_final_state_logs_critical_after_all_retries(self, caplog):
        """After all retries exhausted, a CRITICAL log should be emitted."""
        import logging

        fake_redis = FakeRedis()
        mock_conn = AsyncMock()
        mock_conn.execute.side_effect = Exception("Permanent failure")
        mock_pool = self._make_pool(mock_conn)

        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=mock_pool,
            ttl=3600,
            max_retries=3,
            base_backoff=0.01,
        )

        final_state = {"workflow_id": "wf-001", "agent_id": "a-1", "user_input": "x"}

        with caplog.at_level(logging.CRITICAL):
            with pytest.raises(PersistenceError):
                await manager.persist_final_state(
                    execution_id="exec-critical",
                    tenant_id="tenant-critical",
                    final_state=final_state,
                    trace_id="trace-critical",
                )

        critical_records = [r for r in caplog.records if r.levelname == "CRITICAL"]
        assert len(critical_records) >= 1
        assert "all retries" in critical_records[0].message

    async def test_persist_final_state_raises_runtime_error_without_pg_pool(self):
        """persist_final_state should raise RuntimeError if pg_pool not configured."""
        fake_redis = FakeRedis()
        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=None,
            ttl=3600,
            max_retries=3,
            base_backoff=0.01,
        )

        final_state = {"workflow_id": "wf-001", "agent_id": "a-1", "user_input": "x"}

        with pytest.raises(PersistenceError) as exc_info:
            await manager.persist_final_state(
                execution_id="exec-no-pg",
                tenant_id="tenant-no-pg",
                final_state=final_state,
                trace_id="trace-no-pg",
            )

        assert "3 attempts" in str(exc_info.value)

    async def test_persistence_error_is_subclass_of_state_manager_error(self):
        """PersistenceError should be catchable as StateManagerError."""
        fake_redis = FakeRedis()
        manager = RedisStateManager(
            redis_client=fake_redis,
            pg_pool=None,
            ttl=3600,
            max_retries=1,
            base_backoff=0.01,
        )

        final_state = {"workflow_id": "wf-001", "agent_id": "a-1", "user_input": "x"}

        with pytest.raises(StateManagerError):
            await manager.persist_final_state(
                execution_id="exec-hierarchy",
                tenant_id="tenant-hierarchy",
                final_state=final_state,
            )
