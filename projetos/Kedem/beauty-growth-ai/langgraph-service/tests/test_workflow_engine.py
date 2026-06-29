"""Tests for LangGraphWorkflowEngine: execution, timeout, recursion_limit, and registration."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.workflow_engine import (
    ExecutionConfig,
    ExecutionResult,
    LangGraphWorkflowEngine,
    StepResult,
    TokenUsage,
    WorkflowNotFoundError,
)


@pytest.fixture
def execution_config() -> ExecutionConfig:
    """Provide a standard execution config for tests."""
    return ExecutionConfig(
        tenant_id="550e8400-e29b-41d4-a716-446655440000",
        user_id="user-123",
        trace_id="trace-abc-123",
        max_steps=50,
        timeout_ms=120_000,
    )


@pytest.fixture
def initial_state() -> dict:
    """Provide a sample initial state for workflow execution."""
    return {
        "user_input": "Criar campanha de marketing",
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "agent_id": "agent-001",
        "messages": [],
        "intermediate_results": {},
        "output": "",
        "steps": [],
    }


@pytest.fixture
def successful_graph_result() -> dict:
    """Simulate a successful graph execution result."""
    return {
        "user_input": "Criar campanha de marketing",
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "agent_id": "agent-001",
        "messages": [],
        "intermediate_results": {},
        "output": "Campanha criada com sucesso",
        "steps": [
            {
                "node_id": "planejar",
                "node_type": "llm_call",
                "output": "Plano elaborado",
                "duration_ms": 150,
                "status": "completed",
            },
            {
                "node_id": "criar_conteudo",
                "node_type": "llm_call",
                "output": "Conteúdo gerado",
                "duration_ms": 200,
                "status": "completed",
            },
        ],
    }


def create_mock_graph(result: dict, delay: float = 0.0) -> MagicMock:
    """Create a mock compiled graph with configurable ainvoke behavior."""
    graph = MagicMock()

    async def mock_ainvoke(state, config=None):
        if delay > 0:
            await asyncio.sleep(delay)
        return result

    graph.ainvoke = mock_ainvoke
    return graph


class TestLangGraphWorkflowEngineExecute:
    """Tests for the execute method."""

    async def test_successful_execution_returns_completed_result(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
        successful_graph_result: dict,
    ):
        """Test that a successful execution returns an ExecutionResult with success=True."""
        graph = create_mock_graph(successful_graph_result)
        engine = LangGraphWorkflowEngine(workflows={"campaign-workflow": graph})

        result = await engine.execute("campaign-workflow", initial_state, execution_config)

        assert result.success is True
        assert result.output == "Campanha criada com sucesso"
        assert result.trace_id == "trace-abc-123"
        assert result.used_fallback is False
        assert result.duration_ms >= 0
        assert len(result.steps) == 2
        assert result.steps[0].node_id == "planejar"
        assert result.steps[0].node_type == "llm_call"
        assert result.steps[0].status == "completed"
        assert result.steps[1].node_id == "criar_conteudo"
        assert result.final_state["output"] == "Campanha criada com sucesso"

    async def test_execution_tracks_duration_ms(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
        successful_graph_result: dict,
    ):
        """Test that duration_ms is measured and > 0 for non-trivial executions."""
        graph = create_mock_graph(successful_graph_result, delay=0.01)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is True
        assert result.duration_ms >= 10  # At least 10ms from the delay

    async def test_execution_builds_step_results_with_correct_fields(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that StepResult objects are built with all expected fields."""
        graph_result = {
            "output": "Done",
            "steps": [
                {
                    "node_id": "node_a",
                    "node_type": "tool_call",
                    "output": "tool output",
                    "duration_ms": 50,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 10, "output_tokens": 20},
                    "error_message": None,
                }
            ],
        }
        graph = create_mock_graph(graph_result)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        step = result.steps[0]
        assert step.node_id == "node_a"
        assert step.node_type == "tool_call"
        assert step.output == "tool output"
        assert step.duration_ms == 50
        assert step.status == "completed"
        assert step.tokens_used.input_tokens == 10
        assert step.tokens_used.output_tokens == 20
        assert step.error_message is None

    async def test_execution_aggregates_token_usage(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that total tokens_used is aggregated from all steps."""
        graph_result = {
            "output": "Done",
            "steps": [
                {
                    "node_id": "n1",
                    "node_type": "llm_call",
                    "output": "out1",
                    "duration_ms": 100,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 50, "output_tokens": 30},
                },
                {
                    "node_id": "n2",
                    "node_type": "llm_call",
                    "output": "out2",
                    "duration_ms": 120,
                    "status": "completed",
                    "tokens_used": {"input_tokens": 40, "output_tokens": 60},
                },
            ],
        }
        graph = create_mock_graph(graph_result)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.tokens_used.input_tokens == 90
        assert result.tokens_used.output_tokens == 90


class TestLangGraphWorkflowEngineTimeout:
    """Tests for timeout handling."""

    async def test_timeout_returns_failure_result(
        self,
        initial_state: dict,
    ):
        """Test that exceeding timeout returns success=False with TIMEOUT indication."""
        config = ExecutionConfig(
            tenant_id="tenant-1",
            user_id="user-1",
            trace_id="trace-timeout",
            max_steps=50,
            timeout_ms=50,  # Very short timeout: 50ms
        )
        # Graph that takes longer than timeout
        graph = create_mock_graph({"output": "late", "steps": []}, delay=0.2)
        engine = LangGraphWorkflowEngine(workflows={"slow-wf": graph})

        result = await engine.execute("slow-wf", initial_state, config)

        assert result.success is False
        assert result.output == ""
        assert "TIMEOUT" in result.blocked_reason
        assert "50ms" in result.blocked_reason
        assert result.trace_id == "trace-timeout"
        assert result.duration_ms >= 50

    async def test_timeout_preserves_trace_id(
        self,
        initial_state: dict,
    ):
        """Test that trace_id is preserved in timeout failure results."""
        config = ExecutionConfig(
            tenant_id="t",
            user_id="u",
            trace_id="my-trace-id",
            max_steps=10,
            timeout_ms=10,
        )
        graph = create_mock_graph({"output": "", "steps": []}, delay=1.0)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, config)

        assert result.trace_id == "my-trace-id"


class TestLangGraphWorkflowEngineRecursionLimit:
    """Tests for recursion_limit enforcement."""

    async def test_recursion_limit_passed_to_langgraph_config(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
        successful_graph_result: dict,
    ):
        """Test that recursion_limit from config.max_steps is passed to LangGraph."""
        graph = MagicMock()
        captured_config = {}

        async def capture_ainvoke(state, config=None):
            captured_config.update(config or {})
            return successful_graph_result

        graph.ainvoke = capture_ainvoke
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        execution_config.max_steps = 25
        await engine.execute("wf", initial_state, execution_config)

        assert captured_config["recursion_limit"] == 25

    async def test_recursion_error_returns_failure(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that GraphRecursionError is caught and returns failure with RECURSION_LIMIT."""
        graph = MagicMock()

        async def raise_recursion_error(state, config=None):
            raise Exception("Recursion limit of 50 reached without hitting a stop condition")

        graph.ainvoke = raise_recursion_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert "RECURSION_LIMIT" in result.blocked_reason
        assert result.duration_ms >= 0


class TestLangGraphWorkflowEngineRegistration:
    """Tests for workflow registration."""

    def test_register_workflow_stores_graph(self):
        """Test that register_workflow stores the graph for later execution."""
        engine = LangGraphWorkflowEngine()
        mock_graph = MagicMock()

        engine.register_workflow("my-workflow", mock_graph)

        assert "my-workflow" in engine._workflows
        assert engine._workflows["my-workflow"] is mock_graph

    def test_register_workflow_overwrites_existing(self):
        """Test that registering with same ID overwrites the previous graph."""
        engine = LangGraphWorkflowEngine()
        graph1 = MagicMock()
        graph2 = MagicMock()

        engine.register_workflow("wf", graph1)
        engine.register_workflow("wf", graph2)

        assert engine._workflows["wf"] is graph2

    async def test_register_then_execute_integration(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
        successful_graph_result: dict,
    ):
        """Test that a registered workflow can be executed successfully."""
        engine = LangGraphWorkflowEngine()
        graph = create_mock_graph(successful_graph_result)

        engine.register_workflow("integrated-wf", graph)
        result = await engine.execute("integrated-wf", initial_state, execution_config)

        assert result.success is True
        assert result.output == "Campanha criada com sucesso"

    async def test_constructor_with_initial_workflows(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
        successful_graph_result: dict,
    ):
        """Test that constructor with workflows dict makes them available for execution."""
        graph = create_mock_graph(successful_graph_result)
        engine = LangGraphWorkflowEngine(workflows={"pre-registered": graph})

        result = await engine.execute("pre-registered", initial_state, execution_config)

        assert result.success is True


class TestLangGraphWorkflowEngineErrors:
    """Tests for error handling."""

    async def test_nonexistent_workflow_raises_error(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that executing a non-existent workflow_id raises WorkflowNotFoundError."""
        engine = LangGraphWorkflowEngine()

        with pytest.raises(WorkflowNotFoundError) as exc_info:
            await engine.execute("nonexistent", initial_state, execution_config)

        assert "nonexistent" in str(exc_info.value)

    async def test_unexpected_error_returns_failure(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that unexpected errors are caught and return failure result."""
        graph = MagicMock()

        async def raise_error(state, config=None):
            raise ValueError("Something went wrong in node processing")

        graph.ainvoke = raise_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert "ValueError" in result.blocked_reason
        assert "Something went wrong" in result.blocked_reason
        assert result.trace_id == execution_config.trace_id

    async def test_error_message_truncated_to_1024_chars(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that error messages are truncated to max 1024 characters."""
        graph = MagicMock()
        long_message = "x" * 2000

        async def raise_long_error(state, config=None):
            raise RuntimeError(long_message)

        graph.ainvoke = raise_long_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        # blocked_reason includes "RuntimeError: " prefix + truncated message
        assert len(result.blocked_reason) <= 1024 + len("RuntimeError: ")
