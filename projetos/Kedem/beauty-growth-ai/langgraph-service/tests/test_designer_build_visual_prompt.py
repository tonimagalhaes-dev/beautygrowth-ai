"""Tests for the Designer Agent build_visual_prompt node implementation.

Tests cover:
- Resolving template from Prompt Registry (agent_type='designer')
- Substitution of template variables (descricao_visual, paleta_cores, etc.)
- Aspect ratio mapping per social network
- Appending estilo_visual_adicional when provided
- Incorporating Content Agent visual suggestion per network
- Incorporating cumulative edit history + new edit instruction
- Fallback to default template when Prompt Registry has no designer template
- _substitute_designer_template_variables helper
- _fetch_designer_template helper

Requirements tested: 2.2, 2.3, 2.5, 6.3
"""

import asyncio
from contextlib import asynccontextmanager
from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    ASPECT_RATIO_MAP,
    DEFAULT_DESIGNER_PROMPT_TEMPLATE,
    DesignerAgentState,
    _fetch_designer_template,
    _substitute_designer_template_variables,
    build_visual_prompt,
    make_build_visual_prompt,
)


# --- Helpers ---


def _make_state(
    tenant_id: str = "tenant-123",
    user_id: str = "user-456",
    trace_id: str = "trace-789",
    execution_id: str = "exec-001",
    descricao_visual: str = "Uma imagem elegante de procedimento facial",
    redes_sociais: Optional[list] = None,
    estilo_visual_adicional: Optional[str] = None,
    content_execution_id: Optional[str] = None,
    aplicar_logo_overlay: bool = False,
    brand_identity: Optional[dict] = None,
    content_agent_data: Optional[dict] = None,
    is_edit: bool = False,
    edit_instruction: Optional[str] = None,
    edit_history: Optional[list] = None,
) -> dict:
    """Build a state dict for testing build_visual_prompt."""
    if redes_sociais is None:
        redes_sociais = ["instagram"]

    if brand_identity is None:
        brand_identity = {
            "paleta_cores": ["#FF5733", "#C70039", "#FFC300"],
            "estilo_visual": "moderno e clean",
            "valores": ["Excelência", "Cuidado"],
            "elementos_recorrentes": ["folhas", "linhas suaves"],
            "nome_clinica": "Clínica Bela Vida",
        }

    return {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "trace_id": trace_id,
        "execution_id": execution_id,
        "request": {
            "descricao_visual": descricao_visual,
            "redes_sociais": redes_sociais,
            "estilo_visual_adicional": estilo_visual_adicional,
            "content_execution_id": content_execution_id,
            "aplicar_logo_overlay": aplicar_logo_overlay,
        },
        "is_edit": is_edit,
        "original_execution_id": None,
        "edit_instruction": edit_instruction,
        "target_social": None,
        "version": 1,
        "brand_identity": brand_identity,
        "brand_identity_defaults_used": False,
        "clinic_logo_url": None,
        "content_agent_data": content_agent_data,
        "knowledge_chunks": [],
        "edit_history": edit_history or [],
        "warnings": [],
        "steps": [],
    }


# --- Fake asyncpg fixtures ---


class FakeRow(dict):
    """Dict-like object supporting row['key'] access."""

    def __getitem__(self, key):
        return dict.__getitem__(self, key)


class FakeConnection:
    """Simulates an asyncpg.Connection for testing."""

    def __init__(self, rows: list[dict]):
        self._rows = rows

    async def fetch(self, query: str, *args):
        return [FakeRow(r) for r in self._rows]

    async def execute(self, query: str, *args):
        pass

    def transaction(self):
        return FakeTransaction()


class FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


class FakePool:
    """Simulates an asyncpg.Pool for testing."""

    def __init__(self, rows: list[dict]):
        self._conn = FakeConnection(rows)

    def acquire(self):
        return FakeAcquire(self._conn)


class FakeAcquire:
    """Simulates pool.acquire() context manager."""

    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *args):
        pass


# --- Tests for _substitute_designer_template_variables ---


class TestSubstituteDesignerTemplateVariables:
    """Tests for the template variable substitution helper."""

    def test_substitutes_known_variables(self):
        template = "Gere uma imagem para {{nome_clinica}} com cores {{paleta_cores}}"
        variables = {"nome_clinica": "Clínica Bela", "paleta_cores": "#FF0000, #00FF00"}
        result = _substitute_designer_template_variables(template, variables)
        assert result == "Gere uma imagem para Clínica Bela com cores #FF0000, #00FF00"

    def test_preserves_unknown_variables(self):
        template = "{{descricao_visual}} com {{unknown_var}}"
        variables = {"descricao_visual": "Uma imagem elegante"}
        result = _substitute_designer_template_variables(template, variables)
        assert "Uma imagem elegante" in result
        assert "{{unknown_var}}" in result

    def test_handles_whitespace_in_variable_names(self):
        template = "Estilo: {{ estilo_visual }}"
        variables = {"estilo_visual": "minimalista"}
        result = _substitute_designer_template_variables(template, variables)
        assert result == "Estilo: minimalista"

    def test_handles_empty_template(self):
        result = _substitute_designer_template_variables("", {"var": "value"})
        assert result == ""

    def test_handles_no_variables_in_template(self):
        template = "Texto sem variáveis"
        result = _substitute_designer_template_variables(template, {"var": "value"})
        assert result == "Texto sem variáveis"

    def test_handles_empty_variable_value(self):
        template = "Clinica: {{nome_clinica}}"
        variables = {"nome_clinica": ""}
        result = _substitute_designer_template_variables(template, variables)
        assert result == "Clinica: "


