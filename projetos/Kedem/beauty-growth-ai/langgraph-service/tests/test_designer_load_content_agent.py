"""Unit tests for Content Agent data loading in the Designer Agent workflow (Task 3.2).

Tests cover:
- Successful loading of Content Agent data with valid execution (draft/approved status)
- 404 error when execution_id does not exist or belongs to another tenant
- 409 error when Content Agent status is incompatible (not draft/approved)
- 422 error when visual suggestions are missing for requested networks
- Status resolution logic (_resolve_content_agent_status)
- Integration with load_context node (content_agent_data populated in state)

Requirements validated: 1.6, 1.7, 9.2, 9.4, 9.5, 9.6
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    ContentAgentNotFoundError,
    ContentAgentStatusIncompatibleError,
    ContentAgentMissingVisualSuggestionsError,
    DesignerAgentState,
    _load_content_agent_data,
    _resolve_content_agent_status,
    make_load_context,
)


# --- Fixtures ---


@pytest.fixture
def tenant_id() -> str:
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def content_execution_id() -> str:
    return "660e8400-e29b-41d4-a716-446655440001"


@pytest.fixture
def valid_output_json() -> str:
    """JSON output from a successful Content Agent execution with visual suggestions."""
    return json.dumps({
        "legendas": {
            "instagram": "Legenda para Instagram...",
            "facebook": "Legenda para Facebook...",
        },
        "hashtags": ["#beleza", "#estetica", "#botox"],
        "sugestoes_visuais": {
            "instagram": {
                "formato": "4:5",
                "descricao": "Imagem elegante de procedimento de harmonização facial com tons suaves",
            },
            "facebook": {
                "formato": "1.91:1",
                "descricao": "Banner profissional mostrando resultado natural de botox",
            },
            "tiktok": {
                "formato": "9:16",
                "descricao": "Visual dinâmico vertical para TikTok com procedimento estético",
            },
        },
    })


@pytest.fixture
def valid_input_json() -> str:
    """JSON input from the Content Agent execution."""
    return json.dumps({
        "execution_id": "660e8400-e29b-41d4-a716-446655440001",
        "tema": "Harmonização facial",
        "redes_sociais": ["instagram", "facebook"],
    })


@pytest.fixture
def base_designer_state(tenant_id: str) -> DesignerAgentState:
    """Minimal valid state for Designer Agent load_context with content_execution_id."""
    return {
        "tenant_id": tenant_id,
        "user_id": "user-001",
        "trace_id": "trace-001",
        "execution_id": "exec-designer-001",
        "request": {
            "descricao_visual": "Imagem elegante de harmonização facial",
            "redes_sociais": ["instagram", "facebook"],
            "content_execution_id": "660e8400-e29b-41d4-a716-446655440001",
            "aplicar_logo_overlay": False,
        },
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
        "visual_prompts": {},
        "negative_prompts": [],
        "guardrail_attempt": 0,
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
        "warnings": [],
        "output": "",
    }


# --- Tests for _resolve_content_agent_status ---


class TestResolveContentAgentStatus:
    """Tests for the status resolution logic."""

    def test_completed_without_blocked_reason_is_draft(self):
        """Completed execution without blocked_reason maps to 'draft'."""
        result = _resolve_content_agent_status("completed", None, None)
        assert result == "draft"

    def test_completed_with_persisted_blocked_reason_is_draft(self):
        """Completed execution with persistence-related blocked_reason is still 'draft'."""
        result = _resolve_content_agent_status(
            "completed", "persisted due to storage failure", None
        )
        assert result == "draft"

    def test_completed_with_guardrail_blocked_reason_is_blocked(self):
        """Completed execution with guardrail blocked_reason is 'guardrail_blocked'."""
        result = _resolve_content_agent_status(
            "completed", "Violação de guardrail ANVISA", None
        )
        assert result == "guardrail_blocked"

    def test_failed_status_is_error(self):
        """Failed execution maps to 'error'."""
        result = _resolve_content_agent_status("failed", None, None)
        assert result == "error"

    def test_pending_status_remains_pending(self):
        """Pending execution remains 'pending'."""
        result = _resolve_content_agent_status("pending", None, None)
        assert result == "pending"

    def test_running_status_remains_running(self):
        """Running execution remains 'running'."""
        result = _resolve_content_agent_status("running", None, None)
        assert result == "running"

    def test_metadata_content_status_overrides(self):
        """Explicit content_status in metadata overrides all other logic."""
        result = _resolve_content_agent_status(
            "completed", None, {"content_status": "approved"}
        )
        assert result == "approved"

    def test_metadata_content_status_approved(self):
        """Metadata with approved status returns 'approved'."""
        result = _resolve_content_agent_status(
            "completed", None, {"content_status": "approved"}
        )
        assert result == "approved"

    def test_empty_metadata_does_not_override(self):
        """Empty metadata dict does not affect status resolution."""
        result = _resolve_content_agent_status("completed", None, {})
        assert result == "draft"


# --- Tests for _load_content_agent_data ---


class TestLoadContentAgentData:
    """Tests for the Content Agent data loading function."""

    @pytest.fixture
    def mock_conn(self, valid_output_json, valid_input_json, content_execution_id):
        """Create a mock connection with a valid Content Agent execution row."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
            "workflow_id": "content_agent",
            "status": "completed",
            "output": valid_output_json,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": valid_input_json,
        })
        return conn

    async def test_successful_load_draft_status(
        self, mock_conn, content_execution_id, tenant_id
    ):
        """Successfully loads Content Agent data with draft status (Req 1.6, 9.2)."""
        result = await _load_content_agent_data(
            mock_conn,
            content_execution_id,
            ["instagram", "facebook"],
            tenant_id,
        )

        assert result["execution_id"] == content_execution_id
        assert result["status"] == "draft"
        assert "instagram" in result["sugestoes_visuais"]
        assert "facebook" in result["sugestoes_visuais"]
        assert result["sugestoes_visuais"]["instagram"]["descricao"] == (
            "Imagem elegante de procedimento de harmonização facial com tons suaves"
        )
        assert result["sugestoes_visuais"]["facebook"]["descricao"] == (
            "Banner profissional mostrando resultado natural de botox"
        )

    async def test_successful_load_approved_status(
        self, mock_conn, content_execution_id, tenant_id
    ):
        """Successfully loads Content Agent data with approved status (Req 9.4)."""
        # Override metadata to have approved status
        mock_conn.fetchrow.return_value = {
            **mock_conn.fetchrow.return_value,
            "metadata": json.dumps({"content_status": "approved"}),
        }

        result = await _load_content_agent_data(
            mock_conn,
            content_execution_id,
            ["instagram"],
            tenant_id,
        )

        assert result["status"] == "approved"

    async def test_not_found_returns_404(self, content_execution_id, tenant_id):
        """Raises 404 when execution_id does not exist (Req 1.7, 9.5)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=None)

        with pytest.raises(ContentAgentNotFoundError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

        assert exc_info.value.http_status == 404
        assert exc_info.value.execution_id == content_execution_id
        # Verify message does not reveal tenant info
        assert "tenant" not in str(exc_info.value).lower()

    async def test_incompatible_status_returns_409(
        self, content_execution_id, tenant_id, valid_output_json
    ):
        """Raises 409 when content status is not draft/approved (Req 9.4)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "failed",
            "output": valid_output_json,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentStatusIncompatibleError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

        assert exc_info.value.http_status == 409
        # Verify message does not reveal actual status
        assert "failed" not in str(exc_info.value).lower()
        assert "status" not in str(exc_info.value).lower() or "incompatível" in str(exc_info.value).lower()

    async def test_guardrail_blocked_status_returns_409(
        self, content_execution_id, tenant_id, valid_output_json
    ):
        """Raises 409 when content was blocked by guardrails (Req 9.4)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": valid_output_json,
            "blocked_reason": "ANVISA violation detected",
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentStatusIncompatibleError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

        assert exc_info.value.http_status == 409

    async def test_missing_visual_suggestions_returns_422(
        self, content_execution_id, tenant_id
    ):
        """Raises 422 when visual suggestions are missing for requested networks (Req 9.6)."""
        # Output has only instagram suggestions but we request tiktok too
        output = json.dumps({
            "legendas": {"instagram": "test"},
            "hashtags": [],
            "sugestoes_visuais": {
                "instagram": {"formato": "4:5", "descricao": "test description"},
            },
        })

        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": output,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentMissingVisualSuggestionsError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram", "tiktok"],
                tenant_id,
            )

        assert exc_info.value.http_status == 422
        assert "tiktok" in exc_info.value.missing_networks
        assert "instagram" not in exc_info.value.missing_networks

    async def test_empty_descricao_counts_as_missing(
        self, content_execution_id, tenant_id
    ):
        """Raises 422 when descricao field is empty string (Req 9.6)."""
        output = json.dumps({
            "legendas": {},
            "hashtags": [],
            "sugestoes_visuais": {
                "instagram": {"formato": "4:5", "descricao": ""},
            },
        })

        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": output,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentMissingVisualSuggestionsError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

        assert "instagram" in exc_info.value.missing_networks

    async def test_no_output_returns_422(
        self, content_execution_id, tenant_id
    ):
        """Raises 422 when Content Agent execution has no output at all (Req 9.6)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": None,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentMissingVisualSuggestionsError):
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

    async def test_invalid_json_output_returns_422(
        self, content_execution_id, tenant_id
    ):
        """Raises 422 when output is malformed JSON (Req 9.6)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": "not a valid json {{{",
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentMissingVisualSuggestionsError):
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

    async def test_extracts_descricao_per_network(
        self, mock_conn, content_execution_id, tenant_id
    ):
        """Extracts descricao field per requested social network (Req 9.2)."""
        result = await _load_content_agent_data(
            mock_conn,
            content_execution_id,
            ["instagram", "facebook"],
            tenant_id,
        )

        # Should have entries for both requested networks
        assert len(result["sugestoes_visuais"]) == 2
        assert "descricao" in result["sugestoes_visuais"]["instagram"]
        assert "descricao" in result["sugestoes_visuais"]["facebook"]
        # Should also include formato for context
        assert "formato" in result["sugestoes_visuais"]["instagram"]

    async def test_pending_status_returns_409(
        self, content_execution_id, tenant_id, valid_output_json
    ):
        """Raises 409 when content execution is still pending (Req 9.4)."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "pending",
            "output": valid_output_json,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with pytest.raises(ContentAgentStatusIncompatibleError) as exc_info:
            await _load_content_agent_data(
                conn,
                content_execution_id,
                ["instagram"],
                tenant_id,
            )

        assert exc_info.value.http_status == 409


