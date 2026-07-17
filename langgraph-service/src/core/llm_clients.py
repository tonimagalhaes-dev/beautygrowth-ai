"""LLM Client adapters for the Content Agent workflow.

This module provides concrete implementations of the LLMClient interface
defined in src.workflows.content_agent. Each adapter wraps a specific
LLM provider SDK while maintaining the same callable signature:

    (system_prompt, task_prompt, model_name, temperature, max_tokens) -> LLMResponse

To switch providers, simply instantiate a different adapter and pass it
to build_content_agent_graph(). No workflow code needs to change.

Available adapters:
    - GeminiLLMClient: Google Gemini via google-genai SDK v2+

Migrated to google-genai SDK v2.0+ (July 2026):
    - Uses `google.genai.Client` instead of deprecated `google.generativeai`
    - Model updated to `gemini-3.5-flash` (GA, stable)
    - Removed temperature/top_p/top_k (not recommended for Gemini 3.x)
    - Uses `thinking_level` instead of `thinking_budget`
    - Reference: https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5
"""

from __future__ import annotations

import asyncio
import logging
import os

from google import genai
from google.genai import types

from src.workflows.content_agent import LLMResponse

logger = logging.getLogger(__name__)

# Default model — Gemini 3.5 Flash (GA, stable, best for agentic/coding tasks)
DEFAULT_MODEL = "gemini-3.5-flash"


class GeminiLLMClient:
    """LLM client adapter for Google Gemini models.

    Uses the google-genai SDK v2+ to call Gemini models.
    Conforms to the LLMClient callable interface.

    Usage:
        client = GeminiLLMClient()
        response = await client("You are...", "Generate...", "gemini-3.5-flash", 0.7, 4096)

    Environment:
        GOOGLE_API_KEY: Required. The API key for Google Generative AI.

    Notes on Gemini 3.x best practices:
        - temperature, top_p, top_k are NOT recommended (model is optimized for defaults)
        - Use thinking_level instead of thinking_budget
        - Be concise with instructions; Gemini 3.x responds better to direct prompts
    """

    def __init__(self, api_key: str | None = None) -> None:
        """Initialize the Gemini client.

        Args:
            api_key: Google API key. Falls back to GOOGLE_API_KEY env var.

        Raises:
            ValueError: If no API key is provided or found in environment.
        """
        self._api_key = api_key or os.environ.get("GOOGLE_API_KEY")
        if not self._api_key:
            raise ValueError(
                "GOOGLE_API_KEY is required. Set it in the environment or pass api_key."
            )
        self._client = genai.Client(api_key=self._api_key)

    async def __call__(
        self,
        system_prompt: str,
        task_prompt: str,
        model_name: str,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        """Call the Gemini model with the given prompts.

        Maps the LLMClient interface to google-genai SDK v2 format:
        - system_prompt -> system_instruction in config
        - task_prompt -> contents
        - max_tokens -> max_output_tokens in config
        - temperature is IGNORED for Gemini 3.x (not recommended per docs)

        Args:
            system_prompt: The system instruction for the model.
            task_prompt: The user/task prompt content.
            model_name: Gemini model identifier (e.g., "gemini-3.5-flash").
            temperature: Sampling temperature (IGNORED for Gemini 3.x models).
            max_tokens: Maximum output tokens.

        Returns:
            LLMResponse with content, token counts, and model_id.

        Raises:
            Exception: If the Gemini API call fails.
        """
        # Use default model if not specified or using old model names
        resolved_model = self._resolve_model(model_name)

        logger.info(
            "Calling Gemini model=%s, max_tokens=%d (temperature ignored for 3.x)",
            resolved_model,
            max_tokens,
        )

        # Build generation config following Gemini 3.5 Flash best practices:
        # - No temperature/top_p/top_k (not recommended for Gemini 3.x)
        # - Use thinking_level for controlling reasoning depth
        # - JSON output via response_mime_type
        config = types.GenerateContentConfig(
            system_instruction=system_prompt if system_prompt else None,
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
            thinking_config=types.ThinkingConfig(
                thinking_level="medium",  # Default for Gemini 3.5 Flash
            ),
        )

        # Run synchronous SDK call in thread to avoid blocking event loop
        response = await asyncio.to_thread(
            self._client.models.generate_content,
            model=resolved_model,
            contents=task_prompt,
            config=config,
        )

        # Extract token counts from usage metadata
        input_tokens = 0
        output_tokens = 0
        if hasattr(response, "usage_metadata") and response.usage_metadata:
            input_tokens = getattr(response.usage_metadata, "prompt_token_count", 0) or 0
            output_tokens = getattr(response.usage_metadata, "candidates_token_count", 0) or 0

        content = response.text or ""

        logger.info(
            "Gemini response: model=%s, input_tokens=%d, output_tokens=%d, content_len=%d",
            resolved_model,
            input_tokens,
            output_tokens,
            len(content),
        )

        return LLMResponse(
            content=content,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model_id=resolved_model,
        )

    @staticmethod
    def _resolve_model(model_name: str) -> str:
        """Resolve model name, mapping old names to current defaults.

        Gemini 3.5 Flash is the recommended model for agentic and coding tasks.
        Old model references are automatically upgraded.
        """
        # Map old/deprecated model names to current default
        deprecated_models = {
            "gemini-2.0-flash",
            "gemini-2.0-flash-exp",
            "gemini-2.5-flash",
            "gemini-2.5-flash-preview",
            "gemini-3-flash-preview",
            "gemini-pro",
        }
        if model_name in deprecated_models or not model_name:
            return DEFAULT_MODEL
        return model_name
