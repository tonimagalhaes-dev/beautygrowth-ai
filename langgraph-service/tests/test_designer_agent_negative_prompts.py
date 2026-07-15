"""Tests for the Designer Agent negative prompts generation (task 4.2).

Tests cover:
- _generate_negative_prompts() returns correct number of negative prompts
- All 5 regulatory categories are addressed (ANVISA/CFM compliance)
- Negative prompts are in Portuguese
- build_visual_prompt node stores negative_prompts in state
- Negative prompts contain required prohibition keywords
"""

import pytest

from src.workflows.designer_agent import (
    DesignerAgentState,
    _generate_negative_prompts,
    build_visual_prompt,
)


# --- Tests for _generate_negative_prompts ---


class TestGenerateNegativePrompts:
    """Tests for the _generate_negative_prompts() function."""

    def test_returns_list_of_strings(self):
        """Negative prompts should be returned as a list of strings."""
        result = _generate_negative_prompts()
        assert isinstance(result, list)
        assert all(isinstance(item, str) for item in result)

    def test_returns_exactly_five_prompts(self):
        """Should return exactly 5 negative prompts (one per regulatory category)."""
        result = _generate_negative_prompts()
        assert len(result) == 5

    def test_contains_before_after_prohibition(self):
        """Must prohibit before/after comparison images of procedures."""
        result = _generate_negative_prompts()
        before_after_prompt = next(
            (p for p in result if "antes" in p.lower() and "depois" in p.lower()),
            None,
        )
        assert before_after_prompt is not None, (
            "Missing negative prompt for before/after procedure images"
        )

    def test_contains_unidentified_professionals_prohibition(self):
        """Must prohibit unidentified health professionals."""
        result = _generate_negative_prompts()
        professionals_prompt = next(
            (p for p in result if "profissionais" in p.lower() and "identificad" in p.lower()),
            None,
        )
        assert professionals_prompt is not None, (
            "Missing negative prompt for unidentified health professionals"
        )

    def test_contains_nudity_prohibition(self):
        """Must prohibit explicit nudity."""
        result = _generate_negative_prompts()
        nudity_prompt = next(
            (p for p in result if "nudez" in p.lower()),
            None,
        )
        assert nudity_prompt is not None, (
            "Missing negative prompt for explicit nudity"
        )

    def test_contains_irregular_advertising_prohibition(self):
        """Must prohibit irregular advertising of health services."""
        result = _generate_negative_prompts()
        advertising_prompt = next(
            (p for p in result if "propaganda irregular" in p.lower()),
            None,
        )
        assert advertising_prompt is not None, (
            "Missing negative prompt for irregular health advertising"
        )

    def test_contains_third_party_brands_prohibition(self):
        """Must prohibit unauthorized third-party brand logos/trademarks."""
        result = _generate_negative_prompts()
        brands_prompt = next(
            (p for p in result if "marcas" in p.lower() or "logotipos" in p.lower()),
            None,
        )
        assert brands_prompt is not None, (
            "Missing negative prompt for unauthorized third-party brands"
        )

    def test_prompts_are_in_portuguese(self):
        """All negative prompts should be in Portuguese (contain 'NÃO')."""
        result = _generate_negative_prompts()
        for prompt in result:
            assert "NÃO" in prompt, (
                f"Prompt does not start with Portuguese negation 'NÃO': {prompt[:50]}"
            )

    def test_prompts_are_non_empty(self):
        """Each negative prompt should contain meaningful content (> 20 chars)."""
        result = _generate_negative_prompts()
        for prompt in result:
            assert len(prompt) > 20, (
                f"Negative prompt too short: {prompt}"
            )

    def test_returns_consistent_results(self):
        """Multiple calls should return the same set of prompts (deterministic)."""
        result1 = _generate_negative_prompts()
        result2 = _generate_negative_prompts()
        assert result1 == result2


# --- Tests for build_visual_prompt node (negative prompts integration) ---


class TestBuildVisualPromptNegativePrompts:
    """Tests for the build_visual_prompt node's negative prompts integration."""

    def _make_state(self) -> dict:
        """Build a minimal state for testing build_visual_prompt."""
        return {
            "tenant_id": "tenant-123",
            "user_id": "user-456",
            "trace_id": "trace-789",
            "execution_id": "exec-001",
            "request": {
                "descricao_visual": "Uma imagem elegante de clínica",
                "redes_sociais": ["instagram"],
                "aplicar_logo_overlay": False,
            },
            "is_edit": False,
            "original_execution_id": None,
            "edit_instruction": None,
            "target_social": None,
            "version": 1,
            "brand_identity": {
                "paleta_cores": ["#FFFFFF", "#9E9E9E", "#D4AF37"],
                "estilo_visual": "minimalista",
                "valores": "elegância, sofisticação",
                "elementos_recorrentes": "flores, linhas suaves",
                "nome_clinica": "Clínica Bela",
            },
            "brand_identity_defaults_used": False,
            "clinic_logo_url": None,
            "content_agent_data": None,
            "knowledge_chunks": [],
            "edit_history": [],
            "visual_prompts": {},
            "negative_prompts": [],
            "guardrail_attempt": 0,
            "guardrail_violations": [],
            "warnings": [],
            "steps": [],
        }

    @pytest.mark.asyncio
    async def test_build_visual_prompt_returns_negative_prompts(self):
        """build_visual_prompt should return negative_prompts in its output."""
        state = self._make_state()
        result = await build_visual_prompt(state)

        assert "negative_prompts" in result
        assert isinstance(result["negative_prompts"], list)
        assert len(result["negative_prompts"]) == 5

    @pytest.mark.asyncio
    async def test_build_visual_prompt_negative_prompts_are_strings(self):
        """All negative prompts returned by build_visual_prompt should be strings."""
        state = self._make_state()
        result = await build_visual_prompt(state)

        for prompt in result["negative_prompts"]:
            assert isinstance(prompt, str)
            assert len(prompt) > 0

    @pytest.mark.asyncio
    async def test_build_visual_prompt_negative_prompts_cover_all_categories(self):
        """Negative prompts from build_visual_prompt should cover all 5 regulatory categories."""
        state = self._make_state()
        result = await build_visual_prompt(state)
        prompts = result["negative_prompts"]

        # Combine all prompts into a single text for category verification
        combined = " ".join(prompts).lower()

        assert "antes" in combined and "depois" in combined, "Missing before/after prohibition"
        assert "profissionais" in combined, "Missing unidentified professionals prohibition"
        assert "nudez" in combined, "Missing nudity prohibition"
        assert "propaganda irregular" in combined, "Missing irregular advertising prohibition"
        assert "marcas" in combined or "logotipos" in combined, "Missing third-party brands prohibition"