# --- Tests for make_load_context integration with Content Agent data ---


class TestLoadContextWithContentAgent:
    """Integration tests for load_context node when content_execution_id is present."""

    @pytest.fixture
    def mock_pg_pool(self):
        """Mock asyncpg pool."""
        return MagicMock()

    async def test_load_context_populates_content_agent_data(
        self, base_designer_state, tenant_id, mock_pg_pool,
        valid_output_json, valid_input_json, content_execution_id
    ):
        """load_context populates content_agent_data when content_execution_id present."""
        # Mock tenant_connection to return controlled data
        mock_conn = AsyncMock()

        # Business Memory query
        bm_rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FF6B9D", "#4A90D9"]},
            {"category": "brand", "key": "estilo_visual", "value": "moderno e elegante"},
            {"category": "brand", "key": "nome_clinica", "value": "Clínica Beleza"},
        ]

        # Content Agent execution row
        content_row = {
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "completed",
            "output": valid_output_json,
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": valid_input_json,
        }

        call_count = [0]

        async def fake_fetch(*args, **kwargs):
            return bm_rows

        async def fake_fetchrow(*args, **kwargs):
            return content_row

        mock_conn.fetch = fake_fetch
        mock_conn.fetchrow = fake_fetchrow

        with patch(
            "src.workflows.designer_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node = make_load_context(mock_pg_pool)
            result = await node(base_designer_state)

        assert result["content_agent_data"] is not None
        assert result["content_agent_data"]["execution_id"] == content_execution_id
        assert result["content_agent_data"]["status"] == "draft"
        assert "instagram" in result["content_agent_data"]["sugestoes_visuais"]

    async def test_load_context_no_content_agent_when_not_linked(
        self, base_designer_state, mock_pg_pool
    ):
        """load_context sets content_agent_data to None when no content_execution_id."""
        # Remove content_execution_id from request
        state = {**base_designer_state}
        state["request"] = {
            "descricao_visual": "Imagem elegante",
            "redes_sociais": ["instagram"],
        }

        mock_conn = AsyncMock()
        bm_rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FFFFFF"]},
        ]
        mock_conn.fetch = AsyncMock(return_value=bm_rows)

        with patch(
            "src.workflows.designer_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node = make_load_context(mock_pg_pool)
            result = await node(state)

        assert result["content_agent_data"] is None

    async def test_load_context_raises_404_for_invalid_content_execution(
        self, base_designer_state, mock_pg_pool
    ):
        """load_context propagates ContentAgentNotFoundError (404) to caller."""
        mock_conn = AsyncMock()
        bm_rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FFFFFF"]},
        ]
        mock_conn.fetch = AsyncMock(return_value=bm_rows)
        mock_conn.fetchrow = AsyncMock(return_value=None)

        with patch(
            "src.workflows.designer_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node = make_load_context(mock_pg_pool)

            with pytest.raises(ContentAgentNotFoundError) as exc_info:
                await node(base_designer_state)

            assert exc_info.value.http_status == 404

    async def test_load_context_raises_409_for_incompatible_status(
        self, base_designer_state, mock_pg_pool, content_execution_id, tenant_id
    ):
        """load_context propagates ContentAgentStatusIncompatibleError (409)."""
        mock_conn = AsyncMock()
        bm_rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FFFFFF"]},
        ]
        mock_conn.fetch = AsyncMock(return_value=bm_rows)
        mock_conn.fetchrow = AsyncMock(return_value={
            "id": content_execution_id,
            "tenant_id": tenant_id,
            "workflow_id": "content_agent",
            "status": "failed",
            "output": "{}",
            "blocked_reason": None,
            "metadata": json.dumps({}),
            "input": "{}",
        })

        with patch(
            "src.workflows.designer_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node = make_load_context(mock_pg_pool)

            with pytest.raises(ContentAgentStatusIncompatibleError) as exc_info:
                await node(base_designer_state)

            assert exc_info.value.http_status == 409
