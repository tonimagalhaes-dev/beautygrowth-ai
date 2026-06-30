"""gRPC interceptors for tenant validation and context propagation.

Implements:
- TenantValidationInterceptor: validates x-tenant-id metadata on every RPC call
- CrossTenantValidationInterceptor: cross-cutting interceptor that validates metadata
  tenant_id matches payload tenant_id for ALL RPCs, and logs cross-tenant attempts
- validate_tenant_payload_match: utility to compare metadata tenant_id vs payload tenant_id
- UUID validation helper
- Context propagation via Python contextvars
- Audit logging for cross-tenant access attempts

Requirements: 5.4, 5.5, 5.6, 5.7
"""

from __future__ import annotations

import logging
import re
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Callable, List, Tuple

import grpc
from grpc import aio

from ..core.context_vars import tenant_id_var, trace_id_var, user_id_var

logger = logging.getLogger(__name__)

# Dedicated audit logger for cross-tenant access attempts
audit_logger = logging.getLogger("audit.cross_tenant")

# ---------------------------------------------------------------------------
# UUID validation
# ---------------------------------------------------------------------------

_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def is_valid_uuid(value: str) -> bool:
    """Check if a string is a valid UUID format.

    Args:
        value: The string to validate.

    Returns:
        True if the string matches UUID format, False otherwise.
    """
    return bool(_UUID_PATTERN.match(value))


# ---------------------------------------------------------------------------
# Metadata extraction helper
# ---------------------------------------------------------------------------


def _extract_metadata_value(
    metadata: Tuple[Tuple[str, str], ...] | None, key: str
) -> str | None:
    """Extract a value from gRPC invocation metadata by key.

    Args:
        metadata: The gRPC invocation metadata (tuple of key-value tuples).
        key: The metadata key to look for (case-insensitive).

    Returns:
        The metadata value if found, None otherwise.
    """
    if metadata is None:
        return None
    for k, v in metadata:
        if k.lower() == key.lower():
            return v
    return None


# ---------------------------------------------------------------------------
# Tenant Validation Interceptor
# ---------------------------------------------------------------------------


class TenantValidationInterceptor(aio.ServerInterceptor):
    """gRPC server interceptor that validates tenant_id from metadata.

    Extracts x-tenant-id, x-trace-id, x-user-id from gRPC invocation metadata.
    Rejects calls missing x-tenant-id or with invalid UUID format.
    Stores extracted values in contextvars for downstream access.

    Requirements: 5.5, 5.6, 5.7
    """

    async def intercept_service(
        self,
        continuation: Callable,
        handler_call_details: grpc.HandlerCallDetails,
    ) -> Any:
        """Intercept incoming gRPC calls to validate tenant metadata.

        Args:
            continuation: The next handler in the chain.
            handler_call_details: Details about the incoming RPC call.

        Returns:
            The handler if validation passes, or an abort handler if validation fails.
        """
        metadata = handler_call_details.invocation_metadata

        # Extract x-tenant-id
        tenant_id = _extract_metadata_value(metadata, "x-tenant-id")

        if not tenant_id:
            logger.warning(
                "gRPC call rejected: missing x-tenant-id header for method %s",
                handler_call_details.method,
            )
            return _create_abort_handler(
                grpc.StatusCode.INVALID_ARGUMENT,
                "Missing x-tenant-id header",
            )

        if not is_valid_uuid(tenant_id):
            logger.warning(
                "gRPC call rejected: invalid x-tenant-id format '%s' for method %s",
                tenant_id,
                handler_call_details.method,
            )
            return _create_abort_handler(
                grpc.StatusCode.INVALID_ARGUMENT,
                "Invalid x-tenant-id format: must be a valid UUID",
            )

        # Extract optional headers
        trace_id = _extract_metadata_value(metadata, "x-trace-id") or ""
        user_id = _extract_metadata_value(metadata, "x-user-id") or ""

        # Set context variables for downstream handlers
        tenant_id_var.set(tenant_id)
        trace_id_var.set(trace_id)
        user_id_var.set(user_id)

        return await continuation(handler_call_details)


