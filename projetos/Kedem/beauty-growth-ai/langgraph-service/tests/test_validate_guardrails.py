"""Tests for the validate_guardrails node in Content Agent workflow.

Covers task 2.5:
- No violations pass through cleanly
- Single violation triggers retry (increments guardrail_attempt)
- Multiple violations from different guardrails
- 3rd attempt blocks with blocked_reason
- Regex pattern matching (case-insensitive)
- Keyword matching (case-insensitive)
- Fail-open when guardrails table is unreachable

Requirements: 4.1, 4.2, 4.3, 4.4
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.content_agent import (
    _check_guardrail_against_text,
    make_validate_guardrails,
    validate_guardrails,
)


# --- Helper: mock pg_pool with configurable guardrail rows ---


def _make_mock_pool(rows: list[dict] | None = None, raise_error: bool = False):
    """Create a mock asyncpg.Pool that returns specified guardrail rows.

    Args:
        rows: List of dicts with 'name' and 'rule' keys.
        raise_error: If True, simulates a DB connection failure.

    Returns:
        A mock pool compatible with tenant_connection usage.
    """
    mock_pool = MagicMock()
    mock_conn = AsyncMock()

    if raise_error:
        mock_conn.fetch = AsyncMock(side_effect=OSError("DB unavailable"))
    else:
        mock_conn.fetch = AsyncMock(return_value=rows or [])

    mock_conn.execute = AsyncMock()

    # Mock the pool.acquire() -> conn context manager
    mock_acquire_cm = AsyncMock()
    mock_acquire_cm.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_acquire_cm.__aexit__ = AsyncMock(return_value=False)
    mock_pool.acquire = MagicMock(return_value=mock_acquire_cm)

    return mock_pool


def _make_guardrail_row(name: str, pattern: str | None = None, keywords: list[str] | None = None) -> dict:
    """Create a mock guardrail row matching the DB schema."""
    rule = {}
    if pattern:
        rule["pattern"] = pattern
    if keywords:
        rule["keywords"] = keywords
    rule["action"] = "regenerate"
    rule["maxRetries"] = 3
    return {"name": name, "rule": rule}


def _base_state(
    legendas: dict[str, str] | None = None,
    guardrail_attempt: int = 0,
) -> dict:
    """Create a minimal ContentAgentState for testing."""
    return {
        "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
        "user_id": "user-1",
        "trace_id": "trace-1",
        "execution_id": "exec-1",
        "briefing": {"tema": "test", "redes_sociais": ["instagram"]},
        "legendas": legendas or {},
        "guardrail_attempt": guardrail_attempt,
        "guardrail_violations": [],
    }


class TestCheckGuardrailAgainstText:
    """Unit tests for the _check_guardrail_against_text helper."""

    def test_no_pattern_no_keywords_no_violation(self):
        """Empty rule never triggers a violation."""
        rule = {"action": "regenerate"}
        assert _check_guardrail_against_text("any text", rule) is False

    def test_regex_pattern_match(self):
        """Regex pattern detects violation."""
        rule = {"pattern": r"resultado\s+garantido"}
        assert _check_guardrail_against_text("Nosso resultado garantido!", rule) is True

    def test_regex_pattern_case_insensitive(self):
        """Regex match is case-insensitive."""
        rule = {"pattern": r"resultado\s+garantido"}
        assert _check_guardrail_against_text("RESULTADO GARANTIDO aqui", rule) is True

    def test_regex_pattern_no_match(self):
        """Regex that doesn't match returns no violation."""
        rule = {"pattern": r"resultado\s+garantido"}
        assert _check_guardrail_against_text("Resultados incríveis", rule) is False

    def test_keyword_match(self):
        """Keyword substring match detects violation."""
        rule = {"keywords": ["cura definitiva", "resultado permanente"]}
        assert _check_guardrail_against_text("Esta é uma cura definitiva!", rule) is True

    def test_keyword_case_insensitive(self):
        """Keyword match is case-insensitive."""
        rule = {"keywords": ["Resultado Permanente"]}
        assert _check_guardrail_against_text("resultado permanente do tratamento", rule) is True

    def test_keyword_no_match(self):
        """Keywords that don't match return no violation."""
        rule = {"keywords": ["cura definitiva", "resultado permanente"]}
        assert _check_guardrail_against_text("Tratamento com bons resultados", rule) is False

    def test_invalid_regex_does_not_crash(self):
        """Invalid regex pattern logs warning but doesn't crash."""
        rule = {"pattern": r"[invalid(regex"}
        # Should not raise, returns False
        assert _check_guardrail_against_text("some text", rule) is False

    def test_pattern_match_takes_priority(self):
        """If pattern matches, returns True even if keywords don't match."""
        rule = {"pattern": r"garante resultado", "keywords": ["unrelated"]}
        assert _check_guardrail_against_text("garante resultado aqui", rule) is True


