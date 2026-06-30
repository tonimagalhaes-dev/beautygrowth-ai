"""Tests for task 14.1: Ensure all executions persist final state and metrics.

Validates:
- All terminal states (COMPLETED, FAILED, CANCELLED, TIMEOUT) are persisted to PostgreSQL
- duration_ms and tokens_used (input + output) are recorded in all executions
- If persistence fails: log with trace_id and execution_id for recovery, still return response
- Requirements: 10.4, 10.5, 11.3
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import grpc
import grpc.aio
import pytest

from src.core.agent_router import ResolvedWorkflow
from src.core.exceptions import PersistenceError
from src.core.workflow_engine import (
    ExecutionResult,
    LangGraphWorkflowEngine,
    StepResult,
    TokenUsage,
)

# Import the server module directly to avoid circular import issues
import src.grpc.server as grpc_server_module
from src.grpc.server import (
    AgentOrchestrationServicer,
    _determine_terminal_status,
)


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
def sample_request():
    """Create a sample ExecuteWorkflowRequest as a dict."""
    return {
        "agent_id": "770e8400-e29b-41d4-a716-446655440002",
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "user_input": "Criar campanha de marketing",
        "user_id": "880e8400-e29b-41d4-a716-446655440003",
        "conversation_id": "990e8400-e29b-41d4-a716-446655440004",
        "workflow_id": "",
        "tenant_context": {},
        "options": {
            "max_steps": 50,
            "timeout_ms": 120_000,
        },
    }


@pytest.fixture
def sample_resolved_workflow():
    """Create a sample ResolvedWorkflow."""
    return ResolvedWorkflow(
        workflow_id="workflow-marketing-v1",
        graph_definition={
            "nodes": [
                {"node_id": "planner", "node_type": "llm_call", "config": {}},
            ],
            "edges": [
                {"source": "planner", "target": "__end__"},
            ],
            "entry_point": "planner",
        },
        config={},
        agent_type="marketing",
    )


# ============================================================
# Tests: _determine_terminal_status helper
# ============================================================


class TestDetermineTerminalStatus:
    """Tests for the _determine_terminal_status helper function."""

    def test_completed_status_on_success(self):
        """Returns 'completed' when result.success is True."""
        result = ExecutionResult(
            success=True,
            output="done",
            trace_id="t1",
            model_id="gpt-4",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=10, output_tokens=5),
            duration_ms=1000,
            steps=[],
            final_state={},
        )
        assert _determine_terminal_status(result) == "completed"

    def test_timeout_status_detected_from_blocked_reason(self):
        """Returns 'timeout' when blocked_reason contains TIMEOUT."""
        result = ExecutionResult(
            success=False,
            output="",
            trace_id="t1",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(),
            duration_ms=120001,
            steps=[],
            final_state={},
            blocked_reason="TIMEOUT: Execution exceeded 120000ms limit",
        )
        assert _determine_terminal_status(result) == "timeout"

    def test_failed_status_on_generic_failure(self):
        """Returns 'failed' for non-timeout failures."""
        result = ExecutionResult(
            success=False,
            output="",
            trace_id="t1",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(),
            duration_ms=500,
            steps=[],
            final_state={},
            blocked_reason="Node 'planner' (llm_call) failed: connection error",
        )
        assert _determine_terminal_status(result) == "failed"

    def test_failed_status_on_guardrail_violation(self):
        """Returns 'failed' for guardrail violations."""
        result = ExecutionResult(
            success=False,
            output="",
            trace_id="t1",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(),
            duration_ms=300,
            steps=[],
            final_state={},
            blocked_reason="Guardrail violation at node reviewer: ['no_profanity']",
            guardrail_violations=["no_profanity"],
        )
        assert _determine_terminal_status(result) == "failed"

    def test_failed_status_on_recursion_limit(self):
        """Returns 'failed' for recursion limit exceeded."""
        result = ExecutionResult(
            success=False,
            output="",
            trace_id="t1",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(),
            duration_ms=5000,
            steps=[],
            final_state={},
            blocked_reason="RECURSION_LIMIT: Execution exceeded recursion_limit of 50 steps",
        )
        assert _determine_terminal_status(result) == "failed"


# ============================================================
# Tests: ExecuteWorkflow persists all terminal states
# ============================================================


class TestExecuteWorkflowPersistence:
    """Tests that ExecuteWorkflow persists state for all terminal statuses."""

    async def test_persist_completed_status(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """Completed execution persists with status='completed' and metrics."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = ExecutionResult(
            success=True,
            output="Campaign created",
            trace_id="trace-1",
            model_id="gpt-4",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=100, output_tokens=50),
            duration_ms=2500,
            steps=[
                StepResult(
                    node_id="planner",
                    node_type="llm_call",
                    output="plan",
                    duration_ms=2500,
                    status="completed",
                    tokens_used=TokenUsage(input_tokens=100, output_tokens=50),
                ),
            ],
            final_state={"output": "Campaign created"},
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        # Verify persist_final_state was called
        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        final_state = call_kwargs["final_state"]

        assert final_state["status"] == "completed"
        assert final_state["duration_ms"] == 2500
        assert final_state["tokens_input"] == 100
        assert final_state["tokens_output"] == 50
        assert result["success"] is True

    async def test_persist_failed_status(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """Failed execution persists with status='failed' and metrics."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = ExecutionResult(
            success=False,
            output="",
            trace_id="trace-2",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=30, output_tokens=0),
            duration_ms=800,
            steps=[
                StepResult(
                    node_id="planner",
                    node_type="llm_call",
                    output="",
                    duration_ms=800,
                    status="failed",
                    tokens_used=TokenUsage(input_tokens=30, output_tokens=0),
                    error_message="LLM connection failed",
                ),
            ],
            final_state={},
            blocked_reason="Node 'planner' (llm_call) failed: LLM connection failed",
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        final_state = call_kwargs["final_state"]

        assert final_state["status"] == "failed"
        assert final_state["duration_ms"] == 800
        assert final_state["tokens_input"] == 30
        assert final_state["tokens_output"] == 0
        assert result["success"] is False

    async def test_persist_timeout_status(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """Timeout execution persists with status='timeout' and metrics."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = ExecutionResult(
            success=False,
            output="",
            trace_id="trace-3",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=0, output_tokens=0),
            duration_ms=120001,
            steps=[],
            final_state={},
            blocked_reason="TIMEOUT: Execution exceeded 120000ms limit",
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        final_state = call_kwargs["final_state"]

        assert final_state["status"] == "timeout"
        assert final_state["duration_ms"] == 120001
        assert final_state["tokens_input"] == 0
        assert final_state["tokens_output"] == 0
        assert result["success"] is False
        assert "TIMEOUT" in result["blocked_reason"]

    async def test_persist_includes_duration_and_tokens_always(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """All executions include duration_ms and tokens in persisted state."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        # Execution with zero tokens (e.g., immediate failure)
        mock_workflow_engine.execute.return_value = ExecutionResult(
            success=False,
            output="",
            trace_id="trace-4",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=0, output_tokens=0),
            duration_ms=50,
            steps=[],
            final_state={},
            blocked_reason="RECURSION_LIMIT: Execution exceeded recursion_limit of 50 steps",
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        final_state = call_kwargs["final_state"]

        # Even when there are no tokens, the fields must be present with default 0
        assert "duration_ms" in final_state
        assert "tokens_input" in final_state
        assert "tokens_output" in final_state
        assert final_state["duration_ms"] == 50
        assert final_state["tokens_input"] == 0
        assert final_state["tokens_output"] == 0


# ============================================================
# Tests: Persistence failure handling (Requirement 10.5)
# ============================================================


class TestPersistenceFailureHandling:
    """Tests that persistence failures are handled gracefully."""

    async def test_execute_workflow_returns_response_on_persistence_failure(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """ExecuteWorkflow returns result even if persistence fails."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = ExecutionResult(
            success=True,
            output="Campaign plan",
            trace_id="trace-5",
            model_id="gpt-4",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=80, output_tokens=40),
            duration_ms=2000,
            steps=[
                StepResult(
                    node_id="planner",
                    node_type="llm_call",
                    output="plan",
                    duration_ms=2000,
                    status="completed",
                    tokens_used=TokenUsage(input_tokens=80, output_tokens=40),
                ),
            ],
            final_state={"output": "Campaign plan"},
        )

        # Make persist_final_state raise PersistenceError
        mock_state_manager.persist_final_state.side_effect = PersistenceError(
            "Failed to persist after 3 attempts",
            trace_id="trace-5",
            execution_id="exec-123",
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        # Should still return a response (not raise or abort)
        assert result is not None
        assert result["output"] == "Campaign plan"
        assert result["duration_ms"] == 2000
        assert result["tokens_used"]["input_tokens"] == 80
        assert result["tokens_used"]["output_tokens"] == 40
        # success is False because persistence failed
        assert result["success"] is False
        # blocked_reason indicates persistence issue
        assert "persist" in result["blocked_reason"].lower()

    async def test_cancel_execution_succeeds_despite_persistence_failure(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution returns success=true even if persistence fails."""
        execution_id = "exec-cancel-1"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        # State is "running" — eligible for cancellation
        mock_state_manager.get_state.return_value = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "running",
            "current_node": "planner",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "tokens_input": 20,
            "tokens_output": 10,
        }
        mock_state_manager.update_state.return_value = None

        # Persistence fails
        mock_state_manager.persist_final_state.side_effect = PersistenceError(
            "DB connection lost",
            trace_id="trace-cancel-1",
            execution_id=execution_id,
        )

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        # Cancellation itself succeeded; persistence failure is logged
        assert result["success"] is True
        assert result["message"] == "Execution cancelled successfully"


# ============================================================
# Tests: CancelExecution persistence (CANCELLED status)
# ============================================================


class TestCancelExecutionPersistence:
    """Tests that CancelExecution persists state with CANCELLED status."""

    async def test_cancel_persists_cancelled_status_with_metrics(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """CancelExecution persists with status='cancelled', duration_ms, and tokens."""
        execution_id = "exec-cancel-2"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "running",
            "current_node": "content_creator",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "tokens_input": 50,
            "tokens_output": 25,
            "workflow_id": "wf-1",
        }
        mock_state_manager.update_state.return_value = None
        mock_state_manager.persist_final_state.return_value = None

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.CancelExecution(request, mock_context)

        assert result["success"] is True

        # Verify persist_final_state was called
        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args.kwargs
        final_state = call_kwargs["final_state"]

        assert final_state["status"] == "cancelled"
        assert "duration_ms" in final_state
        assert final_state["duration_ms"] >= 0
        # tokens from the original state are preserved
        assert final_state["tokens_input"] == 50
        assert final_state["tokens_output"] == 25