# ---------------------------------------------------------------------------
# Cross-Tenant Validation Interceptor (Cross-cutting)
# ---------------------------------------------------------------------------


def _extract_payload_tenant_id(request: Any) -> str | None:
    """Extract tenant_id from request payload.

    Supports dict-like and protobuf-like request objects.

    Args:
        request: The deserialized request payload.

    Returns:
        The tenant_id string if found, None otherwise.
    """
    if request is None:
        return None
    if isinstance(request, dict):
        return request.get("tenant_id")
    return getattr(request, "tenant_id", None)


class CrossTenantValidationInterceptor(aio.ServerInterceptor):
    """gRPC server interceptor that validates metadata tenant_id matches payload.

    This is a cross-cutting concern: for ALL RPCs that carry a tenant_id
    in the payload, the interceptor ensures it matches the x-tenant-id from
    gRPC metadata. If there's a mismatch, the call is rejected with
    PERMISSION_DENIED and the attempt is logged in the audit log.

    This interceptor wraps the handler to perform post-deserialization validation.

    Requirements: 5.4, 5.6, 5.7
    """

    def __init__(self, audit_log_store: AuditLogStore | None = None) -> None:
        """Initialize the cross-tenant validation interceptor.

        Args:
            audit_log_store: Optional persistent audit log store for recording
                cross-tenant access attempts. If None, only logs to audit_logger.
        """
        self._audit_log_store = audit_log_store

    async def intercept_service(
        self,
        continuation: Callable,
        handler_call_details: grpc.HandlerCallDetails,
    ) -> Any:
        """Intercept and wrap handler to validate tenant consistency post-deserialization.

        Args:
            continuation: The next handler in the chain.
            handler_call_details: Details about the incoming RPC call.

        Returns:
            A wrapped handler that validates tenant_id match after deserialization.
        """
        # Get the original handler from the chain
        handler = await continuation(handler_call_details)

        if handler is None:
            return handler

        # Wrap the handler's unary_unary or unary_stream to inject validation
        method = handler_call_details.method or ""

        if handler.unary_unary:
            original_fn = handler.unary_unary
            wrapped_fn = self._wrap_unary_unary(original_fn, method)
            return grpc.unary_unary_rpc_method_handler(
                wrapped_fn,
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )

        if handler.unary_stream:
            original_fn = handler.unary_stream
            wrapped_fn = self._wrap_unary_stream(original_fn, method)
            return grpc.unary_stream_rpc_method_handler(
                wrapped_fn,
                request_deserializer=handler.request_deserializer,
                response_serializer=handler.response_serializer,
            )

        # For stream_unary and stream_stream, return as-is (no payload tenant to check)
        return handler

    def _wrap_unary_unary(self, original_fn: Callable, method: str) -> Callable:
        """Wrap a unary-unary handler to inject tenant validation.

        Args:
            original_fn: The original handler function.
            method: The gRPC method name for logging.

        Returns:
            A wrapped async function with tenant validation.
        """
        interceptor = self

        async def _wrapped(request: Any, context: grpc.aio.ServicerContext) -> Any:
            if not await interceptor._validate_cross_tenant(request, context, method):
                return None
            return await original_fn(request, context)

        return _wrapped

    def _wrap_unary_stream(self, original_fn: Callable, method: str) -> Callable:
        """Wrap a unary-stream handler to inject tenant validation.

        Args:
            original_fn: The original handler function.
            method: The gRPC method name for logging.

        Returns:
            A wrapped async generator with tenant validation.
        """
        interceptor = self

        async def _wrapped(request: Any, context: grpc.aio.ServicerContext):
            if not await interceptor._validate_cross_tenant(request, context, method):
                return
            async for item in original_fn(request, context):
                yield item

        return _wrapped

    async def _validate_cross_tenant(
        self,
        request: Any,
        context: grpc.aio.ServicerContext,
        method: str,
    ) -> bool:
        """Validate that metadata tenant_id matches payload tenant_id.

        Logs cross-tenant access attempts to the audit log and rejects with
        PERMISSION_DENIED.

        Args:
            request: The deserialized request payload.
            context: The gRPC servicer context.
            method: The gRPC method name.

        Returns:
            True if validation passes, False if the call was aborted.
        """
        metadata_tenant_id = tenant_id_var.get()
        payload_tenant_id = _extract_payload_tenant_id(request)

        # If there's no tenant_id in payload, skip cross-tenant validation
        # (e.g., HealthCheck requests don't carry tenant_id in payload)
        if not payload_tenant_id:
            return True

        # If they match, validation passes
        if metadata_tenant_id == payload_tenant_id:
            return True

        # Cross-tenant access attempt detected!
        trace_id = trace_id_var.get()
        user_id = user_id_var.get()

        # Log the audit event
        audit_entry = CrossTenantAuditEntry(
            timestamp=datetime.now(timezone.utc).isoformat(),
            trace_id=trace_id,
            user_id=user_id,
            method=method,
            metadata_tenant_id=metadata_tenant_id,
            payload_tenant_id=payload_tenant_id,
        )

        audit_logger.warning(
            "CROSS-TENANT ACCESS ATTEMPT: method=%s, metadata_tenant=%s, "
            "payload_tenant=%s, trace_id=%s, user_id=%s",
            method,
            metadata_tenant_id,
            payload_tenant_id,
            trace_id,
            user_id,
        )

        # Persist to audit log store if available
        if self._audit_log_store:
            await self._audit_log_store.record(audit_entry)

        # Reject with PERMISSION_DENIED
        await context.abort(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )
        return False


