"""Tests for the resolve_prompt node implementation.

Tests cover:
- Template variable substitution (_substitute_template_variables)
- make_resolve_prompt factory with mocked database
- Error handling when prompts are not found
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.content_agent import (
    _substitute_template_variables,
    make_resolve_prompt,
)


class TestSubstituteTemplateVariables:
    """Tests for _substitute_template_variables function."""

    def _make_state(self, **overrides):
        """Create a minimal state for testing."""
        state = {
            "brand_identity": {
                "nome_clinica": "Clínica Bela Vida",
                "tom_de_voz": "Acolhedor e profissional",
                "valores": ["excelência", "cuidado"],
            },
            "publico_alvo": "Mulheres 25-45 anos, classe A/B",
            "especialidades": ["Dermatologia", "Harmonização Facial", "Laser"],
            "knowledge_chunks": [
                {"content": "Botox é um procedimento seguro."},
                {"content": "Indicado para rugas dinâmicas."},
            ],
            "briefing": {
                "tema": "Benefícios do Botox preventivo",
                "procedimento": "Toxina Botulínica",
                "redes_sociais": ["instagram", "facebook"],
                "idioma": "pt-BR",
            },
        }
        state.update(overrides)
        return state

    def test_all_variables_substituted(self):
        """All recognized template variables are replaced."""
        template = (
            "Clínica: {{nome_clinica}}, Tom: {{tom_de_voz}}, "
            "Especialidades: {{especialidades}}, Público: {{publico_alvo}}, "
            "Tema: {{tema}}, Procedimento: {{procedimento}}, "
            "Redes: {{redes_sociais}}, Idioma: {{idioma}}"
        )
        state = self._make_state()
        result = _substitute_template_variables(template, state)

        assert "Clínica Bela Vida" in result
        assert "Acolhedor e profissional" in result
        assert "Dermatologia, Harmonização Facial, Laser" in result
        assert "Mulheres 25-45 anos, classe A/B" in result
        assert "Benefícios do Botox preventivo" in result
        assert "Toxina Botulínica" in result
        assert "instagram, facebook" in result
        assert "pt-BR" in result

    def test_knowledge_context_joined(self):
        """Knowledge chunks are joined with double newline."""
        template = "Contexto: {{knowledge_context}}"
        state = self._make_state()
        result = _substitute_template_variables(template, state)

        assert "Botox é um procedimento seguro." in result
        assert "Indicado para rugas dinâmicas." in result

    def test_knowledge_context_empty_chunks(self):
        """Empty knowledge chunks produce fallback text."""
        template = "{{knowledge_context}}"
        state = self._make_state(knowledge_chunks=[])
        result = _substitute_template_variables(template, state)

        assert result == "Nenhum contexto adicional disponível."

    def test_knowledge_context_string_chunks(self):
        """Knowledge chunks as plain strings are handled."""
        template = "{{knowledge_context}}"
        state = self._make_state(knowledge_chunks=["Chunk 1", "Chunk 2"])
        result = _substitute_template_variables(template, state)

        assert "Chunk 1" in result
        assert "Chunk 2" in result

    def test_procedimento_default_when_missing(self):
        """Missing procedimento defaults to 'Não especificado'."""
        template = "{{procedimento}}"
        state = self._make_state()
        state["briefing"] = {"tema": "Test", "redes_sociais": ["instagram"]}
        result = _substitute_template_variables(template, state)

        assert result == "Não especificado"

    def test_idioma_default_when_missing(self):
        """Missing idioma defaults to 'pt-BR'."""
        template = "{{idioma}}"
        state = self._make_state()
        state["briefing"] = {"tema": "Test", "redes_sociais": ["instagram"]}
        result = _substitute_template_variables(template, state)

        assert result == "pt-BR"

    def test_unrecognized_variable_preserved(self):
        """Unrecognized template variables remain unchanged."""
        template = "{{unknown_var}} and {{nome_clinica}}"
        state = self._make_state()
        result = _substitute_template_variables(template, state)

        assert "{{unknown_var}}" in result
        assert "Clínica Bela Vida" in result

    def test_whitespace_inside_braces_handled(self):
        """Whitespace inside {{ }} is trimmed for variable lookup."""
        template = "{{ nome_clinica }} and {{ tom_de_voz }}"
        state = self._make_state()
        result = _substitute_template_variables(template, state)

        assert "Clínica Bela Vida" in result
        assert "Acolhedor e profissional" in result

    def test_empty_state_graceful(self):
        """Empty state produces empty substitutions without errors."""
        template = "{{nome_clinica}} {{tom_de_voz}} {{especialidades}}"
        state = {}
        result = _substitute_template_variables(template, state)

        # Should not raise, all values will be empty strings
        assert "{{" not in result  # All known vars are replaced with ""

    def test_empty_especialidades_produces_empty_string(self):
        """Empty especialidades list produces empty string."""
        template = "{{especialidades}}"
        state = self._make_state(especialidades=[])
        result = _substitute_template_variables(template, state)

        assert result == ""


class TestMakeResolvePrompt:
    """Tests for the make_resolve_prompt factory function."""

    def _make_state(self):
        """Create a full state for testing the node."""
        return {
            "tenant_id": "tenant-123",
            "user_id": "user-456",
            "trace_id": "trace-789",
            "execution_id": "exec-001",
            "brand_identity": {
                "nome_clinica": "Clínica Bela Vida",
                "tom_de_voz": "Acolhedor e profissional",
            },
            "publico_alvo": "Mulheres 25-45 anos",
            "especialidades": ["Dermatologia", "Laser"],
            "knowledge_chunks": [{"content": "Procedimento seguro."}],
            "briefing": {
                "tema": "Botox preventivo",
                "procedimento": "Toxina Botulínica",
                "redes_sociais": ["instagram"],
                "idioma": "pt-BR",
            },
        }

    @pytest.mark.asyncio
    async def test_resolve_prompt_returns_system_and_task(self):
        """Real resolve_prompt queries DB and returns both prompts."""
        # Mock the pg_pool and tenant_connection
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"function": "system", "content": "System: {{nome_clinica}} - {{tom_de_voz}}"},
                {"function": "task", "content": "Task: {{tema}} para {{redes_sociais}}"},
            ]
        )

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            # Setup the async context manager
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)
            result = await node_fn(self._make_state())

        assert "system_prompt" in result
        assert "task_prompt" in result
        assert "Clínica Bela Vida" in result["system_prompt"]
        assert "Acolhedor e profissional" in result["system_prompt"]
        assert "Botox preventivo" in result["task_prompt"]
        assert "instagram" in result["task_prompt"]

    @pytest.mark.asyncio
    async def test_resolve_prompt_raises_when_no_system_prompt(self):
        """Raises RuntimeError when no active system prompt found."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"function": "task", "content": "Task: {{tema}}"},
            ]
        )

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)

            with pytest.raises(RuntimeError, match="No active system prompt"):
                await node_fn(self._make_state())

    @pytest.mark.asyncio
    async def test_resolve_prompt_raises_when_no_task_prompt(self):
        """Raises RuntimeError when no active task prompt found."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"function": "system", "content": "System: {{nome_clinica}}"},
            ]
        )

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)

            with pytest.raises(RuntimeError, match="No active task prompt"):
                await node_fn(self._make_state())

    @pytest.mark.asyncio
    async def test_resolve_prompt_raises_when_empty_results(self):
        """Raises RuntimeError when no prompts found at all."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)

            with pytest.raises(RuntimeError, match="No active system prompt"):
                await node_fn(self._make_state())

    @pytest.mark.asyncio
    async def test_resolve_prompt_passes_correct_query_args(self):
        """Verifies the query passes 'content' as agent_type."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"function": "system", "content": "System prompt"},
                {"function": "task", "content": "Task prompt"},
            ]
        )

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)
            await node_fn(self._make_state())

        # Verify the query was called with 'content'
        mock_conn.fetch.assert_called_once()
        call_args = mock_conn.fetch.call_args
        assert "content" in call_args[0]  # second positional arg is 'content'

    @pytest.mark.asyncio
    async def test_resolve_prompt_uses_tenant_id_from_state(self):
        """tenant_connection is called with the tenant_id from state."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"function": "system", "content": "System"},
                {"function": "task", "content": "Task"},
            ]
        )

        mock_pool = MagicMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(
                return_value=mock_conn
            )
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(
                return_value=False
            )

            node_fn = make_resolve_prompt(mock_pool)
            state = self._make_state()
            await node_fn(state)

        # tenant_connection should be called with pool and tenant_id
        mock_tenant_conn.assert_called_once_with(mock_pool, "tenant-123")
