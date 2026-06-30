"""Tests for the persist_and_output node (task 2.6).

Validates:
- Serializes output JSON with legendas, hashtags, sugestoes_visuais, model_id, tokens
- Persists to agent_memory_short with correct fields
- Records observability log in workflow_executions
- Graceful degradation: returns output even when persistence fails (Requirement 6.5)
- Requirements: 6.1, 6.2, 6.5
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.content_agent import (
    ContentAgentState,
    make_persist_and_output,
    persist_and_output,
    _compute_duration_ms,
    _serialize_output,
)


# ============================================================
# Fixtures
# ============================================================


@pytest.fixture
def sample_state() -> dict:
    """Provide a complete ContentAgentState dict for persist_and_output tests."""
    return {
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "user_id": "880e8400-e29b-41d4-a716-446655440003",
        "trace_id": "trace-abc-123",
        "execution_id": "exec-def-456",
        "briefing": {
            "tema": "Harmonização facial",
            "procedimento": "botox",
            "redes_sociais": ["instagram", "facebook"],
            "idioma": "pt-BR",
        },
        "is_refinement": False,
        "original_execution_id": None,
        "refinement_instructions": None,
        "version": 1,
        "brand_identity": {"tom_de_voz": "profissional", "valores": "confiança"},
        "publico_alvo": "Mulheres 30-50 anos",
        "especialidades": ["dermatologia", "estética"],
        "diferenciais": ["equipe especializada"],
        "knowledge_chunks": [],
        "system_prompt": "Você é um assistente...",
        "task_prompt": "Gere conteúdo sobre...",
        "legendas": {
            "instagram": "Descubra os benefícios da harmonização facial! ✨",
            "facebook": "Harmonização facial: resultados naturais para você.",
        },
        "hashtags": [
            "#harmonizacao", "#estetica", "#beleza", "#botox", "#pele",
            "#clinica", "#cuidados",
        ],
        "sugestoes_visuais": {
            "instagram": {"formato": "4:5", "descricao": "Antes e depois com filtro suave"},
            "facebook": {"formato": "1.91:1", "descricao": "Imagem da clínica moderna"},
        },
        "model_id": "gpt-4o",
        "used_fallback": False,
        "guardrail_attempt": 0,
        "guardrail_violations": [],
        "blocked_reason": None,
        "steps": [
            {"node": "load_context", "duration_ms": 150},
            {"node": "resolve_prompt", "duration_ms": 50},
            {"node": "generate_content", "duration_ms": 3000},
            {"node": "validate_guardrails", "duration_ms": 100},
        ],
        "tokens_input": 500,
        "tokens_output": 300,
        "output": "",
    }


@pytest.fixture
def mock_pg_pool():
    """Create a mocked asyncpg pool with connection context manager."""
    pool = AsyncMock()
    conn = AsyncMock()
    conn.execute = AsyncMock(return_value=None)

    # Create a proper async context manager for tenant_connection
    return pool, conn


# ============================================================
# Tests: _compute_duration_ms helper
# ============================================================


class TestComputeDurationMs:
    """Tests for the _compute_duration_ms helper function."""

    def test_sums_step_durations(self):
        """Correctly sums duration_ms from steps."""
        steps = [
            {"node": "a", "duration_ms": 100},
            {"node": "b", "duration_ms": 200},
            {"node": "c", "duration_ms": 50},
        ]
        assert _compute_duration_ms(steps) == 350

    def test_empty_steps_returns_zero(self):
        """Empty steps list returns 0."""
        assert _compute_duration_ms([]) == 0

    def test_missing_duration_ms_treated_as_zero(self):
        """Steps without duration_ms are treated as 0."""
        steps = [
            {"node": "a"},
            {"node": "b", "duration_ms": 100},
        ]
        assert _compute_duration_ms(steps) == 100

    def test_float_duration_ms_is_cast_to_int(self):
        """Float durations are cast to int."""
        steps = [{"node": "a", "duration_ms": 150.7}]
        assert _compute_duration_ms(steps) == 150

    def test_non_numeric_duration_ms_treated_as_zero(self):
        """Non-numeric duration_ms values are treated as 0."""
        steps = [
            {"node": "a", "duration_ms": "invalid"},
            {"node": "b", "duration_ms": 200},
        ]
        assert _compute_duration_ms(steps) == 200


# ============================================================
# Tests: _serialize_output helper
# ============================================================


class TestSerializeOutput:
    """Tests for the _serialize_output helper function."""

    def test_serializes_all_fields(self, sample_state):
        """Output contains legendas, hashtags, sugestoes_visuais, model_id, used_fallback, tokens."""
        result = _serialize_output(sample_state)
        parsed = json.loads(result)

        assert parsed["legendas"] == sample_state["legendas"]
        assert parsed["hashtags"] == sample_state["hashtags"]
        assert parsed["sugestoes_visuais"] == sample_state["sugestoes_visuais"]
        assert parsed["model_id"] == "gpt-4o"
        assert parsed["used_fallback"] is False
        assert parsed["tokens"]["input"] == 500
        assert parsed["tokens"]["output"] == 300

    def test_handles_empty_state_gracefully(self):
        """Serializes correctly when state has missing/empty fields."""
        state = {}
        result = _serialize_output(state)
        parsed = json.loads(result)

        assert parsed["legendas"] == {}
        assert parsed["hashtags"] == []
        assert parsed["sugestoes_visuais"] == {}
        assert parsed["model_id"] == ""
        assert parsed["used_fallback"] is False
        assert parsed["tokens"]["input"] == 0
        assert parsed["tokens"]["output"] == 0

    def test_unicode_content_preserved(self):
        """Unicode characters (emojis, accents) are preserved."""
        state = {
            "legendas": {"instagram": "Beleza é ✨ transformação!"},
            "hashtags": ["#estética"],
            "sugestoes_visuais": {},
            "model_id": "gpt-4o",
            "used_fallback": False,
            "tokens_input": 10,
            "tokens_output": 5,
        }
        result = _serialize_output(state)
        parsed = json.loads(result)
        assert "✨" in parsed["legendas"]["instagram"]
        assert "#estética" in parsed["hashtags"]


# ============================================================
# Tests: make_persist_and_output factory - success path
# ============================================================


class TestPersistAndOutputSuccess:
    """Tests for persist_and_output node success path."""

    async def test_returns_serialized_output(self, sample_state):
        """Node returns dict with 'output' key containing serialized JSON."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(return_value=None)

            # Create async context manager
            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(sample_state)

        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["legendas"] == sample_state["legendas"]
        assert parsed["hashtags"] == sample_state["hashtags"]
        assert parsed["model_id"] == "gpt-4o"
        assert parsed["tokens"]["input"] == 500
        assert parsed["tokens"]["output"] == 300

    async def test_persists_to_agent_memory_short(self, sample_state):
        """Node inserts into agent_memory_short with correct parameters."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(return_value=None)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            await node(sample_state)

        # tenant_connection is called twice: once for agent_memory, once for observability
        assert mock_tc.call_count == 2

        # First call: agent_memory_short insert
        first_call = mock_conn.execute.call_args_list[0]
        sql = first_call[0][0]
        args = first_call[0][1:]

        assert "agent_memory_short" in sql
        assert args[0] == "content"  # agent_id
        assert args[1] == sample_state["tenant_id"]  # tenant_id
        assert args[2] == "assistant"  # role

        # content is JSON string
        content_json = json.loads(args[3])
        assert content_json["legendas"] == sample_state["legendas"]

        # metadata contains execution_id, version, trace_id
        metadata = json.loads(args[4])
        assert metadata["execution_id"] == "exec-def-456"
        assert metadata["version"] == 1
        assert metadata["trace_id"] == "trace-abc-123"

    async def test_records_observability_log(self, sample_state):
        """Node inserts into workflow_executions with observability data."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(return_value=None)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            await node(sample_state)

        # Second call: workflow_executions insert
        second_call = mock_conn.execute.call_args_list[1]
        sql = second_call[0][0]
        args = second_call[0][1:]

        assert "workflow_executions" in sql
        assert args[0] == sample_state["tenant_id"]  # tenant_id
        assert args[1] == "content_agent"  # workflow_id
        assert args[2] == sample_state["execution_id"]  # agent_id (execution_id)
        assert args[3] == sample_state["user_id"]  # user_id
        assert args[4] == "success"  # status
        # tokens
        assert args[7] == 500  # tokens_input
        assert args[8] == 300  # tokens_output
        # duration_ms = sum of step durations
        assert args[9] == 3300  # 150+50+3000+100
        assert args[10] == "gpt-4o"  # model_id
        assert args[11] == []  # guardrail_violations

        # metadata JSON
        metadata = json.loads(args[12])
        assert metadata["trace_id"] == "trace-abc-123"
        assert metadata["execution_id"] == "exec-def-456"
        assert metadata["version"] == 1
        assert metadata["guardrail_violation_count"] == 0


