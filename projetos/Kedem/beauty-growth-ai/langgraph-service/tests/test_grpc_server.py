"""Tests for the gRPC server AgentOrchestrationServicer.

Tests cover:
- ExecuteWorkflow handler with mocked dependencies
- GetExecutionState returns state when found
- GetExecutionState returns NOT_FOUND when state doesn't exist
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import grpc
import grpc.aio
import pytest

from src.core.agent_router import (
    AgentNotFoundError,
    ResolvedWorkflow,
    RouterConnectionError,
    WorkflowNotFoundError as RouterWorkflowNotFoundError,
)
from src.core.workflow_engine import (
    ExecutionConfig,
    ExecutionResult,
    LangGraphWorkflowEngine,
    StepResult,
    TokenUsage,
)

# Import the server module directly to avoid path resolution issues with patch
import src.grpc.server as grpc_server_module
from src.grpc.server import (
    AgentOrchestrationServicer,
    ExecuteWorkflowResponse,
    ExecutionStateResponse,
    _build_workflow_definition_from_resolved,
    _get_field,
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


@pytest.fixture
def sample_execution_result():
    """Create a sample ExecutionResult."""
    return ExecutionResult(
        success=True,
        output="Campaign plan created successfully",
        trace_id="trace-123",
        model_id="gpt-4",
        used_fallback=False,
        tokens_used=TokenUsage(input_tokens=100, output_tokens=50),
        duration_ms=2500,
        steps=[
            StepResult(
                node_id="planner",
                node_type="llm_call",
                output="Campaign plan",
                duration_ms=2500,
                status="completed",
                tokens_used=TokenUsage(input_tokens=100, output_tokens=50),
            ),
        ],
        final_state={"output": "Campaign plan created successfully"},
    )


# ============================================================
# Tests: ExecuteWorkflow
# ============================================================


class TestExecuteWorkflow:
    """Tests for the ExecuteWorkflow RPC handler."""

    async def test_execute_workflow_success(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
        sample_execution_result,
    ):
        """ExecuteWorkflow returns success response with correct data."""
        # Setup mocks
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = sample_execution_result

        # Patch build_agent_graph to avoid real graph compilation
        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()  # compiled graph

            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        # Verify response structure
        assert result["success"] is True
        assert result["output"] == "Campaign plan created successfully"
        assert result["model_id"] == "gpt-4"
        assert result["used_fallback"] is False
        assert result["duration_ms"] == 2500
        assert result["tokens_used"]["input_tokens"] == 100
        assert result["tokens_used"]["output_tokens"] == 50
        assert len(result["steps"]) == 1
        assert result["steps"][0]["node_id"] == "planner"
        assert result["steps"][0]["node_type"] == "llm_call"
        assert result["trace_id"] != ""

    async def test_execute_workflow_calls_agent_router(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
        sample_execution_result,
    ):
        """ExecuteWorkflow calls agent_router.resolve_workflow with correct args."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = sample_execution_result

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_agent_router.resolve_workflow.assert_called_once_with(
            agent_id="770e8400-e29b-41d4-a716-446655440002",
            tenant_id="550e8400-e29b-41d4-a716-446655440000",
            context=None,
        )

    async def test_execute_workflow_creates_initial_state(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
        sample_execution_result,
    ):
        """ExecuteWorkflow creates initial state via state_manager."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = sample_execution_result

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        # Verify create_state was called
        mock_state_manager.create_state.assert_called_once()
        call_kwargs = mock_state_manager.create_state.call_args
        assert call_kwargs.kwargs["tenant_id"] == "550e8400-e29b-41d4-a716-446655440000"
        assert call_kwargs.kwargs["workflow_id"] == "workflow-marketing-v1"
        assert call_kwargs.kwargs["initial_state"]["user_input"] == "Criar campanha de marketing"

    async def test_execute_workflow_persists_final_state(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
        sample_execution_result,
    ):
        """ExecuteWorkflow persists final state via state_manager."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = sample_execution_result

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        # Verify persist_final_state was called
        mock_state_manager.persist_final_state.assert_called_once()
        call_kwargs = mock_state_manager.persist_final_state.call_args
        assert call_kwargs.kwargs["tenant_id"] == "550e8400-e29b-41d4-a716-446655440000"
        assert call_kwargs.kwargs["final_state"]["status"] == "completed"
        assert call_kwargs.kwargs["final_state"]["output"] == "Campaign plan created successfully"

    async def test_execute_workflow_agent_not_found(
        self,
        servicer,
        mock_agent_router,
        mock_context,
        sample_request,
    ):
        """ExecuteWorkflow aborts with NOT_FOUND when agent doesn't exist."""
        mock_agent_router.resolve_workflow.side_effect = AgentNotFoundError(
            "770e8400-e29b-41d4-a716-446655440002"
        )

        with pytest.raises(grpc.aio.AbortError):
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args
        assert call_args[0][0] == grpc.StatusCode.NOT_FOUND

    async def test_execute_workflow_no_active_workflow(
        self,
        servicer,
        mock_agent_router,
        mock_context,
        sample_request,
    ):
        """ExecuteWorkflow aborts with NOT_FOUND when no workflow is configured."""
        mock_agent_router.resolve_workflow.side_effect = RouterWorkflowNotFoundError(
            "770e8400-e29b-41d4-a716-446655440002",
            "550e8400-e29b-41d4-a716-446655440000",
        )

        with pytest.raises(grpc.aio.AbortError):
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args
        assert call_args[0][0] == grpc.StatusCode.NOT_FOUND

    async def test_execute_workflow_router_connection_error(
        self,
        servicer,
        mock_agent_router,
        mock_context,
        sample_request,
    ):
        """ExecuteWorkflow aborts with UNAVAILABLE on router connection error."""
        mock_agent_router.resolve_workflow.side_effect = RouterConnectionError(
            "770e8400-e29b-41d4-a716-446655440002",
            "550e8400-e29b-41d4-a716-446655440000",
        )

        with pytest.raises(grpc.aio.AbortError):
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args
        assert call_args[0][0] == grpc.StatusCode.UNAVAILABLE

    async def test_execute_workflow_registers_graph_in_engine(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
        sample_execution_result,
    ):
        """ExecuteWorkflow registers compiled graph in the workflow engine."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow
        mock_workflow_engine.execute.return_value = sample_execution_result

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_compiled = MagicMock()
            mock_build.return_value = mock_compiled
            await servicer.ExecuteWorkflow(sample_request, mock_context)

        mock_workflow_engine.register_workflow.assert_called_once_with(
            "workflow-marketing-v1", mock_compiled
        )

    async def test_execute_workflow_failed_result(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """ExecuteWorkflow handles failed execution result correctly."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        failed_result = ExecutionResult(
            success=False,
            output="",
            trace_id="trace-456",
            model_id="",
            used_fallback=False,
            tokens_used=TokenUsage(input_tokens=50, output_tokens=0),
            duration_ms=1000,
            steps=[],
            final_state={},
            blocked_reason="TIMEOUT: Execution exceeded 120000ms limit",
        )
        mock_workflow_engine.execute.return_value = failed_result

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()
            result = await servicer.ExecuteWorkflow(sample_request, mock_context)

        assert result["success"] is False
        assert result["blocked_reason"] == "TIMEOUT: Execution exceeded 120000ms limit"
        assert result["duration_ms"] == 1000


