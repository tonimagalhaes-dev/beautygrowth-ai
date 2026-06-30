"""Tests for PostgresAgentRouter workflow resolution."""

import json
import sys
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Import directly from the module to avoid __init__.py pulling in
# graph_builder which requires Python 3.10+ match syntax
import importlib.util

_service_root = Path(__file__).parent.parent
sys.path.insert(0, str(_service_root))

# Set up package structure in sys.modules so relative imports work
if "src" not in sys.modules:
    src_pkg = types.ModuleType("src")
    src_pkg.__path__ = [str(_service_root / "src")]
    sys.modules["src"] = src_pkg

if "src.core" not in sys.modules:
    core_pkg = types.ModuleType("src.core")
    core_pkg.__path__ = [str(_service_root / "src" / "core")]
    sys.modules["src.core"] = core_pkg

# Load context_vars first (leaf dependency, no circular imports)
_cv_path = _service_root / "src" / "core" / "context_vars.py"
_cv_spec = importlib.util.spec_from_file_location("src.core.context_vars", _cv_path)
_cv_mod = importlib.util.module_from_spec(_cv_spec)
_cv_mod.__package__ = "src.core"
sys.modules["src.core.context_vars"] = _cv_mod
_cv_spec.loader.exec_module(_cv_mod)

# Load tenant_context (depends on context_vars)
_tc_path = _service_root / "src" / "core" / "tenant_context.py"
_tc_spec = importlib.util.spec_from_file_location("src.core.tenant_context", _tc_path)
_tc_mod = importlib.util.module_from_spec(_tc_spec)
_tc_mod.__package__ = "src.core"
sys.modules["src.core.tenant_context"] = _tc_mod
_tc_spec.loader.exec_module(_tc_mod)

# Load agent_router (depends on tenant_context)
_module_path = _service_root / "src" / "core" / "agent_router.py"
_spec = importlib.util.spec_from_file_location("src.core.agent_router", _module_path)
_agent_router_mod = importlib.util.module_from_spec(_spec)
_agent_router_mod.__package__ = "src.core"
sys.modules["src.core.agent_router"] = _agent_router_mod
_spec.loader.exec_module(_agent_router_mod)

AgentNotFoundError = _agent_router_mod.AgentNotFoundError
PostgresAgentRouter = _agent_router_mod.PostgresAgentRouter
ResolvedWorkflow = _agent_router_mod.ResolvedWorkflow
RouterConnectionError = _agent_router_mod.RouterConnectionError
RouterError = _agent_router_mod.RouterError
WorkflowNotFoundError = _agent_router_mod.WorkflowNotFoundError


# --- Fixtures ---


@pytest.fixture
def mock_pool():
    """Create a mock asyncpg pool."""
    pool = AsyncMock()
    return pool


@pytest.fixture
def mock_connection():
    """Create a mock asyncpg connection."""
    conn = AsyncMock()
    return conn


@pytest.fixture
def router(mock_pool):
    """Create a PostgresAgentRouter with a mocked pool."""
    return PostgresAgentRouter(mock_pool)


@pytest.fixture
def sample_graph_definition():
    """Sample graph definition for testing."""
    return {
        "nodes": [
            {"node_id": "start", "node_type": "llm_call", "config": {}},
            {"node_id": "end", "node_type": "tool_call", "config": {}},
        ],
        "edges": [{"source": "start", "target": "end"}],
        "entry_point": "start",
    }


class _AsyncContextManager:
    """Helper async context manager for mocking pool.acquire()."""

    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *args):
        pass


def _setup_connection(mock_pool, mock_connection):
    """Helper to set up pool.acquire() to return mock connection as async context manager.

    Also sets up conn.transaction() as an async context manager since
    tenant_connection wraps queries in a transaction.
    """
    mock_pool.acquire = MagicMock(return_value=_AsyncContextManager(mock_connection))
    # tenant_connection uses conn.transaction() as an async context manager
    mock_connection.transaction = MagicMock(
        return_value=_AsyncContextManager(None)
    )


# --- Tests ---


