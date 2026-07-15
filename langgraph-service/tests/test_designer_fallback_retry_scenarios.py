"""Cross-cutting integration tests for Designer Agent fallback and retry scenarios (Task 13.3).

These tests consolidate the key resilience guarantees of the Designer Agent workflow
into a single test module that exercises the FULL error handling paths end-to-end:

1. Model fallback: primary model fails → fallback model used → used_fallback=True
2. Logging fallback: _emit_final_structured_log catches exception → stdout → execution continues
3. Upload retry: MinIO upload fails transiently → succeeds on retry → no error raised
4. Agent Memory continuity: Agent Memory INSERT fails after 2 retries → images returned normally → WARNING

Requirements: 10.3, 10.5, 10.7
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    AGENT_MEMORY_MAX_RETRIES,
    AGENT_MEMORY_RETRY_INTERVAL_SECONDS,
    AllNetworksFailedError,
    DEFAULT_IMAGE_MODEL,
    IMAGE_GENERATION_TIMEOUT_SECONDS,
    ImageGenerationResponse,
    UPLOAD_BACKOFF_DELAYS,
    UPLOAD_MAX_RETRIES,
    UploadFailedError,
    _emit_final_structured_log,
    _upload_with_retry,
    make_generate_images,
    make_upload_and_persist,
)


# =============================================================================
# Shared Helpers
# =============================================================================


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
    primary_name: str = "gemini-primary",
    fallback_name: str | None = "gemini-fallback",
):
    """Create a mock asyncpg pool with model config rows."""
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


def _make_generate_state(
    visual_prompts: dict | None = None,
    tokens_consumed: int = 0,
) -> dict:
    """Build a minimal state dict for testing generate_images."""
    prompts = visual_prompts or {
        "instagram": "IG prompt",
        "facebook": "FB prompt",
    }
    return {
        "tenant_id": "tenant-resilience-001",
        "user_id": "user-resilience-001",
        "trace_id": "trace-resilience-001",
        "execution_id": "exec-resilience-001",
        "request": {
            "descricao_visual": "Imagem profissional de teste",
            "redes_sociais": list(prompts.keys()),
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


class FakeStorageClient:
    """Fake StorageClient for upload testing with configurable failures."""

    def __init__(self, fail_count: int = 0, fail_on_paths: list[str] | None = None):
        self.uploaded: list[dict] = []
        self.presigned_urls: list[dict] = []
        self._fail_count = fail_count
        self._fail_on_paths = fail_on_paths or []
        self._attempt_tracker: dict[str, int] = {}

    async def upload_object(self, path: str, data: bytes, content_type: str) -> None:
        if path not in self._attempt_tracker:
            self._attempt_tracker[path] = 0
        self._attempt_tracker[path] += 1

        if path in self._fail_on_paths:
            raise ConnectionError(f"Permanent failure for {path}")

        if self._attempt_tracker[path] <= self._fail_count:
            raise ConnectionError(
                f"Transient failure (attempt {self._attempt_tracker[path]})"
            )

        self.uploaded.append({"path": path, "size": len(data), "content_type": content_type})

    async def generate_presigned_url(self, path: str, expiry_seconds: int) -> str:
        self.presigned_urls.append({"path": path, "expiry_seconds": expiry_seconds})
        return f"https://minio.local/presigned/{path}?expiry={expiry_seconds}"


class FakeRecord:
    """Fake asyncpg Record."""

    def __init__(self, data: dict):
        self._data = data

    def __getitem__(self, key):
        return self._data[key]

    def get(self, key, default=None):
        return self._data.get(key, default)


class FakeConnection:
    """Fake asyncpg Connection for persistence testing."""

    def __init__(self, execute_side_effect=None):
        self.execute_calls: list[tuple] = []
        self.fetchrow_calls: list[tuple] = []
        self._execute_side_effect = execute_side_effect

    async def execute(self, query: str, *args):
        if self._execute_side_effect and "agent_memory_short" in query:
            raise self._execute_side_effect
        self.execute_calls.append((query, args))

    async def fetchrow(self, query: str, *args):
        self.fetchrow_calls.append((query, args))
        if "RETURNING id" in query or "designer_images" in query:
            return FakeRecord({"id": "img-uuid-integration-001"})
        if "agent_configs" in query:
            return FakeRecord({"id": "agent-config-uuid"})
        return None


def _make_upload_state(
    tenant_id: str = "tenant-resilience-001",
    execution_id: str = "exec-resilience-001",
    processed_images: dict | None = None,
    warnings: list | None = None,
) -> dict:
    """Create a state for upload_and_persist tests."""
    if processed_images is None:
        processed_images = {
            "instagram": {
                "original_bytes": b"\x89PNG" + b"\x00" * 1000,
                "thumbnail_bytes": b"\xff\xd8\xff" + b"\x00" * 500,
                "overlay_bytes": None,
            }
        }
    return {
        "tenant_id": tenant_id,
        "user_id": "user-resilience-001",
        "trace_id": "trace-resilience-001",
        "execution_id": execution_id,
        "request": {
            "descricao_visual": "Imagem profissional de teste",
            "redes_sociais": list(processed_images.keys()),
        },
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
        "visual_prompts": {"instagram": "Prompt de integração"},
        "negative_prompts": [],
        "guardrail_attempt": 0,
        "guardrail_violations": [],
        "generated_images": {
            "instagram": {
                "image_bytes": b"\x89PNG" + b"\x00" * 1000,
                "format": "PNG",
                "model_id": "gemini-3.1-flash-image",
                "width": 1080,
                "height": 1350,
                "input_tokens": 100,
                "output_tokens": 50,
            }
        },
        "generation_errors": {},
        "model_id": "gemini-3.1-flash-image",
        "used_fallback": False,
        "processed_images": processed_images,
        "logo_overlay_applied": False,
        "logo_overlay_warnings": [],
        "image_urls": {},
        "image_metadata": [],
        "steps": [{"node": "generate_images", "duration_ms": 5000}],
        "tokens_consumed": 250,
        "duration_ms": 0,
        "warnings": warnings or [],
        "output": "",
    }


# =============================================================================
# Scenario 1: Model Fallback (Req 10.3)
# Primary model times out/errors → fallback model used → used_fallback=True
# =============================================================================


class TestModelFallbackResilience:
    """Cross-cutting test: the full model fallback path from error to recovery.

    Validates the end-to-end resilience guarantee: when the primary image model
    is unavailable (timeout or 5xx error), the system transparently switches to
    the fallback model and produces results with the used_fallback flag set.

    Requirements: 10.3 (30s timeout per model, primary + fallback)
    """

    @pytest.mark.asyncio
    async def test_primary_error_triggers_fallback_across_all_networks(self):
        """Primary model errors for all networks → all recover via fallback → used_fallback=True.

        This is the critical cross-cutting scenario: multiple networks all experience
        primary model failure, and ALL transparently recover using fallback, producing
        a full successful result set.
        """
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if model_name == "gemini-primary":
                raise ConnectionError("Primary model HTTP 503: Service overloaded")
            return _make_image_response(model_id="gemini-fallback", width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_generate_state(
            visual_prompts={
                "instagram": "IG image",
                "facebook": "FB image",
            }
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)
            result = await node(state)

        # All networks recovered via fallback
        assert len(result["generated_images"]) == 2
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-fallback"
        assert result["generated_images"]["facebook"]["model_id"] == "gemini-fallback"
        assert result["used_fallback"] is True
        assert result["generation_errors"] == {}

    @pytest.mark.asyncio
    async def test_primary_timeout_triggers_fallback_within_budget(self):
        """Primary times out (30s) → fallback succeeds within its own 30s budget.

        Validates that the timeout is per-model (30s primary + 30s fallback),
        NOT per-image (60s total), as specified in Req 10.3.
        """
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            if model_name == "gemini-primary":
                # Would exceed the 30s per-model timeout
                await asyncio.sleep(100)
                return _make_image_response()
            # Fallback responds quickly
            return _make_image_response(model_id="gemini-fallback", width=width, height=height)

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_generate_state(visual_prompts={"instagram": "IG image"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            # Use a very short timeout for test speed
            with patch("src.workflows.designer_agent.IMAGE_GENERATION_TIMEOUT_SECONDS", 0.01):
                result = await node(state)

        # Fallback recovered the timeout situation
        assert "instagram" in result["generated_images"]
        assert result["generated_images"]["instagram"]["model_id"] == "gemini-fallback"
        assert result["used_fallback"] is True
        assert result["generation_errors"] == {}

    @pytest.mark.asyncio
    async def test_both_primary_and_fallback_fail_raises_503(self):
        """Primary + fallback both fail → AllNetworksFailedError (503) + CRITICAL log.

        Validates the terminal failure case where neither model is available.
        """
        mock_pool, mock_conn = _make_mock_pool(
            primary_name="gemini-primary", fallback_name="gemini-fallback"
        )

        async def mock_image_client(prompt, negative_prompt, model_name, width, height):
            raise ConnectionError(f"{model_name}: Service completely unavailable")

        node = make_generate_images(mock_pool, mock_image_client)
        state = _make_generate_state(visual_prompts={"instagram": "IG image"})

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=None)

            with patch("src.workflows.designer_agent.logger") as mock_logger:
                with pytest.raises(AllNetworksFailedError) as exc_info:
                    await node(state)

                # CRITICAL log emitted for total failure
                mock_logger.critical.assert_called_once()

        assert exc_info.value.http_status == 503
        assert "instagram" in exc_info.value.errors


# =============================================================================
# Scenario 2: Logging Fallback (Req 10.7)
# _emit_final_structured_log catches exception → writes to stdout → execution continues
# =============================================================================


class TestLoggingFallbackResilience:
    """Cross-cutting test: logging subsystem failure does not crash the workflow.

    Validates the resilience guarantee that if the logging infrastructure
    is unavailable, the Designer Agent continues execution normally and
    writes the event to stdout as a fallback for later recovery.

    Requirements: 10.7
    """

    def test_logging_failure_falls_back_to_stdout_preserving_all_fields(
        self, capsys: pytest.CaptureFixture
    ) -> None:
        """Logging system exception → stdout JSON fallback with all required fields.

        This exercises the full fallback chain: normal logging fails → catch →
        write structured JSON to stdout with all observability fields intact.
        """
        with patch(
            "src.workflows.designer_agent.logger.log",
            side_effect=RuntimeError("Logging infrastructure unavailable"),
        ):
            # Must NOT raise — this is the critical resilience guarantee
            _emit_final_structured_log(
                trace_id="trace-logging-fallback-001",
                execution_id="exec-logging-fallback-001",
                tenant_id="tenant-logging-fallback-001",
                user_id="user-logging-fallback-001",
                duration_ms=15000,
                tokens_consumed=1500,
                model_id="gemini-3.1-flash-image",
                qtd_imagens=3,
                qtd_violacoes=1,
                status_final="success",
            )

        captured = capsys.readouterr()
        assert "[FALLBACK_LOG]" in captured.out

        # Parse the fallback JSON
        json_str = captured.out.strip().replace("[FALLBACK_LOG] ", "")
        fallback_data = json.loads(json_str)

        # Verify all required observability fields are preserved
        assert fallback_data["trace_id"] == "trace-logging-fallback-001"
        assert fallback_data["execution_id"] == "exec-logging-fallback-001"
        assert fallback_data["tenant_id"] == "tenant-logging-fallback-001"
        assert fallback_data["user_id"] == "user-logging-fallback-001"
        assert fallback_data["duracao_ms"] == 15000
        assert fallback_data["tokens_consumidos"] == 1500
        assert fallback_data["modelo_utilizado"] == "gemini-3.1-flash-image"
        assert fallback_data["qtd_imagens"] == 3
        assert fallback_data["qtd_violacoes"] == 1
        assert fallback_data["status_final"] == "success"

    def test_both_logging_and_stdout_fail_execution_continues(self) -> None:
        """Both logging + stdout fail → execution continues silently (no crash).

        This is the ultimate resilience guarantee: even if ALL logging
        mechanisms fail, the workflow continues to serve the user.
        """
        with patch(
            "src.workflows.designer_agent.logger.log",
            side_effect=RuntimeError("Logging broken"),
        ), patch(
            "builtins.print",
            side_effect=RuntimeError("stdout also broken"),
        ):
            # Must NOT raise — execution continues no matter what
            _emit_final_structured_log(
                trace_id="trace-all-broken",
                execution_id="exec-all-broken",
                tenant_id="tenant-all-broken",
                user_id="user-all-broken",
                duration_ms=2000,
                tokens_consumed=0,
                model_id="",
                qtd_imagens=0,
                qtd_violacoes=0,
                status_final="error",
            )
            # Reaching here without exception proves the resilience contract


# =============================================================================
# Scenario 3: Upload Retry to MinIO (Req 10.3)
# MinIO upload fails transiently → succeeds on retry 2 or 3 → no error raised
# =============================================================================


class TestUploadRetryResilience:
    """Cross-cutting test: transient MinIO failures are absorbed by retry logic.

    Validates the resilience guarantee that transient upload failures
    (network blips, temporary MinIO unavailability) are handled transparently
    with exponential backoff (1s, 2s, 4s) and do not propagate to the user.

    Requirements: 10.3 (MinIO upload: 3 attempts with backoff)
    """

    @pytest.mark.asyncio
    async def test_upload_succeeds_after_transient_failures(self):
        """Upload fails first 2 attempts → succeeds on 3rd → images delivered normally.

        Exercises the full retry path through the upload_and_persist node,
        verifying the final result contains valid image URLs despite failures.
        """
        # Client fails 2 times then succeeds (within the 3-attempt budget)
        client = FakeStorageClient(fail_count=2)
        node = make_upload_and_persist(
            storage_client=client,
            timestamp_fn=lambda: "20260715143052123",
        )

        state = _make_upload_state()

        with patch("src.workflows.designer_agent.asyncio.sleep", new_callable=AsyncMock):
            with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
                fake_conn = FakeConnection()

                @asynccontextmanager
                async def fake_tenant_conn(pool, tid):
                    yield fake_conn

                mock_tc.side_effect = fake_tenant_conn
                fake_pool = MagicMock()
                node_with_db = make_upload_and_persist(
                    storage_client=client,
                    pg_pool=fake_pool,
                    timestamp_fn=lambda: "20260715143052123",
                )
                result = await node_with_db(state)

        # Images delivered successfully despite transient failures
        assert "instagram" in result["image_urls"]
        assert "presigned" in result["image_urls"]["instagram"]["url"]
        # Each file required 3 attempts (2 failures + 1 success)
        for path, attempts in client._attempt_tracker.items():
            assert attempts == 3

    @pytest.mark.asyncio
    async def test_upload_retry_exhaustion_propagates_503(self):
        """Upload fails all 3 attempts → UploadFailedError(503) is raised.

        Validates the boundary case: when transient failures persist beyond
        the retry budget, the error correctly propagates as a 503.
        """
        client = FakeStorageClient(
            fail_on_paths=[
                "tenant-resilience-001/designer/exec-resilience-001/instagram_20260715143052123.png"
            ]
        )

        with patch("src.workflows.designer_agent.asyncio.sleep", new_callable=AsyncMock):
            with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:
                fake_conn = FakeConnection()

                @asynccontextmanager
                async def fake_tenant_conn(pool, tid):
                    yield fake_conn

                mock_tc.side_effect = fake_tenant_conn
                fake_pool = MagicMock()
                node = make_upload_and_persist(
                    storage_client=client,
                    pg_pool=fake_pool,
                    timestamp_fn=lambda: "20260715143052123",
                )

                state = _make_upload_state()

                with pytest.raises(UploadFailedError) as exc_info:
                    await node(state)

        assert exc_info.value.http_status == 503
        assert exc_info.value.attempts == UPLOAD_MAX_RETRIES

    @pytest.mark.asyncio
    async def test_upload_retry_uses_exponential_backoff(self):
        """Retry delays follow exponential backoff: 1s, 2s, 4s."""
        client = FakeStorageClient(fail_on_paths=["always/fail.png"])
        sleep_calls: list[float] = []

        original_sleep = asyncio.sleep

        async def capture_sleep(seconds):
            sleep_calls.append(seconds)

        with patch("src.workflows.designer_agent.asyncio.sleep", side_effect=capture_sleep):
            with pytest.raises(UploadFailedError):
                await _upload_with_retry(
                    client, "always/fail.png", b"data", "image/png",
                    max_retries=3,
                    backoff_delays=list(UPLOAD_BACKOFF_DELAYS),
                )

        # Should sleep between attempts: 1.0s after 1st fail, 2.0s after 2nd fail
        assert sleep_calls == [1.0, 2.0]


# =============================================================================
# Scenario 4: Agent Memory Continuity (Req 10.5)
# Agent Memory INSERT fails after 2 retries → images returned normally → WARNING
# =============================================================================


class TestAgentMemoryContinuity:
    """Cross-cutting test: Agent Memory failure does not block image delivery.

    Validates the critical resilience guarantee: even when the Agent Memory
    persistence layer is completely unavailable, the user still receives their
    generated images with a WARNING indicating the memory failure.

    Requirements: 10.5 (Agent Memory: 2 retries with 1s interval → continue + WARNING)
    """

    @pytest.mark.asyncio
    async def test_agent_memory_failure_delivers_images_with_warning(self):
        """Agent Memory fails after 2 retries → images returned normally + WARNING.

        This is the complete end-to-end resilience path: Agent Memory INSERT
        fails on both attempts, but the user still receives all generated images
        and the response includes a warning about the memory persistence failure.
        """
        client = FakeStorageClient()

        # Connection that fails specifically on agent_memory_short INSERT
        fake_conn = FakeConnection(
            execute_side_effect=ConnectionError("Agent Memory completely unavailable")
        )

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:

            @asynccontextmanager
            async def fake_tenant_conn(pool, tid):
                yield fake_conn

            mock_tc.side_effect = fake_tenant_conn

            fake_pool = MagicMock()
            node = make_upload_and_persist(
                storage_client=client,
                pg_pool=fake_pool,
                timestamp_fn=lambda: "20260715143052123",
            )

            state = _make_upload_state()

            with patch("src.workflows.designer_agent.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
                result = await node(state)

        # Images delivered successfully despite Agent Memory failure
        assert "instagram" in result["image_urls"]
        assert result["image_urls"]["instagram"]["url"] is not None
        assert "presigned" in result["image_urls"]["instagram"]["url"]

        # WARNING about Agent Memory failure in warnings list
        assert any("Agent Memory" in w for w in result["warnings"])

        # Output JSON is still valid and complete
        output = json.loads(result["output"])
        assert output["status"] == "generated"
        assert output["executionId"] == "exec-resilience-001"
        assert "instagram" in output["images"]
        assert output["images"]["instagram"]["status"] == "generated"

    @pytest.mark.asyncio
    async def test_agent_memory_retries_exactly_twice_with_1s_interval(self):
        """Agent Memory retry: exactly 2 attempts with 1s delay between them.

        Validates the specific retry contract: max 2 attempts with exactly
        AGENT_MEMORY_RETRY_INTERVAL_SECONDS (1.0s) between them.
        """
        client = FakeStorageClient()
        attempt_counter = {"count": 0}
        sleep_durations: list[float] = []

        class CountingAgentMemoryConn:
            """Connection that counts agent_memory attempts and tracks sleeps."""

            def __init__(self):
                self.execute_calls: list[tuple] = []
                self.fetchrow_calls: list[tuple] = []

            async def execute(self, query: str, *args):
                if "agent_memory_short" in query:
                    attempt_counter["count"] += 1
                    raise ConnectionError("Agent Memory down")
                self.execute_calls.append((query, args))

            async def fetchrow(self, query: str, *args):
                self.fetchrow_calls.append((query, args))
                if "RETURNING id" in query:
                    return FakeRecord({"id": "img-uuid-retry-001"})
                if "agent_configs" in query:
                    return FakeRecord({"id": "agent-config-uuid"})
                return None

        fake_conn = CountingAgentMemoryConn()

        async def track_sleep(seconds):
            sleep_durations.append(seconds)

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:

            @asynccontextmanager
            async def fake_tenant_conn(pool, tid):
                yield fake_conn

            mock_tc.side_effect = fake_tenant_conn

            fake_pool = MagicMock()
            node = make_upload_and_persist(
                storage_client=client,
                pg_pool=fake_pool,
                timestamp_fn=lambda: "20260715143052123",
            )

            state = _make_upload_state()

            with patch("src.workflows.designer_agent.asyncio.sleep", side_effect=track_sleep):
                result = await node(state)

        # Exactly AGENT_MEMORY_MAX_RETRIES attempts
        assert attempt_counter["count"] == AGENT_MEMORY_MAX_RETRIES

        # Exactly 1 sleep (between attempt 1 and 2)
        assert len(sleep_durations) == 1
        assert sleep_durations[0] == AGENT_MEMORY_RETRY_INTERVAL_SECONDS

        # Images still delivered
        assert "instagram" in result["image_urls"]

    @pytest.mark.asyncio
    async def test_agent_memory_success_no_warning(self):
        """Agent Memory persists successfully → no warning in response.

        Validates the positive case: when Agent Memory works, the response
        is clean with no resilience warnings.
        """
        client = FakeStorageClient()
        fake_conn = FakeConnection()  # No side_effect → execute succeeds

        with patch("src.workflows.designer_agent.tenant_connection") as mock_tc:

            @asynccontextmanager
            async def fake_tenant_conn(pool, tid):
                yield fake_conn

            mock_tc.side_effect = fake_tenant_conn

            fake_pool = MagicMock()
            node = make_upload_and_persist(
                storage_client=client,
                pg_pool=fake_pool,
                timestamp_fn=lambda: "20260715143052123",
            )

            state = _make_upload_state()
            result = await node(state)

        # No Agent Memory warning
        assert not any("Agent Memory" in w for w in result["warnings"])

        # Images delivered normally
        assert "instagram" in result["image_urls"]
        output = json.loads(result["output"])
        assert output["status"] == "generated"
