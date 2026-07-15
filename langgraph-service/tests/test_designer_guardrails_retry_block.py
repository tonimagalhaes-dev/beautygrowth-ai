"""Tests for Designer Agent validate_guardrails_pre retry/block logic (task 5.2).

Tests cover:
- Retry behavior: when violations detected and attempt < 3, violating terms are removed
  from prompts and state is set for conditional edge to route back to build_visual_prompt.
- Block behavior: when violations detected and attempt >= 3, execution is blocked with
  422 error JSON in output field.
- Violation logging: execution_id, trace_id, regra, tentativa, trecho (max 200 chars).
- Violation accumulation: violations across retries are appended, not replaced.
- _remove_violating_terms_from_prompts helper function.
- Conditional edge routing (should_rebuild_or_generate).

Requirements: 7.3, 7.4, 7.5
"""

from __future__ import annotations

import asyncio
import json
from typing import Dict, List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    DesignerAgentState,
    PLATFORM_GUARDRAIL_RULES,
    _check_prompt_against_guardrail,
    _remove_violating_terms_from_prompts,
    make_validate_guardrails_pre,
    should_rebuild_or_generate,
    validate_guardrails_pre,
)


# --- Helpers ---


def _base_state(
    visual_prompts: Optional[Dict[str, str]] = None,
    guardrail_attempt: int = 0,
    guardrail_violations: Optional[List] = None,
    execution_id: str = "exec-123",
    trace_id: str = "trace-456",
    tenant_id: str = "tenant-789",
    warnings: Optional[List] = None,
) -> DesignerAgentState:
    """Create a minimal DesignerAgentState for testing."""
    return {
        "tenant_id": tenant_id,
        "user_id": "user-001",
        "trace_id": trace_id,
        "execution_id": execution_id,
        "request": {"redes_sociais": ["instagram"], "descricao_visual": "test"},
        "is_edit": False,
        "original_execution_id": None,
        "edit_instruction": None,
        "target_social": None,
        "version": 1,
        "brand_identity": {},
        "brand_identity_defaults_used": False,
        "clinic_logo_url": None,
        "content_agent_data": None,
        "knowledge_chunks": [],
        "edit_history": [],
        "visual_prompts": visual_prompts or {},
        "negative_prompts": [],
        "guardrail_attempt": guardrail_attempt,
        "guardrail_violations": guardrail_violations or [],
        "generated_images": {},
        "generation_errors": {},
        "model_id": "",
        "used_fallback": False,
        "processed_images": {},
        "logo_overlay_applied": False,
        "logo_overlay_warnings": [],
        "image_urls": {},
        "image_metadata": [],
        "steps": [],
        "tokens_consumed": 0,
        "duration_ms": 0,
        "warnings": warnings or [],
        "output": "",
    }


def _make_mock_pool(tenant_rows=None, raise_error=False, raise_timeout=False):
    """Create a mock asyncpg pool that returns tenant custom guardrails."""
    mock_pool = MagicMock()
    mock_conn = AsyncMock()

    if raise_timeout:

        async def _slow_fetch(*args, **kwargs):
            await asyncio.sleep(20)
            return []

        mock_conn.fetch = _slow_fetch
    elif raise_error:
        mock_conn.fetch = AsyncMock(side_effect=Exception("DB error"))
    else:
        mock_conn.fetch = AsyncMock(return_value=tenant_rows or [])

    mock_conn.execute = AsyncMock()

    # Mock the tenant_connection context manager
    mock_pool.acquire = MagicMock()
    mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
    mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)

    return mock_pool


# --- Tests for _remove_violating_terms_from_prompts ---


