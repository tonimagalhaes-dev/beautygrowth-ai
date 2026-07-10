"""Tests for the generate_content node implementation.

Tests cover:
- make_generate_content factory with mocked LLM client and database
- Primary model success
- Primary model failure with fallback success
- Both models failing → LLMUnavailableError (503)
- LLM response parsing (_parse_llm_response)
- Character limit truncation (_truncate_legenda)
- Hashtag validation (_validate_hashtags)
- Token accumulation across retries
- Model config loading (_get_model_config)
"""

from __future__ import annotations

import json
from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.content_agent import (
    LLMResponse,
    LLMUnavailableError,
    CHAR_LIMITS,
    MIN_HASHTAGS,
    MAX_HASHTAGS,
    _truncate_legenda,
    _validate_hashtags,
    _parse_llm_response,
    _get_model_config,
    make_generate_content,
)


# --- Helper functions ---


def _make_mock_fetchrow(primary_name="gpt-4o", fallback_name="gpt-4o-mini", temperature=0.7, max_tokens=4096):
    async def mock_fetchrow(query, *args):
        query_upper = query.upper()
        if "AGENT_CONFIGS" in query_upper:
            if not primary_name and not fallback_name:
                return None
            return {
                "model_id": "primary-id" if primary_name else None,
                "fallback_model_id": "fallback-id" if fallback_name else None,
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
        elif "AI_MODELS" in query_upper:
            model_id = args[0]
            if model_id == "primary-id":
                return {"name": primary_name}
            elif model_id == "fallback-id":
                return {"name": fallback_name}
            return None
        return None
    return mock_fetchrow


def _make_llm_response_json(
    redes_sociais: Optional[List[str]] = None,
    hashtag_count: int = 10,
    legenda_text: str = "Uma legenda de exemplo para a rede social.",
) -> str:
    """Create a valid LLM JSON response string."""
    if redes_sociais is None:
        redes_sociais = ["instagram"]

    legendas = {rede: legenda_text for rede in redes_sociais}
    hashtags = [f"#tag{i}" for i in range(hashtag_count)]

    formatos = {
        "instagram": "1:1",
        "facebook": "1.91:1",
        "tiktok": "9:16",
    }
    sugestoes_visuais = {
        rede: {"formato": formatos.get(rede, "1:1"), "descricao": "Visual sugerido"}
        for rede in redes_sociais
    }

    return json.dumps({
        "legendas": legendas,
        "hashtags": hashtags,
        "sugestoes_visuais": sugestoes_visuais,
    })


def _make_state(**overrides) -> dict:
    """Create a minimal ContentAgentState for testing."""
    state = {
        "tenant_id": "tenant-123",
        "user_id": "user-456",
        "trace_id": "trace-789",
        "execution_id": "exec-001",
        "briefing": {
            "tema": "Benefícios do Botox",
            "procedimento": "Toxina Botulínica",
            "redes_sociais": ["instagram", "facebook"],
            "idioma": "pt-BR",
        },
        "system_prompt": "Você é um assistente de conteúdo.",
        "task_prompt": "Gere legendas para Instagram e Facebook sobre Botox.",
        "tokens_input": 0,
        "tokens_output": 0,
    }
    state.update(overrides)
    return state


def _make_mock_llm_client(
    response_content: Optional[str] = None,
    redes: Optional[List[str]] = None,
    should_raise: bool = False,
    raise_on_model: Optional[str] = None,
) -> AsyncMock:
    """Create a mock LLM client.

    Args:
        response_content: JSON string to return. If None, generates a default.
        redes: Social networks for default response generation.
        should_raise: If True, raises on all calls.
        raise_on_model: Model name that should raise an exception.
    """
    if redes is None:
        redes = ["instagram", "facebook"]
    if response_content is None:
        response_content = _make_llm_response_json(redes)

    async def mock_client(system_prompt, task_prompt, model_name, temperature, max_tokens):
        if should_raise:
            raise ConnectionError(f"Model {model_name} is unavailable")
        if raise_on_model and model_name == raise_on_model:
            raise ConnectionError(f"Model {model_name} is unavailable")
        return LLMResponse(
            content=response_content,
            input_tokens=150,
            output_tokens=500,
            model_id=model_name,
        )

    return AsyncMock(side_effect=mock_client)


# --- Tests for _truncate_legenda ---


class TestTruncateLegenda:
    """Tests for character limit truncation."""

    def test_instagram_within_limit(self):
        """Text within 2200 chars is not truncated."""
        text = "A" * 2200
        result = _truncate_legenda(text, "instagram")
        assert len(result) == 2200

    def test_instagram_exceeds_limit(self):
        """Text exceeding 2200 chars is truncated."""
        text = "A" * 2500
        result = _truncate_legenda(text, "instagram")
        assert len(result) == 2200

    def test_facebook_within_limit(self):
        """Facebook text within 63206 chars is not truncated."""
        text = "B" * 63206
        result = _truncate_legenda(text, "facebook")
        assert len(result) == 63206

    def test_facebook_exceeds_limit(self):
        """Facebook text exceeding 63206 chars is truncated."""
        text = "B" * 64000
        result = _truncate_legenda(text, "facebook")
        assert len(result) == 63206

    def test_tiktok_within_limit(self):
        """TikTok text within 2200 chars is not truncated."""
        text = "C" * 2200
        result = _truncate_legenda(text, "tiktok")
        assert len(result) == 2200

    def test_tiktok_exceeds_limit(self):
        """TikTok text exceeding 2200 chars is truncated."""
        text = "C" * 3000
        result = _truncate_legenda(text, "tiktok")
        assert len(result) == 2200

    def test_unknown_rede_no_truncation(self):
        """Unknown network has no limit applied."""
        text = "D" * 100000
        result = _truncate_legenda(text, "unknown_network")
        assert len(result) == 100000

    def test_empty_text(self):
        """Empty text remains empty."""
        result = _truncate_legenda("", "instagram")
        assert result == ""


# --- Tests for _validate_hashtags ---


class TestValidateHashtags:
    """Tests for hashtag count validation."""

    def test_valid_count_unchanged(self):
        """Hashtag list within 5-15 range is unchanged."""
        hashtags = [f"#tag{i}" for i in range(10)]
        result = _validate_hashtags(hashtags)
        assert result == hashtags

    def test_exactly_5_unchanged(self):
        """Exactly 5 hashtags is valid (minimum)."""
        hashtags = [f"#tag{i}" for i in range(5)]
        result = _validate_hashtags(hashtags)
        assert len(result) == 5

    def test_exactly_15_unchanged(self):
        """Exactly 15 hashtags is valid (maximum)."""
        hashtags = [f"#tag{i}" for i in range(15)]
        result = _validate_hashtags(hashtags)
        assert len(result) == 15

    def test_too_many_truncated(self):
        """More than 15 hashtags are truncated to 15."""
        hashtags = [f"#tag{i}" for i in range(20)]
        result = _validate_hashtags(hashtags)
        assert len(result) == MAX_HASHTAGS
        # First 15 are preserved
        assert result == hashtags[:15]

    def test_too_few_padded(self):
        """Fewer than 5 hashtags are padded with generic ones."""
        hashtags = ["#botox", "#estetica"]
        result = _validate_hashtags(hashtags.copy())
        assert len(result) >= MIN_HASHTAGS
        # Original hashtags are preserved
        assert "#botox" in result
        assert "#estetica" in result

    def test_empty_list_padded(self):
        """Empty hashtag list is padded to minimum."""
        result = _validate_hashtags([])
        assert len(result) >= MIN_HASHTAGS

    def test_padding_avoids_duplicates(self):
        """Padding does not introduce duplicates."""
        hashtags = ["#beleza", "#estetica"]
        result = _validate_hashtags(hashtags.copy())
        assert len(result) == len(set(result))


# --- Tests for _parse_llm_response ---


class TestParseLlmResponse:
    """Tests for parsing LLM response JSON."""

    def test_valid_json_parsed(self):
        """Valid JSON response is parsed correctly."""
        content = _make_llm_response_json(["instagram", "facebook"], hashtag_count=10)
        result = _parse_llm_response(content, ["instagram", "facebook"])

        assert "instagram" in result["legendas"]
        assert "facebook" in result["legendas"]
        assert len(result["hashtags"]) == 10
        assert "instagram" in result["sugestoes_visuais"]
        assert "facebook" in result["sugestoes_visuais"]

    def test_json_wrapped_in_markdown_code_block(self):
        """JSON wrapped in ```json ... ``` is parsed correctly."""
        raw = _make_llm_response_json(["instagram"])
        wrapped = f"```json\n{raw}\n```"
        result = _parse_llm_response(wrapped, ["instagram"])

        assert "instagram" in result["legendas"]

    def test_invalid_json_raises_value_error(self):
        """Non-JSON content raises ValueError."""
        with pytest.raises(ValueError, match="Failed to parse"):
            _parse_llm_response("This is not JSON", ["instagram"])

    def test_legendas_truncated_when_exceeding_limit(self):
        """Legendas exceeding char limits are truncated."""
        long_text = "A" * 3000
        content = json.dumps({
            "legendas": {"instagram": long_text},
            "hashtags": [f"#tag{i}" for i in range(10)],
            "sugestoes_visuais": {"instagram": {"formato": "1:1", "descricao": "test"}},
        })
        result = _parse_llm_response(content, ["instagram"])
        assert len(result["legendas"]["instagram"]) == 2200

    def test_missing_rede_gets_empty_string(self):
        """Requested rede not in LLM response gets empty string."""
        content = json.dumps({
            "legendas": {"instagram": "only ig"},
            "hashtags": [f"#tag{i}" for i in range(10)],
            "sugestoes_visuais": {"instagram": {"formato": "1:1", "descricao": "test"}},
        })
        result = _parse_llm_response(content, ["instagram", "tiktok"])
        assert result["legendas"]["instagram"] == "only ig"
        assert result["legendas"]["tiktok"] == ""

    def test_sugestao_visual_descricao_truncated_to_200(self):
        """Sugestão visual descrição exceeding 200 chars is truncated."""
        long_desc = "X" * 300
        content = json.dumps({
            "legendas": {"instagram": "test"},
            "hashtags": [f"#tag{i}" for i in range(10)],
            "sugestoes_visuais": {
                "instagram": {"formato": "1:1", "descricao": long_desc}
            },
        })
        result = _parse_llm_response(content, ["instagram"])
        assert len(result["sugestoes_visuais"]["instagram"]["descricao"]) == 200

    def test_hashtags_validated_to_bounds(self):
        """Hashtags outside 5-15 range are adjusted."""
        # Too many
        content = json.dumps({
            "legendas": {"instagram": "test"},
            "hashtags": [f"#tag{i}" for i in range(20)],
            "sugestoes_visuais": {"instagram": {"formato": "1:1", "descricao": "ok"}},
        })
        result = _parse_llm_response(content, ["instagram"])
        assert len(result["hashtags"]) == MAX_HASHTAGS

    def test_hashtags_too_few_padded(self):
        """Too few hashtags in LLM response are padded."""
        content = json.dumps({
            "legendas": {"instagram": "test"},
            "hashtags": ["#one", "#two"],
            "sugestoes_visuais": {"instagram": {"formato": "1:1", "descricao": "ok"}},
        })
        result = _parse_llm_response(content, ["instagram"])
        assert len(result["hashtags"]) >= MIN_HASHTAGS


# --- Tests for _get_model_config ---


class TestGetModelConfig:
    """Tests for model configuration loading from database."""

    @pytest.mark.asyncio
    async def test_returns_primary_and_fallback(self):
        """Returns both primary and fallback when 2+ models configured."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", "gpt-4o-mini", 0.7, 4096))

        primary, fallback = await _get_model_config(mock_conn, "content")

        assert primary is not None
        assert primary["model_name"] == "gpt-4o"
        assert primary["temperature"] == 0.7
        assert primary["max_tokens"] == 4096

        assert fallback is not None
        assert fallback["model_name"] == "gpt-4o-mini"
        assert fallback["temperature"] == 0.7
        assert fallback["max_tokens"] == 4096

    @pytest.mark.asyncio
    async def test_returns_primary_only_when_single_model(self):
        """Returns primary and None fallback when only 1 model configured."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, 0.7, 4096))

        primary, fallback = await _get_model_config(mock_conn, "content")

        assert primary is not None
        assert primary["model_name"] == "gpt-4o"
        assert fallback is None

    @pytest.mark.asyncio
    async def test_returns_none_when_no_models(self):
        """Returns (None, None) when no models configured."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow(None, None))

        primary, fallback = await _get_model_config(mock_conn, "content")

        assert primary is None
        assert fallback is None

    @pytest.mark.asyncio
    async def test_defaults_temperature_and_max_tokens(self):
        """Uses defaults when temperature/max_tokens are None."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, None, None))

        primary, _ = await _get_model_config(mock_conn, "content")

        assert primary["temperature"] == 0.7
        assert primary["max_tokens"] == 4096


# --- Tests for make_generate_content ---


class TestMakeGenerateContent:
    """Tests for the make_generate_content factory function."""

    def _setup_mock_pool(self, model_rows):
        """Create mock pool that returns model config rows."""
        mock_conn = AsyncMock()
        primary_name = model_rows[0]["model_name"] if len(model_rows) > 0 else None
        fallback_name = model_rows[1]["model_name"] if len(model_rows) > 1 else None
        temp = model_rows[0].get("temperature", 0.7) if len(model_rows) > 0 else 0.7
        tokens = model_rows[0].get("max_tokens", 4096) if len(model_rows) > 0 else 4096
        
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow(primary_name, fallback_name, temp, tokens))
        mock_pool = MagicMock()
        return mock_pool, mock_conn

    @pytest.mark.asyncio
    async def test_primary_model_success(self):
        """Primary model succeeds — returns generated content."""
        redes = ["instagram", "facebook"]
        response_json = _make_llm_response_json(redes, hashtag_count=10)

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", "gpt-4o-mini", 0.7, 4096))

        mock_llm = _make_mock_llm_client(response_json, redes)

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)
            result = await node_fn(_make_state())

        assert "instagram" in result["legendas"]
        assert "facebook" in result["legendas"]
        assert len(result["hashtags"]) == 10
        assert result["model_id"] == "gpt-4o"
        assert result["used_fallback"] is False
        assert result["tokens_input"] == 150
        assert result["tokens_output"] == 500

    @pytest.mark.asyncio
    async def test_primary_fails_fallback_succeeds(self):
        """Primary model fails, fallback succeeds — used_fallback=True."""
        redes = ["instagram"]
        response_json = _make_llm_response_json(redes, hashtag_count=8)

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", "gpt-4o-mini", 0.7, 4096))

        # LLM client that fails on primary but succeeds on fallback
        mock_llm = _make_mock_llm_client(
            response_json, redes, raise_on_model="gpt-4o"
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)
            result = await node_fn(_make_state(briefing={
                "tema": "Test",
                "redes_sociais": ["instagram"],
                "idioma": "pt-BR",
            }))

        assert result["used_fallback"] is True
        assert result["model_id"] == "gpt-4o-mini"
        assert "instagram" in result["legendas"]

    @pytest.mark.asyncio
    async def test_both_models_fail_raises_503(self):
        """Both primary and fallback fail → LLMUnavailableError."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", "gpt-4o-mini", 0.7, 4096))

        mock_llm = _make_mock_llm_client(should_raise=True)

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)

            with pytest.raises(LLMUnavailableError) as exc_info:
                await node_fn(_make_state())

        assert exc_info.value.http_status == 503

    @pytest.mark.asyncio
    async def test_no_model_configured_raises_503(self):
        """No model configured in DB → LLMUnavailableError."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow(None, None))

        mock_llm = _make_mock_llm_client()

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)

            with pytest.raises(LLMUnavailableError):
                await node_fn(_make_state())

    @pytest.mark.asyncio
    async def test_primary_fails_no_fallback_raises_503(self):
        """Primary fails and no fallback configured → LLMUnavailableError."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, 0.7, 4096))

        mock_llm = _make_mock_llm_client(should_raise=True)

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)

            with pytest.raises(LLMUnavailableError) as exc_info:
                await node_fn(_make_state())

        assert "gpt-4o is unavailable" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_tokens_accumulate_on_retry(self):
        """Token counts accumulate across guardrail retries."""
        redes = ["instagram"]
        response_json = _make_llm_response_json(redes, hashtag_count=7)

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, 0.7, 4096))

        mock_llm = _make_mock_llm_client(response_json, redes)

        # Simulate state after a previous generation attempt (guardrail retry)
        state = _make_state(
            tokens_input=200,
            tokens_output=600,
            briefing={"tema": "Test", "redes_sociais": ["instagram"], "idioma": "pt-BR"},
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)
            result = await node_fn(state)

        # Should accumulate: 200 + 150 = 350 input, 600 + 500 = 1100 output
        assert result["tokens_input"] == 350
        assert result["tokens_output"] == 1100

    @pytest.mark.asyncio
    async def test_llm_called_with_correct_params(self):
        """LLM client is called with correct system_prompt, task_prompt, model config."""
        redes = ["instagram"]
        response_json = _make_llm_response_json(redes)

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, 0.65, 8192))

        mock_llm = _make_mock_llm_client(response_json, redes)

        state = _make_state(
            system_prompt="System test prompt",
            task_prompt="Task test prompt",
            briefing={"tema": "Test", "redes_sociais": ["instagram"], "idioma": "pt-BR"},
        )

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)
            await node_fn(state)

        # Verify LLM was called with correct args
        mock_llm.assert_called_once_with(
            "System test prompt",
            "Task test prompt",
            "gpt-4o",
            0.65,
            8192,
        )

    @pytest.mark.asyncio
    async def test_malformed_llm_response_raises_value_error(self):
        """Malformed LLM response that isn't JSON raises ValueError."""
        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=_make_mock_fetchrow("gpt-4o", None, 0.7, 4096))

        # LLM returns non-JSON content
        async def bad_llm(*args):
            return LLMResponse(
                content="This is not valid JSON at all",
                input_tokens=100,
                output_tokens=50,
                model_id="gpt-4o",
            )

        mock_llm = AsyncMock(side_effect=bad_llm)

        with patch("src.workflows.content_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_content(mock_pool, mock_llm)

            with pytest.raises(ValueError, match="Failed to parse"):
                await node_fn(_make_state())