# ---------------------------------------------------------------------------
# Audit logging types and store
# ---------------------------------------------------------------------------


class CrossTenantAuditEntry:
    """Represents an audit log entry for a cross-tenant access attempt.

    Attributes:
        timestamp: ISO timestamp of the attempt.
        trace_id: The trace ID from the request.
        user_id: The user ID that attempted the cross-tenant access.
        method: The gRPC method being called.
        metadata_tenant_id: The tenant_id from gRPC metadata (authenticated).
        payload_tenant_id: The tenant_id in the request payload (target).
    """

    def __init__(
        self,
        timestamp: str,
        trace_id: str,
        user_id: str,
        method: str,
        metadata_tenant_id: str,
        payload_tenant_id: str,
    ) -> None:
        self.timestamp = timestamp
        self.trace_id = trace_id
        self.user_id = user_id
        self.method = method
        self.metadata_tenant_id = metadata_tenant_id
        self.payload_tenant_id = payload_tenant_id

    def to_dict(self) -> dict:
        """Convert to dictionary for serialization."""
        return {
            "timestamp": self.timestamp,
            "trace_id": self.trace_id,
            "user_id": self.user_id,
            "method": self.method,
            "metadata_tenant_id": self.metadata_tenant_id,
            "payload_tenant_id": self.payload_tenant_id,
            "event_type": "cross_tenant_access_attempt",
        }


class AuditLogStore:
    """Interface for persisting audit log entries.

    Subclass this to implement persistence to PostgreSQL, file system,
    or external logging services.
    """

    async def record(self, entry: CrossTenantAuditEntry) -> None:
        """Record an audit log entry.

        Args:
            entry: The audit entry to persist.
        """
        raise NotImplementedError


