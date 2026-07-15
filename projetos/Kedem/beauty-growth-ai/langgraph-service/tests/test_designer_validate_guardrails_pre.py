"""Tests for the Designer Agent validate_guardrails_pre node.

Tests cover:
- Platform guardrails (ANVISA/CFM) detection of prohibited terms
- Tenant custom guardrails loading and validation
- Timeout/error handling for custom guardrails (warning propagation)
- Violation recording format: {regra, trecho (max 200 chars), tentativa}
- guardrail_attempt increment on violations
- Clean pass when no violations found

Requirements: 7.2, 7.6
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    GUARDRAIL_CUSTOM_TIMEOUT_SECONDS,
    PLATFORM_GUARDRAIL_RULES,
    DesignerAgentState,
    _check_prompt_against_guardrail,
    _fetch_tenant_custom_guardrails,
    make_validate_guardrails_pre,
    validate_guardrails_pre,
)


# --- Helper: build minimal state ---


def _make_state(
    visual_prompts: dict[str, str] | None = None,
    guardrail_attempt: int = 0,
    warnings: list[str] | None = None,
    tenant_id: str = "test-tenant-id",
) -> dict:
    """Build a minimal DesignerAgentState dict for testing."""
    return {
        "tenant_id": tenant_id,
        "user_id": "test-user-id",
        "trace_id": "test-trace-id",
        "execution_id": "test-execution-id",
        "request": {"redes_sociais": ["instagram"]},
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
        "guardrail_violations": [],
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


# --- Tests: _check_prompt_against_guardrail ---


class TestCheckPromptAgainstGuardrail:
    """Tests for the _check_prompt_against_guardrail utility function."""

    def test_detects_keyword_match(self):
        """Should detect prohibited keyword in text."""
        rule = {"keywords": ["antes e depois"], "pattern": None}
        result = _check_prompt_against_guardrail(
            "Mostre imagem antes e depois do procedimento", rule
        )
        assert result is not None
        assert "antes e depois" in result.lower()

    def test_detects_regex_pattern_match(self):
        """Should detect prohibited regex pattern."""
        rule = {
            "keywords": [],
            "pattern": r"(?i)\bantes\s+e\s+depois\b",
        }
        result = _check_prompt_against_guardrail(
            "Imagem de antes e depois do tratamento facial", rule
        )
        assert result is not None

    def test_returns_none_when_no_match(self):
        """Should return None when no violation found."""
        rule = {
            "keywords": ["antes e depois"],
            "pattern": r"(?i)\bantes\s+e\s+depois\b",
        }
        result = _check_prompt_against_guardrail(
            "Imagem profissional de procedimento estético", rule
        )
        assert result is None

    def test_keyword_case_insensitive(self):
        """Should detect keywords regardless of case."""
        rule = {"keywords": ["resultado garantido"], "pattern": None}
        result = _check_prompt_against_guardrail(
            "Temos RESULTADO GARANTIDO para você", rule
        )
        assert result is not None

    def test_trecho_max_200_chars(self):
        """Should truncate trecho to max 200 characters."""
        long_text = "A" * 100 + "antes e depois" + "B" * 100
        rule = {"keywords": ["antes e depois"], "pattern": None}
        result = _check_prompt_against_guardrail(long_text, rule)
        assert result is not None
        assert len(result) <= 200

    def test_handles_invalid_regex_gracefully(self):
        """Should handle invalid regex pattern without raising."""
        rule = {"keywords": [], "pattern": r"(?P<invalid"}
        result = _check_prompt_against_guardrail("Some text", rule)
        assert result is None

    def test_empty_text_returns_none(self):
        """Should return None for empty text."""
        rule = {"keywords": ["promoção"], "pattern": None}
        result = _check_prompt_against_guardrail("", rule)
        assert result is None


# --- Tests: Platform guardrails structure ---


class TestPlatformGuardrailRules:
    """Tests for the PLATFORM_GUARDRAIL_RULES constant."""

    def test_has_at_least_5_rules(self):
        """Platform should have comprehensive ANVISA/CFM rules."""
        assert len(PLATFORM_GUARDRAIL_RULES) >= 5

    def test_each_rule_has_required_fields(self):
        """Each rule must have name, keywords, and pattern."""
        for rule in PLATFORM_GUARDRAIL_RULES:
            assert "name" in rule, f"Rule missing 'name': {rule}"
            assert "keywords" in rule, f"Rule missing 'keywords': {rule}"
            assert "pattern" in rule, f"Rule missing 'pattern': {rule}"

    def test_covers_antes_e_depois(self):
        """Platform rules must cover 'antes e depois' prohibition."""
        names = [r["name"] for r in PLATFORM_GUARDRAIL_RULES]
        assert any("antes e depois" in n.lower() for n in names)

    def test_covers_resultado_garantido(self):
        """Platform rules must cover 'resultado garantido' prohibition."""
        all_keywords = []
        for rule in PLATFORM_GUARDRAIL_RULES:
            all_keywords.extend(rule.get("keywords", []))
        assert any("resultado garantido" in k.lower() for k in all_keywords)

    def test_covers_cura(self):
        """Platform rules must cover 'cura' prohibition."""
        all_keywords = []
        for rule in PLATFORM_GUARDRAIL_RULES:
            all_keywords.extend(rule.get("keywords", []))
        assert any("cura" in k.lower() for k in all_keywords)

    def test_covers_preco_promocao_desconto(self):
        """Platform rules must cover pricing/discount prohibitions."""
        all_keywords = []
        for rule in PLATFORM_GUARDRAIL_RULES:
            all_keywords.extend(rule.get("keywords", []))
        keywords_lower = [k.lower() for k in all_keywords]
        assert "preço" in keywords_lower
        assert "promoção" in keywords_lower
        assert "desconto" in keywords_lower

    def test_timeout_is_10_seconds(self):
        """Custom guardrails timeout must be 10 seconds."""
        assert GUARDRAIL_CUSTOM_TIMEOUT_SECONDS == 10


# --- Tests: validate_guardrails_pre stub ---


class TestValidateGuardrailsPreStub:
    """Tests for the standalone stub (no pg_pool)."""

    @pytest.mark.asyncio
    async def test_stub_returns_empty_dict(self):
        """Stub should return empty dict for graph testing."""
        state = _make_state()
        result = await validate_guardrails_pre(state)
        assert result == {}


# --- Tests: make_validate_guardrails_pre factory ---


class TestMakeValidateGuardrailsPre:
    """Tests for the factory-produced validate_guardrails_pre node."""

    @pytest.fixture
    def mock_pool(self):
        """Create a mock asyncpg pool."""
        return MagicMock()

    @pytest.mark.asyncio
    async def test_no_violations_returns_empty_list(self, mock_pool):
        """Should return empty violations list for clean prompt."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Imagem profissional de um salão de beleza moderno"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        assert result["guardrail_violations"] == []

    @pytest.mark.asyncio
    async def test_detects_platform_violation(self, mock_pool):
        """Should detect 'antes e depois' as a platform guardrail violation."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Mostre antes e depois do procedimento facial"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        assert len(violations) > 0
        assert result["guardrail_attempt"] == 1

    @pytest.mark.asyncio
    async def test_violation_has_correct_structure(self, mock_pool):
        """Violations should have {regra, trecho, tentativa} format."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Resultado garantido para harmonização"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        assert len(violations) > 0
        violation = violations[0]
        assert "regra" in violation
        assert "trecho" in violation
        assert "tentativa" in violation
        assert violation["tentativa"] == 1

    @pytest.mark.asyncio
    async def test_trecho_max_200_chars(self, mock_pool):
        """Violation trecho should be max 200 chars."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        long_prompt = "X" * 200 + "resultado garantido" + "Y" * 200
        state = _make_state(visual_prompts={"instagram": long_prompt})

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        assert len(violations) > 0
        for v in violations:
            assert len(v["trecho"]) <= 200

    @pytest.mark.asyncio
    async def test_increments_guardrail_attempt(self, mock_pool):
        """Should increment guardrail_attempt when violations found."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={"instagram": "Temos promoção de botox"},
            guardrail_attempt=1,
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        assert result["guardrail_attempt"] == 2

    @pytest.mark.asyncio
    async def test_custom_guardrails_timeout_adds_warning(self, mock_pool):
        """Should add warning when custom guardrails timeout."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Imagem profissional de salão moderno"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            side_effect=asyncio.TimeoutError(),
        ):
            result = await node(state)

        assert "warnings" in result
        assert any(
            "guardrails personalizados não foram aplicados" in w
            for w in result["warnings"]
        )

    @pytest.mark.asyncio
    async def test_custom_guardrails_error_adds_warning(self, mock_pool):
        """Should add warning when custom guardrails fail to load."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Imagem elegante de clínica de estética"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            side_effect=Exception("Connection refused"),
        ):
            result = await node(state)

        assert "warnings" in result
        assert any(
            "guardrails personalizados não foram aplicados" in w
            for w in result["warnings"]
        )

    @pytest.mark.asyncio
    async def test_custom_guardrails_applied_when_available(self, mock_pool):
        """Should apply tenant custom guardrails when loaded successfully."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        custom_rules = [
            {
                "name": "Regra do Tenant - Termo proibido",
                "keywords": ["termo especial proibido"],
                "pattern": None,
            }
        ]

        state = _make_state(
            visual_prompts={
                "instagram": "Usamos termo especial proibido nesta imagem"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=custom_rules,
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        assert len(violations) > 0
        assert any(
            "Regra do Tenant" in v["regra"] for v in violations
        )

    @pytest.mark.asyncio
    async def test_scans_all_visual_prompts(self, mock_pool):
        """Should scan prompts for all social networks."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Imagem limpa sem problemas",
                "facebook": "Resultado garantido neste tratamento",
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        assert len(violations) > 0

    @pytest.mark.asyncio
    async def test_does_not_duplicate_warning(self, mock_pool):
        """Should not duplicate warning if already present in state."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={"instagram": "Imagem profissional de clínica"},
            warnings=["guardrails personalizados não foram aplicados"],
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            side_effect=asyncio.TimeoutError(),
        ):
            result = await node(state)

        warning_count = sum(
            1
            for w in result["warnings"]
            if "guardrails personalizados não foram aplicados" in w
        )
        assert warning_count == 1

    @pytest.mark.asyncio
    async def test_empty_visual_prompts_passes(self, mock_pool):
        """Should pass validation when visual_prompts is empty."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(visual_prompts={})

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        assert result["guardrail_violations"] == []

    @pytest.mark.asyncio
    async def test_detects_multiple_violations_in_single_prompt(self, mock_pool):
        """Should detect multiple different violations in a single prompt."""
        node = make_validate_guardrails_pre(pg_pool=mock_pool)

        state = _make_state(
            visual_prompts={
                "instagram": "Promoção com resultado garantido e cura total"
            }
        )

        with patch(
            "src.workflows.designer_agent._fetch_tenant_custom_guardrails",
            new_callable=AsyncMock,
            return_value=[],
        ):
            result = await node(state)

        violations = result["guardrail_violations"]
        # Should detect at least promoção + resultado garantido + cura
        rule_names = [v["regra"] for v in violations]
        assert len(set(rule_names)) >= 2  # At least 2 different rules violated