class TestRemoveViolatingTermsFromPrompts:
    """Tests for the helper that removes violating terms from prompts."""

    def test_removes_keyword_matches(self):
        """Should remove keyword matches from prompts."""
        prompts = {
            "instagram": "Resultado garantido para seu tratamento facial",
        }
        violations = [{"regra": "ANVISA/CFM - Resultado garantido", "trecho": "Resultado garantido", "tentativa": 1}]
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert "resultado garantido" not in result["instagram"].lower()

    def test_removes_pattern_matches(self):
        """Should remove regex pattern matches from prompts."""
        prompts = {
            "instagram": "Venha conferir o antes e depois do procedimento",
        }
        violations = [{"regra": "ANVISA/CFM - Comparação antes e depois", "trecho": "antes e depois", "tentativa": 1}]
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert "antes e depois" not in result["instagram"].lower()

    def test_preserves_non_violating_content(self):
        """Should preserve prompt content that doesn't violate any rules."""
        prompts = {
            "instagram": "Tratamento facial de qualidade com resultado garantido",
        }
        violations = [{"regra": "ANVISA/CFM - Resultado garantido", "trecho": "resultado garantido", "tentativa": 1}]
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert "tratamento facial" in result["instagram"].lower()
        assert "qualidade" in result["instagram"].lower()

    def test_handles_multiple_violations(self):
        """Should remove terms from multiple violated rules."""
        prompts = {
            "instagram": "Resultado garantido! Antes e depois de tratamento milagroso!",
        }
        violations = [
            {"regra": "ANVISA/CFM - Resultado garantido", "trecho": "Resultado garantido", "tentativa": 1},
            {"regra": "ANVISA/CFM - Comparação antes e depois", "trecho": "Antes e depois", "tentativa": 1},
            {"regra": "ANVISA/CFM - Alegações médicas não autorizadas", "trecho": "tratamento milagroso", "tentativa": 1},
        ]
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert "resultado garantido" not in result["instagram"].lower()
        assert "antes e depois" not in result["instagram"].lower()
        assert "tratamento milagroso" not in result["instagram"].lower()

    def test_handles_multiple_social_networks(self):
        """Should clean prompts for all social networks."""
        prompts = {
            "instagram": "Resultado garantido no Instagram",
            "facebook": "Resultado garantido no Facebook",
        }
        violations = [{"regra": "ANVISA/CFM - Resultado garantido", "trecho": "Resultado garantido", "tentativa": 1}]
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert "resultado garantido" not in result["instagram"].lower()
        assert "resultado garantido" not in result["facebook"].lower()

    def test_handles_empty_violations(self):
        """Should return prompts unchanged when no violations."""
        prompts = {"instagram": "Belo tratamento facial profissional"}
        violations = []
        all_rules = PLATFORM_GUARDRAIL_RULES

        result = _remove_violating_terms_from_prompts(prompts, violations, all_rules)

        assert result["instagram"] == prompts["instagram"]


# --- Tests for conditional edge (should_rebuild_or_generate) ---