# --- Tests for _fetch_designer_template ---


class TestFetchDesignerTemplate:
    """Tests for fetching the designer template from Prompt Registry."""

    @pytest.mark.asyncio
    async def test_returns_task_template_when_found(self):
        """Should return the 'task' function template from registry."""
        rows = [
            {"function": "system", "content": "System prompt content"},
            {"function": "task", "content": "Custom designer task template: {{descricao_visual}}"},
        ]
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            result = await _fetch_designer_template(pool, "tenant-123")

        assert result == "Custom designer task template: {{descricao_visual}}"

    @pytest.mark.asyncio
    async def test_returns_first_available_if_no_task_function(self):
        """Should fall back to any available template if no 'task' function."""
        rows = [
            {"function": "system", "content": "Fallback system prompt"},
        ]
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            result = await _fetch_designer_template(pool, "tenant-123")

        assert result == "Fallback system prompt"

    @pytest.mark.asyncio
    async def test_returns_default_when_no_rows(self):
        """Should return DEFAULT_DESIGNER_PROMPT_TEMPLATE when registry is empty."""
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            result = await _fetch_designer_template(pool, "tenant-123")

        assert result == DEFAULT_DESIGNER_PROMPT_TEMPLATE

    @pytest.mark.asyncio
    async def test_returns_default_on_exception(self):
        """Should return default template if Prompt Registry query fails."""
        pool = FakePool([])

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            side_effect=Exception("Connection failed"),
        ):
            result = await _fetch_designer_template(pool, "tenant-123")

        assert result == DEFAULT_DESIGNER_PROMPT_TEMPLATE


# --- Tests for make_build_visual_prompt (full node) ---


