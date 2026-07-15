"""Tests for Designer Agent structured logging (Task 13.1).

Tests cover:
- _emit_final_structured_log emits INFO log for success status
- _emit_final_structured_log emits ERROR log for failure status
- All required fields are present in log output
- If logging fails, execution continues and event is written to stdout as fallback
- Stdout fallback contains valid JSON with all required fields

Requirements: 10.2, 10.6, 10.7
"""

from __future__ import annotations

import json
import logging
from io import StringIO
from unittest.mock import patch

import pytest

from src.workflows.designer_agent import _emit_final_structured_log


class TestEmitFinalStructuredLog:
    """Tests for the _emit_final_structured_log function."""

    def test_emits_info_log_for_success(self, caplog: pytest.LogCaptureFixture) -> None:
        """Verifies INFO level is used when status_final is 'success'."""
        with caplog.at_level(logging.INFO, logger="src.workflows.designer_agent"):
            _emit_final_structured_log(
                trace_id="trace-abc-123",
                execution_id="exec-def-456",
                tenant_id="tenant-ghi-789",
                user_id="user-jkl-012",
                duration_ms=12500,
                tokens_consumed=1250,
                model_id="gemini-3.1-flash-image",
                qtd_imagens=3,
                qtd_violacoes=0,
                status_final="success",
            )

        assert len(caplog.records) == 1
        record = caplog.records[0]
        assert record.levelno == logging.INFO
        assert "designer_agent_execution_complete" in record.message
        assert "trace-abc-123" in record.message
        assert "exec-def-456" in record.message
        assert "tenant-ghi-789" in record.message
        assert "user-jkl-012" in record.message
        assert "12500" in record.message
        assert "1250" in record.message
        assert "gemini-3.1-flash-image" in record.message
        assert "success" in record.message

    def test_emits_error_log_for_failure(self, caplog: pytest.LogCaptureFixture) -> None:
        """Verifies ERROR level is used when status_final is 'error'."""
        with caplog.at_level(logging.ERROR, logger="src.workflows.designer_agent"):
            _emit_final_structured_log(
                trace_id="trace-err-111",
                execution_id="exec-err-222",
                tenant_id="tenant-err-333",
                user_id="user-err-444",
                duration_ms=5000,
                tokens_consumed=0,
                model_id="gemini-3.1-flash-image",
                qtd_imagens=0,
                qtd_violacoes=0,
                status_final="error",
            )

        assert len(caplog.records) == 1
        record = caplog.records[0]
        assert record.levelno == logging.ERROR
        assert "designer_agent_execution_complete" in record.message

    def test_emits_error_log_for_guardrail_blocked(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Verifies ERROR level is used when status_final is 'guardrail_blocked'."""
        with caplog.at_level(logging.ERROR, logger="src.workflows.designer_agent"):
            _emit_final_structured_log(
                trace_id="trace-blk-555",
                execution_id="exec-blk-666",
                tenant_id="tenant-blk-777",
                user_id="user-blk-888",
                duration_ms=3000,
                tokens_consumed=500,
                model_id="gemini-3.1-flash-image",
                qtd_imagens=0,
                qtd_violacoes=2,
                status_final="guardrail_blocked",
            )

        assert len(caplog.records) == 1
        record = caplog.records[0]
        assert record.levelno == logging.ERROR
        assert "guardrail_blocked" in record.message
        assert "2" in record.message  # qtd_violacoes

    def test_contains_all_required_fields(self, caplog: pytest.LogCaptureFixture) -> None:
        """Verifies all required fields per Requirement 10.2 are present in log."""
        with caplog.at_level(logging.INFO, logger="src.workflows.designer_agent"):
            _emit_final_structured_log(
                trace_id="trace-full-aaa",
                execution_id="exec-full-bbb",
                tenant_id="tenant-full-ccc",
                user_id="user-full-ddd",
                duration_ms=8000,
                tokens_consumed=900,
                model_id="gemini-fallback-model",
                qtd_imagens=2,
                qtd_violacoes=1,
                status_final="success",
            )

        msg = caplog.records[0].message
        # All required fields must appear in the log message
        assert "trace-full-aaa" in msg  # trace_id
        assert "exec-full-bbb" in msg  # execution_id
        assert "tenant-full-ccc" in msg  # tenant_id
        assert "user-full-ddd" in msg  # user_id
        assert "8000" in msg  # duracao_ms
        assert "900" in msg  # tokens_consumidos
        assert "gemini-fallback-model" in msg  # modelo_utilizado
        assert "2" in msg  # qtd_imagens
        assert "1" in msg  # qtd_violacoes
        assert "success" in msg  # status_final

    def test_logging_failure_falls_back_to_stdout(self, capsys: pytest.CaptureFixture) -> None:
        """Verifies stdout fallback when logging fails (Requirement 10.7)."""
        with patch(
            "src.workflows.designer_agent.logger.log",
            side_effect=RuntimeError("Logging system failure"),
        ):
            # Should NOT raise — execution continues normally
            _emit_final_structured_log(
                trace_id="trace-fallback-999",
                execution_id="exec-fallback-888",
                tenant_id="tenant-fallback-777",
                user_id="user-fallback-666",
                duration_ms=4000,
                tokens_consumed=300,
                model_id="gemini-3.1-flash-image",
                qtd_imagens=1,
                qtd_violacoes=0,
                status_final="success",
            )

        captured = capsys.readouterr()
        assert "[FALLBACK_LOG]" in captured.out

        # Extract the JSON from stdout
        fallback_line = captured.out.strip()
        json_str = fallback_line.replace("[FALLBACK_LOG] ", "")
        fallback_data = json.loads(json_str)

        # Verify all required fields are in the fallback output
        assert fallback_data["trace_id"] == "trace-fallback-999"
        assert fallback_data["execution_id"] == "exec-fallback-888"
        assert fallback_data["tenant_id"] == "tenant-fallback-777"
        assert fallback_data["user_id"] == "user-fallback-666"
        assert fallback_data["duracao_ms"] == 4000
        assert fallback_data["tokens_consumidos"] == 300
        assert fallback_data["modelo_utilizado"] == "gemini-3.1-flash-image"
        assert fallback_data["qtd_imagens"] == 1
        assert fallback_data["qtd_violacoes"] == 0
        assert fallback_data["status_final"] == "success"

    def test_execution_continues_even_if_both_logging_and_stdout_fail(self) -> None:
        """Verifies execution does not crash even if both logging and stdout fail."""
        with patch(
            "src.workflows.designer_agent.logger.log",
            side_effect=RuntimeError("Logging broken"),
        ), patch(
            "builtins.print",
            side_effect=RuntimeError("stdout broken"),
        ):
            # Should NOT raise any exception
            _emit_final_structured_log(
                trace_id="trace-crash-111",
                execution_id="exec-crash-222",
                tenant_id="tenant-crash-333",
                user_id="user-crash-444",
                duration_ms=1000,
                tokens_consumed=0,
                model_id="",
                qtd_imagens=0,
                qtd_violacoes=0,
                status_final="error",
            )
            # If we reach here, the test passes — no exception was raised