class TestValidateGuardrailsStub:
    """Tests for the backward-compatible stub."""

    @pytest.mark.asyncio
    async def test_stub_returns_empty_dict(self):
        """The stub validate_guardrails returns empty dict."""
        state = _base_state(legendas={"instagram": "test content"})
        result = await validate_guardrails(state)
        assert result == {}


class TestMakeValidateGuardrails:
    """Tests for the make_validate_guardrails factory node."""

    @pytest.mark.asyncio
    async def test_no_violations_passes(self):
        """Content without violations returns empty guardrail_violations."""
        rows = [_make_guardrail_row("no_promises", pattern=r"resultado\s+garantido")]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(legendas={"instagram": "Conheça nossos tratamentos!"})

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_violations"] == []
        assert "blocked_reason" not in result

    @pytest.mark.asyncio
    async def test_single_violation_triggers_retry(self):
        """Single violation increments guardrail_attempt and records violation."""
        rows = [_make_guardrail_row("no_promises", pattern=r"resultado\s+garantido")]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={"instagram": "Garantimos resultado garantido para você!"},
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_attempt"] == 1
        assert "no_promises" in result["guardrail_violations"]
        assert "blocked_reason" not in result

    @pytest.mark.asyncio
    async def test_multiple_violations_recorded(self):
        """Multiple violations from different guardrails are all recorded."""
        rows = [
            _make_guardrail_row("no_promises", pattern=r"resultado\s+garantido"),
            _make_guardrail_row("no_diagnosis", keywords=["você tem", "diagnóstico"]),
        ]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={
                "instagram": "Resultado garantido! Você tem pele perfeita!",
            },
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_attempt"] == 1
        assert "no_promises" in result["guardrail_violations"]
        assert "no_diagnosis" in result["guardrail_violations"]
        assert len(result["guardrail_violations"]) == 2

    @pytest.mark.asyncio
    async def test_third_attempt_blocks_content(self):
        """Third attempt sets blocked_reason for the conditional edge to route to END."""
        rows = [_make_guardrail_row("no_promises", pattern=r"resultado\s+garantido")]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        # Already at attempt 2, this will be the 3rd
        state = _base_state(
            legendas={"instagram": "Resultado garantido em todas sessões!"},
            guardrail_attempt=2,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_attempt"] == 3
        assert "no_promises" in result["guardrail_violations"]
        assert "blocked_reason" in result
        assert "3 tentativas" in result["blocked_reason"]
        assert "no_promises" in result["blocked_reason"]

    @pytest.mark.asyncio
    async def test_db_failure_fails_open(self):
        """If guardrails table is unreachable, node passes through (fail-open)."""
        mock_pool = _make_mock_pool(raise_error=True)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={"instagram": "Resultado garantido!"},
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(
                side_effect=OSError("DB unavailable")
            )

            result = await node(state)

        assert result == {"guardrail_violations": []}

    @pytest.mark.asyncio
    async def test_empty_legendas_no_violation(self):
        """Empty legendas dict results in no violations."""
        rows = [_make_guardrail_row("no_promises", pattern=r"resultado\s+garantido")]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(legendas={})

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_violations"] == []

    @pytest.mark.asyncio
    async def test_violation_in_one_rede_detected(self):
        """Violation in only one rede social is still detected."""
        rows = [_make_guardrail_row("no_promises", keywords=["garante resultado"])]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={
                "instagram": "Conheça nossos serviços!",
                "facebook": "Este tratamento garante resultado!",
            },
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_attempt"] == 1
        assert "no_promises" in result["guardrail_violations"]

    @pytest.mark.asyncio
    async def test_rule_as_json_string(self):
        """Handles rule stored as JSON string (not dict) gracefully."""
        import json

        rule_dict = {
            "pattern": r"cura\s+definitiva",
            "keywords": ["cura definitiva"],
            "action": "regenerate",
            "maxRetries": 3,
        }
        rows = [{"name": "no_cure_claims", "rule": json.dumps(rule_dict)}]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={"instagram": "Oferecemos cura definitiva!"},
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        assert result["guardrail_attempt"] == 1
        assert "no_cure_claims" in result["guardrail_violations"]

    @pytest.mark.asyncio
    async def test_no_duplicate_violation_names(self):
        """Same guardrail violated by multiple redes is recorded only once."""
        rows = [_make_guardrail_row("no_promises", keywords=["garante resultado"])]
        mock_pool = _make_mock_pool(rows)

        node = make_validate_guardrails(mock_pool)
        state = _base_state(
            legendas={
                "instagram": "Garante resultado aqui!",
                "facebook": "Garante resultado lá também!",
                "tiktok": "Garante resultado em vídeo!",
            },
            guardrail_attempt=0,
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_conn = AsyncMock()
            mock_conn.fetch = AsyncMock(return_value=rows)
            mock_conn.execute = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await node(state)

        # Should only appear once despite 3 redes violating
        assert result["guardrail_violations"].count("no_promises") == 1
