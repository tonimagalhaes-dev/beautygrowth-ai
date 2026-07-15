"""Tests for the Designer Agent load_context node implementation.

Tests cover:
- Loading brand identity from Business Memory (paleta_cores, estilo_visual, valores, etc.)
- Default color palette when paleta_cores is absent
- brand_identity_defaults_used flag
- Clinic logo URL loading when aplicar_logo_overlay is true
- 10-second timeout enforcement on Business Memory
- ContextLoadError on connection failure
- Initialization of warnings, steps, knowledge_chunks, edit_history
"""

import asyncio
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.core.exceptions import ContextLoadError
from src.workflows.designer_agent import (
    DEFAULT_COLOR_PALETTE,
    BUSINESS_MEMORY_TIMEOUT_SECONDS,
    DesignerAgentState,
    build_designer_agent_graph,
    load_context,
    make_load_context,
    _load_designer_business_memory,
)


# --- Helper to build minimal state ---


def _make_state(
    tenant_id: str = "tenant-123",
    user_id: str = "user-456",
    trace_id: str = "trace-789",
    execution_id: str = "exec-001",
    aplicar_logo_overlay: bool = False,
    descricao_visual: str = "Uma imagem elegante",
    redes_sociais: Optional[list] = None,
) -> dict:
    """Build a minimal state dict for testing load_context."""
    return {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "trace_id": trace_id,
        "execution_id": execution_id,
        "request": {
            "descricao_visual": descricao_visual,
            "redes_sociais": redes_sociais or ["instagram"],
            "aplicar_logo_overlay": aplicar_logo_overlay,
        },
        "is_edit": False,
        "original_execution_id": None,
        "edit_instruction": None,
        "target_social": None,
        "version": 1,
    }


# --- Fake asyncpg fixtures ---


class FakeConnection:
    """Simulates an asyncpg.Connection for testing."""

    def __init__(self, rows: list[dict]):
        self._rows = rows

    async def fetch(self, query: str, *args):
        return [FakeRow(r) for r in self._rows]

    async def execute(self, query: str, *args):
        pass


class FakeRow(dict):
    """Dict-like object supporting row['key'] access."""

    def __getitem__(self, key):
        return dict.__getitem__(self, key)


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


# --- Tests ---


