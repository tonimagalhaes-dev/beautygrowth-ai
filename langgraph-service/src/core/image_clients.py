"""Image Generation Client adapter for Gemini Image API.

Uses the google-genai SDK v2+ for native image generation with Gemini models.
Updated to use Gemini 3.5 Flash compatible image generation (July 2026).

Reference: https://ai.google.dev/gemini-api/docs/image-generation
Best practices: https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
"""

from __future__ import annotations

import asyncio
import logging
import os

from google import genai
from google.genai import types

from src.workflows.designer_agent import ImageGenerationResponse

logger = logging.getLogger(__name__)

# Image generation model — uses dedicated image model
IMAGE_MODEL = "gemini-2.5-flash-image"


class GeminiImageClient:
    """Image generation client using google-genai SDK v2+.

    Uses Gemini models with native image generation capability.
    The image generation model remains gemini-2.5-flash-image as it's
    the stable dedicated image generation model.

    Environment:
        GOOGLE_API_KEY: Required.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self._api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not self._api_key:
            raise ValueError("GOOGLE_API_KEY is required for image generation.")
        self._client = genai.Client(api_key=self._api_key)

    async def __call__(
        self,
        prompt: str,
        negative_prompt: str,
        model_name: str,
        width: int,
        height: int,
    ) -> ImageGenerationResponse:
        """Generate an image using Gemini's native image generation.

        Uses the google-genai SDK v2+ with response_modalities=["IMAGE"]
        as documented in https://ai.google.dev/gemini-api/docs/image-generation

        Notes on Gemini 3.x:
            - No temperature/top_p/top_k (not recommended)
            - Image generation uses dedicated model (gemini-2.5-flash-image)
        """
        full_prompt = (
            f"{prompt}\n\n"
            f"IMPORTANT - Do NOT include: {negative_prompt}\n\n"
            f"Generate this as a high-quality professional image "
            f"with aspect ratio approximately {width}:{height}."
        )

        logger.info(
            "Calling Gemini image generation (google-genai v2+): "
            "model=%s, size=%dx%d, prompt_len=%d",
            IMAGE_MODEL,
            width,
            height,
            len(prompt),
        )

        # Run synchronous SDK call in thread to avoid blocking event loop
        response = await asyncio.to_thread(
            self._client.models.generate_content,
            model=IMAGE_MODEL,
            contents=full_prompt,
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
            ),
        )

        # Extract image from response parts
        image_bytes = None
        input_tokens = 0
        output_tokens = 0

        if hasattr(response, "usage_metadata") and response.usage_metadata:
            input_tokens = getattr(response.usage_metadata, "prompt_token_count", 0) or 0
            output_tokens = getattr(response.usage_metadata, "candidates_token_count", 0) or 0

        # Look for image parts in the response
        if response.candidates:
            for part in response.candidates[0].content.parts:
                if (
                    part.inline_data
                    and part.inline_data.mime_type
                    and "image" in part.inline_data.mime_type
                ):
                    image_bytes = part.inline_data.data
                    break

        if not image_bytes:
            # Get any text response for debugging
            text_parts = []
            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, "text") and part.text:
                        text_parts.append(part.text[:200])
            raise RuntimeError(
                f"Gemini did not return image data. "
                f"Model: {IMAGE_MODEL}. "
                f"Text response: {' '.join(text_parts) or 'empty'}"
            )

        logger.info(
            "Gemini image generated successfully: model=%s, "
            "size=%d bytes, input_tokens=%d, output_tokens=%d",
            IMAGE_MODEL,
            len(image_bytes),
            input_tokens,
            output_tokens,
        )

        return ImageGenerationResponse(
            image_bytes=image_bytes,
            format="PNG",
            width=width,
            height=height,
            model_id=IMAGE_MODEL,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
