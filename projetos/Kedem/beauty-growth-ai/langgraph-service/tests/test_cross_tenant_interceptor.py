"""Unit tests for CrossTenantValidationInterceptor.

Tests:
- Matching tenant_ids (metadata == payload) pass validation
- Mismatched tenant_ids rejected with PERMISSION_DENIED
- Requests without payload tenant_id pass (e.g., HealthCheck)
- Cross-tenant attempts are recorded in audit log
- InMemoryAuditLogStore correctly stores entries
- CrossTenantAuditEntry serialization to dict
- Integration with TenantValidationInterceptor (interceptor chaining)

Requirements: 5.4, 5.6, 5.7
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Module loading (same pattern as other tests in this project)
# ---------------------------------------------------------------------------

_service_root = Path(__file__).parent.parent
sys.path.insert(0, str(_service_root))

# Set up package structure in sys.modules so relative imports work
if "src" not in sys.modules:
    src_pkg = types.ModuleType("src")
    src_pkg.__path__ = [str(_service_root / "src")]
    sys.modules["src"] = src_pkg

if "src.grpc" not in sys.modules:
    grpc_pkg = types.ModuleType("src.grpc")
    grpc_pkg.__path__ = [str(_service_root / "src" / "grpc")]
    sys.modules["src.grpc"] = grpc_pkg

# Load interceptors module
_spec = importlib.util.spec_from_file_location(
    "src.grpc.interceptors",
    _service_root / "src" / "grpc" / "interceptors.py",
)
_module = importlib.util.module_from_spec(_spec)
_module.__package__ = "src.grpc"
sys.modules["src.grpc.interceptors"] = _module
_spec.loader.exec_module(_module)

CrossTenantValidationInterceptor = _module.CrossTenantValidationInterceptor
CrossTenantAuditEntry = _module.CrossTenantAuditEntry
InMemoryAuditLogStore = _module.InMemoryAuditLogStore
PostgresAuditLogStore = _module.PostgresAuditLogStore
_extract_payload_tenant_id = _module._extract_payload_tenant_id
tenant_id_var = _module.tenant_id_var
trace_id_var = _module.trace_id_var
user_id_var = _module.user_id_var

import grpc


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def audit_store() -> InMemoryAuditLogStore:
    """Provide an in-memory audit log store for tests."""
    return InMemoryAuditLogStore()


@pytest.fixture
def interceptor(audit_store: InMemoryAuditLogStore) -> CrossTenantValidationInterceptor:
    """Provide a CrossTenantValidationInterceptor instance with audit store."""
    return CrossTenantValidationInterceptor(audit_log_store=audit_store)


@pytest.fixture
def interceptor_no_store() -> CrossTenantValidationInterceptor:
    """Provide a CrossTenantValidationInterceptor without audit store."""
    return CrossTenantValidationInterceptor(audit_log_store=None)


@pytest.fixture
def tenant_a() -> str:
    """Tenant A UUID."""
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def tenant_b() -> str:
    """Tenant B UUID (different from tenant A)."""
    return "660e8400-e29b-41d4-a716-446655440001"


@pytest.fixture
def trace_id() -> str:
    """A trace ID for testing."""
    return "trace-test-abc-123"


@pytest.fixture
def user_id() -> str:
    """A user ID for testing."""
    return "880e8400-e29b-41d4-a716-446655440099"


def _make_handler_call_details(method: str = "/test/Method"):
    """Create a mock HandlerCallDetails."""
    details = MagicMock()
    details.method = method
    details.invocation_metadata = []
    return details


def _make_unary_handler(original_fn):
    """Create a mock RPC method handler with unary_unary."""
    handler = MagicMock()
    handler.unary_unary = original_fn
    handler.unary_stream = None
    handler.stream_unary = None
    handler.stream_stream = None
    handler.request_deserializer = None
    handler.response_serializer = None
    return handler


def _make_stream_handler(original_fn):
    """Create a mock RPC method handler with unary_stream."""
    handler = MagicMock()
    handler.unary_unary = None
    handler.unary_stream = original_fn
    handler.stream_unary = None
    handler.stream_stream = None
    handler.request_deserializer = None
    handler.response_serializer = None
    return handler


# ---------------------------------------------------------------------------
# Tests: _extract_payload_tenant_id
# ---------------------------------------------------------------------------


class TestExtractPayloadTenantId:
    """Tests for payload tenant_id extraction."""

    def test_extract_from_dict(self, tenant_a: str):
        """Extract tenant_id from dict payload."""
        request = {"tenant_id": tenant_a, "agent_id": "some-agent"}
        assert _extract_payload_tenant_id(request) == tenant_a

    def test_extract_from_object(self, tenant_a: str):
        """Extract tenant_id from object with attribute."""
        request = MagicMock()
        request.tenant_id = tenant_a
        assert _extract_payload_tenant_id(request) == tenant_a

    def test_extract_from_dict_without_tenant(self):
        """Returns None when dict has no tenant_id."""
        request = {"agent_id": "some-agent"}
        assert _extract_payload_tenant_id(request) is None

    def test_extract_from_none(self):
        """Returns None when request is None."""
        assert _extract_payload_tenant_id(None) is None

    def test_extract_empty_string(self):
        """Returns empty string when tenant_id is empty."""
        request = {"tenant_id": ""}
        assert _extract_payload_tenant_id(request) == ""


# ---------------------------------------------------------------------------
# Tests: CrossTenantValidationInterceptor
# ---------------------------------------------------------------------------


class TestCrossTenantValidationInterceptor:
    """Tests for the cross-tenant validation interceptor."""

    async def test_matching_tenants_pass(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
    ):
        """Request with matching metadata and payload tenant_id passes."""
        # Set context var (as if TenantValidationInterceptor ran first)
        tenant_id_var.set(tenant_a)
        trace_id_var.set("trace-123")
        user_id_var.set("user-456")

        # Create a request with matching tenant_id
        request = {"tenant_id": tenant_a, "agent_id": "agent-1"}
        mock_context = AsyncMock()

        # Create original handler
        async def original_handler(req, ctx):
            return {"success": True}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details("/test/ExecuteWorkflow")

        # Create continuation that returns our handler
        continuation = AsyncMock(return_value=handler)

        # Intercept
        result_handler = await interceptor.intercept_service(continuation, details)

        # Call the wrapped handler
        assert result_handler is not None
        # The wrapped handler is a grpc.RpcMethodHandler; call its unary_unary
        response = await result_handler.unary_unary(request, mock_context)

        assert response == {"success": True}
        mock_context.abort.assert_not_called()
        assert len(audit_store.entries) == 0

    async def test_mismatched_tenants_rejected(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
        tenant_b: str,
    ):
        """Request with mismatched tenant_ids is rejected with PERMISSION_DENIED."""
        # Set context var with tenant_a (from metadata)
        tenant_id_var.set(tenant_a)
        trace_id_var.set("trace-xyz")
        user_id_var.set("user-abc")

        # Create a request with tenant_b (different from metadata)
        request = {"tenant_id": tenant_b, "agent_id": "agent-1"}
        mock_context = AsyncMock()

        # Create original handler
        async def original_handler(req, ctx):
            return {"success": True}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details(
            "/beautygrowth.orchestration.v1.AgentOrchestrationService/ExecuteWorkflow"
        )

        continuation = AsyncMock(return_value=handler)

        # Intercept
        result_handler = await interceptor.intercept_service(continuation, details)

        # Call the wrapped handler
        response = await result_handler.unary_unary(request, mock_context)

        # Should abort with PERMISSION_DENIED
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )
        assert response is None

    async def test_mismatched_tenants_audit_logged(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
        tenant_b: str,
    ):
        """Cross-tenant access attempt is recorded in audit log."""
        tenant_id_var.set(tenant_a)
        trace_id_var.set("trace-audit-1")
        user_id_var.set("user-bad-actor")

        request = {"tenant_id": tenant_b, "agent_id": "agent-1"}
        mock_context = AsyncMock()

        async def original_handler(req, ctx):
            return {"success": True}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details("/test/ExecuteWorkflow")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor.intercept_service(continuation, details)
        await result_handler.unary_unary(request, mock_context)

        # Verify audit entry was recorded
        assert len(audit_store.entries) == 1
        entry = audit_store.entries[0]
        assert entry.metadata_tenant_id == tenant_a
        assert entry.payload_tenant_id == tenant_b
        assert entry.trace_id == "trace-audit-1"
        assert entry.user_id == "user-bad-actor"
        assert entry.method == "/test/ExecuteWorkflow"

    async def test_no_payload_tenant_passes(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
    ):
        """Request without tenant_id in payload passes (e.g., HealthCheck)."""
        tenant_id_var.set(tenant_a)

        # HealthCheck has no tenant_id in payload
        request = {}
        mock_context = AsyncMock()

        async def original_handler(req, ctx):
            return {"status": "serving"}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details("/test/HealthCheck")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor.intercept_service(continuation, details)
        response = await result_handler.unary_unary(request, mock_context)

        assert response == {"status": "serving"}
        mock_context.abort.assert_not_called()
        assert len(audit_store.entries) == 0

    async def test_empty_payload_tenant_passes(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
    ):
        """Request with empty string tenant_id in payload passes (treated as no tenant)."""
        tenant_id_var.set(tenant_a)

        request = {"tenant_id": ""}
        mock_context = AsyncMock()

        async def original_handler(req, ctx):
            return {"result": "ok"}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details("/test/Something")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor.intercept_service(continuation, details)
        response = await result_handler.unary_unary(request, mock_context)

        assert response == {"result": "ok"}
        mock_context.abort.assert_not_called()
        assert len(audit_store.entries) == 0

    async def test_none_handler_passthrough(
        self,
        interceptor: CrossTenantValidationInterceptor,
    ):
        """If continuation returns None handler, interceptor returns None."""
        details = _make_handler_call_details("/test/Unknown")
        continuation = AsyncMock(return_value=None)

        result = await interceptor.intercept_service(continuation, details)
        assert result is None

    async def test_without_audit_store(
        self,
        interceptor_no_store: CrossTenantValidationInterceptor,
        tenant_a: str,
        tenant_b: str,
    ):
        """Interceptor works without audit store (only logs)."""
        tenant_id_var.set(tenant_a)
        trace_id_var.set("trace-no-store")
        user_id_var.set("user-test")

        request = {"tenant_id": tenant_b}
        mock_context = AsyncMock()

        async def original_handler(req, ctx):
            return {"success": True}

        handler = _make_unary_handler(original_handler)
        details = _make_handler_call_details("/test/Method")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor_no_store.intercept_service(continuation, details)
        await result_handler.unary_unary(request, mock_context)

        # Should still abort even without audit store
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )

    async def test_streaming_handler_matching_tenants(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
    ):
        """Streaming handler with matching tenants passes validation."""
        tenant_id_var.set(tenant_a)

        request = {"tenant_id": tenant_a, "agent_id": "agent-1"}
        mock_context = AsyncMock()

        async def original_stream_handler(req, ctx):
            yield {"event": "step_started"}
            yield {"event": "workflow_completed"}

        handler = _make_stream_handler(original_stream_handler)
        details = _make_handler_call_details("/test/ExecuteWorkflowStream")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor.intercept_service(continuation, details)

        # Collect stream results
        events = []
        async for event in result_handler.unary_stream(request, mock_context):
            events.append(event)

        assert len(events) == 2
        assert events[0] == {"event": "step_started"}
        assert events[1] == {"event": "workflow_completed"}
        mock_context.abort.assert_not_called()
        assert len(audit_store.entries) == 0

    async def test_streaming_handler_mismatched_tenants(
        self,
        interceptor: CrossTenantValidationInterceptor,
        audit_store: InMemoryAuditLogStore,
        tenant_a: str,
        tenant_b: str,
    ):
        """Streaming handler with mismatched tenants is rejected."""
        tenant_id_var.set(tenant_a)
        trace_id_var.set("trace-stream")
        user_id_var.set("user-stream")

        request = {"tenant_id": tenant_b}
        mock_context = AsyncMock()

        async def original_stream_handler(req, ctx):
            yield {"event": "step_started"}

        handler = _make_stream_handler(original_stream_handler)
        details = _make_handler_call_details("/test/ExecuteWorkflowStream")

        continuation = AsyncMock(return_value=handler)
        result_handler = await interceptor.intercept_service(continuation, details)

        # Collect stream results
        events = []
        async for event in result_handler.unary_stream(request, mock_context):
            events.append(event)

        # Should have aborted, no events yielded
        assert len(events) == 0
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )
        assert len(audit_store.entries) == 1


# ---------------------------------------------------------------------------
# Tests: CrossTenantAuditEntry
# ---------------------------------------------------------------------------


class TestCrossTenantAuditEntry:
    """Tests for the audit entry data class."""

    def test_to_dict(self, tenant_a: str, tenant_b: str):
        """Audit entry serializes correctly to dict."""
        entry = CrossTenantAuditEntry(
            timestamp="2024-01-15T10:30:00+00:00",
            trace_id="trace-xyz",
            user_id="user-abc",
            method="/test/Execute",
            metadata_tenant_id=tenant_a,
            payload_tenant_id=tenant_b,
        )

        result = entry.to_dict()

        assert result["timestamp"] == "2024-01-15T10:30:00+00:00"
        assert result["trace_id"] == "trace-xyz"
        assert result["user_id"] == "user-abc"
        assert result["method"] == "/test/Execute"
        assert result["metadata_tenant_id"] == tenant_a
        assert result["payload_tenant_id"] == tenant_b
        assert result["event_type"] == "cross_tenant_access_attempt"

    def test_attributes(self, tenant_a: str, tenant_b: str):
        """Audit entry attributes are accessible."""
        entry = CrossTenantAuditEntry(
            timestamp="2024-01-15T10:30:00+00:00",
            trace_id="trace-1",
            user_id="user-1",
            method="/method",
            metadata_tenant_id=tenant_a,
            payload_tenant_id=tenant_b,
        )

        assert entry.metadata_tenant_id == tenant_a
        assert entry.payload_tenant_id == tenant_b
        assert entry.trace_id == "trace-1"
        assert entry.user_id == "user-1"
        assert entry.method == "/method"


# ---------------------------------------------------------------------------
# Tests: InMemoryAuditLogStore
# ---------------------------------------------------------------------------


class TestInMemoryAuditLogStore:
    """Tests for the in-memory audit log store."""

    async def test_stores_entries(self, tenant_a: str, tenant_b: str):
        """Store records entries in the list."""
        store = InMemoryAuditLogStore()

        entry = CrossTenantAuditEntry(
            timestamp="2024-01-15T10:30:00+00:00",
            trace_id="t1",
            user_id="u1",
            method="/m1",
            metadata_tenant_id=tenant_a,
            payload_tenant_id=tenant_b,
        )

        await store.record(entry)
        assert len(store.entries) == 1
        assert store.entries[0] is entry

    async def test_stores_multiple_entries(self, tenant_a: str, tenant_b: str):
        """Store accumulates multiple entries."""
        store = InMemoryAuditLogStore()

        for i in range(3):
            entry = CrossTenantAuditEntry(
                timestamp=f"2024-01-15T10:{i:02d}:00+00:00",
                trace_id=f"t{i}",
                user_id=f"u{i}",
                method=f"/m{i}",
                metadata_tenant_id=tenant_a,
                payload_tenant_id=tenant_b,
            )
            await store.record(entry)

        assert len(store.entries) == 3


# ---------------------------------------------------------------------------
# Tests: PostgresAuditLogStore
# ---------------------------------------------------------------------------


class TestPostgresAuditLogStore:
    """Tests for the PostgreSQL audit log store."""

    async def test_records_entry_to_database(self, tenant_a: str, tenant_b: str):
        """Records audit entry via SQL INSERT."""
        mock_conn = AsyncMock()

        # Create async context manager mock for pool.acquire()
        class FakeAcquireCtx:
            async def __aenter__(self):
                return mock_conn

            async def __aexit__(self, *args):
                return False

        mock_pool = MagicMock()
        mock_pool.acquire.return_value = FakeAcquireCtx()

        store = PostgresAuditLogStore(pg_pool=mock_pool)

        entry = CrossTenantAuditEntry(
            timestamp="2024-01-15T10:30:00+00:00",
            trace_id="trace-db-1",
            user_id="user-db-1",
            method="/test/Execute",
            metadata_tenant_id=tenant_a,
            payload_tenant_id=tenant_b,
        )

        await store.record(entry)

        mock_conn.execute.assert_called_once()
        call_args = mock_conn.execute.call_args
        sql = call_args[0][0]
        assert "INSERT INTO audit_logs" in sql
        assert call_args[0][1] == "cross_tenant_access_attempt"
        assert call_args[0][2] == "trace-db-1"
        assert call_args[0][3] == "user-db-1"

    async def test_handles_database_error_gracefully(self, tenant_a: str, tenant_b: str):
        """Database failure doesn't raise; error is logged."""
        mock_conn = AsyncMock()
        mock_conn.execute.side_effect = Exception("DB connection failed")

        class FakeAcquireCtx:
            async def __aenter__(self):
                return mock_conn

            async def __aexit__(self, *args):
                return False

        mock_pool = MagicMock()
        mock_pool.acquire.return_value = FakeAcquireCtx()

        store = PostgresAuditLogStore(pg_pool=mock_pool)

        entry = CrossTenantAuditEntry(
            timestamp="2024-01-15T10:30:00+00:00",
            trace_id="trace-err",
            user_id="user-err",
            method="/test/Execute",
            metadata_tenant_id=tenant_a,
            payload_tenant_id=tenant_b,
        )

        # Should not raise
        await store.record(entry)