class TestShouldRebuildOrGenerate:
    """Tests for the conditional edge routing function."""

    def test_no_violations_routes_to_generate(self):
        """No violations → route to generate_images."""
        state = _base_state(guardrail_violations=[])
        assert should_rebuild_or_generate(state) == "generate_images"

    def test_violations_attempt_0_routes_to_rebuild(self):
        """Violations with attempt=0 → route to build_visual_prompt."""
        state = _base_state(
            guardrail_violations=[{"regra": "test", "trecho": "x", "tentativa": 1}],
            guardrail_attempt=0,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_violations_attempt_1_routes_to_rebuild(self):
        """Violations with attempt=1 → route to build_visual_prompt."""
        state = _base_state(
            guardrail_violations=[{"regra": "test", "trecho": "x", "tentativa": 2}],
            guardrail_attempt=1,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_violations_attempt_2_routes_to_rebuild(self):
        """Violations with attempt=2 → route to build_visual_prompt."""
        state = _base_state(
            guardrail_violations=[{"regra": "test", "trecho": "x", "tentativa": 3}],
            guardrail_attempt=2,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_violations_attempt_3_routes_to_end(self):
        """Violations with attempt=3 → route to __end__ (blocked)."""
        state = _base_state(
            guardrail_violations=[{"regra": "test", "trecho": "x", "tentativa": 3}],
            guardrail_attempt=3,
        )
        assert should_rebuild_or_generate(state) == "__end__"

    def test_violations_attempt_greater_than_3_routes_to_end(self):
        """Violations with attempt > 3 → route to __end__."""
        state = _base_state(
            guardrail_violations=[{"regra": "test", "trecho": "x", "tentativa": 4}],
            guardrail_attempt=4,
        )
        assert should_rebuild_or_generate(state) == "__end__"

    def test_none_violations_routes_to_generate(self):
        """None violations (not set) → route to generate_images."""
        state = _base_state()
        state["guardrail_violations"] = None  # type: ignore
        assert should_rebuild_or_generate(state) == "generate_images"


# --- Tests for make_validate_guardrails_pre (retry/block logic) ---


class TestMakeValidateGuardrailsPreRetryBlock:
    """Tests for the full retry/block behavior of make_validate_guardrails_pre."""

    @pytest.mark.asyncio
    async def test_no_violations_clears_state(self):
        """When no violations found, guardrail_violations should be cleared."""
        mock_pool = _make_mock_pool(tenant_rows=[])

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            node = make_validate_guardrails_pre(mock_pool)
            state = _base_state(
                visual_prompts={"instagram": "Belo tratamento facial profissional"}
            )
            result = await node(state)

        assert result["guardrail_violations"] == []

    @pytest.mark.asyncio
    async def test_violation_attempt_0_increments_and_cleans(self):
        """First violation (attempt 0→1): increments attempt, cleans prompts, accumulates."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)
            state = _base_state(
                visual_prompts={
                    "instagram": "Venha conferir nosso resultado garantido!"
                },
                guardrail_attempt=0,
                guardrail_violations=[],
            )

            result = await node(state)

        # Should increment attempt to 1
        assert result["guardrail_attempt"] == 1
        # Should have violations recorded
        assert len(result["guardrail_violations"]) > 0
        # Should have cleaned prompts (violating terms removed)
        assert "visual_prompts" in result
        assert "resultado garantido" not in result["visual_prompts"]["instagram"].lower()

    @pytest.mark.asyncio
    async def test_violation_attempt_1_continues_retry(self):
        """Second violation (attempt 1→2): continues retry logic."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            # Simulate second attempt with existing violations from first attempt
            existing_violations = [
                {"regra": "ANVISA/CFM - Resultado garantido", "trecho": "resultado garantido", "tentativa": 1}
            ]
            state = _base_state(
                visual_prompts={
                    "instagram": "Tratamento com resultado garantido!"
                },
                guardrail_attempt=1,
                guardrail_violations=existing_violations,
            )

            result = await node(state)

        # Should increment attempt to 2
        assert result["guardrail_attempt"] == 2
        # Should accumulate violations (old + new)
        assert len(result["guardrail_violations"]) > len(existing_violations)
        # Should still have cleaned prompts
        assert "visual_prompts" in result

    @pytest.mark.asyncio
    async def test_violation_attempt_2_blocks_with_422(self):
        """Third violation (attempt 2→3): blocks execution with 422 output."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            existing_violations = [
                {"regra": "ANVISA/CFM - Resultado garantido", "trecho": "resultado garantido", "tentativa": 1},
                {"regra": "ANVISA/CFM - Resultado garantido", "trecho": "resultado garantido", "tentativa": 2},
            ]
            state = _base_state(
                visual_prompts={
                    "instagram": "Venha para resultado garantido!"
                },
                guardrail_attempt=2,
                guardrail_violations=existing_violations,
                execution_id="exec-blocked-123",
                trace_id="trace-blocked-456",
            )

            result = await node(state)

        # Should set attempt to 3
        assert result["guardrail_attempt"] == 3
        # Should have accumulated all violations
        assert len(result["guardrail_violations"]) > len(existing_violations)
        # Should have output with 422 error JSON
        assert "output" in result
        output_data = json.loads(result["output"])
        assert output_data["error"] == "guardrail_blocked"
        assert output_data["status_code"] == 422
        assert "não pode ser gerada em conformidade" in output_data["message"]
        assert output_data["details"]["execution_id"] == "exec-blocked-123"
        assert output_data["details"]["trace_id"] == "trace-blocked-456"
        assert output_data["details"]["attempts"] == 3
        assert len(output_data["details"]["violated_rules"]) > 0
        # Should NOT have visual_prompts in result (blocked, not retrying)
        assert "visual_prompts" not in result

    @pytest.mark.asyncio
    async def test_violations_accumulate_across_retries(self):
        """Violations from different attempts should all be accumulated."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            # Previous violations from attempt 1
            previous_violations = [
                {"regra": "ANVISA/CFM - Comparação antes e depois", "trecho": "antes e depois", "tentativa": 1},
            ]

            state = _base_state(
                visual_prompts={
                    "instagram": "Oferecemos resultado garantido para o tratamento!"
                },
                guardrail_attempt=1,
                guardrail_violations=previous_violations,
            )

            result = await node(state)

        # Should accumulate: previous + new
        all_violations = result["guardrail_violations"]
        # Previous attempt 1 violation should still be there
        attempt_1_violations = [v for v in all_violations if v["tentativa"] == 1]
        assert len(attempt_1_violations) >= 1
        # New attempt 2 violations should be added
        attempt_2_violations = [v for v in all_violations if v["tentativa"] == 2]
        assert len(attempt_2_violations) >= 1

    @pytest.mark.asyncio
    async def test_violation_snippet_max_200_chars(self):
        """Violation trecho should be truncated to max 200 characters."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            # Create a prompt with a very long violating phrase
            long_prefix = "a" * 300
            state = _base_state(
                visual_prompts={
                    "instagram": f"{long_prefix} resultado garantido {long_prefix}"
                },
                guardrail_attempt=0,
            )

            result = await node(state)

        # Check that all trechos are <= 200 chars
        for violation in result["guardrail_violations"]:
            assert len(violation["trecho"]) <= 200

    @pytest.mark.asyncio
    async def test_violation_records_correct_fields(self):
        """Each violation record should have regra, trecho, tentativa, rede_social."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            state = _base_state(
                visual_prompts={
                    "instagram": "Resultado garantido para nossos clientes!"
                },
                guardrail_attempt=0,
            )

            result = await node(state)

        assert len(result["guardrail_violations"]) > 0
        violation = result["guardrail_violations"][0]
        assert "regra" in violation
        assert "trecho" in violation
        assert "tentativa" in violation
        assert "rede_social" in violation
        assert violation["tentativa"] == 1
        assert violation["rede_social"] == "instagram"

    @pytest.mark.asyncio
    async def test_custom_guardrails_timeout_adds_warning(self):
        """When custom guardrails timeout, warning should be added."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(side_effect=asyncio.TimeoutError()),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            state = _base_state(
                visual_prompts={"instagram": "Tratamento facial seguro e profissional"},
            )

            result = await node(state)

        # Should pass (no platform violations in the prompt)
        assert result["guardrail_violations"] == []
        # Should have warning about custom guardrails
        assert "warnings" in result
        assert any(
            "guardrails personalizados" in w for w in result["warnings"]
        )

    @pytest.mark.asyncio
    async def test_blocked_output_json_structure(self):
        """Blocked output should have correct JSON structure for 422 response."""
        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=lambda: lambda: AsyncMock(return_value=[]),
        ):
            mock_pool = _make_mock_pool(tenant_rows=[])
            node = make_validate_guardrails_pre(mock_pool)

            state = _base_state(
                visual_prompts={"instagram": "Promoção resultado garantido!"},
                guardrail_attempt=2,
                guardrail_violations=[
                    {"regra": "r1", "trecho": "t1", "tentativa": 1},
                    {"regra": "r2", "trecho": "t2", "tentativa": 2},
                ],
                execution_id="exec-abc",
                trace_id="trace-def",
            )

            result = await node(state)

        output = json.loads(result["output"])
        assert output["error"] == "guardrail_blocked"
        assert output["status_code"] == 422
        assert isinstance(output["message"], str)
        assert isinstance(output["details"], dict)
        assert output["details"]["execution_id"] == "exec-abc"
        assert output["details"]["trace_id"] == "trace-def"
        assert isinstance(output["details"]["violated_rules"], list)
        assert isinstance(output["details"]["attempts"], int)
        assert output["details"]["attempts"] == 3


# --- Tests for _check_prompt_against_guardrail ---


class TestCheckPromptAgainstGuardrail:
    """Tests for the guardrail rule matching helper."""

    def test_keyword_match_returns_snippet(self):
        """Keyword match should return the violating snippet."""
        rule = {
            "name": "test_rule",
            "keywords": ["resultado garantido"],
            "pattern": None,
        }
        result = _check_prompt_against_guardrail(
            "Venha para nosso resultado garantido!",
            rule,
        )
        assert result is not None
        assert "resultado garantido" in result.lower()

    def test_pattern_match_returns_snippet(self):
        """Regex pattern match should return the violating snippet."""
        rule = {
            "name": "test_rule",
            "keywords": [],
            "pattern": r"(?i)\bantes\s+e\s+depois\b",
        }
        result = _check_prompt_against_guardrail(
            "Confira o antes e depois do procedimento.",
            rule,
        )
        assert result is not None
        assert "antes" in result.lower()

    def test_no_match_returns_none(self):
        """No match should return None."""
        rule = {
            "name": "test_rule",
            "keywords": ["resultado garantido"],
            "pattern": r"(?i)\bantes\s+e\s+depois\b",
        }
        result = _check_prompt_against_guardrail(
            "Tratamento facial de qualidade profissional.",
            rule,
        )
        assert result is None

    def test_snippet_max_200_chars(self):
        """Returned snippet should never exceed 200 characters."""
        long_text = "x" * 500 + " resultado garantido " + "y" * 500
        rule = {
            "name": "test_rule",
            "keywords": ["resultado garantido"],
            "pattern": None,
        }
        result = _check_prompt_against_guardrail(long_text, rule)
        assert result is not None
        assert len(result) <= 200

    def test_invalid_regex_returns_none(self):
        """Invalid regex should not crash and should return None."""
        rule = {
            "name": "test_rule",
            "keywords": [],
            "pattern": r"[invalid(regex",
        }
        result = _check_prompt_against_guardrail("some text here", rule)
        assert result is None
