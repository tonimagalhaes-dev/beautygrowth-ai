"""LLM Client adapters for the Content Agent workflow.

This module provides concrete implementations of the LLMClient interface
defined in src.workflows.content_agent. Each adapter wraps a specific
LLM provider SDK while maintaining the same callable signature:

    (system_prompt, task_prompt, model_name, temperature, max_tokens) -> LLMResponse

To switch providers, simply instantiate a different adapter and pass it
to build_content_agent_graph(). No workflow code needs to change.

Available adapters:
    - GeminiLLMClient: Google Generative AI (Gemini) via google-generativeai SDK
"""

from __future__ import annotations

import logging
import os

import google.generativeai as genai

from src.workflows.content_agent import LLMResponse

logger = logging.getLogger(__name__)


class GeminiLLMClient:
    """LLM client adapter for Google Gemini models.

    Uses the google-generativeai SDK to call Gemini models.
    Conforms to the LLMClient callable interface.

    Usage:
        client = GeminiLLMClient()
        response = await client("You are...", "Generate...", "gemini-2.0-flash", 0.7, 4096)

    Environment:
        GOOGLE_API_KEY: Required. The API key for Google Generative AI.
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
        genai.configure(api_key=self._api_key)

    async def __call__(
        self,
        system_prompt: str,
        task_prompt: str,
        model_name: str,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        """Call the Gemini model with the given prompts.

        Maps the LLMClient interface to Gemini's expected format:
        - system_prompt -> system_instruction parameter
        - task_prompt -> user message content
        - temperature and max_tokens -> generation_config

        Args:
            system_prompt: The system instruction for the model.
            task_prompt: The user/task prompt content.
            model_name: Gemini model identifier (e.g., "gemini-2.0-flash").
            temperature: Sampling temperature (0.0 - 2.0).
            max_tokens: Maximum output tokens.

        Returns:
            LLMResponse with content, token counts, and model_id.

        Raises:
            Exception: If the Gemini API call fails.
        """
        logger.info(
            "Calling Gemini model=%s, temperature=%.2f, max_tokens=%d",
            model_name,
            temperature,
            max_tokens,
        )

        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system_prompt if system_prompt else None,
        )

        generation_config = genai.types.GenerationConfig(
            temperature=temperature,
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
        )

        response = await model.generate_content_async(
            contents=task_prompt,
            generation_config=generation_config,
        )

        # Extract token counts from usage metadata
        input_tokens = 0
        output_tokens = 0
        if response.usage_metadata:
            input_tokens = response.usage_metadata.prompt_token_count or 0
            output_tokens = response.usage_metadata.candidates_token_count or 0

        content = response.text or ""

        logger.info(
            "Gemini response: model=%s, input_tokens=%d, output_tokens=%d, content_len=%d",
            model_name,
            input_tokens,
            output_tokens,
            len(content),
        )

        return LLMResponse(
            content=content,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            model_id=model_name,
        )