class PostgresAuditLogStore(AuditLogStore):
    """Audit log store that persists entries to PostgreSQL audit_logs table.

    Requires an asyncpg connection pool.
    """

    def __init__(self, pg_pool: Any) -> None:
        """Initialize with PostgreSQL connection pool.

        Args:
            pg_pool: asyncpg pool for database access.
        """
        self._pg_pool = pg_pool

    async def record(self, entry: CrossTenantAuditEntry) -> None:
        """Record a cross-tenant access attempt in the audit_logs table.

        Args:
            entry: The audit entry to persist.
        """
        try:
            async with self._pg_pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO audit_logs (
                        event_type, trace_id, user_id, method,
                        metadata_tenant_id, payload_tenant_id, created_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
                    """,
                    "cross_tenant_access_attempt",
                    entry.trace_id,
                    entry.user_id,
                    entry.method,
                    entry.metadata_tenant_id,
                    entry.payload_tenant_id,
                )
        except Exception as e:
            # Never let audit logging failure break the main flow
            logger.error(
                "Failed to persist audit log entry: %s (trace_id=%s)",
                str(e),
                entry.trace_id,
            )


class InMemoryAuditLogStore(AuditLogStore):
    """In-memory audit log store for testing.

    Stores entries in a list for easy assertion in tests.
    """

    def __init__(self) -> None:
        self.entries: List[CrossTenantAuditEntry] = []

    async def record(self, entry: CrossTenantAuditEntry) -> None:
        """Record an audit entry in memory.

        Args:
            entry: The audit entry to store.
        """
        self.entries.append(entry)


# ---------------------------------------------------------------------------
# Payload validation utility
# ---------------------------------------------------------------------------


def validate_tenant_payload_match(
    metadata_tenant_id: str, payload_tenant_id: str
) -> None:
    """Validate that the tenant_id from metadata matches the payload tenant_id.

    This should be called in each servicer handler after extracting metadata.
    Raises grpc.RpcError (via context.abort) if they don't match.

    Args:
        metadata_tenant_id: The tenant_id extracted from gRPC metadata.
        payload_tenant_id: The tenant_id from the request payload.

    Raises:
        TenantMismatchError: If metadata and payload tenant_ids don't match.
    """
    if metadata_tenant_id != payload_tenant_id:
        raise TenantMismatchError(
            metadata_tenant_id=metadata_tenant_id,
            payload_tenant_id=payload_tenant_id,
        )


class TenantMismatchError(Exception):
    """Raised when metadata tenant_id does not match payload tenant_id."""

    def __init__(self, metadata_tenant_id: str, payload_tenant_id: str) -> None:
        self.metadata_tenant_id = metadata_tenant_id
        self.payload_tenant_id = payload_tenant_id
        super().__init__(
            "Metadata tenant_id does not match payload tenant_id"
        )


async def check_tenant_consistency(
    context: grpc.aio.ServicerContext,
    payload_tenant_id: str,
) -> bool:
    """Check tenant consistency between metadata and payload in a servicer handler.

    Convenience function that reads tenant_id from contextvar and compares
    with payload. Aborts the RPC with PERMISSION_DENIED if they don't match.

    Args:
        context: The gRPC servicer context (for aborting).
        payload_tenant_id: The tenant_id from the request payload.

    Returns:
        True if tenant_ids match, False if the call was aborted.
    """
    metadata_tenant_id = tenant_id_var.get()
    if metadata_tenant_id != payload_tenant_id:
        logger.warning(
            "Tenant mismatch: metadata=%s payload=%s",
            metadata_tenant_id,
            payload_tenant_id,
        )
        await context.abort(
            grpc.StatusCode.PERMISSION_DENIED,
            "Metadata tenant_id does not match payload tenant_id",
        )
        return False
    return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _create_abort_handler(code: grpc.StatusCode, details: str) -> grpc.RpcMethodHandler:
    """Create an RPC handler that immediately aborts with the given status.

    Args:
        code: The gRPC status code to abort with.
        details: The error detail message.

    Returns:
        A grpc.RpcMethodHandler that aborts with the given code and details.
    """

    async def _abort_unary_unary(request, context: grpc.aio.ServicerContext):
        await context.abort(code, details)

    async def _abort_unary_stream(request, context: grpc.aio.ServicerContext):
        await context.abort(code, details)

    async def _abort_stream_unary(request_iterator, context: grpc.aio.ServicerContext):
        await context.abort(code, details)

    async def _abort_stream_stream(request_iterator, context: grpc.aio.ServicerContext):
        await context.abort(code, details)

    return grpc.unary_unary_rpc_method_handler(
        _abort_unary_unary,
    )
