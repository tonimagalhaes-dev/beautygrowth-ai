"""Tests for Designer Agent edit context loading (Task 3.3).

Validates:
- Loading original execution + cumulative edit history when is_edit=True
- Tenant isolation (404 when execution not found via RLS)
- Edit limit enforcement (429 when >= 5 edits for a social network)
- Integration with make_load_context factory

Requirements: 6.1, 6.2, 6.5
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    MAX_EDITS_PER_SOCIAL,
    EditLimitExceededError,
    ExecutionNotFoundError,
    _load_edit_context,
    make_load_context,
)


# --- Fixtures ---


@pytest.fixture
def sample_tenant_id() -> str:
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def sample_execution_id() -> str:
    return uuid.UUID("660e8400-e29b-41d4-a716-446655440001")


@pytest.fixture
def sample_execution_row(sample_execution_id: uuid.UUID) -> dict:
    """Simulates a row from designer_executions."""
    return {
        "execution_id": sample_execution_id,
        "tenant_id": uuid.UUID("550e8400-e29b-41d4-a716-446655440000"),
        "descricao_visual": "Imagem elegante de harmonização facial",
        "redes_sociais": ["instagram", "facebook"],
        "estilo_visual_adicional": "minimalista",
        "aplicar_logo_overlay": True,
        "version": 1,
        "content_execution_id": None,
        "status": "generated",
        "created_at": "2025-01-15 10:30:00+00",
    }


@pytest.fixture
def sample_edit_rows() -> list[dict]:
    """Simulates rows from designer_edit_history (2 prior edits)."""
    return [
        {
            "id": uuid.UUID("aaa00000-0000-0000-0000-000000000001"),
            "version": 1,
            "instrucao_edicao": "Aumentar destaque para o rosto",
            "prompt_visual_utilizado": "prompt v1 text...",
            "created_at": "2025-01-15 11:00:00+00",
        },
        {
            "id": uuid.UUID("aaa00000-0000-0000-0000-000000000002"),
            "version": 2,
            "instrucao_edicao": "Adicionar mais luz no fundo",
            "prompt_visual_utilizado": "prompt v2 text...",
            "created_at": "2025-01-15 11:30:00+00",
        },
    ]


def _make_mock_conn(
    execution_row: dict | None,
    edit_rows: list[dict] | None = None,
) -> AsyncMock:
    """Create a mock asyncpg connection with fetchrow and fetch behavior."""
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=execution_row)
    conn.fetch = AsyncMock(return_value=edit_rows or [])
    return conn


# --- Tests for _load_edit_context ---


class TestLoadEditContext:
    """Unit tests for _load_edit_context helper function."""

    async def test_loads_execution_and_edit_history_successfully(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
        sample_edit_rows: list[dict],
    ):
        """Validates Requirement 6.1: loads original execution + cumulative edit history."""
        conn = _make_mock_conn(sample_execution_row, sample_edit_rows)

        result = await _load_edit_context(
            conn,
            str(sample_execution_id),
            "instagram",
            sample_tenant_id,
        )

        # Verify original execution is loaded
        assert result["original_execution"]["execution_id"] == str(sample_execution_id)
        assert result["original_execution"]["descricao_visual"] == "Imagem elegante de harmonização facial"
        assert result["original_execution"]["redes_sociais"] == ["instagram", "facebook"]
        assert result["original_execution"]["estilo_visual_adicional"] == "minimalista"
        assert result["original_execution"]["aplicar_logo_overlay"] is True
        assert result["original_execution"]["version"] == 1
        assert result["original_execution"]["status"] == "generated"

        # Verify edit history is loaded in order
        assert len(result["edit_history"]) == 2
        assert result["edit_history"][0]["version"] == 1
        assert result["edit_history"][0]["instrucao_edicao"] == "Aumentar destaque para o rosto"
        assert result["edit_history"][1]["version"] == 2
        assert result["edit_history"][1]["instrucao_edicao"] == "Adicionar mais luz no fundo"

        # Verify edit count
        assert result["edit_count"] == 2

    async def test_raises_404_when_execution_not_found(
        self,
        sample_tenant_id: str,
    ):
        """Validates Requirement 6.5: returns 404 when execution not found (tenant isolation)."""
        conn = _make_mock_conn(execution_row=None)

        with pytest.raises(ExecutionNotFoundError) as exc_info:
            await _load_edit_context(
                conn,
                "non-existent-execution-id",
                "instagram",
                sample_tenant_id,
            )

        assert exc_info.value.http_status == 404
        assert "non-existent-execution-id" in str(exc_info.value)

    async def test_raises_429_when_edit_limit_exceeded(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """Validates Requirement 6.2: returns 429 when 5 edits already exist."""
        # Create 5 prior edits (the maximum)
        five_edits = [
            {
                "id": uuid.uuid4(),
                "version": i + 1,
                "instrucao_edicao": f"Edit instruction {i + 1}",
                "prompt_visual_utilizado": f"prompt v{i + 1}",
                "created_at": f"2025-01-15 1{i}:00:00+00",
            }
            for i in range(MAX_EDITS_PER_SOCIAL)
        ]
        conn = _make_mock_conn(sample_execution_row, five_edits)

        with pytest.raises(EditLimitExceededError) as exc_info:
            await _load_edit_context(
                conn,
                str(sample_execution_id),
                "instagram",
                sample_tenant_id,
            )

        assert exc_info.value.http_status == 429
        assert exc_info.value.rede_social == "instagram"
        assert exc_info.value.max_edits == MAX_EDITS_PER_SOCIAL

    async def test_allows_edit_when_below_limit(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """Validates that 4 existing edits still allows one more (limit is 5)."""
        four_edits = [
            {
                "id": uuid.uuid4(),
                "version": i + 1,
                "instrucao_edicao": f"Edit instruction {i + 1}",
                "prompt_visual_utilizado": f"prompt v{i + 1}",
                "created_at": f"2025-01-15 1{i}:00:00+00",
            }
            for i in range(4)
        ]
        conn = _make_mock_conn(sample_execution_row, four_edits)

        result = await _load_edit_context(
            conn,
            str(sample_execution_id),
            "instagram",
            sample_tenant_id,
        )

        assert result["edit_count"] == 4
        assert len(result["edit_history"]) == 4

    async def test_empty_edit_history_for_new_edit(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """First edit: no prior history exists."""
        conn = _make_mock_conn(sample_execution_row, [])

        result = await _load_edit_context(
            conn,
            str(sample_execution_id),
            "instagram",
            sample_tenant_id,
        )

        assert result["edit_count"] == 0
        assert result["edit_history"] == []
        assert result["original_execution"]["execution_id"] == str(sample_execution_id)

    async def test_queries_correct_execution_id_and_rede_social(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """Verifies the SQL queries receive correct parameters."""
        conn = _make_mock_conn(sample_execution_row, [])

        await _load_edit_context(
            conn,
            str(sample_execution_id),
            "tiktok",
            sample_tenant_id,
        )

        # Verify fetchrow called with execution_id
        conn.fetchrow.assert_called_once()
        args = conn.fetchrow.call_args[0]
        assert str(sample_execution_id) in args

        # Verify fetch called with execution_id and rede_social
        conn.fetch.assert_called_once()
        fetch_args = conn.fetch.call_args[0]
        assert str(sample_execution_id) in fetch_args
        assert "tiktok" in fetch_args

    async def test_handles_content_execution_id_none(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """content_execution_id is None when not linked to Content Agent."""
        conn = _make_mock_conn(sample_execution_row, [])

        result = await _load_edit_context(
            conn,
            str(sample_execution_id),
            "instagram",
            sample_tenant_id,
        )

        assert result["original_execution"]["content_execution_id"] is None

    async def test_handles_content_execution_id_present(
        self,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """content_execution_id is serialized as string when present."""
        content_exec_id = uuid.uuid4()
        row = {**sample_execution_row, "content_execution_id": content_exec_id}
        conn = _make_mock_conn(row, [])

        result = await _load_edit_context(
            conn,
            str(sample_execution_id),
            "instagram",
            sample_tenant_id,
        )

        assert result["original_execution"]["content_execution_id"] == str(content_exec_id)


# --- Tests for make_load_context integration with edit context ---


class TestMakeLoadContextEditIntegration:
    """Integration tests for make_load_context with is_edit=True."""

    @pytest.fixture
    def mock_pg_pool(self) -> AsyncMock:
        return AsyncMock()

    @pytest.fixture
    def base_state(self, sample_tenant_id: str) -> dict:
        """Base state for non-edit scenario."""
        return {
            "tenant_id": sample_tenant_id,
            "user_id": "user-123",
            "trace_id": "trace-abc",
            "execution_id": "exec-new",
            "request": {"aplicar_logo_overlay": False},
            "is_edit": False,
            "original_execution_id": None,
            "edit_instruction": None,
            "target_social": None,
            "version": 1,
        }

    async def test_skips_edit_context_when_is_edit_false(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_tenant_id: str,
    ):
        """When is_edit=False, edit_history should be empty list."""
        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": "moderno",
            "valores": "inovação",
            "elementos_recorrentes": "logo",
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ):
            load_ctx_fn = make_load_context(mock_pg_pool)
            result = await load_ctx_fn(base_state)

        assert result["edit_history"] == []

    async def test_loads_edit_context_when_is_edit_true(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_tenant_id: str,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
        sample_edit_rows: list[dict],
    ):
        """When is_edit=True, edit_history should be populated from database."""
        edit_state = {
            **base_state,
            "is_edit": True,
            "original_execution_id": str(sample_execution_id),
            "target_social": "instagram",
            "edit_instruction": "Make it brighter",
        }

        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": "moderno",
            "valores": "inovação",
            "elementos_recorrentes": "logo",
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        mock_conn = _make_mock_conn(sample_execution_row, sample_edit_rows)

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tenant_conn:
            # Make tenant_connection return our mock conn as async context manager
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(return_value=False)

            load_ctx_fn = make_load_context(mock_pg_pool)
            result = await load_ctx_fn(edit_state)

        # Verify edit history populated
        assert len(result["edit_history"]) == 2
        assert result["edit_history"][0]["version"] == 1
        assert result["edit_history"][1]["version"] == 2

    async def test_raises_error_when_target_social_missing_in_edit_mode(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_execution_id: uuid.UUID,
    ):
        """When is_edit=True but target_social is empty, should raise ValueError."""
        edit_state = {
            **base_state,
            "is_edit": True,
            "original_execution_id": str(sample_execution_id),
            "target_social": "",  # Missing!
        }

        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": "moderno",
            "valores": "inovação",
            "elementos_recorrentes": "logo",
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ):
            load_ctx_fn = make_load_context(mock_pg_pool)
            with pytest.raises(ValueError, match="target_social is required"):
                await load_ctx_fn(edit_state)

    async def test_propagates_execution_not_found_error(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_execution_id: uuid.UUID,
    ):
        """ExecutionNotFoundError (404) propagates up from _load_edit_context."""
        edit_state = {
            **base_state,
            "is_edit": True,
            "original_execution_id": str(sample_execution_id),
            "target_social": "instagram",
        }

        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": "moderno",
            "valores": None,
            "elementos_recorrentes": None,
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        # Mock conn returns None for fetchrow (execution not found)
        mock_conn = _make_mock_conn(execution_row=None)

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(return_value=False)

            load_ctx_fn = make_load_context(mock_pg_pool)
            with pytest.raises(ExecutionNotFoundError) as exc_info:
                await load_ctx_fn(edit_state)

            assert exc_info.value.http_status == 404

    async def test_propagates_edit_limit_exceeded_error(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
    ):
        """EditLimitExceededError (429) propagates up when limit is reached."""
        edit_state = {
            **base_state,
            "is_edit": True,
            "original_execution_id": str(sample_execution_id),
            "target_social": "facebook",
        }

        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": None,
            "valores": None,
            "elementos_recorrentes": None,
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        # Create 5 edits (at the limit)
        five_edits = [
            {
                "id": uuid.uuid4(),
                "version": i + 1,
                "instrucao_edicao": f"Edit {i + 1}",
                "prompt_visual_utilizado": f"prompt v{i + 1}",
                "created_at": f"2025-01-15 1{i}:00:00+00",
            }
            for i in range(5)
        ]
        mock_conn = _make_mock_conn(sample_execution_row, five_edits)

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(return_value=False)

            load_ctx_fn = make_load_context(mock_pg_pool)
            with pytest.raises(EditLimitExceededError) as exc_info:
                await load_ctx_fn(edit_state)

            assert exc_info.value.http_status == 429
            assert exc_info.value.rede_social == "facebook"

    async def test_records_edit_context_step_in_observability(
        self,
        mock_pg_pool: AsyncMock,
        base_state: dict,
        sample_execution_id: uuid.UUID,
        sample_execution_row: dict,
        sample_edit_rows: list[dict],
    ):
        """Verifies that loading edit context adds a step entry for observability."""
        edit_state = {
            **base_state,
            "is_edit": True,
            "original_execution_id": str(sample_execution_id),
            "target_social": "instagram",
        }

        bm_data = {
            "paleta_cores": ["#FF0000"],
            "estilo_visual": "moderno",
            "valores": None,
            "elementos_recorrentes": None,
            "nome_clinica": "Clínica Bela",
            "logo_url": None,
        }

        mock_conn = _make_mock_conn(sample_execution_row, sample_edit_rows)

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            new_callable=AsyncMock,
            return_value=bm_data,
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tenant_conn:
            mock_tenant_conn.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tenant_conn.return_value.__aexit__ = AsyncMock(return_value=False)

            load_ctx_fn = make_load_context(mock_pg_pool)
            result = await load_ctx_fn(edit_state)

        # Should have 2 steps: load_business_memory + load_edit_context
        assert len(result["steps"]) == 2
        edit_step = result["steps"][1]
        assert edit_step["action"] == "load_edit_context"
        assert edit_step["execution_id"] == str(sample_execution_id)
        assert edit_step["target_social"] == "instagram"
        assert edit_step["edit_count"] == 2


# --- Tests for exception attributes ---


class TestEditContextExceptions:
    """Tests for custom exception classes."""

    def test_execution_not_found_error_attributes(self):
        err = ExecutionNotFoundError("exec-123")
        assert err.http_status == 404
        assert err.execution_id == "exec-123"
        assert "exec-123" in str(err)

    def test_edit_limit_exceeded_error_attributes(self):
        err = EditLimitExceededError("exec-456", "instagram", 5)
        assert err.http_status == 429
        assert err.execution_id == "exec-456"
        assert err.rede_social == "instagram"
        assert err.max_edits == 5
        assert "instagram" in str(err)
        assert "5" in str(err)

    def test_max_edits_per_social_constant(self):
        """Verify the constant matches requirements (5 edits per social)."""
        assert MAX_EDITS_PER_SOCIAL == 5
