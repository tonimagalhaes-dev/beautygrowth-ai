"""Tests for token tracking: TokenTracker utility and per-node token accounting."""

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.core.token_tracker import NodeTokenRecord, TokenTracker
from src.core.workflow_engine import (
    ExecutionConfig,
    LangGraphWorkflowEngine,
    StepResult,
    TokenUsage,
)


# ---------------------------------------------------------------------------
# TokenTracker unit tests
# ---------------------------------------------------------------------------


class TestTokenTrackerRecordTokens:
    """Tests for TokenTracker.record_tokens."""

    def test_record_single_node(self):
        """Test recording tokens for a single node."""
        tracker = TokenTracker()
        tracker.record_tokens("node_1", "llm_call", input_tokens=100, output_tokens=50)

        records = tracker.get_per_node()
        assert len(records) == 1
        assert records[0]["node_id"] == "node_1"
        assert records[0]["node_type"] == "llm_call"
        assert records[0]["input_tokens"] == 100
        assert records[0]["output_tokens"] == 50

    def test_record_multiple_nodes(self):
        """Test recording tokens for multiple nodes."""
        tracker = TokenTracker()
        tracker.record_tokens("n1", "llm_call", input_tokens=100, output_tokens=50)
        tracker.record_tokens("n2", "tool_call", input_tokens=0, output_tokens=0)
        tracker.record_tokens("n3", "llm_call", input_tokens=200, output_tokens=80)

        records = tracker.get_per_node()
        assert len(records) == 3

    def test_record_zero_tokens_for_non_llm_nodes(self):
        """Test that tool_call, condition, parallel nodes have zero tokens."""
        tracker = TokenTracker()
        tracker.record_tokens("tool_1", "tool_call", input_tokens=0, output_tokens=0)
        tracker.record_tokens("cond_1", "condition", input_tokens=0, output_tokens=0)
        tracker.record_tokens("par_1", "parallel", input_tokens=0, output_tokens=0)

        for record in tracker.get_per_node():
            assert record["input_tokens"] == 0
            assert record["output_tokens"] == 0


class TestTokenTrackerGetTotal:
    """Tests for TokenTracker.get_total."""

    def test_total_with_no_records(self):
        """Test that total is zero when no tokens recorded."""
        tracker = TokenTracker()
        total = tracker.get_total()
        assert total.input_tokens == 0
        assert total.output_tokens == 0

    def test_total_aggregates_across_all_nodes(self):
        """Test that total sums input and output tokens from all nodes."""
        tracker = TokenTracker()
        tracker.record_tokens("n1", "llm_call", input_tokens=100, output_tokens=50)
        tracker.record_tokens("n2", "tool_call", input_tokens=0, output_tokens=0)
        tracker.record_tokens("n3", "llm_call", input_tokens=200, output_tokens=80)

        total = tracker.get_total()
        assert total.input_tokens == 300
        assert total.output_tokens == 130

    def test_total_returns_token_usage_dataclass(self):
        """Test that get_total returns a TokenUsage instance."""
        tracker = TokenTracker()
        tracker.record_tokens("n1", "llm_call", input_tokens=10, output_tokens=5)

        total = tracker.get_total()
        assert isinstance(total, TokenUsage)


class TestTokenTrackerGetPerNode:
    """Tests for TokenTracker.get_per_node."""

    def test_per_node_empty_when_no_records(self):
        """Test that per_node returns empty list initially."""
        tracker = TokenTracker()
        assert tracker.get_per_node() == []

    def test_per_node_preserves_order(self):
        """Test that per_node returns records in insertion order."""
        tracker = TokenTracker()
        tracker.record_tokens("first", "llm_call", input_tokens=10, output_tokens=5)
        tracker.record_tokens("second", "tool_call", input_tokens=0, output_tokens=0)

        records = tracker.get_per_node()
        assert records[0]["node_id"] == "first"
        assert records[1]["node_id"] == "second"


