"""Tests for Designer Agent post_process thumbnail generation.

Tests the _generate_adaptive_thumbnail helper and the make_post_process node
with actual Pillow image generation (no mocks for image processing).

Requirements: 8.2, 8.5
"""

import io
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from src.workflows.designer_agent import (
    THUMBNAIL_FALLBACK_WIDTH,
    THUMBNAIL_MAX_BYTES,
    THUMBNAIL_MAX_WIDTH,
    THUMBNAIL_MIN_QUALITY,
    THUMBNAIL_QUALITY,
    _generate_adaptive_thumbnail,
    make_post_process,
)


# --- Helpers ---


def _create_test_image(
    width: int = 1080,
    height: int = 1350,
    color: tuple = (200, 100, 50),
    mode: str = "RGB",
) -> bytes:
    """Create a test PNG image of specified dimensions."""
    img = Image.new(mode, (width, height), color)
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def _create_complex_image(
    width: int = 1080,
    height: int = 1350,
) -> bytes:
    """Create a more complex image with gradients (harder to compress)."""
    img = Image.new("RGB", (width, height))
    pixels = img.load()
    for y in range(height):
        for x in range(width):
            pixels[x, y] = (
                x % 256,
                y % 256,
                (x + y) % 256,
            )
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


def _create_rgba_image(width: int = 1080, height: int = 1350) -> bytes:
    """Create a test RGBA PNG image (with alpha channel)."""
    img = Image.new("RGBA", (width, height), (200, 100, 50, 128))
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    return buffer.getvalue()


# --- Unit Tests for _generate_adaptive_thumbnail ---


class TestGenerateAdaptiveThumbnail:
    """Tests for the _generate_adaptive_thumbnail helper function."""

    def test_returns_jpeg_bytes(self):
        """Thumbnail should be valid JPEG bytes."""
        image_bytes = _create_test_image()
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        # Verify it's a valid JPEG
        img = Image.open(io.BytesIO(result))
        assert img.format == "JPEG"

    def test_resizes_to_400px_width(self):
        """Thumbnail should have width of 400px (initial target)."""
        image_bytes = _create_test_image(width=1080, height=1350)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        assert img.width == THUMBNAIL_MAX_WIDTH  # 400px

    def test_maintains_aspect_ratio(self):
        """Thumbnail should maintain the original aspect ratio."""
        # Instagram 4:5 ratio (1080x1350)
        image_bytes = _create_test_image(width=1080, height=1350)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        # 400 / 1080 = 0.3703... -> height = 1350 * 0.3703 = 500
        expected_height = int(1350 * (400 / 1080))
        assert img.width == 400
        assert img.height == expected_height

    def test_maintains_aspect_ratio_facebook(self):
        """Thumbnail for Facebook (1.91:1) should maintain ratio."""
        # Facebook 1.91:1 (1200x628)
        image_bytes = _create_test_image(width=1200, height=628)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        expected_height = int(628 * (400 / 1200))
        assert img.width == 400
        assert img.height == expected_height

    def test_maintains_aspect_ratio_tiktok(self):
        """Thumbnail for TikTok (9:16) should maintain ratio."""
        # TikTok 9:16 (1080x1920)
        image_bytes = _create_test_image(width=1080, height=1920)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        expected_height = int(1920 * (400 / 1080))
        assert img.width == 400
        assert img.height == expected_height

    def test_result_within_200kb(self):
        """Thumbnail should be ≤ 200KB."""
        image_bytes = _create_test_image(width=1080, height=1350)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        assert len(result) <= THUMBNAIL_MAX_BYTES

    def test_complex_image_within_200kb(self):
        """Even complex images should result in thumbnail ≤ 200KB."""
        image_bytes = _create_complex_image(width=1080, height=1350)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        assert len(result) <= THUMBNAIL_MAX_BYTES

    def test_handles_rgba_images(self):
        """RGBA images should be converted to RGB for JPEG output."""
        image_bytes = _create_rgba_image()
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        assert img.mode == "RGB"
        assert img.format == "JPEG"

    def test_handles_small_images_no_upscale(self):
        """Images smaller than 400px should not be upscaled."""
        image_bytes = _create_test_image(width=200, height=250)
        result = _generate_adaptive_thumbnail(image_bytes)

        assert result is not None
        img = Image.open(io.BytesIO(result))
        # Should NOT upscale — keeps original width
        assert img.width == 200

    def test_returns_none_for_invalid_bytes(self):
        """Invalid image bytes should return None (not crash)."""
        result = _generate_adaptive_thumbnail(b"not an image")
        assert result is None

    def test_returns_none_for_empty_bytes(self):
        """Empty bytes should return None."""
        result = _generate_adaptive_thumbnail(b"")
        assert result is None

    def test_adaptive_compression_reduces_quality(self):
        """When initial quality produces > 200KB, quality should be reduced."""
        # Create a large, hard-to-compress image
        # Use random-like patterns
        img = Image.new("RGB", (2000, 2500))
        pixels = img.load()
        import random
        random.seed(42)
        for y in range(2500):
            for x in range(2000):
                pixels[x, y] = (
                    random.randint(0, 255),
                    random.randint(0, 255),
                    random.randint(0, 255),
                )
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        large_image_bytes = buffer.getvalue()

        result = _generate_adaptive_thumbnail(large_image_bytes)

        assert result is not None
        # Should still be within 200KB after adaptive compression
        assert len(result) <= THUMBNAIL_MAX_BYTES