class TestLoadDesignerBusinessMemory:
    """Tests for _load_designer_business_memory helper."""

    @pytest.mark.asyncio
    async def test_loads_paleta_cores(self):
        """Should load paleta_cores from brand category."""
        rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FF0000", "#00FF00"]},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["paleta_cores"] == ["#FF0000", "#00FF00"]

    @pytest.mark.asyncio
    async def test_loads_estilo_visual(self):
        """Should load estilo_visual from brand category."""
        rows = [
            {"category": "brand", "key": "estilo_visual", "value": "minimalista"},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["estilo_visual"] == "minimalista"

    @pytest.mark.asyncio
    async def test_loads_valores(self):
        """Should load valores from brand category."""
        rows = [
            {"category": "brand", "key": "valores", "value": ["Segurança", "Ética"]},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["valores"] == ["Segurança", "Ética"]

    @pytest.mark.asyncio
    async def test_loads_elementos_recorrentes(self):
        """Should load elementos_recorrentes from brand category."""
        rows = [
            {"category": "brand", "key": "elementos_recorrentes", "value": ["folhas", "círculos"]},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["elementos_recorrentes"] == ["folhas", "círculos"]

    @pytest.mark.asyncio
    async def test_loads_nome_clinica(self):
        """Should load nome_clinica from brand category."""
        rows = [
            {"category": "brand", "key": "nome_clinica", "value": "Clínica Bela"},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["nome_clinica"] == "Clínica Bela"

    @pytest.mark.asyncio
    async def test_loads_logo_url(self):
        """Should load logo_url from brand category."""
        rows = [
            {"category": "brand", "key": "logo_url", "value": "https://minio.local/logo.png"},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["logo_url"] == "https://minio.local/logo.png"

    @pytest.mark.asyncio
    async def test_returns_none_for_missing_fields(self):
        """Should return None for all fields when no rows exist."""
        conn = FakeConnection([])
        result = await _load_designer_business_memory(conn)
        assert result["paleta_cores"] is None
        assert result["estilo_visual"] is None
        assert result["valores"] is None
        assert result["elementos_recorrentes"] is None
        assert result["nome_clinica"] is None
        assert result["logo_url"] is None

    @pytest.mark.asyncio
    async def test_supports_english_key_variants(self):
        """Should accept English key names (color_palette, visual_style, etc.)."""
        rows = [
            {"category": "brand", "key": "color_palette", "value": ["#AAA"]},
            {"category": "brand", "key": "visual_style", "value": "moderno"},
            {"category": "brand", "key": "values", "value": ["Qualidade"]},
            {"category": "brand", "key": "recurring_elements", "value": ["linhas"]},
            {"category": "brand", "key": "clinic_name", "value": "My Clinic"},
            {"category": "brand", "key": "clinic_logo", "value": "https://logo.png"},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["paleta_cores"] == ["#AAA"]
        assert result["estilo_visual"] == "moderno"
        assert result["valores"] == ["Qualidade"]
        assert result["elementos_recorrentes"] == ["linhas"]
        assert result["nome_clinica"] == "My Clinic"
        assert result["logo_url"] == "https://logo.png"

    @pytest.mark.asyncio
    async def test_estilo_visual_from_preferences(self):
        """Should fallback to preferences category for estilo_visual."""
        rows = [
            {"category": "preferences", "key": "estilo_visual", "value": "vintage"},
        ]
        conn = FakeConnection(rows)
        result = await _load_designer_business_memory(conn)
        assert result["estilo_visual"] == "vintage"


class TestMakeLoadContext:
    """Tests for the make_load_context factory and the resulting node function."""

    @pytest.mark.asyncio
    async def test_loads_brand_identity_with_paleta(self):
        """Should load brand identity and NOT set defaults_used when paleta exists."""
        rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#D4A574", "#F5E6D3"]},
            {"category": "brand", "key": "estilo_visual", "value": "elegante"},
            {"category": "brand", "key": "valores", "value": ["Excelência"]},
            {"category": "brand", "key": "elementos_recorrentes", "value": ["flores"]},
            {"category": "brand", "key": "nome_clinica", "value": "Clínica Zen"},
        ]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["brand_identity"]["paleta_cores"] == ["#D4A574", "#F5E6D3"]
        assert result["brand_identity"]["estilo_visual"] == "elegante"
        assert result["brand_identity"]["valores"] == ["Excelência"]
        assert result["brand_identity"]["elementos_recorrentes"] == ["flores"]
        assert result["brand_identity"]["nome_clinica"] == "Clínica Zen"
        assert result["brand_identity_defaults_used"] is False

    @pytest.mark.asyncio
    async def test_uses_default_palette_when_paleta_absent(self):
        """Should use default colors and set flag when paleta_cores is absent."""
        rows = [
            {"category": "brand", "key": "nome_clinica", "value": "Clínica Sem Paleta"},
        ]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["brand_identity"]["paleta_cores"] == DEFAULT_COLOR_PALETTE
        assert result["brand_identity_defaults_used"] is True
        assert any("#FFFFFF" in w and "#9E9E9E" in w and "#D4AF37" in w for w in result["warnings"])

    @pytest.mark.asyncio
    async def test_uses_default_palette_when_paleta_is_empty_list(self):
        """Should use defaults when paleta_cores is an empty list (falsy)."""
        rows = [
            {"category": "brand", "key": "paleta_cores", "value": []},
        ]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["brand_identity"]["paleta_cores"] == DEFAULT_COLOR_PALETTE
        assert result["brand_identity_defaults_used"] is True

    @pytest.mark.asyncio
    async def test_clinic_logo_loaded_when_overlay_requested(self):
        """Should include clinic_logo_url when aplicar_logo_overlay is true."""
        rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FFF"]},
            {"category": "brand", "key": "logo_url", "value": "https://minio/logo.png"},
        ]
        state = _make_state(aplicar_logo_overlay=True)

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["clinic_logo_url"] == "https://minio/logo.png"

    @pytest.mark.asyncio
    async def test_clinic_logo_none_when_overlay_not_requested(self):
        """Should NOT load logo when aplicar_logo_overlay is false."""
        rows = [
            {"category": "brand", "key": "paleta_cores", "value": ["#FFF"]},
            {"category": "brand", "key": "logo_url", "value": "https://minio/logo.png"},
        ]
        state = _make_state(aplicar_logo_overlay=False)

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["clinic_logo_url"] is None

    @pytest.mark.asyncio
    async def test_timeout_raises_context_load_error(self):
        """Should raise ContextLoadError (503) when Business Memory exceeds 10s."""
        state = _make_state()

        async def _slow_fetch(*args, **kwargs):
            await asyncio.sleep(20)  # Longer than timeout

        with patch("src.workflows.designer_agent._fetch_business_memory", side_effect=_slow_fetch):
            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)

            with pytest.raises(ContextLoadError) as exc_info:
                await node_fn(state)

            assert exc_info.value.http_status == 503
            assert "business_memory" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_connection_error_raises_context_load_error(self):
        """Should raise ContextLoadError (503) on asyncpg connection failure."""
        import asyncpg

        state = _make_state()

        with patch(
            "src.workflows.designer_agent._fetch_business_memory",
            side_effect=OSError("Connection refused"),
        ):
            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)

            with pytest.raises(ContextLoadError) as exc_info:
                await node_fn(state)

            assert exc_info.value.http_status == 503

    @pytest.mark.asyncio
    async def test_initializes_empty_knowledge_chunks(self):
        """Should initialize knowledge_chunks as empty list."""
        rows = [{"category": "brand", "key": "paleta_cores", "value": ["#FFF"]}]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["knowledge_chunks"] == []

    @pytest.mark.asyncio
    async def test_initializes_empty_edit_history(self):
        """Should initialize edit_history as empty list."""
        rows = [{"category": "brand", "key": "paleta_cores", "value": ["#FFF"]}]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert result["edit_history"] == []

    @pytest.mark.asyncio
    async def test_records_step_metadata(self):
        """Should record a step with node name and duration_ms."""
        rows = [{"category": "brand", "key": "paleta_cores", "value": ["#FFF"]}]
        state = _make_state()

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_conn = FakeConnection(rows)
            mock_tc.return_value = _async_ctx_manager(mock_conn)

            pool = MagicMock()
            node_fn = make_load_context(pg_pool=pool)
            result = await node_fn(state)

        assert len(result["steps"]) == 1
        step = result["steps"][0]
        assert step["node"] == "load_context"
        assert step["action"] == "load_business_memory"
        assert "duration_ms" in step
        assert isinstance(step["duration_ms"], int)


class TestLoadContextStub:
    """Tests for the standalone load_context stub."""

    @pytest.mark.asyncio
    async def test_stub_returns_empty_dict(self):
        """Standalone stub returns empty dict when no deps injected."""
        state = _make_state()
        result = await load_context(state)
        assert result == {}


class TestBuildDesignerAgentGraph:
    """Tests for graph construction with optional pg_pool."""

    def test_graph_compiles_without_deps(self):
        """Graph compiles successfully without any dependencies (uses stubs)."""
        graph = build_designer_agent_graph()
        assert graph is not None
        assert hasattr(graph, "ainvoke")

    def test_graph_has_correct_nodes(self):
        """Graph contains all 6 expected nodes plus __start__."""
        graph = build_designer_agent_graph()
        node_names = set(graph.nodes.keys())
        expected = {
            "load_context", "build_visual_prompt", "validate_guardrails_pre",
            "generate_images", "post_process", "upload_and_persist", "__start__",
        }
        assert expected.issubset(node_names)


class TestDefaultColorPalette:
    """Tests for the default color palette constants."""

    def test_default_palette_has_three_colors(self):
        """Default palette should contain exactly 3 colors."""
        assert len(DEFAULT_COLOR_PALETTE) == 3

    def test_default_palette_values(self):
        """Default palette should be white, gray, gold as per requirements."""
        assert "#FFFFFF" in DEFAULT_COLOR_PALETTE  # branco
        assert "#9E9E9E" in DEFAULT_COLOR_PALETTE  # cinza
        assert "#D4AF37" in DEFAULT_COLOR_PALETTE  # dourado

    def test_timeout_is_10_seconds(self):
        """Business Memory timeout should be 10 seconds per requirements."""
        assert BUSINESS_MEMORY_TIMEOUT_SECONDS == 10


# --- Test helpers ---


class _AsyncCtxManager:
    """Helper to create async context managers for testing."""

    def __init__(self, value):
        self._value = value

    async def __aenter__(self):
        return self._value

    async def __aexit__(self, *args):
        pass


def _async_ctx_manager(value):
    """Create a simple async context manager returning `value`."""
    return _AsyncCtxManager(value)