class TestResolveWorkflowTenantPriority:
    """Test that tenant-specific workflow takes precedence over global."""

    @pytest.mark.asyncio
    async def test_tenant_specific_wins_over_global(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """When both tenant-specific and global workflows exist,
        the tenant-specific one should be selected."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        # Mock agent_configs query
        mock_connection.fetchrow.return_value = {"agent_type": "content"}

        # Mock workflow_definitions query - returns tenant-specific first
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "tenant-workflow-v1",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert isinstance(result, ResolvedWorkflow)
        assert result.workflow_id == "tenant-workflow-v1"
        assert result.graph_definition == sample_graph_definition
        assert result.agent_type == "content"

    @pytest.mark.asyncio
    async def test_global_workflow_used_when_no_tenant_specific(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """When only a global workflow exists, it should be selected."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.fetchrow.return_value = {"agent_type": "campaigns"}

        # Only global workflow available
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "global-workflow-v2",
                "tenant_id": None,
                "graph_definition": sample_graph_definition,
                "version": 2,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert result.workflow_id == "global-workflow-v2"
        assert result.agent_type == "campaigns"


class TestResolveWorkflowVersionSelection:
    """Test that the highest version is selected."""

    @pytest.mark.asyncio
    async def test_selects_highest_version(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """When multiple versions are active, the highest version should be selected."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.fetchrow.return_value = {"agent_type": "content"}

        # The SQL query already orders by version DESC and LIMIT 1,
        # so the first row returned is the highest version.
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "workflow-v3",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 3,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert result.workflow_id == "workflow-v3"

    @pytest.mark.asyncio
    async def test_sql_query_orders_by_tenant_then_version(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """Verify the SQL query is called with correct parameters."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.fetchrow.return_value = {"agent_type": "customer_service"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "cs-workflow",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 5,
            }
        ]

        await router.resolve_workflow(agent_id, tenant_id)

        # Verify set_config was called for RLS
        mock_connection.execute.assert_called_once_with(
            "SELECT set_config('app.current_tenant', $1, true)", tenant_id
        )

        # Verify agent_configs query
        mock_connection.fetchrow.assert_called_once_with(
            "SELECT agent_type FROM agent_configs WHERE id = $1",
            agent_id,
        )

        # Verify workflow_definitions query was called with correct agent_type and tenant_id
        fetch_call = mock_connection.fetch.call_args
        assert "customer_service" in fetch_call.args or fetch_call.args[1] == "customer_service"
        assert tenant_id in fetch_call.args


class TestResolveWorkflowErrors:
    """Test error handling in resolve_workflow."""

    @pytest.mark.asyncio
    async def test_raises_agent_not_found_error(
        self, router, mock_pool, mock_connection
    ):
        """When agent_id does not exist in agent_configs, raise AgentNotFoundError."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "nonexistent-agent-id"

        # No row found for agent_id
        mock_connection.fetchrow.return_value = None

        with pytest.raises(AgentNotFoundError) as exc_info:
            await router.resolve_workflow(agent_id, tenant_id)

        assert exc_info.value.agent_id == agent_id
        assert "nonexistent-agent-id" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_raises_workflow_not_found_error(
        self, router, mock_pool, mock_connection
    ):
        """When no active workflow is found, raise WorkflowNotFoundError."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        # Agent exists
        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        # But no workflows found
        mock_connection.fetch.return_value = []

        with pytest.raises(WorkflowNotFoundError) as exc_info:
            await router.resolve_workflow(agent_id, tenant_id)

        assert exc_info.value.agent_id == agent_id
        assert exc_info.value.tenant_id == tenant_id
        assert agent_id in str(exc_info.value)
        assert tenant_id in str(exc_info.value)