class TestMakeBuildVisualPrompt:
    """Tests for the make_build_visual_prompt factory node."""

    @pytest.mark.asyncio
    async def test_builds_prompt_for_single_network(self):
        """Should build a visual prompt for a single network with variable substitution."""
        state = _make_state(redes_sociais=["instagram"])
        rows = []  # No registry template → falls back to default
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        assert "visual_prompts" in result
        assert "instagram" in result["visual_prompts"]
        prompt = result["visual_prompts"]["instagram"]
        # Check that variables were substituted
        assert "Clínica Bela Vida" in prompt
        assert "4:5 (1080x1350px)" in prompt
        assert "Uma imagem elegante de procedimento facial" in prompt
        assert "#FF5733" in prompt
        assert "moderno e clean" in prompt
        assert "folhas" in prompt

    @pytest.mark.asyncio
    async def test_builds_prompts_for_multiple_networks(self):
        """Should build separate prompts for each selected network."""
        state = _make_state(redes_sociais=["instagram", "facebook", "tiktok"])
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompts = result["visual_prompts"]
        assert len(prompts) == 3
        assert "4:5 (1080x1350px)" in prompts["instagram"]
        assert "1.91:1 (1200x628px)" in prompts["facebook"]
        assert "9:16 (1080x1920px)" in prompts["tiktok"]

    @pytest.mark.asyncio
    async def test_appends_estilo_visual_adicional(self):
        """Should append estilo_visual_adicional when provided."""
        state = _make_state(
            redes_sociais=["instagram"],
            estilo_visual_adicional="minimalista, tons pastéis",
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "ESTILO VISUAL ADICIONAL:" in prompt
        assert "minimalista, tons pastéis" in prompt

    @pytest.mark.asyncio
    async def test_does_not_append_estilo_visual_adicional_when_absent(self):
        """Should NOT append ESTILO VISUAL ADICIONAL section when not provided."""
        state = _make_state(redes_sociais=["instagram"], estilo_visual_adicional=None)
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "ESTILO VISUAL ADICIONAL:" not in prompt

    @pytest.mark.asyncio
    async def test_incorporates_content_agent_suggestion(self):
        """Should append Content Agent visual suggestion when linked."""
        content_data = {
            "execution_id": "content-exec-001",
            "status": "draft",
            "sugestoes_visuais": {
                "instagram": {
                    "descricao": "Foto de uma mulher sorrindo com pele radiante",
                    "formato": "foto",
                },
            },
            "redes_sociais": ["instagram"],
        }
        state = _make_state(
            redes_sociais=["instagram"],
            content_agent_data=content_data,
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "SUGESTÃO VISUAL DO CONTENT AGENT (instagram):" in prompt
        assert "Foto de uma mulher sorrindo com pele radiante" in prompt

    @pytest.mark.asyncio
    async def test_no_content_agent_section_when_no_suggestion_for_network(self):
        """Should not add content agent section if no suggestion for the network."""
        content_data = {
            "execution_id": "content-exec-001",
            "status": "draft",
            "sugestoes_visuais": {
                "facebook": {
                    "descricao": "Imagem para facebook apenas",
                    "formato": "foto",
                },
            },
            "redes_sociais": ["facebook"],
        }
        state = _make_state(
            redes_sociais=["instagram"],
            content_agent_data=content_data,
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "SUGESTÃO VISUAL DO CONTENT AGENT" not in prompt

    @pytest.mark.asyncio
    async def test_incorporates_edit_history(self):
        """Should append cumulative edit history when is_edit=true."""
        edit_history = [
            {"instrucao_edicao": "Aumentar brilho", "version": 1},
            {"instrucao_edicao": "Adicionar mais verde", "version": 2},
        ]
        state = _make_state(
            redes_sociais=["instagram"],
            is_edit=True,
            edit_instruction="Remover fundo escuro",
            edit_history=edit_history,
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "HISTÓRICO DE EDIÇÕES:" in prompt
        assert "Edição 1: Aumentar brilho" in prompt
        assert "Edição 2: Adicionar mais verde" in prompt
        assert "INSTRUÇÃO DE EDIÇÃO ATUAL (Edição 3):" in prompt
        assert "Remover fundo escuro" in prompt
        assert "Aplique TODAS as instruções de edição" in prompt

    @pytest.mark.asyncio
    async def test_edit_without_history_only_new_instruction(self):
        """Should handle is_edit=true with no previous history, only new instruction."""
        state = _make_state(
            redes_sociais=["instagram"],
            is_edit=True,
            edit_instruction="Adicionar mais luz",
            edit_history=[],
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "INSTRUÇÃO DE EDIÇÃO ATUAL (Edição 1):" in prompt
        assert "Adicionar mais luz" in prompt

    @pytest.mark.asyncio
    async def test_no_edit_section_when_not_edit_mode(self):
        """Should NOT add edit section when is_edit=false."""
        state = _make_state(
            redes_sociais=["instagram"],
            is_edit=False,
            edit_instruction=None,
            edit_history=[],
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "HISTÓRICO DE EDIÇÕES:" not in prompt

    @pytest.mark.asyncio
    async def test_uses_custom_template_from_registry(self):
        """Should use the template from Prompt Registry when available."""
        custom_template = (
            "CUSTOM: Gere imagem {{descricao_visual}} para {{nome_clinica}} "
            "em formato {{aspecto_ratio}}"
        )
        rows = [{"function": "task", "content": custom_template}]
        pool = FakePool(rows)

        state = _make_state(redes_sociais=["facebook"])

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["facebook"]
        assert prompt.startswith("CUSTOM: Gere imagem")
        assert "Clínica Bela Vida" in prompt
        assert "1.91:1 (1200x628px)" in prompt

    @pytest.mark.asyncio
    async def test_returns_negative_prompts(self):
        """Should also return negative_prompts from _generate_negative_prompts."""
        state = _make_state(redes_sociais=["instagram"])
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        assert "negative_prompts" in result
        assert len(result["negative_prompts"]) == 5

    @pytest.mark.asyncio
    async def test_handles_paleta_cores_as_string(self):
        """Should handle paleta_cores when it's a string instead of list."""
        state = _make_state(
            redes_sociais=["instagram"],
            brand_identity={
                "paleta_cores": "#FF0000, #00FF00",
                "estilo_visual": "elegante",
                "valores": [],
                "elementos_recorrentes": "",
                "nome_clinica": "Clinica Test",
            },
        )
        rows = []
        pool = FakePool(rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            return_value=_fake_tenant_context(FakeConnection(rows)),
        ):
            node_fn = make_build_visual_prompt(pool)
            result = await node_fn(state)

        prompt = result["visual_prompts"]["instagram"]
        assert "#FF0000, #00FF00" in prompt


class TestBuildVisualPromptStub:
    """Tests for the standalone build_visual_prompt stub (no dependencies)."""

    @pytest.mark.asyncio
    async def test_stub_returns_empty_visual_prompts(self):
        """Standalone stub should return empty visual_prompts dict."""
        state = _make_state()
        result = await build_visual_prompt(state)
        assert result["visual_prompts"] == {}

    @pytest.mark.asyncio
    async def test_stub_returns_negative_prompts(self):
        """Standalone stub should still return negative_prompts."""
        state = _make_state()
        result = await build_visual_prompt(state)
        assert "negative_prompts" in result
        assert len(result["negative_prompts"]) == 5


# --- Test helpers ---


@asynccontextmanager
async def _fake_tenant_context_cm(conn):
    """Fake async context manager that yields the given connection."""
    yield conn


def _fake_tenant_context(conn):
    """Create a fake tenant_connection context manager."""
    return _fake_tenant_context_cm(conn)