# ============================================================
# Tests: make_persist_and_output factory - failure paths
# ============================================================


class TestPersistAndOutputFailure:
    """Tests for persist_and_output node graceful degradation (Req 6.5)."""

    async def test_returns_output_when_agent_memory_fails(self, sample_state):
        """Returns output normally even when agent_memory_short INSERT fails."""
        call_count = 0

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()

            async def execute_side_effect(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    # First call (agent_memory) fails
                    raise Exception("Connection refused to PostgreSQL")
                return None

            mock_conn.execute = AsyncMock(side_effect=execute_side_effect)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(sample_state)

        # Output is still returned
        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["legendas"] == sample_state["legendas"]

    async def test_returns_output_when_observability_fails(self, sample_state):
        """Returns output normally even when workflow_executions INSERT fails."""
        call_count = 0

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()

            async def execute_side_effect(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 2:
                    # Second call (observability) fails
                    raise Exception("Disk full")
                return None

            mock_conn.execute = AsyncMock(side_effect=execute_side_effect)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(sample_state)

        # Output is still returned
        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["model_id"] == "gpt-4o"

    async def test_returns_output_when_both_persist_calls_fail(self, sample_state):
        """Returns output even when BOTH persistence calls fail."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(
                side_effect=Exception("Total DB failure")
            )

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(sample_state)

        # Output is STILL returned (graceful degradation)
        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["legendas"] == sample_state["legendas"]
        assert parsed["tokens"]["input"] == 500

    async def test_logs_warning_on_agent_memory_failure(self, sample_state):
        """Logs a warning when agent_memory_short persistence fails."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc, patch(
            "src.workflows.content_agent.logger"
        ) as mock_logger:
            mock_conn = AsyncMock()

            call_count = 0

            async def execute_side_effect(*args, **kwargs):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    raise Exception("agent memory error")
                return None

            mock_conn.execute = AsyncMock(side_effect=execute_side_effect)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            await node(sample_state)

        # Check that warning was logged
        mock_logger.warning.assert_called()
        warning_call_args = mock_logger.warning.call_args_list[0][0]
        assert "Agent Memory" in warning_call_args[0]

    async def test_tenant_connection_itself_raises(self, sample_state):
        """Handles case where tenant_connection context manager raises."""
        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(
                side_effect=Exception("Pool exhausted")
            )
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(sample_state)

        # Still returns output
        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["legendas"] == sample_state["legendas"]


# ============================================================
# Tests: persist_and_output stub (backward compatibility)
# ============================================================


class TestPersistAndOutputStub:
    """Tests for the backward-compatible stub function."""

    async def test_stub_returns_empty_dict(self):
        """The stub persist_and_output returns empty dict."""
        state = {"output": "", "steps": []}
        result = await persist_and_output(state)
        assert result == {}


# ============================================================
# Tests: Edge cases
# ============================================================


class TestPersistAndOutputEdgeCases:
    """Tests for edge cases in persist_and_output."""

    async def test_handles_missing_optional_state_fields(self):
        """Works with minimal state (only required fields present)."""
        minimal_state = {
            "tenant_id": "t1",
            "execution_id": "e1",
            "trace_id": "tr1",
            "user_id": "u1",
            "version": 1,
        }

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(return_value=None)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            result = await node(minimal_state)

        assert "output" in result
        parsed = json.loads(result["output"])
        assert parsed["legendas"] == {}
        assert parsed["hashtags"] == []
        assert parsed["tokens"]["input"] == 0
        assert parsed["tokens"]["output"] == 0

    async def test_handles_guardrail_violations_in_observability(self):
        """Correctly reports guardrail_violations count in metadata."""
        state = {
            "tenant_id": "t1",
            "user_id": "u1",
            "trace_id": "tr1",
            "execution_id": "e1",
            "version": 1,
            "briefing": {"tema": "test"},
            "legendas": {"instagram": "test"},
            "hashtags": ["#test"] * 5,
            "sugestoes_visuais": {},
            "model_id": "gpt-4o",
            "used_fallback": False,
            "guardrail_violations": ["no_promises", "no_diagnosis"],
            "steps": [{"duration_ms": 500}],
            "tokens_input": 100,
            "tokens_output": 50,
        }

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.execute = AsyncMock(return_value=None)

            mock_cm = AsyncMock()
            mock_cm.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_cm.__aexit__ = AsyncMock(return_value=False)
            mock_tc.return_value = mock_cm

            pool = AsyncMock()
            node = make_persist_and_output(pool)
            await node(state)

        # Second call is observability
        second_call = mock_conn.execute.call_args_list[1]
        args = second_call[0][1:]
        # guardrail_violations passed to INSERT
        assert args[11] == ["no_promises", "no_diagnosis"]
        # metadata includes count
        metadata = json.loads(args[12])
        assert metadata["guardrail_violation_count"] == 2
