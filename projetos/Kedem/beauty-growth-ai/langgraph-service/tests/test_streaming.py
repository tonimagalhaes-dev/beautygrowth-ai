"""Tests for streaming functionality (ExecuteWorkflowStream).

Tests cover:
- Streaming yields StepStarted + StepCompleted for each node
- WorkflowCompleted is the last event on success
- WorkflowError is the last event on failure
- enable_streaming=false only yields terminal event
- Workflow engine execute_stream produces correct event sequence
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List
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
    WorkflowEvent,
)

import src.grpc.server as grpc_server_module
from src.grpc.server import (
    AgentOrchestrationServicer,
    _map_workflow_event_to_stream,
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
    """Create a mocked workflow engine with execute_stream support."""
    engine = MagicMock(spec=LangGraphWorkflowEngine)
    engine._workflows = {}
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
            "enable_streaming": True,
        },
    }


@pytest.fixture
def sample_request_no_streaming():
    """Create a sample request with enable_streaming=false."""
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
            "enable_streaming": False,
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
                {"node_id": "writer", "node_type": "llm_call", "config": {}},
            ],
            "edges": [
                {"source": "planner", "target": "writer"},
                {"source": "writer", "target": "__end__"},
            ],
            "entry_point": "planner",
        },
        config={},
        agent_type="marketing",
    )


def _make_streaming_events(success: bool = True) -> List[WorkflowEvent]:
    """Create a sequence of streaming events for testing."""
    events = [
        WorkflowEvent(
            event_type="step_started",
            node_id="planner",
            data={"node_type": "llm_call"},
        ),
        WorkflowEvent(
            event_type="step_completed",
            node_id="planner",
            data={
                "result": {
                    "node_id": "planner",
                    "node_type": "llm_call",
                    "output": "Plan created",
                    "duration_ms": 1000,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 50, "output_tokens": 30},
                    "error_message": "",
                }
            },
        ),
        WorkflowEvent(
            event_type="step_started",
            node_id="writer",
            data={"node_type": "llm_call"},
        ),
        WorkflowEvent(
            event_type="step_completed",
            node_id="writer",
            data={
                "result": {
                    "node_id": "writer",
                    "node_type": "llm_call",
                    "output": "Content written",
                    "duration_ms": 1500,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 60, "output_tokens": 40},
                    "error_message": "",
                }
            },
        ),
    ]

    if success:
        events.append(
            WorkflowEvent(
                event_type="workflow_completed",
                data={
                    "output": "Campaign created",
                    "success": True,
                    "trace_id": "trace-123",
                    "model_id": "gpt-4",
                    "duration_ms": 2500,
                    "tokens_used": {"input_tokens": 110, "output_tokens": 70},
                },
            )
        )
    else:
        events.append(
            WorkflowEvent(
                event_type="workflow_error",
                node_id="writer",
                data={
                    "error_code": "NODE_EXECUTION_ERROR",
                    "error_message": "Node 'writer' (llm_call) failed: LLM timeout",
                },
            )
        )

    return events


async def _async_iter_events(events: List[WorkflowEvent]):
    """Helper to create an async iterator from a list of events."""
    for event in events:
        yield event


# ============================================================
# Tests: Workflow Engine execute_stream
# ============================================================


class TestWorkflowEngineExecuteStream:
    """Tests for LangGraphWorkflowEngine.execute_stream()."""

    async def test_execute_stream_yields_step_events_for_each_node(self):
        """execute_stream yields StepStarted and StepCompleted for each step."""
        engine = LangGraphWorkflowEngine()

        # Create a mock graph that returns a result with steps
        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(return_value={
            "output": "Done",
            "model_id": "gpt-4",
            "steps": [
                {
                    "node_id": "planner",
                    "node_type": "llm_call",
                    "output": "Plan",
                    "duration_ms": 1000,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 50, "output_tokens": 30},
                },
                {
                    "node_id": "writer",
                    "node_type": "llm_call",
                    "output": "Content",
                    "duration_ms": 1500,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 60, "output_tokens": 40},
                },
            ],
        })

        engine.register_workflow("test-wf", mock_graph)

        config = ExecutionConfig(
            tenant_id="tenant-1",
            user_id="user-1",
            trace_id="trace-1",
        )

        events = []
        async for event in engine.execute_stream("test-wf", {}, config):
            events.append(event)

        # Should have: step_started, step_completed for each node + workflow_completed
        assert len(events) == 5

        # Verify step events for first node
        assert events[0].event_type == "step_started"
        assert events[0].node_id == "planner"
        assert events[0].data["node_type"] == "llm_call"

        assert events[1].event_type == "step_completed"
        assert events[1].node_id == "planner"
        assert events[1].data["result"]["output"] == "Plan"

        # Verify step events for second node
        assert events[2].event_type == "step_started"
        assert events[2].node_id == "writer"

        assert events[3].event_type == "step_completed"
        assert events[3].node_id == "writer"
        assert events[3].data["result"]["output"] == "Content"

    async def test_execute_stream_ends_with_workflow_completed_on_success(self):
        """execute_stream yields WorkflowCompleted as the last event on success."""
        engine = LangGraphWorkflowEngine()

        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(return_value={
            "output": "Success output",
            "model_id": "gpt-4",
            "steps": [
                {
                    "node_id": "node1",
                    "node_type": "llm_call",
                    "output": "Result",
                    "duration_ms": 500,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 10, "output_tokens": 20},
                },
            ],
        })

        engine.register_workflow("test-wf", mock_graph)

        config = ExecutionConfig(
            tenant_id="tenant-1",
            user_id="user-1",
            trace_id="trace-1",
        )

        events = []
        async for event in engine.execute_stream("test-wf", {}, config):
            events.append(event)

        # Last event should be workflow_completed
        last_event = events[-1]
        assert last_event.event_type == "workflow_completed"
        assert last_event.data["success"] is True
        assert last_event.data["output"] == "Success output"

    async def test_execute_stream_ends_with_workflow_error_on_timeout(self):
        """execute_stream yields WorkflowError as the last event on timeout."""
        engine = LangGraphWorkflowEngine()

        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(side_effect=asyncio.TimeoutError())

        engine.register_workflow("test-wf", mock_graph)

        config = ExecutionConfig(
            tenant_id="tenant-1",
            user_id="user-1",
            trace_id="trace-1",
            timeout_ms=100,
        )

        events = []
        async for event in engine.execute_stream("test-wf", {}, config):
            events.append(event)

        # Should only have workflow_error
        assert len(events) == 1
        assert events[0].event_type == "workflow_error"
        assert events[0].data["error_code"] == "TIMEOUT"
        assert "100ms" in events[0].data["error_message"]

    async def test_execute_stream_ends_with_workflow_error_on_exception(self):
        """execute_stream yields WorkflowError on unexpected exceptions."""
        engine = LangGraphWorkflowEngine()

        mock_graph = AsyncMock()
        mock_graph.ainvoke = AsyncMock(side_effect=RuntimeError("Unexpected failure"))

        engine.register_workflow("test-wf", mock_graph)

        config = ExecutionConfig(
            tenant_id="tenant-1",
            user_id="user-1",
            trace_id="trace-1",
        )

        events = []
        async for event in engine.execute_stream("test-wf", {}, config):
            events.append(event)

        assert len(events) == 1
        assert events[0].event_type == "workflow_error"
        assert events[0].data["error_code"] == "RuntimeError"
        assert "Unexpected failure" in events[0].data["error_message"]


# ============================================================
# Tests: ExecuteWorkflowStream handler
# ============================================================


class TestExecuteWorkflowStream:
    """Tests for the ExecuteWorkflowStream RPC handler."""

    async def test_streaming_yields_step_started_and_completed_for_each_node(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """Streaming yields StepStarted + StepCompleted for each node."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        # Set up execute_stream to return events
        events = _make_streaming_events(success=True)
        mock_workflow_engine.execute_stream = MagicMock(
            return_value=_async_iter_events(events)
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()

            collected_events = []
            async for event in servicer.ExecuteWorkflowStream(sample_request, mock_context):
                collected_events.append(event)

        # Verify we get step_started and step_completed for planner
        assert collected_events[0] == {
            "step_started": {"node_id": "planner", "node_type": "llm_call"}
        }
        assert collected_events[1]["step_completed"]["result"]["node_id"] == "planner"

        # Verify we get step_started and step_completed for writer
        assert collected_events[2] == {
            "step_started": {"node_id": "writer", "node_type": "llm_call"}
        }
        assert collected_events[3]["step_completed"]["result"]["node_id"] == "writer"

    async def test_streaming_ends_with_workflow_completed_on_success(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """WorkflowCompleted is the last event when workflow succeeds."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        events = _make_streaming_events(success=True)
        mock_workflow_engine.execute_stream = MagicMock(
            return_value=_async_iter_events(events)
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()

            collected_events = []
            async for event in servicer.ExecuteWorkflowStream(sample_request, mock_context):
                collected_events.append(event)

        # Last event should be workflow_completed
        last_event = collected_events[-1]
        assert "workflow_completed" in last_event
        assert last_event["workflow_completed"]["response"]["success"] is True
        assert last_event["workflow_completed"]["response"]["output"] == "Campaign created"

    async def test_streaming_ends_with_workflow_error_on_failure(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
        sample_resolved_workflow,
    ):
        """WorkflowError is the last event when workflow fails."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        events = _make_streaming_events(success=False)
        mock_workflow_engine.execute_stream = MagicMock(
            return_value=_async_iter_events(events)
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()

            collected_events = []
            async for event in servicer.ExecuteWorkflowStream(sample_request, mock_context):
                collected_events.append(event)

        # Last event should be workflow_error
        last_event = collected_events[-1]
        assert "workflow_error" in last_event
        assert last_event["workflow_error"]["error_code"] == "NODE_EXECUTION_ERROR"
        assert "writer" in last_event["workflow_error"]["error_message"]
        assert last_event["workflow_error"]["node_id"] == "writer"

    async def test_streaming_disabled_only_yields_terminal_event(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request_no_streaming,
        sample_resolved_workflow,
    ):
        """With enable_streaming=false, only terminal event is emitted."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        events = _make_streaming_events(success=True)
        mock_workflow_engine.execute_stream = MagicMock(
            return_value=_async_iter_events(events)
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()

            collected_events = []
            async for event in servicer.ExecuteWorkflowStream(
                sample_request_no_streaming, mock_context
            ):
                collected_events.append(event)

        # Only 1 event should be emitted (the terminal workflow_completed)
        assert len(collected_events) == 1
        assert "workflow_completed" in collected_events[0]

    async def test_streaming_disabled_error_only_yields_terminal_error(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request_no_streaming,
        sample_resolved_workflow,
    ):
        """With enable_streaming=false and failure, only terminal error event is emitted."""
        mock_agent_router.resolve_workflow.return_value = sample_resolved_workflow

        events = _make_streaming_events(success=False)
        mock_workflow_engine.execute_stream = MagicMock(
            return_value=_async_iter_events(events)
        )

        with patch.object(grpc_server_module, "build_agent_graph") as mock_build:
            mock_build.return_value = MagicMock()

            collected_events = []
            async for event in servicer.ExecuteWorkflowStream(
                sample_request_no_streaming, mock_context
            ):
                collected_events.append(event)

        # Only 1 event: workflow_error
        assert len(collected_events) == 1
        assert "workflow_error" in collected_events[0]

    async def test_streaming_agent_not_found_emits_error_event(
        self,
        servicer,
        mock_agent_router,
        mock_workflow_engine,
        mock_state_manager,
        mock_context,
        sample_request,
    ):
        """Agent not found emits a WorkflowError event."""
        mock_agent_router.resolve_workflow.side_effect = AgentNotFoundError(
            "770e8400-e29b-41d4-a716-446655440002"
        )

        collected_events = []
        async for event in servicer.ExecuteWorkflowStream(sample_request, mock_context):
            collected_events.append(event)

        assert len(collected_events) == 1
        assert "workflow_error" in collected_events[0]
        assert collected_events[0]["workflow_error"]["error_code"] == "NOT_FOUND"


# ============================================================
# Tests: _map_workflow_event_to_stream helper
# ============================================================


class TestMapWorkflowEventToStream:
    """Tests for the _map_workflow_event_to_stream helper function."""

    def test_maps_step_started(self):
        """Maps step_started event correctly."""
        event = WorkflowEvent(
            event_type="step_started",
            node_id="planner",
            data={"node_type": "llm_call"},
        )
        result = _map_workflow_event_to_stream(event)
        assert result == {
            "step_started": {"node_id": "planner", "node_type": "llm_call"}
        }

    def test_maps_step_completed(self):
        """Maps step_completed event correctly."""
        event = WorkflowEvent(
            event_type="step_completed",
            node_id="planner",
            data={"result": {"node_id": "planner", "output": "Done"}},
        )
        result = _map_workflow_event_to_stream(event)
        assert result == {
            "step_completed": {"result": {"node_id": "planner", "output": "Done"}}
        }

    def test_maps_token_generated(self):
        """Maps token_generated event correctly."""
        event = WorkflowEvent(
            event_type="token_generated",
            node_id="writer",
            data={"token": "Hello"},
        )
        result = _map_workflow_event_to_stream(event)
        assert result == {
            "token_generated": {"token": "Hello", "node_id": "writer"}
        }

    def test_maps_workflow_completed(self):
        """Maps workflow_completed event correctly."""
        event = WorkflowEvent(
            event_type="workflow_completed",
            data={"output": "Done", "success": True},
        )
        result = _map_workflow_event_to_stream(event)
        assert result == {
            "workflow_completed": {"response": {"output": "Done", "success": True}}
        }

    def test_maps_workflow_error(self):
        """Maps workflow_error event correctly."""
        event = WorkflowEvent(
            event_type="workflow_error",
            node_id="bad_node",
            data={"error_code": "TIMEOUT", "error_message": "Exceeded limit"},
        )
        result = _map_workflow_event_to_stream(event)
        assert result == {
            "workflow_error": {
                "error_code": "TIMEOUT",
                "error_message": "Exceeded limit",
                "node_id": "bad_node",
            }
        }

    def test_maps_unknown_event_type(self):
        """Unknown event type returns a workflow_error event."""
        event = WorkflowEvent(
            event_type="unknown_thing",
            node_id="x",
            data={},
        )
        result = _map_workflow_event_to_stream(event)
        assert "workflow_error" in result
        assert result["workflow_error"]["error_code"] == "UNKNOWN_EVENT"