class TestTokenTrackerWarnMissingTokens:
    """Tests for TokenTracker.warn_missing_tokens."""

    def test_warning_emitted_with_trace_and_node(self, caplog):
        """Test that warning is logged with trace_id and node_id."""
        tracker = TokenTracker()

        with caplog.at_level(logging.WARNING, logger="src.core.token_tracker"):
            tracker.warn_missing_tokens(node_id="llm_node_1", trace_id="trace-abc")

        assert "trace-abc" in caplog.text
        assert "llm_node_1" in caplog.text
        assert "token usage" in caplog.text.lower()

    def test_warning_includes_zero_recording_info(self, caplog):
        """Test that warning indicates tokens are recorded as 0."""
        tracker = TokenTracker()

        with caplog.at_level(logging.WARNING, logger="src.core.token_tracker"):
            tracker.warn_missing_tokens(node_id="node_x", trace_id="trace-123")

        assert "input_tokens=0" in caplog.text
        assert "output_tokens=0" in caplog.text


# ---------------------------------------------------------------------------
# Token accounting in node placeholders via workflow execution
# ---------------------------------------------------------------------------


def _create_mock_graph_with_steps(steps: list[dict], output: str = "done") -> MagicMock:
    """Create a mock graph that returns a result with given steps."""
    graph = MagicMock()

    async def mock_ainvoke(state, config=None):
        return {"output": output, "steps": steps}

    graph.ainvoke = mock_ainvoke
    return graph


@pytest.fixture
def exec_config() -> ExecutionConfig:
    """Standard execution config for token tests."""
    return ExecutionConfig(
        tenant_id="tenant-001",
        user_id="user-001",
        trace_id="trace-token-test",
        max_steps=50,
        timeout_ms=120_000,
    )


@pytest.fixture
def base_state() -> dict:
    """Base initial state for execution."""
    return {
        "user_input": "test",
        "tenant_id": "tenant-001",
        "agent_id": "agent-001",
        "messages": [],
        "intermediate_results": {},
        "output": "",
        "steps": [],
    }


