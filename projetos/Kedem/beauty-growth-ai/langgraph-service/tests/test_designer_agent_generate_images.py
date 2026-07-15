"""Tests for Designer Agent generate_images node (Task 7.1).

Tests cover:
- Parallel generation across multiple social networks
- Primary model success
- Primary model failure with fallback success
- Timeout handling (30s per model)
- Resolution mapping per social network
- Token tracking
- used_fallback flag
- AllNetworksFailedError when all networks fail
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    AllNetworksFailedError,
    DEFAULT_IMAGE_MODEL,
    IMAGE_GENERATION_TIMEOUT_SECONDS,
    ImageGenerationResponse,
    MAX_IMAGE_SIZE_BYTES,
    RESOLUTION_MAP,
    DesignerAgentState,
    make_generate_images,
)


# --- Fixtures ---


def _make_state(
    redes_sociais: list[str] | None = None,
    visual_prompts: dict[str, str] | None = None,
    negative_prompts: list[str] | None = None,
) -> DesignerAgentState:
    """Create a minimal DesignerAgentState for testing generate_images."""
    if redes_sociais is None:
        redes_sociais = ["instagram"]
    if visual_prompts is None:
        visual_prompts = {rede: f"Prompt for {rede}" for rede in redes_sociais}
    if negative_prompts is None:
        negative_prompts = ["No nudity", "No before/after"]

    return {
        "tenant_id": "test-tenant-123",
        "user_id": "test-user-456",
        "trace_id": "trace-789",
        "execution_id": "exec-001",
        "request": {"redes_sociais": redes_sociais},
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
        "visual_prompts": visual_prompts,
        "negative_prompts": negative_prompts,
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


def _make_image_response(
    width: int = 1080,
    height: int = 1350,
    model_name: str = "gemini-3.1-flash-image",
    size_bytes: int = 500_000,
    input_tokens: int = 100,
    output_tokens: int = 50,
) -> ImageGenerationResponse:
    """Create a mock ImageGenerationResponse."""
    return ImageGenerationResponse(
        image_bytes=b"\x89PNG" + b"\x00" * (size_bytes - 4),
        format="PNG",
        width=width,
        height=height,
        model_id=model_name,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


@pytest.fixture
def mock_pg_pool():
    """Create a mock asyncpg pool that returns no model config."""
    pool = MagicMock()
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)

    # Mock the tenant_connection context manager
    cm = AsyncMock()
    cm.__aenter__ = AsyncMock(return_value=conn)
    cm.__aexit__ = AsyncMock(return_value=False)

    return pool


# --- Tests ---


class TestMakeGenerateImagesSuccess:
    """Test successful image generation scenarios."""

    @pytest.mark.asyncio
    async def test_single_network_success(self, mock_pg_pool):
        """Generate a single image for Instagram successfully."""
        image_client = AsyncMock(
            return_value=_make_image_response(
                width=1080, height=1350,
                model_name="gemini-3.1-flash-image",
            )
        )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "gemini-3.1-flash-image"},
                {"model_name": "gemini-fallback"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            # Setup tenant_connection mock
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, image_client)
            state = _make_state(redes_sociais=["instagram"])
            result = await node_fn(state)

        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["format"] == "PNG"
        assert result["generated_images"]["instagram"]["width"] == 1080
        assert result["generated_images"]["instagram"]["height"] == 1350
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-3.1-flash-image"
        assert result["used_fallback"] is False
        assert result["model_id"] == "gemini-3.1-flash-image"
        assert not result["generation_errors"]

    @pytest.mark.asyncio
    async def test_multiple_networks_parallel(self, mock_pg_pool):
        """Generate images for all 3 networks in parallel."""
        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            # Simulate some async work
            await asyncio.sleep(0.01)
            return _make_image_response(
                width=width, height=height,
                model_name=model_name,
                input_tokens=100, output_tokens=50,
            )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "gemini-3.1-flash-image"},
                None,
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, mock_image_client)
            state = _make_state(
                redes_sociais=["instagram", "facebook", "tiktok"]
            )
            result = await node_fn(state)

        # All 3 networks should succeed
        assert len(result["generated_images"]) == 3
        assert "instagram" in result["generated_images"]
        assert "facebook" in result["generated_images"]
        assert "tiktok" in result["generated_images"]
        assert not result["generation_errors"]

        # Token tracking: 3 networks × (100 input + 50 output) = 450
        assert result["tokens_consumed"] == 450

    @pytest.mark.asyncio
    async def test_resolution_mapping(self, mock_pg_pool):
        """Verify correct resolution is passed for each network."""
        call_args = []

        async def tracking_client(prompt, negative_prompt, model_name, width, height):
            call_args.append((width, height))
            return _make_image_response(width=width, height=height)

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=({"model_name": "test-model"}, None),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, tracking_client)
            state = _make_state(
                redes_sociais=["instagram", "facebook", "tiktok"]
            )
            await node_fn(state)

        # Sort by resolution for deterministic comparison
        resolutions = sorted(call_args)
        expected = sorted([
            (1080, 1350),  # Instagram 4:5
            (1200, 628),   # Facebook 1.91:1
            (1080, 1920),  # TikTok 9:16
        ])
        assert resolutions == expected


class TestMakeGenerateImagesFallback:
    """Test fallback model behavior."""

    @pytest.mark.asyncio
    async def test_primary_fails_fallback_succeeds(self, mock_pg_pool):
        """When primary model fails, fallback should be used."""
        call_count = {"n": 0}

        async def failing_then_succeeding_client(
            prompt, negative_prompt, model_name, width, height
        ):
            call_count["n"] += 1
            if model_name == "primary-model":
                raise RuntimeError("5xx server error")
            return _make_image_response(
                width=width, height=height,
                model_name=model_name,
            )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "primary-model"},
                {"model_name": "fallback-model"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(
                mock_pg_pool, failing_then_succeeding_client
            )
            state = _make_state(redes_sociais=["instagram"])
            result = await node_fn(state)

        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "fallback-model"
        assert result["used_fallback"] is True
        # Primary (1 call) + fallback (1 call) = 2 calls
        assert call_count["n"] == 2

    @pytest.mark.asyncio
    async def test_primary_timeout_fallback_succeeds(self, mock_pg_pool):
        """When primary model times out, fallback should be used."""
        async def timeout_then_succeeding_client(
            prompt, negative_prompt, model_name, width, height
        ):
            if model_name == "primary-model":
                await asyncio.sleep(60)  # Will be cancelled by timeout
            return _make_image_response(
                width=width, height=height,
                model_name=model_name,
            )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "primary-model"},
                {"model_name": "fallback-model"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc, patch(
            "src.workflows.designer_agent.IMAGE_GENERATION_TIMEOUT_SECONDS",
            0.1,  # Short timeout for testing
        ):
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(
                mock_pg_pool, timeout_then_succeeding_client
            )
            state = _make_state(redes_sociais=["instagram"])
            result = await node_fn(state)

        assert "instagram" in result["generated_images"]
        assert result["used_fallback"] is True

    @pytest.mark.asyncio
    async def test_used_fallback_flag_set_when_any_network_uses_fallback(
        self, mock_pg_pool
    ):
        """used_fallback should be True if ANY network used fallback."""
        call_idx = {"n": 0}

        async def mixed_client(prompt, negative_prompt, model_name, width, height):
            call_idx["n"] += 1
            # First call (instagram primary) succeeds
            # Second call (facebook primary) fails, fallback succeeds
            if "facebook" in prompt and model_name == "primary-model":
                raise RuntimeError("Fail for facebook primary")
            return _make_image_response(
                width=width, height=height, model_name=model_name
            )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "primary-model"},
                {"model_name": "fallback-model"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, mixed_client)
            state = _make_state(
                redes_sociais=["instagram", "facebook"],
                visual_prompts={
                    "instagram": "Prompt for instagram",
                    "facebook": "Prompt for facebook",
                },
            )
            result = await node_fn(state)

        assert len(result["generated_images"]) == 2
        assert result["used_fallback"] is True


class TestMakeGenerateImagesFailure:
    """Test failure scenarios."""

    @pytest.mark.asyncio
    async def test_all_networks_fail_raises_error(self, mock_pg_pool):
        """When all networks fail, AllNetworksFailedError should be raised."""
        async def always_failing_client(
            prompt, negative_prompt, model_name, width, height
        ):
            raise RuntimeError("Service unavailable")

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "primary-model"},
                {"model_name": "fallback-model"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, always_failing_client)
            state = _make_state(
                redes_sociais=["instagram", "facebook"]
            )

            with pytest.raises(AllNetworksFailedError) as exc_info:
                await node_fn(state)

        assert exc_info.value.http_status == 503
        assert "instagram" in exc_info.value.errors
        assert "facebook" in exc_info.value.errors

    @pytest.mark.asyncio
    async def test_partial_failure_returns_successful_images(self, mock_pg_pool):
        """Partial failure should return successful images + errors."""
        async def partial_client(prompt, negative_prompt, model_name, width, height):
            if width == 1200 and height == 628:  # Facebook
                raise RuntimeError("Facebook generation failed")
            return _make_image_response(width=width, height=height)

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "test-model"},
                None,  # No fallback
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, partial_client)
            state = _make_state(
                redes_sociais=["instagram", "facebook"]
            )
            result = await node_fn(state)

        # Instagram should succeed, Facebook should fail
        assert "instagram" in result["generated_images"]
        assert "facebook" in result["generation_errors"]
        assert "facebook" not in result["generated_images"]

    @pytest.mark.asyncio
    async def test_image_exceeding_10mb_rejected(self, mock_pg_pool):
        """Images over 10MB should be rejected (treated as failure)."""
        async def oversized_client(prompt, negative_prompt, model_name, width, height):
            return ImageGenerationResponse(
                image_bytes=b"\x00" * (MAX_IMAGE_SIZE_BYTES + 1),
                format="PNG",
                width=width,
                height=height,
                model_id=model_name,
            )

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "test-model"},
                None,  # No fallback
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, oversized_client)
            state = _make_state(redes_sociais=["instagram"])

            with pytest.raises(AllNetworksFailedError):
                await node_fn(state)


class TestMakeGenerateImagesTokenTracking:
    """Test token consumption tracking."""

    @pytest.mark.asyncio
    async def test_tokens_accumulated_from_existing(self, mock_pg_pool):
        """Tokens should accumulate on top of existing tokens_consumed."""
        async def mock_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response(input_tokens=200, output_tokens=100)

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=({"model_name": "test-model"}, None),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, mock_client)
            state = _make_state(redes_sociais=["instagram"])
            state["tokens_consumed"] = 500  # Existing tokens from prior nodes
            result = await node_fn(state)

        # 500 existing + 200 input + 100 output = 800
        assert result["tokens_consumed"] == 800


class TestMakeGenerateImagesStepRecording:
    """Test observability step recording."""

    @pytest.mark.asyncio
    async def test_step_recorded_with_correct_metadata(self, mock_pg_pool):
        """A step record should be appended with generation metadata."""
        async def mock_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response()

        with patch(
            "src.workflows.designer_agent._get_image_model_config",
            new_callable=AsyncMock,
            return_value=(
                {"model_name": "gemini-3.1-flash-image"},
                {"model_name": "fallback-model"},
            ),
        ), patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_conn = AsyncMock()
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node_fn = make_generate_images(mock_pg_pool, mock_client)
            state = _make_state(redes_sociais=["instagram", "tiktok"])
            result = await node_fn(state)

        # Check step was recorded
        steps = result["steps"]
        assert len(steps) == 1
        step = steps[0]
        assert step["node"] == "generate_images"
        assert step["action"] == "parallel_generation"
        assert "duration_ms" in step
        assert step["model_primary"] == "gemini-3.1-flash-image"
        assert step["model_fallback"] == "fallback-model"
        assert set(step["redes_generated"]) == {"instagram", "tiktok"}
        assert step["redes_failed"] == []


class TestMakeGenerateImagesModelRegistry:
    """Test Model Registry integration."""

    @pytest.mark.asyncio
    async def test_uses_default_model_when_registry_unavailable(
        self, mock_pg_pool
    ):
        """Falls back to DEFAULT_IMAGE_MODEL when registry query fails."""
        async def mock_client(prompt, negative_prompt, model_name, width, height):
            return _make_image_response(model_name=model_name)

        with patch(
            "src.workflows.designer_agent.tenant_connection",
            side_effect=RuntimeError("DB connection failed"),
        ):
            node_fn = make_generate_images(mock_pg_pool, mock_client)
            state = _make_state(redes_sociais=["instagram"])
            result = await node_fn(state)

        # Should use default model
        assert result["model_id"] == DEFAULT_IMAGE_MODEL
        assert "instagram" in result["generated_images"]


class TestResolutionMapConstants:
    """Test resolution map constant values."""

    def test_instagram_resolution(self):
        assert RESOLUTION_MAP["instagram"] == (1080, 1350)

    def test_facebook_resolution(self):
        assert RESOLUTION_MAP["facebook"] == (1200, 628)

    def test_tiktok_resolution(self):
        assert RESOLUTION_MAP["tiktok"] == (1080, 1920)

    def test_timeout_is_30_seconds(self):
        assert IMAGE_GENERATION_TIMEOUT_SECONDS == 30

    def test_max_image_size_is_10mb(self):
        assert MAX_IMAGE_SIZE_BYTES == 10 * 1024 * 1024
