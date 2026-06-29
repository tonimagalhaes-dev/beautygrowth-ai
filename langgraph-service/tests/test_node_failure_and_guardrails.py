"""Tests for node failure handling and guardrail enforcement.

Covers:
- Task 3.4: Node failure records FAILED status in StepResult
- Task 3.4: Guardrail violation returns blocked_reason + guardrail_violations
- Task 3.4: Error messages truncated to 1024 characters
- Task 3.4: Guardrail node type resolved correctly
"""

import asyncio
from unittest.mock import MagicMock

import pytest

from src.core.agent_router import NodeDefinition
from src.core.exceptions import (
    GuardrailViolationError,
    MAX_ERROR_MESSAGE_LENGTH,
    NodeExecutionError,
)
from src.core.graph_builder import (
    WorkflowState,
    _create_guardrail_node,
    create_safe_node_wrapper,
    resolve_node_function,
)
from src.core.workflow_engine import (
    ExecutionConfig,
    LangGraphWorkflowEngine,
    StepResult,
    TokenUsage,
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


class TestGuardrailViolationError:
    """Tests for GuardrailViolationError exception."""

    def test_stores_node_id_and_violations(self):
        """Test that the exception stores node_id and violations correctly."""
        err = GuardrailViolationError(
            node_id="guardrail_1",
            violations=["Rule A violated", "Rule B violated"],
        )
        assert err.node_id == "guardrail_1"
        assert err.violations == ["Rule A violated", "Rule B violated"]

    def test_message_is_truncated_to_1024(self):
        """Test that an extremely long violation list gets truncated."""
        long_violations = [f"Rule {i} violated with long text " * 10 for i in range(50)]
        err = GuardrailViolationError(
            node_id="guardrail_x",
            violations=long_violations,
        )
        assert len(str(err)) <= MAX_ERROR_MESSAGE_LENGTH


class TestNodeExecutionError:
    """Tests for NodeExecutionError exception."""

    def test_stores_attributes(self):
        """Test that the exception stores node_id, node_type, and error_message."""
        err = NodeExecutionError(
            node_id="node_a",
            node_type="llm_call",
            error_message="Connection timeout",
        )
        assert err.node_id == "node_a"
        assert err.node_type == "llm_call"
        assert err.error_message == "Connection timeout"

    def test_error_message_truncated_to_1024(self):
        """Test that error_message is truncated to 1024 characters."""
        long_msg = "x" * 2000
        err = NodeExecutionError(
            node_id="node_b",
            node_type="tool_call",
            error_message=long_msg,
        )
        assert len(err.error_message) == MAX_ERROR_MESSAGE_LENGTH


class TestGuardrailNodeResolution:
    """Tests for guardrail node type resolution in resolve_node_function."""

    def test_guardrail_type_is_resolved(self):
        """Test that 'guardrail' node type is supported and resolved."""
        node_def = NodeDefinition(
            node_id="guard_1",
            node_type="guardrail",
            config={"rules": []},
        )
        fn = resolve_node_function(node_def)
        assert callable(fn)

    def test_unknown_type_raises_value_error(self):
        """Test that unknown node types raise ValueError mentioning guardrail."""
        node_def = NodeDefinition(
            node_id="unknown_1",
            node_type="invalid_type",
            config={},
        )
        with pytest.raises(ValueError) as exc_info:
            resolve_node_function(node_def)
        assert "guardrail" in str(exc_info.value)


class TestGuardrailNodeExecution:
    """Tests for guardrail node function execution."""

    async def test_passes_when_no_violations(self):
        """Test that guardrail node passes when all rules are satisfied."""
        node_def = NodeDefinition(
            node_id="guard_1",
            node_type="guardrail",
            config={
                "rules": [
                    {
                        "field": "user_input",
                        "condition": "not_empty",
                        "message": "User input must not be empty",
                    }
                ]
            },
        )
        fn = _create_guardrail_node(node_def)
        state: WorkflowState = {
            "user_input": "Hello world",
            "tenant_id": "t-1",
            "agent_id": "a-1",
            "messages": [],
            "intermediate_results": {},
            "output": "",
            "steps": [],
        }
        result = await fn(state)
        assert "all rules passed" in result["output"]
        assert result["steps"][-1]["status"] == "completed"
        assert result["steps"][-1]["node_type"] == "guardrail"

    async def test_raises_on_not_empty_violation(self):
        """Test that guardrail raises GuardrailViolationError when not_empty fails."""
        node_def = NodeDefinition(
            node_id="guard_2",
            node_type="guardrail",
            config={
                "rules": [
                    {
                        "field": "user_input",
                        "condition": "not_empty",
                        "message": "User input required",
                    }
                ]
            },
        )
        fn = _create_guardrail_node(node_def)
        state: WorkflowState = {
            "user_input": "",
            "tenant_id": "t-1",
            "agent_id": "a-1",
            "messages": [],
            "intermediate_results": {},
            "output": "",
            "steps": [],
        }
        with pytest.raises(GuardrailViolationError) as exc_info:
            await fn(state)
        assert exc_info.value.node_id == "guard_2"
        assert "User input required" in exc_info.value.violations

    async def test_raises_on_blocked_words_violation(self):
        """Test that guardrail detects blocked words."""
        node_def = NodeDefinition(
            node_id="guard_3",
            node_type="guardrail",
            config={
                "rules": [
                    {
                        "field": "user_input",
                        "condition": "blocked_words",
                        "value": ["spam", "hack"],
                        "message": "Blocked word detected",
                    }
                ]
            },
        )
        fn = _create_guardrail_node(node_def)
        state: WorkflowState = {
            "user_input": "I want to spam everyone",
            "tenant_id": "t-1",
            "agent_id": "a-1",
            "messages": [],
            "intermediate_results": {},
            "output": "",
            "steps": [],
        }
        with pytest.raises(GuardrailViolationError) as exc_info:
            await fn(state)
        assert "Blocked word detected" in exc_info.value.violations

    async def test_raises_on_max_length_violation(self):
        """Test that guardrail detects max_length violations."""
        node_def = NodeDefinition(
            node_id="guard_4",
            node_type="guardrail",
            config={
                "rules": [
                    {
                        "field": "user_input",
                        "condition": "max_length",
                        "value": 10,
                        "message": "Input too long",
                    }
                ]
            },
        )
        fn = _create_guardrail_node(node_def)
        state: WorkflowState = {
            "user_input": "This is a very long input that exceeds the limit",
            "tenant_id": "t-1",
            "agent_id": "a-1",
            "messages": [],
            "intermediate_results": {},
            "output": "",
            "steps": [],
        }
        with pytest.raises(GuardrailViolationError) as exc_info:
            await fn(state)
        assert "Input too long" in exc_info.value.violations

    async def test_multiple_violations_collected(self):
        """Test that multiple violations are accumulated in a single error."""
        node_def = NodeDefinition(
            node_id="guard_5",
            node_type="guardrail",
            config={
                "rules": [
                    {
                        "field": "output",
                        "condition": "not_empty",
                        "message": "Output required",
                    },
                    {
                        "field": "missing_field",
                        "condition": "required_field",
                        "message": "Missing field required",
                    },
                ]
            },
        )
        fn = _create_guardrail_node(node_def)
        state: WorkflowState = {
            "user_input": "hello",
            "tenant_id": "t-1",
            "agent_id": "a-1",
            "messages": [],
            "intermediate_results": {},
            "output": "",
            "steps": [],
        }
        with pytest.raises(GuardrailViolationError) as exc_info:
            await fn(state)
        assert len(exc_info.value.violations) == 2
        assert "Output required" in exc_info.value.violations
        assert "Missing field required" in exc_info.value.violations


class TestWorkflowEngineGuardrailHandling:
    """Tests for guardrail violation handling in LangGraphWorkflowEngine.execute()."""

    async def test_guardrail_violation_returns_blocked_reason_and_violations(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that GuardrailViolationError returns blocked_reason + guardrail_violations."""
        graph = MagicMock()

        async def raise_guardrail_error(state, config=None):
            raise GuardrailViolationError(
                node_id="content_filter",
                violations=["Inappropriate content detected", "PII found in output"],
            )

        graph.ainvoke = raise_guardrail_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert "content_filter" in result.blocked_reason
        assert "Guardrail violation" in result.blocked_reason
        assert result.guardrail_violations is not None
        assert len(result.guardrail_violations) == 2
        assert "Inappropriate content detected" in result.guardrail_violations
        assert "PII found in output" in result.guardrail_violations

    async def test_guardrail_blocked_reason_truncated_to_1024(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that blocked_reason from guardrail is truncated to 1024 chars."""
        graph = MagicMock()
        long_violations = [f"Rule {i} violated " * 20 for i in range(100)]

        async def raise_long_guardrail(state, config=None):
            raise GuardrailViolationError(
                node_id="big_guard",
                violations=long_violations,
            )

        graph.ainvoke = raise_long_guardrail
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert len(result.blocked_reason) <= MAX_ERROR_MESSAGE_LENGTH


class TestWorkflowEngineNodeFailureHandling:
    """Tests for node failure handling in LangGraphWorkflowEngine.execute()."""

    async def test_node_execution_error_returns_failed_step(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that NodeExecutionError records FAILED status in StepResult."""
        graph = MagicMock()

        async def raise_node_error(state, config=None):
            raise NodeExecutionError(
                node_id="analyzer_node",
                node_type="tool_call",
                error_message="External API unavailable",
            )

        graph.ainvoke = raise_node_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert "analyzer_node" in result.blocked_reason
        assert len(result.steps) == 1
        assert result.steps[0].node_id == "analyzer_node"
        assert result.steps[0].node_type == "tool_call"
        assert result.steps[0].status == "failed"
        assert result.steps[0].error_message == "External API unavailable"

    async def test_node_failure_error_message_truncated(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that NodeExecutionError's error_message is truncated to 1024 chars."""
        graph = MagicMock()
        long_error = "x" * 2000

        async def raise_long_node_error(state, config=None):
            raise NodeExecutionError(
                node_id="bad_node",
                node_type="llm_call",
                error_message=long_error,
            )

        graph.ainvoke = raise_long_node_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert result.steps[0].error_message is not None
        assert len(result.steps[0].error_message) == MAX_ERROR_MESSAGE_LENGTH

    async def test_general_error_blocked_reason_truncated(
        self,
        execution_config: ExecutionConfig,
        initial_state: dict,
    ):
        """Test that general errors have blocked_reason truncated to 1024 chars."""
        graph = MagicMock()
        long_msg = "a" * 2000

        async def raise_big_error(state, config=None):
            raise RuntimeError(long_msg)

        graph.ainvoke = raise_big_error
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", initial_state, execution_config)

        assert result.success is False
        assert len(result.blocked_reason) <= MAX_ERROR_MESSAGE_LENGTH


class TestSafeNodeWrapper:
    """Tests for the create_safe_node_wrapper function."""

    async def test_successful_execution_passes_through(self):
        """Test that successful node execution returns result unchanged."""
        node_def = NodeDefinition(
            node_id="node_1", node_type="llm_call", config={}
        )

        async def good_node(state):
            return {"output": "ok", "steps": []}

        wrapped = create_safe_node_wrapper(good_node, node_def)
        result = await wrapped({})
        assert result == {"output": "ok", "steps": []}

    async def test_raises_node_execution_error_on_failure(self):
        """Test that exceptions become NodeExecutionError."""
        node_def = NodeDefinition(
            node_id="failing_node", node_type="tool_call", config={}
        )

        async def bad_node(state):
            raise ValueError("Something broke")

        wrapped = create_safe_node_wrapper(bad_node, node_def)

        with pytest.raises(NodeExecutionError) as exc_info:
            await wrapped({})

        assert exc_info.value.node_id == "failing_node"
        assert exc_info.value.node_type == "tool_call"
        assert "Something broke" in exc_info.value.error_message

    async def test_guardrail_error_passes_through(self):
        """Test that GuardrailViolationError is not wrapped."""
        node_def = NodeDefinition(
            node_id="node_1", node_type="guardrail", config={}
        )

        async def guardrail_node(state):
            raise GuardrailViolationError(
                node_id="node_1", violations=["rule A"]
            )

        wrapped = create_safe_node_wrapper(guardrail_node, node_def)

        with pytest.raises(GuardrailViolationError):
            await wrapped({})

    async def test_error_message_truncated_in_wrapper(self):
        """Test that wrapper truncates error messages to 1024 chars."""
        node_def = NodeDefinition(
            node_id="node_1", node_type="llm_call", config={}
        )
        long_msg = "z" * 2000

        async def bad_node(state):
            raise RuntimeError(long_msg)

        wrapped = create_safe_node_wrapper(bad_node, node_def)

        with pytest.raises(NodeExecutionError) as exc_info:
            await wrapped({})

        assert len(exc_info.value.error_message) == MAX_ERROR_MESSAGE_LENGTH