class TestLlmCallNodeTokens:
    """Tests for llm_call nodes reporting non-zero tokens."""

    async def test_llm_call_reports_tokens_from_provider(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that llm_call steps with token data produce non-zero token usage."""
        steps = [
            {
                "node_id": "llm_1",
                "node_type": "llm_call",
                "output": "generated text",
                "duration_ms": 150,
                "status": "completed",
                "tokens_used": {"input_tokens": 120, "output_tokens": 45},
            }
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.success is True
        assert result.steps[0].tokens_used.input_tokens == 120
        assert result.steps[0].tokens_used.output_tokens == 45
        assert result.tokens_used.input_tokens == 120
        assert result.tokens_used.output_tokens == 45

    async def test_llm_call_reports_zero_when_no_token_info(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that llm_call steps without token data default to 0."""
        steps = [
            {
                "node_id": "llm_2",
                "node_type": "llm_call",
                "output": "text",
                "duration_ms": 100,
                "status": "completed",
                # No tokens_used field — simulates missing provider data
            }
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.steps[0].tokens_used.input_tokens == 0
        assert result.steps[0].tokens_used.output_tokens == 0


class TestToolCallConditionParallelTokens:
    """Tests for tool_call, condition, parallel nodes reporting zero tokens."""

    async def test_tool_call_reports_zero_tokens(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that tool_call nodes always report tokens = 0."""
        steps = [
            {
                "node_id": "tool_1",
                "node_type": "tool_call",
                "output": "tool result",
                "duration_ms": 50,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            }
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.steps[0].tokens_used.input_tokens == 0
        assert result.steps[0].tokens_used.output_tokens == 0

    async def test_condition_reports_zero_tokens(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that condition nodes always report tokens = 0."""
        steps = [
            {
                "node_id": "cond_1",
                "node_type": "condition",
                "output": "evaluated",
                "duration_ms": 5,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            }
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.steps[0].tokens_used.input_tokens == 0
        assert result.steps[0].tokens_used.output_tokens == 0

    async def test_parallel_reports_zero_tokens(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that parallel nodes always report tokens = 0."""
        steps = [
            {
                "node_id": "par_1",
                "node_type": "parallel",
                "output": "parallel done",
                "duration_ms": 200,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            }
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.steps[0].tokens_used.input_tokens == 0
        assert result.steps[0].tokens_used.output_tokens == 0


class TestTokenAggregation:
    """Tests for token aggregation across all steps equals total."""

    async def test_aggregation_sum_equals_response_total(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that sum of per-step tokens == response.tokens_used (Req 11.1)."""
        steps = [
            {
                "node_id": "llm_1",
                "node_type": "llm_call",
                "output": "out1",
                "duration_ms": 100,
                "status": "completed",
                "tokens_used": {"input_tokens": 50, "output_tokens": 30},
            },
            {
                "node_id": "tool_1",
                "node_type": "tool_call",
                "output": "out2",
                "duration_ms": 20,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            },
            {
                "node_id": "llm_2",
                "node_type": "llm_call",
                "output": "out3",
                "duration_ms": 150,
                "status": "completed",
                "tokens_used": {"input_tokens": 80, "output_tokens": 60},
            },
            {
                "node_id": "cond_1",
                "node_type": "condition",
                "output": "cond",
                "duration_ms": 5,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            },
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        # Sum individual steps
        total_input = sum(s.tokens_used.input_tokens for s in result.steps)
        total_output = sum(s.tokens_used.output_tokens for s in result.steps)

        # Must equal the aggregated total
        assert result.tokens_used.input_tokens == total_input
        assert result.tokens_used.output_tokens == total_output
        # Specific values
        assert result.tokens_used.input_tokens == 130
        assert result.tokens_used.output_tokens == 90

    async def test_aggregation_with_missing_tokens_defaults_to_zero(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test that missing tokens_used in step dicts defaults to 0."""
        steps = [
            {
                "node_id": "llm_1",
                "node_type": "llm_call",
                "output": "out",
                "duration_ms": 100,
                "status": "completed",
                # No tokens_used field
            },
            {
                "node_id": "llm_2",
                "node_type": "llm_call",
                "output": "out2",
                "duration_ms": 100,
                "status": "completed",
                "tokens_used": {"input_tokens": 40, "output_tokens": 20},
            },
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        # First step defaults to 0, second has 40/20
        assert result.tokens_used.input_tokens == 40
        assert result.tokens_used.output_tokens == 20

    async def test_aggregation_with_all_zero_tokens(
        self, exec_config: ExecutionConfig, base_state: dict
    ):
        """Test aggregation when all nodes report zero tokens."""
        steps = [
            {
                "node_id": "tool_1",
                "node_type": "tool_call",
                "output": "r1",
                "duration_ms": 10,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            },
            {
                "node_id": "cond_1",
                "node_type": "condition",
                "output": "r2",
                "duration_ms": 5,
                "status": "completed",
                "tokens_used": {"input_tokens": 0, "output_tokens": 0},
            },
        ]
        graph = _create_mock_graph_with_steps(steps)
        engine = LangGraphWorkflowEngine(workflows={"wf": graph})

        result = await engine.execute("wf", base_state, exec_config)

        assert result.tokens_used.input_tokens == 0
        assert result.tokens_used.output_tokens == 0


class TestWarningWhenNoTokenInfo:
    """Tests for warning emitted when LLM provider doesn't return tokens."""

    async def test_llm_placeholder_emits_warning_when_no_simulated_tokens(self, caplog):
        """Test that llm_call placeholder logs warning when no token config exists."""
        from src.core.agent_router import NodeDefinition
        from src.core.graph_builder import _create_llm_call_placeholder

        node_def = NodeDefinition(
            node_id="llm_no_tokens",
            node_type="llm_call",
            config={},  # No simulated_tokens
        )
        fn = _create_llm_call_placeholder(node_def)

        state = {
            "steps": [],
            "trace_id": "trace-warn-test",
        }

        with caplog.at_level(logging.WARNING):
            result = await fn(state)

        # Warning should include trace_id and node_id
        assert "trace-warn-test" in caplog.text
        assert "llm_no_tokens" in caplog.text
        # Step should have zero tokens
        step = result["steps"][0]
        assert step["tokens_used"]["input_tokens"] == 0
        assert step["tokens_used"]["output_tokens"] == 0

    async def test_llm_placeholder_no_warning_when_tokens_provided(self, caplog):
        """Test that no warning when simulated_tokens config is present."""
        from src.core.agent_router import NodeDefinition
        from src.core.graph_builder import _create_llm_call_placeholder

        node_def = NodeDefinition(
            node_id="llm_with_tokens",
            node_type="llm_call",
            config={"simulated_tokens": {"input_tokens": 100, "output_tokens": 50}},
        )
        fn = _create_llm_call_placeholder(node_def)

        state = {"steps": [], "trace_id": "trace-ok"}

        with caplog.at_level(logging.WARNING):
            result = await fn(state)

        # No warning should be logged
        assert "token usage" not in caplog.text.lower()
        # Step should have the provided tokens
        step = result["steps"][0]
        assert step["tokens_used"]["input_tokens"] == 100
        assert step["tokens_used"]["output_tokens"] == 50
