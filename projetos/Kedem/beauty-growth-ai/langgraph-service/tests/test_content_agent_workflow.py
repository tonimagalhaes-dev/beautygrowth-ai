"""Tests for the Content Agent workflow graph structure and state schema."""

import pytest

from src.workflows.content_agent import (
    ContentAgentState,
    build_content_agent_graph,
    should_retry_or_output,
    load_context,
    resolve_prompt,
    generate_content,
    validate_guardrails,
    persist_and_output,
)


class TestContentAgentState:
    """Tests for ContentAgentState TypedDict schema."""

    def test_state_has_all_input_fields(self):
        """ContentAgentState defines all required input fields."""
        annotations = ContentAgentState.__annotations__
        input_fields = [
            "tenant_id", "user_id", "trace_id", "execution_id",
            "briefing", "is_refinement", "original_execution_id",
            "refinement_instructions", "version",
        ]
        for field in input_fields:
            assert field in annotations, f"Missing input field: {field}"

    def test_state_has_all_context_fields(self):
        """ContentAgentState defines all required context fields."""
        annotations = ContentAgentState.__annotations__
        context_fields = [
            "brand_identity", "publico_alvo", "especialidades",
            "diferenciais", "knowledge_chunks",
        ]
        for field in context_fields:
            assert field in annotations, f"Missing context field: {field}"

    def test_state_has_all_prompt_fields(self):
        """ContentAgentState defines all required prompt fields."""
        annotations = ContentAgentState.__annotations__
        assert "system_prompt" in annotations
        assert "task_prompt" in annotations

    def test_state_has_all_generation_fields(self):
        """ContentAgentState defines all required generation fields."""
        annotations = ContentAgentState.__annotations__
        generation_fields = [
            "legendas", "hashtags", "sugestoes_visuais",
            "model_id", "used_fallback",
        ]
        for field in generation_fields:
            assert field in annotations, f"Missing generation field: {field}"

    def test_state_has_all_validation_fields(self):
        """ContentAgentState defines all required validation fields."""
        annotations = ContentAgentState.__annotations__
        validation_fields = [
            "guardrail_attempt", "guardrail_violations", "blocked_reason",
        ]
        for field in validation_fields:
            assert field in annotations, f"Missing validation field: {field}"

    def test_state_has_all_execution_fields(self):
        """ContentAgentState defines all required execution metadata fields."""
        annotations = ContentAgentState.__annotations__
        execution_fields = [
            "steps", "tokens_input", "tokens_output", "output",
        ]
        for field in execution_fields:
            assert field in annotations, f"Missing execution field: {field}"

    def test_state_total_field_count(self):
        """ContentAgentState has exactly 28 fields as specified in design."""
        annotations = ContentAgentState.__annotations__
        assert len(annotations) == 28


class TestShouldRetryOrOutput:
    """Tests for the conditional edge function."""

    def test_no_violations_routes_to_persist(self):
        """No guardrail violations → persist_and_output."""
        state = {"guardrail_violations": [], "guardrail_attempt": 0}
        assert should_retry_or_output(state) == "persist_and_output"

    def test_violation_below_limit_routes_to_retry(self):
        """Violation with attempts < 3 → generate_content (retry)."""
        state = {"guardrail_violations": ["some violation"], "guardrail_attempt": 1}
        assert should_retry_or_output(state) == "generate_content"

    def test_violation_at_attempt_2_routes_to_retry(self):
        """Violation with attempt=2 → generate_content (still under limit)."""
        state = {"guardrail_violations": ["violation"], "guardrail_attempt": 2}
        assert should_retry_or_output(state) == "generate_content"

    def test_violation_at_attempt_3_routes_to_end(self):
        """Violation with attempt=3 → __end__ (blocked)."""
        state = {"guardrail_violations": ["violation"], "guardrail_attempt": 3}
        assert should_retry_or_output(state) == "__end__"

    def test_violation_above_limit_routes_to_end(self):
        """Violation with attempt > 3 → __end__ (blocked)."""
        state = {"guardrail_violations": ["v1", "v2"], "guardrail_attempt": 5}
        assert should_retry_or_output(state) == "__end__"

    def test_empty_state_routes_to_persist(self):
        """Empty state (no violations key) → persist_and_output."""
        state = {}
        assert should_retry_or_output(state) == "persist_and_output"

    def test_none_violations_routes_to_persist(self):
        """None violations → persist_and_output."""
        state = {"guardrail_violations": None, "guardrail_attempt": 2}
        assert should_retry_or_output(state) == "persist_and_output"


class TestBuildContentAgentGraph:
    """Tests for graph construction."""

    def test_graph_compiles_successfully(self):
        """build_content_agent_graph returns a compiled graph."""
        graph = build_content_agent_graph()
        assert graph is not None
        # CompiledStateGraph has an invoke method
        assert hasattr(graph, "ainvoke")

    def test_graph_has_correct_nodes(self):
        """Graph contains all 5 expected nodes."""
        graph = build_content_agent_graph()
        # CompiledStateGraph exposes nodes via .nodes attribute
        node_names = set(graph.nodes.keys())
        expected = {
            "load_context", "resolve_prompt", "generate_content",
            "validate_guardrails", "persist_and_output", "__start__",
        }
        # __start__ is automatically added by LangGraph
        assert expected.issubset(node_names)


class TestStubNodes:
    """Tests that stub nodes pass state through without modification."""

    @pytest.mark.asyncio
    async def test_load_context_stub_returns_empty(self):
        """load_context stub returns empty dict (no state changes)."""
        state = {"tenant_id": "t1", "briefing": {"tema": "test"}}
        result = await load_context(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_resolve_prompt_stub_returns_empty(self):
        """resolve_prompt stub returns empty dict."""
        state = {"system_prompt": "", "task_prompt": ""}
        result = await resolve_prompt(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_generate_content_stub_returns_empty(self):
        """generate_content stub returns empty dict."""
        state = {"legendas": {}, "hashtags": []}
        result = await generate_content(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_validate_guardrails_stub_returns_empty(self):
        """validate_guardrails stub returns empty dict."""
        state = {"guardrail_attempt": 0, "guardrail_violations": []}
        result = await validate_guardrails(state)
        assert result == {}

    @pytest.mark.asyncio
    async def test_persist_and_output_stub_returns_empty(self):
        """persist_and_output stub returns empty dict."""
        state = {"output": "", "steps": []}
        result = await persist_and_output(state)
        assert result == {}