# ============================================================
# Tests: GetExecutionState
# ============================================================


class TestGetExecutionState:
    """Tests for the GetExecutionState RPC handler."""

    async def test_get_state_returns_found_state(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """GetExecutionState returns state data when found."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = {
            "execution_id": execution_id,
            "workflow_id": "workflow-marketing-v1",
            "tenant_id": tenant_id,
            "status": "running",
            "current_node": "planner",
            "completed_nodes": [],
            "created_at": "2024-01-01T00:00:00+00:00",
            "updated_at": "2024-01-01T00:00:05+00:00",
        }

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        result = await servicer.GetExecutionState(request, mock_context)

        assert result["execution_id"] == execution_id
        assert result["workflow_id"] == "workflow-marketing-v1"
        assert result["tenant_id"] == tenant_id
        assert result["status"] == "running"
        assert result["current_node"] == "planner"

    async def test_get_state_not_found(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """GetExecutionState aborts with NOT_FOUND when state doesn't exist."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = None

        request = {"execution_id": execution_id, "tenant_id": tenant_id}

        with pytest.raises(grpc.aio.AbortError):
            await servicer.GetExecutionState(request, mock_context)

        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args
        assert call_args[0][0] == grpc.StatusCode.NOT_FOUND

    async def test_get_state_missing_parameters(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """GetExecutionState aborts with INVALID_ARGUMENT when params are missing."""
        request = {"execution_id": "", "tenant_id": ""}

        with pytest.raises(grpc.aio.AbortError):
            await servicer.GetExecutionState(request, mock_context)

        mock_context.abort.assert_called_once()
        call_args = mock_context.abort.call_args
        assert call_args[0][0] == grpc.StatusCode.INVALID_ARGUMENT

    async def test_get_state_calls_state_manager_with_correct_params(
        self,
        servicer,
        mock_state_manager,
        mock_context,
    ):
        """GetExecutionState passes correct params to state_manager.get_state."""
        execution_id = "660e8400-e29b-41d4-a716-446655440001"
        tenant_id = "550e8400-e29b-41d4-a716-446655440000"

        mock_state_manager.get_state.return_value = {
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "status": "completed",
            "workflow_id": "wf-1",
            "current_node": "",
            "completed_nodes": ["planner"],
            "created_at": "2024-01-01T00:00:00+00:00",
            "updated_at": "2024-01-01T00:00:10+00:00",
        }

        request = {"execution_id": execution_id, "tenant_id": tenant_id}
        await servicer.GetExecutionState(request, mock_context)

        mock_state_manager.get_state.assert_called_once_with(
            execution_id=execution_id,
            tenant_id=tenant_id,
        )


# ============================================================
# Tests: Helper functions
# ============================================================


class TestHelperFunctions:
    """Tests for helper functions."""

    def test_get_field_from_dict(self):
        """_get_field retrieves values from dicts."""
        data = {"key": "value", "num": 42}
        assert _get_field(data, "key") == "value"
        assert _get_field(data, "num") == 42
        assert _get_field(data, "missing", "default") == "default"

    def test_get_field_from_object(self):
        """_get_field retrieves values from objects via getattr."""

        class Obj:
            key = "value"
            num = 42

        obj = Obj()
        assert _get_field(obj, "key") == "value"
        assert _get_field(obj, "num") == 42
        assert _get_field(obj, "missing", "default") == "default"

    def test_build_workflow_definition_from_resolved(self):
        """_build_workflow_definition_from_resolved parses graph_definition correctly."""
        resolved = ResolvedWorkflow(
            workflow_id="wf-1",
            graph_definition={
                "nodes": [
                    {"node_id": "n1", "node_type": "llm_call", "config": {"model": "gpt-4"}},
                    {"node_id": "n2", "node_type": "tool_call", "config": {}},
                ],
                "edges": [
                    {"source": "n1", "target": "n2"},
                    {"source": "n2", "target": "__end__"},
                ],
                "entry_point": "n1",
            },
            config={},
            agent_type="marketing",
        )

        definition = _build_workflow_definition_from_resolved(resolved)

        assert definition.workflow_id == "wf-1"
        assert definition.agent_type == "marketing"
        assert definition.entry_point == "n1"
        assert len(definition.nodes) == 2
        assert definition.nodes[0].node_id == "n1"
        assert definition.nodes[0].node_type == "llm_call"
        assert definition.nodes[0].config == {"model": "gpt-4"}
        assert len(definition.edges) == 2
        assert definition.edges[0].source == "n1"
        assert definition.edges[0].target == "n2"
        assert definition.edges[1].target == "__end__"