class TestResolveWorkflowContext:
    """Test context passing in resolve_workflow."""

    @pytest.mark.asyncio
    async def test_context_passed_as_config(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """Context dict should be available in the resolved workflow config."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"
        context = {"custom_key": "custom_value", "temperature": 0.7}

        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "workflow-with-context",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id, context)

        assert result.config == context

    @pytest.mark.asyncio
    async def test_none_context_defaults_to_empty_dict(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """When context is None, config should be an empty dict."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "workflow-no-context",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert result.config == {}


class TestResolveWorkflowGraphDefinition:
    """Test graph_definition handling."""

    @pytest.mark.asyncio
    async def test_handles_dict_graph_definition(
        self, router, mock_pool, mock_connection
    ):
        """graph_definition as dict (normal asyncpg JSONB) should be returned as-is."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"
        graph_def = {"nodes": [], "edges": [], "entry_point": "start"}

        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "wf-dict",
                "tenant_id": tenant_id,
                "graph_definition": graph_def,
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert result.graph_definition == graph_def

    @pytest.mark.asyncio
    async def test_handles_string_graph_definition(
        self, router, mock_pool, mock_connection
    ):
        """graph_definition as JSON string should be parsed to dict."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"
        graph_def = {"nodes": [], "edges": [], "entry_point": "start"}

        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "wf-string",
                "tenant_id": tenant_id,
                "graph_definition": json.dumps(graph_def),
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)

        assert result.graph_definition == graph_def


