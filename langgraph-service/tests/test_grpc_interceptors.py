"""Unit tests for gRPC tenant validation interceptor.

Tests:
- Valid UUID passes validation
- Missing tenant_id rejected with INVALID_ARGUMENT
- Invalid UUID format rejected with INVALID_ARGUMENT
- Mismatched tenant_id (metadata vs payload) rejected with PERMISSION_DENIED
- Context propagation via contextvars
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

TenantValidationInterceptor = _module.TenantValidationInterceptor
is_valid_uuid = _module.is_valid_uuid
validate_tenant_payload_match = _module.validate_tenant_payload_match
check_tenant_consistency = _module.check_tenant_consistency
TenantMismatchError = _module.TenantMismatchError
tenant_id_var = _module.tenant_id_var
trace_id_var = _module.trace_id_var
user_id_var = _module.user_id_var
_extract_metadata_value = _module._extract_metadata_value

import grpc


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def interceptor() -> TenantValidationInterceptor:
    """Provide a TenantValidationInterceptor instance."""
    return TenantValidationInterceptor()


@pytest.fixture
def valid_tenant_id() -> str:
    """A valid UUID tenant_id."""
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def valid_trace_id() -> str:
    """A valid trace_id."""
    return "trace-abc-123"


@pytest.fixture
def valid_user_id() -> str:
    """A valid user_id."""
    return "880e8400-e29b-41d4-a716-446655440099"


def _make_handler_call_details(metadata: list[tuple[str, str]] | None = None):
    """Create a mock HandlerCallDetails with given metadata."""
    details = MagicMock()
    details.method = "/beautygrowth.orchestration.v1.AgentOrchestrationService/ExecuteWorkflow"
    details.invocation_metadata = metadata
    return details


# ---------------------------------------------------------------------------
# Tests: UUID Validation
# ---------------------------------------------------------------------------


class TestUUIDValidation:
    """Tests for UUID validation helper."""

    def test_valid_uuid_lowercase(self):
        assert is_valid_uuid("550e8400-e29b-41d4-a716-446655440000") is True

    def test_valid_uuid_uppercase(self):
        assert is_valid_uuid("550E8400-E29B-41D4-A716-446655440000") is True

    def test_valid_uuid_mixed_case(self):
        assert is_valid_uuid("550e8400-E29B-41d4-a716-446655440000") is True

    def test_invalid_uuid_missing_dashes(self):
        assert is_valid_uuid("550e8400e29b41d4a716446655440000") is False

    def test_invalid_uuid_too_short(self):
        assert is_valid_uuid("550e8400-e29b-41d4-a716") is False

    def test_invalid_uuid_too_long(self):
        assert is_valid_uuid("550e8400-e29b-41d4-a716-4466554400001") is False

    def test_invalid_uuid_not_hex(self):
        assert is_valid_uuid("550e8400-e29b-41d4-a716-44665544000z") is False

    def test_invalid_uuid_empty_string(self):
        assert is_valid_uuid("") is False

    def test_invalid_uuid_random_string(self):
        assert is_valid_uuid("not-a-uuid-at-all") is False

    def test_invalid_uuid_with_braces(self):
        assert is_valid_uuid("{550e8400-e29b-41d4-a716-446655440000}") is False


# ---------------------------------------------------------------------------
# Tests: Metadata Extraction
# ---------------------------------------------------------------------------


class TestMetadataExtraction:
    """Tests for _extract_metadata_value helper."""

    def test_extract_existing_key(self):
        metadata = [("x-tenant-id", "abc"), ("x-trace-id", "def")]
        assert _extract_metadata_value(metadata, "x-tenant-id") == "abc"

    def test_extract_missing_key(self):
        metadata = [("x-trace-id", "def")]
        assert _extract_metadata_value(metadata, "x-tenant-id") is None

    def test_extract_from_none_metadata(self):
        assert _extract_metadata_value(None, "x-tenant-id") is None

    def test_extract_case_insensitive(self):
        metadata = [("X-Tenant-Id", "abc")]
        assert _extract_metadata_value(metadata, "x-tenant-id") == "abc"

    def test_extract_empty_metadata(self):
        metadata = []
        assert _extract_metadata_value(metadata, "x-tenant-id") is None


# ---------------------------------------------------------------------------
# Tests: TenantValidationInterceptor
# ---------------------------------------------------------------------------


class TestTenantValidationInterceptor:
    """Tests for the gRPC TenantValidationInterceptor."""

    async def test_valid_tenant_id_passes(
        self, interceptor: TenantValidationInterceptor, valid_tenant_id: str
    ):
        """Valid UUID in x-tenant-id passes validation and continues to handler."""
        metadata = [
            ("x-tenant-id", valid_tenant_id),
            ("x-trace-id", "trace-123"),
            ("x-user-id", "user-456"),
        ]
        details = _make_handler_call_details(metadata)

        continuation = AsyncMock(return_value="handler_result")

        result = await interceptor.intercept_service(continuation, details)

        continuation.assert_called_once_with(details)
        assert result == "handler_result"

    async def test_valid_tenant_sets_context_vars(
        self, interceptor: TenantValidationInterceptor, valid_tenant_id: str
    ):
        """Valid call sets tenant_id, trace_id, user_id in contextvars."""
        metadata = [
            ("x-tenant-id", valid_tenant_id),
            ("x-trace-id", "trace-xyz"),
            ("x-user-id", "user-abc"),
        ]
        details = _make_handler_call_details(metadata)
        continuation = AsyncMock(return_value="handler_result")

        await interceptor.intercept_service(continuation, details)

        assert tenant_id_var.get() == valid_tenant_id
        assert trace_id_var.get() == "trace-xyz"
        assert user_id_var.get() == "user-abc"

    async def test_missing_tenant_id_rejected(
        self, interceptor: TenantValidationInterceptor
    ):
        """Missing x-tenant-id metadata is rejected with INVALID_ARGUMENT."""
        metadata = [("x-trace-id", "trace-123")]
        details = _make_handler_call_details(metadata)
        continuation = AsyncMock()

        result = await interceptor.intercept_service(continuation, details)

        # continuation should NOT be called
        continuation.assert_not_called()
        # result should be an abort handler
        assert result is not None

        # Verify the abort handler aborts with correct code
        mock_context = AsyncMock()
        await result.unary_unary(None, mock_context)
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.INVALID_ARGUMENT,
            "Missing x-tenant-id header",
        )

    async def test_none_metadata_rejected(
        self, interceptor: TenantValidationInterceptor
    ):
        """None metadata (no headers at all) is rejected with INVALID_ARGUMENT."""
        details = _make_handler_call_details(None)
        continuation = AsyncMock()

        result = await interceptor.intercept_service(continuation, details)

        continuation.assert_not_called()
        assert result is not None

        mock_context = AsyncMock()
        await result.unary_unary(None, mock_context)
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.INVALID_ARGUMENT,
            "Missing x-tenant-id header",
        )

    async def test_invalid_uuid_format_rejected(
        self, interceptor: TenantValidationInterceptor
    ):
        """Invalid UUID format in x-tenant-id is rejected with INVALID_ARGUMENT."""
        metadata = [("x-tenant-id", "not-a-valid-uuid")]
        details = _make_handler_call_details(metadata)
        continuation = AsyncMock()

        result = await interceptor.intercept_service(continuation, details)

        continuation.assert_not_called()
        assert result is not None

        mock_context = AsyncMock()
        await result.unary_unary(None, mock_context)
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.INVALID_ARGUMENT,
            "Invalid x-tenant-id format: must be a valid UUID",
        )

    async def test_empty_tenant_id_rejected(
        self, interceptor: TenantValidationInterceptor
    ):
        """Empty string x-tenant-id is rejected with INVALID_ARGUMENT."""
        metadata = [("x-tenant-id", "")]
        details = _make_handler_call_details(metadata)
        continuation = AsyncMock()

        result = await interceptor.intercept_service(continuation, details)

        continuation.assert_not_called()

        mock_context = AsyncMock()
        await result.unary_unary(None, mock_context)
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.INVALID_ARGUMENT,
            "Missing x-tenant-id header",
        )

    async def test_optional_headers_not_required(
        self, interceptor: TenantValidationInterceptor, valid_tenant_id: str
    ):
        """x-trace-id and x-user-id are optional — call should not be rejected."""
        metadata = [("x-tenant-id", valid_tenant_id)]
        details = _make_handler_call_details(metadata)
        continuation = AsyncMock(return_value="handler_result")

        result = await interceptor.intercept_service(continuation, details)

        continuation.assert_called_once_with(details)
        assert result == "handler_result"
        assert tenant_id_var.get() == valid_tenant_id
        assert trace_id_var.get() == ""
        assert user_id_var.get() == ""


# ---------------------------------------------------------------------------
# Tests: Payload Validation (tenant_id mismatch)
# ---------------------------------------------------------------------------


class TestPayloadValidation:
    """Tests for tenant_id payload validation utility."""

    def test_matching_tenant_ids_passes(self, valid_tenant_id: str):
        """No error when metadata and payload tenant_ids match."""
        # Should not raise
        validate_tenant_payload_match(valid_tenant_id, valid_tenant_id)

    def test_mismatched_tenant_ids_raises(self, valid_tenant_id: str):
        """TenantMismatchError raised when tenant_ids don't match."""
        other_tenant = "660e8400-e29b-41d4-a716-446655440001"
        with pytest.raises(TenantMismatchError) as exc_info:
            validate_tenant_payload_match(valid_tenant_id, other_tenant)

        error = exc_info.value
        assert error.metadata_tenant_id == valid_tenant_id
        assert error.payload_tenant_id == other_tenant
        assert "does not match" in str(error)


class TestCheckTenantConsistency:
    """Tests for the check_tenant_consistency servicer utility."""

    async def test_matching_tenants_returns_true(self, valid_tenant_id: str):
        """Returns True when metadata and payload tenant_ids match."""
        tenant_id_var.set(valid_tenant_id)
        mock_context = AsyncMock()

        result = await check_tenant_consistency(mock_context, valid_tenant_id)

        assert result is True
        mock_context.abort.assert_not_called()

    async def test_mismatched_tenants_aborts_with_permission_denied(
        self, valid_tenant_id: str
    ):
        """Aborts with PERMISSION_DENIED when tenant_ids don't match."""
        tenant_id_var.set(valid_tenant_id)
        other_tenant = "660e8400-e29b-41d4-a716-446655440001"
        mock_context = AsyncMock()

        result = await check_tenant_consistency(mock_context, other_tenant)

        assert result is False
        mock_context.abort.assert_called_once_with(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )
