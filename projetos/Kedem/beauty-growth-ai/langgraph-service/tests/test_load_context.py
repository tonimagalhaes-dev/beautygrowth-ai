"""Unit tests for the load_context node of the Content Agent workflow.

Tests cover:
- Business Memory loading with proper data extraction
- tom_de_voz precondition validation (BrandIdentityMissingError / HTTP 412)
- Knowledge Hub semantic search via Qdrant
- Refinement: loading original execution from Agent Memory
- publicoAlvoOverride substitution
- ContextLoadError (HTTP 503) when dependencies fail
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.exceptions import BrandIdentityMissingError, ContextLoadError
from src.workflows.content_agent import (
    ContentAgentState,
    make_load_context,
    _load_business_memory,
    _search_knowledge_hub,
    _load_original_execution,
)


# --- Fixtures ---


@pytest.fixture
def tenant_id() -> str:
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def base_state(tenant_id: str) -> ContentAgentState:
    """Minimal valid state for load_context."""
    return {
        "tenant_id": tenant_id,
        "user_id": "user-001",
        "trace_id": "trace-001",
        "execution_id": "exec-001",
        "briefing": {
            "tema": "Botox para rugas",
            "procedimento": "botox-facial",
            "publico_alvo_override": None,
            "redes_sociais": ["instagram"],
            "idioma": "pt-BR",
        },
        "is_refinement": False,
        "original_execution_id": None,
        "refinement_instructions": None,
        "version": 1,
        "brand_identity": {},
        "publico_alvo": "",
        "especialidades": [],
        "diferenciais": [],
        "knowledge_chunks": [],
        "system_prompt": "",
        "task_prompt": "",
        "legendas": {},
        "hashtags": [],
        "sugestoes_visuais": {},
        "model_id": "",
        "used_fallback": False,
        "guardrail_attempt": 0,
        "guardrail_violations": [],
        "blocked_reason": None,
        "steps": [],
        "tokens_input": 0,
        "tokens_output": 0,
        "output": "",
    }


@pytest.fixture
def business_memory_rows() -> list[dict]:
    """Sample business_memory_entries rows."""
    return [
        {"category": "brand_identity", "key": "tom_de_voz", "value": "Profissional e acolhedor"},
        {"category": "brand_identity", "key": "valores", "value": "Inovacao, Cuidado, Excelencia"},
        {"category": "brand_identity", "key": "paleta_cores", "value": "#FF6B9D, #4A90D9, #FFFFFF"},
        {"category": "publico_alvo", "key": "principal", "value": "Mulheres 30-55 anos, classe A/B"},
        {"category": "especialidades", "key": "botox", "value": "Toxina botulinica"},
        {"category": "especialidades", "key": "preenchimento", "value": "Acido hialuronico"},
        {"category": "diferenciais", "key": "tech", "value": "Tecnologia de ponta"},
        {"category": "diferenciais", "key": "atendimento", "value": "Atendimento personalizado"},
    ]


@dataclass
class FakeQdrantPoint:
    """Simulates a Qdrant ScoredPoint result."""

    score: float
    payload: dict[str, Any]


@pytest.fixture
def mock_qdrant_results() -> list[FakeQdrantPoint]:
    """Simulated Qdrant search results."""
    return [
        FakeQdrantPoint(
            score=0.92,
            payload={
                "content": "O Botox e um procedimento estetico...",
                "category": "procedures",
                "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
                "document_id": "doc-001",
            },
        ),
        FakeQdrantPoint(
            score=0.85,
            payload={
                "content": "Marketing de procedimentos esteticos deve...",
                "category": "marketing",
                "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
                "document_id": "doc-002",
            },
        ),
    ]


@pytest.fixture
def mock_embed_fn():
    """Mock embedding function that returns a fake vector."""

    async def embed(text: str) -> list[float]:
        return [0.1] * 1536

    return embed


# --- Tests for _load_business_memory ---


class TestLoadBusinessMemory:
    async def test_extracts_brand_identity_fields(self, business_memory_rows):
        """Should extract tom_de_voz, valores, paleta_cores from brand_identity category."""
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=business_memory_rows)

        result = await _load_business_memory(conn, "tenant-1")

        assert result["tom_de_voz"] == "Profissional e acolhedor"
        assert result["valores"] == "Inovacao, Cuidado, Excelencia"
        assert result["paleta_cores"] == "#FF6B9D, #4A90D9, #FFFFFF"

    async def test_extracts_publico_alvo(self, business_memory_rows):
        """Should extract publico_alvo from its category."""
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=business_memory_rows)

        result = await _load_business_memory(conn, "tenant-1")

        assert result["publico_alvo"] == "Mulheres 30-55 anos, classe A/B"

    async def test_collects_especialidades_as_list(self, business_memory_rows):
        """Should collect all especialidades into a list."""
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=business_memory_rows)

        result = await _load_business_memory(conn, "tenant-1")

        assert "Toxina botulinica" in result["especialidades"]
        assert "Acido hialuronico" in result["especialidades"]
        assert len(result["especialidades"]) == 2

    async def test_collects_diferenciais_as_list(self, business_memory_rows):
        """Should collect all diferenciais into a list."""
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=business_memory_rows)

        result = await _load_business_memory(conn, "tenant-1")

        assert "Tecnologia de ponta" in result["diferenciais"]
        assert "Atendimento personalizado" in result["diferenciais"]

    async def test_returns_none_for_missing_fields(self):
        """Should return None for missing brand_identity fields."""
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=[])

        result = await _load_business_memory(conn, "tenant-1")

        assert result["tom_de_voz"] is None
        assert result["valores"] is None
        assert result["paleta_cores"] is None
        assert result["publico_alvo"] is None
        assert result["especialidades"] == []
        assert result["diferenciais"] == []


# --- Tests for _search_knowledge_hub ---


class TestSearchKnowledgeHub:
    async def test_returns_formatted_chunks(self, mock_qdrant_results, mock_embed_fn):
        """Should return chunks with content, score, category, metadata."""
        qdrant = AsyncMock()
        qdrant.search = AsyncMock(return_value=mock_qdrant_results)

        chunks = await _search_knowledge_hub(
            qdrant_client=qdrant,
            embed_fn=mock_embed_fn,
            tenant_id="tenant-1",
            query_text="Botox para rugas",
        )

        assert len(chunks) == 2
        assert chunks[0]["content"] == "O Botox e um procedimento estetico..."
        assert chunks[0]["score"] == 0.92
        assert chunks[0]["category"] == "procedures"
        assert "document_id" in chunks[0]["metadata"]

    async def test_excludes_tenant_id_from_metadata(self, mock_qdrant_results, mock_embed_fn):
        """Should not include tenant_id in chunk metadata."""
        qdrant = AsyncMock()
        qdrant.search = AsyncMock(return_value=mock_qdrant_results)

        chunks = await _search_knowledge_hub(
            qdrant_client=qdrant,
            embed_fn=mock_embed_fn,
            tenant_id="tenant-1",
            query_text="Botox",
        )

        for chunk in chunks:
            assert "tenant_id" not in chunk["metadata"]

    async def test_passes_correct_filter_and_limit(self, mock_embed_fn):
        """Should pass tenant_id filter and limit=5 to qdrant.search."""
        qdrant = AsyncMock()
        qdrant.search = AsyncMock(return_value=[])

        await _search_knowledge_hub(
            qdrant_client=qdrant,
            embed_fn=mock_embed_fn,
            tenant_id="my-tenant",
            query_text="test query",
            top_k=5,
        )

        call_kwargs = qdrant.search.call_args.kwargs
        assert call_kwargs["limit"] == 5
        assert call_kwargs["with_payload"] is True

        # Verify filter contains tenant_id
        search_filter = call_kwargs["query_filter"]
        tenant_conditions = [
            c for c in search_filter.must
            if c.key == "tenant_id"
        ]
        assert len(tenant_conditions) == 1

    async def test_calls_embed_fn_with_query_text(self, mock_embed_fn):
        """Should call embed_fn with the provided query text."""
        qdrant = AsyncMock()
        qdrant.search = AsyncMock(return_value=[])

        called_with = []
        original_embed = mock_embed_fn

        async def tracking_embed(text: str) -> list[float]:
            called_with.append(text)
            return await original_embed(text)

        await _search_knowledge_hub(
            qdrant_client=qdrant,
            embed_fn=tracking_embed,
            tenant_id="tenant-1",
            query_text="Botox facial",
        )

        assert called_with == ["Botox facial"]


# --- Tests for _load_original_execution ---


class TestLoadOriginalExecution:
    async def test_returns_execution_context(self):
        """Should return original execution fields when found."""
        row = {
            "briefing": '{"tema": "Botox"}',
            "context_data": '{"brand": "..."}',
            "generated_content": "Legenda sobre botox...",
            "version": 2,
        }
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=row)

        result = await _load_original_execution(conn, "exec-001")

        assert result["original_briefing"] == '{"tema": "Botox"}'
        assert result["original_content"] == "Legenda sobre botox..."
        assert result["original_version"] == 2

    async def test_returns_empty_dict_when_not_found(self):
        """Should return empty dict when execution_id not found."""
        conn = AsyncMock()
        conn.fetchrow = AsyncMock(return_value=None)

        result = await _load_original_execution(conn, "nonexistent-exec")

        assert result == {}


# --- Tests for make_load_context (integration via factory) ---


class TestMakeLoadContext:
    """Tests for the full load_context node via factory pattern."""

    async def test_happy_path_returns_all_context_fields(
        self, base_state, tenant_id, business_memory_rows, mock_qdrant_results, mock_embed_fn
    ):
        """Should return brand_identity, publico_alvo, especialidades, diferenciais, knowledge_chunks."""
        # Mock pg_pool + tenant_connection
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=business_memory_rows)

        mock_pool = MagicMock()

        # Mock Qdrant
        mock_qdrant = AsyncMock()
        mock_qdrant.search = AsyncMock(return_value=mock_qdrant_results)

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            result = await load_context(base_state)

        assert result["brand_identity"]["tom_de_voz"] == "Profissional e acolhedor"
        assert result["brand_identity"]["valores"] == "Inovacao, Cuidado, Excelencia"
        assert result["publico_alvo"] == "Mulheres 30-55 anos, classe A/B"
        assert len(result["especialidades"]) == 2
        assert len(result["diferenciais"]) == 2
        assert len(result["knowledge_chunks"]) == 2

    async def test_raises_brand_identity_missing_when_no_tom_de_voz(
        self, base_state, mock_qdrant_results, mock_embed_fn
    ):
        """Should raise BrandIdentityMissingError (HTTP 412) when tom_de_voz is missing."""
        # Business Memory without tom_de_voz
        rows_without_tom = [
            {"category": "brand_identity", "key": "valores", "value": "Cuidado"},
            {"category": "publico_alvo", "key": "principal", "value": "Mulheres 30+"},
        ]

        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=rows_without_tom)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            with pytest.raises(BrandIdentityMissingError) as exc_info:
                await load_context(base_state)

            assert exc_info.value.http_status == 412
            assert base_state["tenant_id"] in str(exc_info.value)

    async def test_raises_brand_identity_missing_when_tom_de_voz_whitespace(
        self, base_state, mock_embed_fn
    ):
        """Should raise BrandIdentityMissingError when tom_de_voz is whitespace-only."""
        rows = [
            {"category": "brand_identity", "key": "tom_de_voz", "value": "   "},
        ]

        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=rows)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            with pytest.raises(BrandIdentityMissingError):
                await load_context(base_state)

    async def test_publico_alvo_override_replaces_business_memory(
        self, base_state, business_memory_rows, mock_qdrant_results, mock_embed_fn
    ):
        """Should use publicoAlvoOverride from briefing instead of Business Memory value."""
        base_state["briefing"]["publico_alvo_override"] = "Homens 25-40 anos"

        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=business_memory_rows)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()
        mock_qdrant.search = AsyncMock(return_value=mock_qdrant_results)

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            result = await load_context(base_state)

        assert result["publico_alvo"] == "Homens 25-40 anos"

    async def test_refinement_loads_original_execution(
        self, base_state, business_memory_rows, mock_qdrant_results, mock_embed_fn
    ):
        """Should load original execution context when is_refinement=True."""
        base_state["is_refinement"] = True
        base_state["original_execution_id"] = "original-exec-001"

        original_row = {
            "briefing": '{"tema": "Botox original"}',
            "context_data": '{"brand": "original"}',
            "generated_content": "Legenda original sobre botox",
            "version": 1,
        }

        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=business_memory_rows)
        mock_conn.fetchrow = AsyncMock(return_value=original_row)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()
        mock_qdrant.search = AsyncMock(return_value=mock_qdrant_results)

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            result = await load_context(base_state)

        # Should have knowledge_chunks from Qdrant + refinement context
        refinement_chunks = [
            c for c in result["knowledge_chunks"]
            if c["category"] == "refinement_context"
        ]
        assert len(refinement_chunks) == 1
        assert "Legenda original sobre botox" in refinement_chunks[0]["content"]

    async def test_context_load_error_on_pg_failure(
        self, base_state, mock_embed_fn
    ):
        """Should raise ContextLoadError (HTTP 503) when PostgreSQL is unavailable."""
        import asyncpg

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(
                side_effect=OSError("Connection refused")
            )
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            with pytest.raises(ContextLoadError) as exc_info:
                await load_context(base_state)

            assert exc_info.value.http_status == 503
            assert exc_info.value.service == "business_memory"

    async def test_context_load_error_on_qdrant_failure(
        self, base_state, business_memory_rows, mock_embed_fn
    ):
        """Should raise ContextLoadError (HTTP 503) when Qdrant is unavailable."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=business_memory_rows)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()
        mock_qdrant.search = AsyncMock(side_effect=ConnectionError("Qdrant down"))

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            with pytest.raises(ContextLoadError) as exc_info:
                await load_context(base_state)

            assert exc_info.value.http_status == 503
            assert exc_info.value.service == "knowledge_hub"

    async def test_knowledge_hub_zero_chunks_proceeds_normally(
        self, base_state, business_memory_rows, mock_embed_fn
    ):
        """Should proceed with empty knowledge_chunks when Qdrant returns no results."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=business_memory_rows)

        mock_pool = MagicMock()
        mock_qdrant = AsyncMock()
        mock_qdrant.search = AsyncMock(return_value=[])

        with patch(
            "src.workflows.content_agent.tenant_connection"
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            load_context = make_load_context(
                pg_pool=mock_pool,
                qdrant_client=mock_qdrant,
                embed_fn=mock_embed_fn,
            )

            result = await load_context(base_state)

        assert result["knowledge_chunks"] == []
        # Should still return brand_identity and other fields
        assert result["brand_identity"]["tom_de_voz"] == "Profissional e acolhedor"
