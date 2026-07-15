"""Tests for the Designer Agent generate_images node — partial and total failure handling.

Tests cover:
- Full success: all networks generate images successfully (primary model)
- Partial failure: 1 of 3 networks fails, others succeed (Req 3.6)
- Total failure: all networks fail after primary + fallback → AllNetworksFailedError (Req 3.7)
- Fallback: primary fails, fallback succeeds
- Timeout handling: primary times out, fallback succeeds
- generation_errors dict populated correctly for failed networks
- CRITICAL log on total failure (Req 10.3)
"""

import asyncio
from typing import Optional
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    AllNetworksFailedError,
    DEFAULT_IMAGE_MODEL,
    IMAGE_GENERATION_TIMEOUT_SECONDS,
    ImageGenerationError,
    ImageGenerationResponse,
    RESOLUTION_MAP,
    DesignerAgentState,
    make_generate_images,
)


# --- Helpers ---


def _make_state(
    tenant_id: str = "tenant-123",
    user_id: str = "user-456",
    trace_id: str = "trace-789",
    execution_id: str = "exec-001",
    visual_prompts: Optional[dict] = None,
    redes_sociais: Optional[list] = None,
    tokens_consumed: int = 0,
) -> dict:
    """Build a minimal state dict for testing generate_images."""
    prompts = visual_prompts or {"instagram": "Generate beautiful image for Instagram"}
    networks = redes_sociais or list(prompts.keys())
    return {
        "tenant_id": tenant_id,
        "user_id": user_id,
        "trace_id": trace_id,
        "execution_id": execution_id,
        "request": {
            "descricao_visual": "Uma imagem elegante",
            "redes_sociais": networks,
        },
        "is_edit": False,
        "original_execution_id": None,
        "edit_instruction": None,
        "target_social": None,
        "version": 1,
        "visual_prompts": prompts,
        "negative_prompts": ["Não incluir nudez"],
        "tokens_consumed": tokens_consumed,
        "brand_identity": {},
        "brand_identity_defaults_used": False,
        "clinic_logo_url": None,
        "content_agent_data": None,
        "knowledge_chunks": [],
        "edit_history": [],
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
        "duration_ms": 0,
        "warnings": [],
        "output": "",
    }


def _make_image_response(
    model_id: str = "gemini-3.1-flash-image",
    width: int = 1080,
    height: int = 1350,
    size: int = 1024,
) -> ImageGenerationResponse:
    """Create a successful ImageGenerationResponse."""
    return ImageGenerationResponse(
        image_bytes=b"\x89PNG\r\n\x1a\n" + b"\x00" * size,
        format="PNG",
        width=width,
        height=height,
        model_id=model_id,
        input_tokens=100,
        output_tokens=50,
    )


def _make_mock_pool(
    primary_name: str = "gemini-3.1-flash-image",
    fallback_name: Optional[str] = "gemini-3.1-pro-image",
):
    """Create a mock asyncpg pool that returns model config rows."""
    mock_conn = AsyncMock()

    async def mock_fetchrow(query, *args):
        query_upper = query.upper()
        if "AGENT_CONFIGS" in query_upper:
            if not primary_name and not fallback_name:
                return None
            return {
                "model_id": "primary-id" if primary_name else None,
                "fallback_model_id": "fallback-id" if fallback_name else None,
            }
        elif "AI_MODELS" in query_upper:
            model_id = args[0]
            if model_id == "primary-id":
                return {"name": primary_name}
            elif model_id == "fallback-id":
                return {"name": fallback_name}
            return None
        return None

    mock_conn.fetchrow = AsyncMock(side_effect=mock_fetchrow)
    mock_conn.execute = AsyncMock()

    mock_pool = MagicMock()
    return mock_pool, mock_conn


# --- Test Cases ---


