"""Tests for the CancelExecution gRPC handler.

Tests cover:
- Successful cancellation of a running execution
- Cannot cancel an already completed execution
- Execution not found returns success=false
- Tenant isolation (execution of different tenant returns not found)
- Persists partial state with steps, current_node, and duration_ms
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, MagicMock

import grpc
import grpc.aio
import pytest

from src.core.workflow_engine import LangGraphWorkflowEngine
from src.grpc.server import AgentOrchestrationServicer, CancelExecutionResponse


# ============================================================
# Fixtures
# ============================================================


@pytest.fixture
def mock_state_manager():
    """Create a mocked state manager."""
    manager = AsyncMock()
    manager.create_state = AsyncMock(return_value=None)
    manager.get_state = AsyncMock(return_value=None)
    manager.update_state = AsyncMock(return_value=None)
    manager.persist_final_state = AsyncMock(return_value=None)
    return manager


@pytest.fixture
def mock_workflow_engine():
    """Create a mocked workflow engine."""
    engine = MagicMock(spec=LangGraphWorkflowEngine)
    engine.register_workflow = MagicMock()
    engine.execute = AsyncMock()
    return engine


@pytest.fixture
def mock_agent_router():
    """Create a mocked agent router."""
    router = AsyncMock()
    router.resolve_workflow = AsyncMock()
    return router


@pytest.fixture
def mock_context():
    """Create a mocked gRPC servicer context."""
    context = AsyncMock(spec=grpc.aio.ServicerContext)
    context.abort = AsyncMock(side_effect=grpc.aio.AbortError(
        grpc.StatusCode.INTERNAL, "aborted"
    ))
    return context


@pytest.fixture
def servicer(mock_state_manager, mock_workflow_engine, mock_agent_router):
    """Create an AgentOrchestrationServicer with mocked dependencies."""
    return AgentOrchestrationServicer(
        state_manager=mock_state_manager,
        workflow_engine=mock_workflow_engine,
        agent_router=mock_agent_router,
    )


@pytest.fixture
def running_execution_state():
    """Create a sample running execution state."""
    created_at = (datetime.now(timezone.utc) - timedelta(seconds=5)).isoformat()
    return {
        "execution_id": "660e8400-e29b-41d4-a716-446655440001",
        "workflow_id": "workflow-marketing-v1",
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "agent_id": "770e8400-e29b-41d4-a716-446655440002",
        "status": "running",
        "current_node": "planner",
        "steps": [
            {"node_id": "intake", "status": "completed", "duration_ms": 1200},
        ],
        "completed_nodes": ["intake"],
        "created_at": created_at,
        "updated_at": created_at,
        "user_input": "Create marketing campaign",
    }


# ============================================================
# Tests: CancelExecution
# ============================================================


class TestCancelExecution:
    """Tests for the CancelExecution RPC handler."""

    async def test_cancel_running_execution_succeeds(
        self,
        servicer,
        mock_state_manager,
        mock_context,
        running_execution_state,
    ):
        """CancelExecution returns success=true for a running execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = running_execution_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is True
        assert result["message"] == "Execution cancelled successfully"

    async def test_cancel_running_execution_updates_state(
        self,
        servicer,
        mock_state_manager,
        mock_context,
        running_execution_state,
    ):
        """CancelExecution updates state to cancelled via state_manager."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = running_execution_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        await servicer.CancelExecution(request, mock_context)

        # Verify update_state was called with cancellation data
        mock_state_manager.update_state.assert_called_once()
        call_kwargs = mock_state_manager.update_state.call_args.kwargs
        assert call_kwargs["execution_id"] == execution_id
        assert call_kwargs["tenant_id"] == tenant_id
        assert call_kwargs["state_update"]["status"] == "cancelled"
        assert call_kwargs["state_update"]["current_node"] == "planner"
        assert "duration_ms" in call_kwargs["state_update"]
        assert call_kwargs["state_update"]["duration_ms"] > 0

    async def test_cancel_running_execution_persists_final_state(
        self,
        servicer,
        mock_state_manager,
        mock_context,
        running_execution_state,
    ):
        """CancelExecution persists final state to PostgreSQL."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = running_execution_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        await servicer.CancelExecution(request, mock_context)

        # Verify persist_final_state was called
        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        assert call_kwargs["execution_id"] == execution_id
        assert call_kwargs["tenant_id"] == tenant_id
        assert call_kwargs["final_state"]["status"] == "cancelled"
        assert call_kwargs["final_state"]["current_node"] == "planner"
        # Existing steps are preserved
        assert call_kwargs["final_state"]["steps"] == [
            {"node_id": "intake", "status": "completed", "duration_ms": 1200},
        ]

    async def test_cancel_pending_execution_succeeds(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=true for a pending execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        pending_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "pending",
            "current_node": "",
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = pending_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is True
        assert result["message"] == "Execution cancelled successfully"

    async def test_cancel_completed_execution_fails(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=false for a completed execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        completed_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "completed",
            "current_node": "",
            "steps": [{"node_id": "planner", "status": "completed"}],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = completed_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "Cannot cancel execution with status: completed" in result["message"]

    async def test_cancel_failed_execution_fails(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=false for a failed execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        failed_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "failed",
            "current_node": "planner",
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = failed_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "Cannot cancel execution with status: failed" in result["message"]

    async def test_cancel_timeout_execution_fails(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=false for a timed-out execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        timeout_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "timeout",
            "current_node": "",
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = timeout_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "Cannot cancel execution with status: timeout" in result["message"]

    async def test_cancel_already_cancelled_execution_fails(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=false for an already cancelled execution."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        cancelled_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "cancelled",
            "current_node": "planner",
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = cancelled_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "Cannot cancel execution with status: cancelled" in result["message"]

    async def test_cancel_nonexistent_execution_returns_not_found(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=false when execution doesn't exist."""
        execution_id = "000e8400-e29b-41d4-a716-446655440099"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = None

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert result["message"] == "Execution not found"

    async def test_cancel_execution_tenant_isolation(
        self,
        servicer,
        mock_state_manager,
        mock_context,
        running_execution_state,
    ):
        """CancelExecution returns not found when execution belongs to different tenant.

        The state_manager.get_state is scoped by tenant_id, so querying with
        a different tenant returns None — effectively hiding the existence of
        the execution without revealing it belongs to another tenant.
        """
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        other_tenant_id = "aaa00000-0000-0000-0000-000000000001"

        # get_state returns None because the key is tenant-scoped
        mock_state_manager.get_state.return_value = None

        request = {"execution_id": execution_id, "tenant_id": other_tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert result["message"] == "Execution not found"
        # Verify it called get_state with the other tenant's ID
        mock_state_manager.get_state.assert_called_once_with(
            execution_id=execution_id,
            tenant_id=other_tenant_id,
        )

    async def test_cancel_execution_missing_execution_id(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns failure when execution_id is empty."""
        request = {"execution_id": "", "tenant_id": "550e8400-e29b-41d4-a716-446655440000"}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "required" in result["message"]

    async def test_cancel_execution_missing_tenant_id(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns failure when tenant_id is empty."""
        request = {"execution_id": "660e8400-e29b-41d4-a716-446655440001", "tenant_id": ""}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is False
        assert "required" in result["message"]

    async def test_cancel_execution_does_not_update_state_for_terminal(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution does not call update_state for terminal executions."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        completed_state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "completed",
            "current_node": "",
            "steps": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        mock_state_manager.get_state.return_value = completed_state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        await servicer.CancelExecution(request, mock_context)

        # update_state and persist_final_state should NOT be called
        mock_state_manager.update_state.assert_not_called()
        mock_state_manager.persist_final_state.assert_not_called()

    async def test_cancel_execution_computes_duration_ms(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution computes duration_ms from created_at to now."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        # Create state with a created_at 10 seconds ago
        created_at = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        state = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "running",
            "current_node": "processor",
            "steps": [],
            "created_at": created_at,
        }
        mock_state_manager.get_state.return_value = state

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        await servicer.CancelExecution(request, mock_context)

        # Verify duration_ms is approximately 10000ms (10 seconds)
        call_kwargs = mock_state_manager.update_state.call_args.kwargs
        duration_ms = call_kwargs["state_update"]["duration_ms"]
        # Allow some tolerance for test execution time
        assert 9000 <= duration_ms <= 12000
