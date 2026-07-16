"""Image Generation Client adapter for Gemini Image API.

Uses the NEW google-genai SDK (not the deprecated google-generativeai)
for native image generation with Gemini models.

Reference: https://ai.google.dev/gemini-api/docs/image-generation
"""

from __future__ import annotations

import logging
import os

from google import genai
from google.genai import types

from src.workflows.designer_agent import ImageGenerationResponse

logger = logging.getLogger(__name__)


class GeminiImageClient:
    """Image generation client using google-genai SDK.

    Uses Gemini models with native image generation capability
    (gemini-2.0-flash-exp, gemini-2.5-flash-image, etc.).

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

        Uses the google-genai SDK with response_modalities=["IMAGE"]
        as documented in https://ai.google.dev/gemini-api/docs/image-generation
        """
        # Use a model that supports image output
        # gemini-2.5-flash-image is the stable image generation model
        image_model = "gemini-2.5-flash-image"

        full_prompt = (
            f"{prompt}\n\n"
            f"IMPORTANT - Do NOT include: {negative_prompt}\n\n"
            f"Generate this as a high-quality professional image "
            f"with aspect ratio approximately {width}:{height}."
        )

        logger.info(
            "Calling Gemini image generation (google-genai): "
            "model=%s, size=%dx%d, prompt_len=%d",
            image_model,
            width,
            height,
            len(prompt),
        )

        # Use the synchronous client (async not available in google-genai yet)
        # We'll run it in a thread to not block the event loop
        import asyncio

        response = await asyncio.to_thread(
            self._client.models.generate_content,
            model=image_model,
            contents=full_prompt,
            config=types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
            ),
        )

        # Extract image from response parts
        image_bytes = None
        input_tokens = 0
        output_tokens = 0

        if hasattr(response, 'usage_metadata') and response.usage_metadata:
            input_tokens = getattr(response.usage_metadata, 'prompt_token_count', 0) or 0
            output_tokens = getattr(response.usage_metadata, 'candidates_token_count', 0) or 0

        # Look for image parts in the response
        if response.candidates:
            for part in response.candidates[0].content.parts:
                if part.inline_data and part.inline_data.mime_type and 'image' in part.inline_data.mime_type:
                    image_bytes = part.inline_data.data
                    break

        if not image_bytes:
            # Get any text response for debugging
            text_parts = []
            if response.candidates:
                for part in response.candidates[0].content.parts:
                    if hasattr(part, 'text') and part.text:
                        text_parts.append(part.text[:200])
            raise RuntimeError(
                f"Gemini did not return image data. "
                f"Model: {image_model}. "
                f"Text response: {' '.join(text_parts) or 'empty'}"
            )

        logger.info(
            "Gemini image generated successfully: model=%s, "
            "size=%d bytes, input_tokens=%d, output_tokens=%d",
            image_model,
            len(image_bytes),
            input_tokens,
            output_tokens,
        )

        return ImageGenerationResponse(
            image_bytes=image_bytes,
            format="PNG",
            width=width,
            height=height,
            model_id=image_model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
