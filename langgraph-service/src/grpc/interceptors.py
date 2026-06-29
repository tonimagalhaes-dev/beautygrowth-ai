"""gRPC interceptors for tenant validation and context propagation.

Implements:
- TenantValidationInterceptor: validates x-tenant-id metadata on every RPC call
- validate_tenant_payload_match: utility to compare metadata tenant_id vs payload tenant_id
- UUID validation helper
- Context propagation via Python contextvars

Requirements: 5.5, 5.6, 5.7
"""

from __future__ import annotations

import logging
import re
from contextvars import ContextVar
from typing import Any, Callable, Tuple

import grpc
from grpc import aio

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Context variables for propagating tenant/trace/user across async call stack
# ---------------------------------------------------------------------------

tenant_id_var: ContextVar[str] = ContextVar("tenant_id_var", default="")
trace_id_var: ContextVar[str] = ContextVar("trace_id_var", default="")
user_id_var: ContextVar[str] = ContextVar("user_id_var", default="")

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
