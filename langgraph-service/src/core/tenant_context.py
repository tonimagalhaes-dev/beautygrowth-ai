"""Tenant context utilities for PostgreSQL RLS enforcement.

Provides a context manager that sets the `app.current_tenant` session variable
before executing queries, ensuring Row Level Security (RLS) policies are enforced
on tenant-scoped tables (workflow_executions, workflow_definitions).

The tenant_id is read from the contextvar set by the gRPC TenantValidationInterceptor,
or can be explicitly provided.

Usage:
    async with tenant_connection(pool, tenant_id) as conn:
        rows = await conn.fetch("SELECT * FROM workflow_executions")

    # Or using the contextvar (set by TenantValidationInterceptor):
    async with tenant_connection(pool) as conn:
        rows = await conn.fetch("SELECT * FROM workflow_definitions WHERE ...")

Requirements: 5.2
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import asyncpg

from .context_vars import tenant_id_var

logger = logging.getLogger(__name__)


class TenantContextError(Exception):
    """Raised when tenant context cannot be established."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


@asynccontextmanager
async def tenant_connection(
    pool: asyncpg.Pool,
    tenant_id: str | None = None,
) -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection with RLS tenant context set via SET LOCAL.

    Acquires a connection from the pool, starts a transaction, and sets
    `app.current_tenant` using SET LOCAL (scoped to the transaction).
    This ensures RLS policies on workflow_executions and workflow_definitions
    tables are properly enforced.

    Args:
        pool: asyncpg connection pool.
        tenant_id: Explicit tenant_id to use. If None, reads from the
            contextvar set by TenantValidationInterceptor.

    Yields:
        asyncpg.Connection with tenant context set within a transaction.

    Raises:
        TenantContextError: If no tenant_id is available (neither explicit
            nor from contextvar).

    Example:
        async with tenant_connection(pool, "550e8400-...") as conn:
            await conn.fetch("SELECT * FROM workflow_executions")
    """
    resolved_tenant_id = tenant_id or tenant_id_var.get()

    if not resolved_tenant_id:
        raise TenantContextError(
            "No tenant_id available: provide explicitly or set via "
            "TenantValidationInterceptor contextvar"
        )

    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "SELECT set_config('app.current_tenant', $1, true)",
                resolved_tenant_id,
            )
            yield conn


@asynccontextmanager
async def tenant_connection_no_transaction(
    pool: asyncpg.Pool,
    tenant_id: str | None = None,
) -> AsyncIterator[asyncpg.Connection]:
    """Acquire a connection with RLS tenant context without starting a transaction.

    Similar to `tenant_connection` but does not start a transaction. Uses
    `set_config(..., true)` which scopes the setting to the current transaction
    if one exists, otherwise to the session. This variant is useful when the
    caller needs to manage their own transaction boundaries.

    Args:
        pool: asyncpg connection pool.
        tenant_id: Explicit tenant_id to use. If None, reads from contextvar.

    Yields:
        asyncpg.Connection with tenant context set.

    Raises:
        TenantContextError: If no tenant_id is available.
    """
    resolved_tenant_id = tenant_id or tenant_id_var.get()

    if not resolved_tenant_id:
        raise TenantContextError(
            "No tenant_id available: provide explicitly or set via "
            "TenantValidationInterceptor contextvar"
        )

    async with pool.acquire() as conn:
        await conn.execute(
            "SELECT set_config('app.current_tenant', $1, true)",
            resolved_tenant_id,
        )
        yield conn