class TestRLSSetup:
    """Test that RLS session variable is set before queries."""

    @pytest.mark.asyncio
    async def test_sets_current_tenant_before_queries(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """app.current_tenant must be set before any data queries."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        call_order = []

        async def track_execute(*args, **kwargs):
            call_order.append(("execute", args))

        async def track_fetchrow(*args, **kwargs):
            call_order.append(("fetchrow", args))
            return {"agent_type": "content"}

        async def track_fetch(*args, **kwargs):
            call_order.append(("fetch", args))
            return [
                {
                    "workflow_id": "wf-1",
                    "tenant_id": tenant_id,
                    "graph_definition": sample_graph_definition,
                    "version": 1,
                }
            ]

        mock_connection.execute = track_execute
        mock_connection.fetchrow = track_fetchrow
        mock_connection.fetch = track_fetch

        await router.resolve_workflow(agent_id, tenant_id)

        # Verify order: set_config is called first
        assert call_order[0][0] == "execute"
        assert "app.current_tenant" in call_order[0][1][0]
        assert call_order[1][0] == "fetchrow"
        assert call_order[2][0] == "fetch"


class TestRouterErrorHierarchy:
    """Test that exception hierarchy is correct."""

    def test_agent_not_found_is_router_error(self):
        """AgentNotFoundError should inherit from RouterError."""
        err = AgentNotFoundError("some-id")
        assert isinstance(err, RouterError)
        assert isinstance(err, Exception)

    def test_workflow_not_found_is_router_error(self):
        """WorkflowNotFoundError should inherit from RouterError."""
        err = WorkflowNotFoundError("agent-id", "tenant-id")
        assert isinstance(err, RouterError)
        assert isinstance(err, Exception)

    def test_router_connection_error_is_router_error(self):
        """RouterConnectionError should inherit from RouterError."""
        err = RouterConnectionError("agent-id", "tenant-id")
        assert isinstance(err, RouterError)
        assert isinstance(err, Exception)

    def test_agent_not_found_error_contains_agent_id(self):
        """AgentNotFoundError message should contain the agent_id."""
        agent_id = "550e8400-e29b-41d4-a716-446655440099"
        err = AgentNotFoundError(agent_id)
        assert agent_id in str(err)
        assert err.agent_id == agent_id

    def test_workflow_not_found_error_contains_ids(self):
        """WorkflowNotFoundError message should contain agent_id and tenant_id."""
        agent_id = "550e8400-e29b-41d4-a716-446655440099"
        tenant_id = "660e8400-e29b-41d4-a716-446655440011"
        err = WorkflowNotFoundError(agent_id, tenant_id)
        assert agent_id in str(err)
        assert tenant_id in str(err)
        assert err.agent_id == agent_id
        assert err.tenant_id == tenant_id

    def test_router_connection_error_contains_ids(self):
        """RouterConnectionError message should contain agent_id and tenant_id."""
        agent_id = "550e8400-e29b-41d4-a716-446655440099"
        tenant_id = "660e8400-e29b-41d4-a716-446655440011"
        err = RouterConnectionError(agent_id, tenant_id)
        assert agent_id in str(err)
        assert tenant_id in str(err)
        assert err.agent_id == agent_id
        assert err.tenant_id == tenant_id


class TestUUIDValidation:
    """Test that invalid UUID agent_id is rejected early."""

    @pytest.mark.asyncio
    async def test_invalid_uuid_raises_agent_not_found(self, router, mock_pool):
        """Non-UUID agent_id should raise AgentNotFoundError before DB query."""
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        invalid_ids = [
            "not-a-uuid",
            "12345",
            "",
            "550e8400-e29b-41d4-a716",  # truncated
            "gggggggg-gggg-gggg-gggg-gggggggggggg",  # invalid hex
            "550e8400e29b41d4a716446655440000",  # no dashes
        ]

        for invalid_id in invalid_ids:
            with pytest.raises(AgentNotFoundError) as exc_info:
                await router.resolve_workflow(invalid_id, tenant_id)

            assert exc_info.value.agent_id == invalid_id
            assert "invalid UUID format" in str(exc_info.value)

        # Verify pool.acquire was never called (no DB hit)
        mock_pool.acquire.assert_not_called()

    @pytest.mark.asyncio
    async def test_valid_uuid_passes_validation(
        self, router, mock_pool, mock_connection, sample_graph_definition
    ):
        """Valid UUID agent_id should pass validation and proceed to DB."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.fetchrow.return_value = {"agent_type": "content"}
        mock_connection.fetch.return_value = [
            {
                "workflow_id": "wf-1",
                "tenant_id": tenant_id,
                "graph_definition": sample_graph_definition,
                "version": 1,
            }
        ]

        result = await router.resolve_workflow(agent_id, tenant_id)
        assert result.workflow_id == "wf-1"


class TestDatabaseConnectionErrors:
    """Test database connection error handling."""

    @pytest.mark.asyncio
    async def test_connection_error_raises_router_connection_error(
        self, router, mock_pool
    ):
        """asyncpg connection errors should be wrapped in RouterConnectionError."""
        import asyncpg

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        # Simulate pool.acquire() raising a connection error
        mock_pool.acquire = MagicMock(
            side_effect=asyncpg.InterfaceError("connection closed")
        )

        with pytest.raises(RouterConnectionError) as exc_info:
            await router.resolve_workflow(agent_id, tenant_id)

        assert exc_info.value.agent_id == agent_id
        assert exc_info.value.tenant_id == tenant_id
        assert agent_id in str(exc_info.value)
        assert tenant_id in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_os_error_raises_router_connection_error(self, router, mock_pool):
        """OSError (network issues) should be wrapped in RouterConnectionError."""
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_pool.acquire = MagicMock(
            side_effect=OSError("Connection refused")
        )

        with pytest.raises(RouterConnectionError) as exc_info:
            await router.resolve_workflow(agent_id, tenant_id)

        assert exc_info.value.agent_id == agent_id
        assert exc_info.value.tenant_id == tenant_id

    @pytest.mark.asyncio
    async def test_connection_error_during_query(
        self, router, mock_pool, mock_connection
    ):
        """Connection error during a query should also be wrapped."""
        import asyncpg

        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        # Connection acquired fine, but query fails with connection error
        mock_connection.execute.side_effect = asyncpg.InterfaceError(
            "connection is closed"
        )

        with pytest.raises(RouterConnectionError) as exc_info:
            await router.resolve_workflow(agent_id, tenant_id)

        assert exc_info.value.agent_id == agent_id
        assert exc_info.value.tenant_id == tenant_id

    @pytest.mark.asyncio
    async def test_non_connection_errors_not_wrapped(
        self, router, mock_pool, mock_connection
    ):
        """Non-connection errors (e.g. generic Exception) should propagate as-is."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        mock_connection.execute.side_effect = ValueError("unexpected error")

        with pytest.raises(ValueError, match="unexpected error"):
            await router.resolve_workflow(agent_id, tenant_id)

    @pytest.mark.asyncio
    async def test_router_errors_not_wrapped(
        self, router, mock_pool, mock_connection
    ):
        """RouterError subclasses (AgentNotFoundError, etc.) should propagate directly."""
        _setup_connection(mock_pool, mock_connection)

        tenant_id = "550e8400-e29b-41d4-a716-446655440000"
        agent_id = "770e8400-e29b-41d4-a716-446655440002"

        # Agent not found - should raise AgentNotFoundError, not RouterConnectionError
        mock_connection.fetchrow.return_value = None

        with pytest.raises(AgentNotFoundError):
            await router.resolve_workflow(agent_id, tenant_id)