# --- Integration Tests for make_post_process (thumbnail part) ---


class TestPostProcessThumbnailIntegration:
    """Integration tests for the post_process node's thumbnail generation."""

    @pytest.fixture
    def post_process_node(self):
        """Create a post_process node without logo downloader."""
        return make_post_process(logo_downloader=None)

    @pytest.fixture
    def base_state(self) -> dict:
        """Minimal state for post_process testing."""
        return {
            "tenant_id": "test-tenant",
            "user_id": "test-user",
            "trace_id": "test-trace",
            "execution_id": "test-exec",
            "request": {"aplicar_logo_overlay": False},
            "generated_images": {},
            "clinic_logo_url": None,
            "warnings": [],
            "steps": [],
        }

    @pytest.mark.asyncio
    async def test_generates_thumbnail_for_each_image(self, post_process_node, base_state):
        """Should generate a thumbnail for each social network image."""
        instagram_img = _create_test_image(1080, 1350)
        facebook_img = _create_test_image(1200, 628)

        base_state["generated_images"] = {
            "instagram": {"image_bytes": instagram_img, "format": "PNG", "model_id": "test"},
            "facebook": {"image_bytes": facebook_img, "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        assert "processed_images" in result
        assert "instagram" in result["processed_images"]
        assert "facebook" in result["processed_images"]
        assert result["processed_images"]["instagram"]["thumbnail_bytes"] is not None
        assert result["processed_images"]["facebook"]["thumbnail_bytes"] is not None

    @pytest.mark.asyncio
    async def test_thumbnail_is_valid_jpeg(self, post_process_node, base_state):
        """Generated thumbnail should be a valid JPEG."""
        base_state["generated_images"] = {
            "instagram": {"image_bytes": _create_test_image(1080, 1350), "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        thumb_bytes = result["processed_images"]["instagram"]["thumbnail_bytes"]
        img = Image.open(io.BytesIO(thumb_bytes))
        assert img.format == "JPEG"

    @pytest.mark.asyncio
    async def test_preserves_original_bytes(self, post_process_node, base_state):
        """Original image bytes should be preserved in processed_images."""
        original = _create_test_image(1080, 1350)
        base_state["generated_images"] = {
            "instagram": {"image_bytes": original, "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        assert result["processed_images"]["instagram"]["original_bytes"] == original

    @pytest.mark.asyncio
    async def test_thumbnail_failure_adds_warning(self, post_process_node, base_state):
        """When thumbnail generation fails, should add warning (not crash)."""
        base_state["generated_images"] = {
            "instagram": {"image_bytes": b"invalid image data", "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        # Should still have processed_images entry but no thumbnail
        # Warning should be added
        warnings = result.get("warnings", [])
        assert any("thumbnail" in w.lower() for w in warnings)

    @pytest.mark.asyncio
    async def test_empty_generated_images(self, post_process_node, base_state):
        """Empty generated_images should produce empty processed_images."""
        base_state["generated_images"] = {}

        result = await post_process_node(base_state)

        assert result["processed_images"] == {}
        assert result["logo_overlay_applied"] is False

    @pytest.mark.asyncio
    async def test_no_image_bytes_skips_processing(self, post_process_node, base_state):
        """Image entries without image_bytes should be skipped."""
        base_state["generated_images"] = {
            "instagram": {"image_bytes": None, "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        # Should skip entries without image_bytes
        assert "instagram" not in result["processed_images"]

    @pytest.mark.asyncio
    async def test_all_thumbnails_within_size_limit(self, post_process_node, base_state):
        """All generated thumbnails should be ≤ 200KB."""
        base_state["generated_images"] = {
            "instagram": {"image_bytes": _create_complex_image(1080, 1350), "format": "PNG", "model_id": "test"},
            "facebook": {"image_bytes": _create_complex_image(1200, 628), "format": "PNG", "model_id": "test"},
            "tiktok": {"image_bytes": _create_complex_image(1080, 1920), "format": "PNG", "model_id": "test"},
        }

        result = await post_process_node(base_state)

        for rede, data in result["processed_images"].items():
            thumb = data["thumbnail_bytes"]
            assert thumb is not None, f"Thumbnail missing for {rede}"
            assert len(thumb) <= THUMBNAIL_MAX_BYTES, (
                f"Thumbnail for {rede} exceeds 200KB: {len(thumb)} bytes"
            )