class TestGenerateImagesFullSuccess:
    """Tests where all networks generate images successfully."""

    @pytest.mark.asyncio
    async def test_single_network_success(self):
        """Single network generates image successfully using primary model."""
        mock_pool, mock_conn = _make_mock_pool()
        response = _make_image_response(model_id="gemini-3.1-flash-image")

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            return response

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(visual_prompts={"instagram": "Beautiful image"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-3.1-flash-image"
        assert result["generated_images"]["instagram"]["format"] == "PNG"
        assert result["generation_errors"] == {}
        assert result["used_fallback"] is False
        assert result["model_id"] == "gemini-3.1-flash-image"

    @pytest.mark.asyncio
    async def test_multiple_networks_all_success(self):
        """All 3 networks generate images successfully in parallel."""
        mock_pool, mock_conn = _make_mock_pool()

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response(
                model_id=model_name, width=width, height=height
            )

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG prompt",
                "facebook": "FB prompt",
                "tiktok": "TT prompt",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        assert len(result["generated_images"]) == 3
        assert "instagram" in result["generated_images"]
        assert "facebook" in result["generated_images"]
        assert "tiktok" in result["generated_images"]
        assert result["generation_errors"] == {}
        assert result["used_fallback"] is False


class TestGenerateImagesPartialFailure:
    """Tests where some networks fail but at least one succeeds (Req 3.6).

    Validates: If at least one image generated successfully → continue
    with partial results + error status per failed network.
    """

    @pytest.mark.asyncio
    async def test_one_of_three_fails_continues_with_partial(self):
        """1 of 3 networks fails → continue with 2 successes + error for the failed one."""
        mock_pool, mock_conn = _make_mock_pool(fallback_name=None)

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if "TT prompt" in prompt:
                raise ConnectionError("Connection refused for TikTok generation")
            return _make_image_response(model_id=model_name, width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG prompt",
                "facebook": "FB prompt",
                "tiktok": "TT prompt",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        # 2 networks succeeded
        assert len(result["generated_images"]) == 2
        assert "instagram" in result["generated_images"]
        assert "facebook" in result["generated_images"]
        assert "tiktok" not in result["generated_images"]

        # 1 network failed with error recorded in generation_errors
        assert "tiktok" in result["generation_errors"]
        assert "Connection refused" in result["generation_errors"]["tiktok"]

    @pytest.mark.asyncio
    async def test_two_of_three_fail_one_succeeds(self):
        """2 of 3 networks fail → continue with the 1 success.

        Validates: at least one image generated → workflow continues normally.
        """
        mock_pool, mock_conn = _make_mock_pool(fallback_name=None)

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if "IG prompt" in prompt:
                return _make_image_response(model_id=model_name, width=width, height=height)
            raise RuntimeError("Model overloaded")

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG prompt",
                "facebook": "FB prompt",
                "tiktok": "TT prompt",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        # Only 1 network succeeded
        assert len(result["generated_images"]) == 1
        assert "instagram" in result["generated_images"]

        # 2 networks failed with errors recorded
        assert "facebook" in result["generation_errors"]
        assert "tiktok" in result["generation_errors"]

    @pytest.mark.asyncio
    async def test_partial_failure_with_fallback_recovery(self):
        """Primary fails for all, fallback succeeds for some → partial success with fallback flag."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            # Primary always fails
            if model_name == "gemini-primary":
                raise ConnectionError("Primary model down")
            # Fallback succeeds for instagram, fails for facebook
            if "FB prompt" in prompt:
                raise ConnectionError("Fallback also down for FB")
            return _make_image_response(model_id=model_name, width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG prompt",
                "facebook": "FB prompt",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        # Instagram succeeded via fallback
        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-fallback"
        # Facebook failed even with fallback
        assert "facebook" in result["generation_errors"]
        assert result["used_fallback"] is True


class TestGenerateImagesTotalFailure:
    """Tests where ALL networks fail → AllNetworksFailedError (Req 3.7).

    Validates: If all networks fail after primary + fallback → error 503 +
    register CRITICAL in Observability.
    """

    @pytest.mark.asyncio
    async def test_all_networks_fail_raises_503(self):
        """All networks fail after primary + fallback → AllNetworksFailedError."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            raise ConnectionError(f"Model {model_name} is completely down")

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG prompt",
                "facebook": "FB prompt",
                "tiktok": "TT prompt",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            with pytest.raises(AllNetworksFailedError) as exc_info:
                await node(state)

        assert exc_info.value.http_status == 503
        assert "instagram" in exc_info.value.errors
        assert "facebook" in exc_info.value.errors
        assert "tiktok" in exc_info.value.errors

    @pytest.mark.asyncio
    async def test_single_network_fails_no_fallback_raises_503(self):
        """Single network with no fallback fails → AllNetworksFailedError.

        When there's only one network and it fails with no fallback available,
        the error dict should contain that network's error.
        """
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name=None
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            raise RuntimeError("API unavailable")

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={"instagram": "IG prompt"}
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            with pytest.raises(AllNetworksFailedError) as exc_info:
                await node(state)

        assert exc_info.value.http_status == 503
        assert "instagram" in exc_info.value.errors

    @pytest.mark.asyncio
    async def test_total_failure_logs_critical(self):
        """Total failure triggers CRITICAL log for observability (Req 10.3)."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            raise ConnectionError("Service down")

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={"instagram": "IG prompt"},
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            with patch("src.workflows.designer_agent.logger") as mock_logger:
                with pytest.raises(AllNetworksFailedError):
                    await node(state)

                # Verify CRITICAL was logged
                mock_logger.critical.assert_called_once()
                call_args = mock_logger.critical.call_args
                assert "ALL networks failed" in call_args[0][0]

    @pytest.mark.asyncio
    async def test_all_networks_timeout_raises_503(self):
        """All networks timeout for both primary and fallback → AllNetworksFailedError."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            # Simulate a very long operation that exceeds timeout
            await asyncio.sleep(100)
            return _make_image_response()

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={"instagram": "IG prompt"}
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            # Patch the timeout to be very short for test speed
            with patch("src.workflows.designer_agent.IMAGE_GENERATION_TIMEOUT_SECONDS", 0.01):
                with pytest.raises(AllNetworksFailedError) as exc_info:
                    await node(state)

        assert exc_info.value.http_status == 503
        assert "instagram" in exc_info.value.errors
        assert "Timeout" in exc_info.value.errors["instagram"]


class TestGenerateImagesFallback:
    """Tests for primary → fallback model switching."""

    @pytest.mark.asyncio
    async def test_primary_fails_fallback_succeeds(self):
        """Primary model fails for a network, fallback succeeds → used_fallback=True."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if model_name == "gemini-primary":
                raise ConnectionError("Primary down")
            return _make_image_response(model_id="gemini-fallback", width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={"instagram": "IG prompt"}
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-fallback"
        assert result["used_fallback"] is True
        assert result["generation_errors"] == {}

    @pytest.mark.asyncio
    async def test_primary_timeout_fallback_succeeds(self):
        """Primary model times out, fallback succeeds within timeout."""
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if model_name == "gemini-primary":
                await asyncio.sleep(100)  # Would timeout
                return _make_image_response()
            return _make_image_response(model_id="gemini-fallback", width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(visual_prompts={"instagram": "IG prompt"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            with patch("src.workflows.designer_agent.IMAGE_GENERATION_TIMEOUT_SECONDS", 0.01):
                result = await node(state)

        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-fallback"
        assert result["used_fallback"] is True


class TestGenerateImagesModelRegistry:
    """Tests for Model Registry loading and defaults."""

    @pytest.mark.asyncio
    async def test_model_registry_not_configured_uses_default(self):
        """No model config in registry → uses DEFAULT_IMAGE_MODEL."""
        mock_pool, mock_conn = _make_mock_pool()
        # When no config found, fetchrow returns None
        mock_conn.fetchrow = AsyncMock(return_value=None)

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response(model_id=model_name, width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(visual_prompts={"instagram": "IG prompt"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        assert "instagram" in result["generated_images"]
        # Should use DEFAULT_IMAGE_MODEL when config is not found
        assert result["model_id"] == DEFAULT_IMAGE_MODEL

    @pytest.mark.asyncio
    async def test_model_registry_connection_error_uses_default(self):
        """Model Registry connection fails → falls back to DEFAULT_IMAGE_MODEL."""
        mock_pool = MagicMock()

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response(model_id=model_name, width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(visual_prompts={"instagram": "IG prompt"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(
                side_effect=ConnectionError("DB connection failed")
            )
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        assert "instagram" in result["generated_images"]
        assert result["model_id"] == DEFAULT_IMAGE_MODEL


class TestGenerateImagesResolution:
    """Tests that correct resolution is passed per social network."""

    @pytest.mark.asyncio
    async def test_correct_resolution_per_network(self):
        """Each network receives its correct width/height from RESOLUTION_MAP."""
        mock_pool, mock_conn = _make_mock_pool()
        captured_calls: list = []

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            captured_calls.append((prompt, model_name, width, height))
            return _make_image_response(model_id=model_name, width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_state(
            visual_prompts={
                "instagram": "IG",
                "facebook": "FB",
                "tiktok": "TT",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            await node(state)

        # Find each network's call and verify dimensions
        ig_call = next(c for c in captured_calls if c[0] == "IG")
        fb_call = next(c for c in captured_calls if c[0] == "FB")
        tt_call = next(c for c in captured_calls if c[0] == "TT")

        assert (ig_call[2], ig_call[3]) == (1080, 1350)   # Instagram 4:5
        assert (fb_call[2], fb_call[3]) == (1200, 628)    # Facebook 1.91:1
        assert (tt_call[2], tt_call[3]) == (1080, 1920)   # TikTok 9:16


class TestExceptionClasses:
    """Tests for custom exception classes."""

    def test_image_generation_error_attributes(self):
        """ImageGenerationError stores rede_social and detail."""
        err = ImageGenerationError("instagram", "timeout exceeded")
        assert err.rede_social == "instagram"
        assert err.detail == "timeout exceeded"
        assert "instagram" in str(err)
        assert "timeout exceeded" in str(err)

    def test_all_networks_failed_error_attributes(self):
        """AllNetworksFailedError stores errors dict and has http_status 503."""
        errors = {
            "instagram": "Primary timeout; Fallback timeout",
            "facebook": "Primary error; Fallback error",
        }
        err = AllNetworksFailedError(errors)
        assert err.http_status == 503
        assert err.errors == errors
        assert "instagram" in str(err)
        assert "facebook" in str(err)
