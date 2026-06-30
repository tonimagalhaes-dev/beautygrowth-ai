"""Tests for tenant_context utility module.

Validates that the tenant_connection context manager correctly sets
app.current_tenant via SET LOCAL and enforces RLS policies.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from contextlib import asynccontextmanager

from src.core.context_vars import tenant_id_var
from src.core.tenant_context import (
    TenantContextError,
    tenant_connection,
    tenant_connection_no_transaction,
)


# ---------------------------------------------------------------------------
# Helpers: mock asyncpg pool/connection
# ---------------------------------------------------------------------------


def _make_mock_connection():
    """Create a mock asyncpg connection with transaction support."""
    conn = AsyncMock()
    conn.execute = AsyncMock()
    conn.fetch = AsyncMock(return_value=[])
    conn.fetchrow = AsyncMock(return_value=None)

    # Make transaction() an async context manager
    tx = AsyncMock()
    tx.__aenter__ = AsyncMock(return_value=tx)
    tx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx)

    return conn


def _make_mock_pool(conn=None):
    """Create a mock asyncpg pool that yields a mock connection."""
    if conn is None:
        conn = _make_mock_connection()

    pool = MagicMock()

    @asynccontextmanager
    async def _acquire():
        yield conn

    pool.acquire = _acquire
    return pool, conn


# ---------------------------------------------------------------------------
# Tests: tenant_connection
# ---------------------------------------------------------------------------


class TestTenantConnection:
    """Tests for tenant_connection context manager."""

    @pytest.mark.asyncio
    async def test_sets_tenant_before_yielding(self):
        """Should execute SET LOCAL with the provided tenant_id."""
        pool, conn = _make_mock_pool()
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        async with tenant_connection(pool, tenant_id) as c:
            assert c is conn

        # Verify set_config was called with correct tenant_id
        conn.execute.assert_any_call(
            "SELECT set_config('app.current_tenant', $1, true)",
            tenant_id,
        )

    @pytest.mark.asyncio
    async def test_wraps_in_transaction(self):
        """Should execute within a transaction context."""
        pool, conn = _make_mock_pool()
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        async with tenant_connection(pool, tenant_id) as c:
            pass

        # Verify transaction was used
        conn.transaction.assert_called_once()

    @pytest.mark.asyncio
    async def test_reads_from_contextvar_when_no_explicit_tenant(self):
        """Should read tenant_id from contextvar if not explicitly provided."""
        pool, conn = _make_mock_pool()
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        token = tenant_id_var.set(tenant_id)
        try:
            async with tenant_connection(pool) as c:
                assert c is conn

            conn.execute.assert_any_call(
                "SELECT set_config('app.current_tenant', $1, true)",
                tenant_id,
            )
        finally:
            tenant_id_var.reset(token)

    @pytest.mark.asyncio
    async def test_raises_error_when_no_tenant_available(self):
        """Should raise TenantContextError if no tenant_id is available."""
        pool, conn = _make_mock_pool()

        token = tenant_id_var.set("")
        try:
            with pytest.raises(TenantContextError, match="No tenant_id available"):
                async with tenant_connection(pool) as c:
                    pass
        finally:
            tenant_id_var.reset(token)

    @pytest.mark.asyncio
    async def test_explicit_tenant_takes_precedence_over_contextvar(self):
        """Should use explicit tenant_id even if contextvar has a value."""
        pool, conn = _make_mock_pool()
        explicit_tenant = "aaaa0000-e29b-41d4-a716-446655440000"
        contextvar_tenant = "bbbb0000-e29b-41d4-a716-446655440000"

        token = tenant_id_var.set(contextvar_tenant)
        try:
            async with tenant_connection(pool, explicit_tenant) as c:
                pass

            conn.execute.assert_any_call(
                "SELECT set_config('app.current_tenant', $1, true)",
                explicit_tenant,
            )
        finally:
            tenant_id_var.reset(token)

    @pytest.mark.asyncio
    async def test_connection_usable_for_queries(self):
        """Should allow executing queries within the tenant context."""
        pool, conn = _make_mock_pool()
        conn.fetch.return_value = [{"id": "test"}]
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        async with tenant_connection(pool, tenant_id) as c:
            result = await c.fetch("SELECT * FROM workflow_executions")
            assert result == [{"id": "test"}]


# ---------------------------------------------------------------------------
# Tests: tenant_connection_no_transaction
# ---------------------------------------------------------------------------


class TestTenantConnectionNoTransaction:
    """Tests for tenant_connection_no_transaction context manager."""

    @pytest.mark.asyncio
    async def test_sets_tenant_without_transaction(self):
        """Should set tenant context without starting a transaction."""
        pool, conn = _make_mock_pool()
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        async with tenant_connection_no_transaction(pool, tenant_id) as c:
            assert c is conn

        # Verify set_config was called
        conn.execute.assert_any_call(
            "SELECT set_config('app.current_tenant', $1, true)",
            tenant_id,
        )

        # Verify transaction was NOT started
        conn.transaction.assert_not_called()

    @pytest.mark.asyncio
    async def test_raises_error_when_no_tenant_available(self):
        """Should raise TenantContextError if no tenant_id is available."""
        pool, conn = _make_mock_pool()

        token = tenant_id_var.set("")
        try:
            with pytest.raises(TenantContextError, match="No tenant_id available"):
                async with tenant_connection_no_transaction(pool) as c:
                    pass
        finally:
            tenant_id_var.reset(token)
