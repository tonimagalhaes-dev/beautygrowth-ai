"""Custom exceptions for the LangGraph Service.

Provides a hierarchy of errors for Redis and PostgreSQL failures,
node execution failures, and guardrail violations,
with support for trace_id and execution_id for observability.
"""

from __future__ import annotations

MAX_ERROR_MESSAGE_LENGTH = 1024


class StateManagerError(Exception):
    """Base error for State Manager operations.

    Attributes:
        message: Human-readable error description.
        trace_id: Optional trace ID for distributed tracing correlation.
        execution_id: Optional execution ID for identifying the affected workflow.
    """

    def __init__(
        self,
        message: str,
        *,
        trace_id: str | None = None,
        execution_id: str | None = None,
    ) -> None:
        self.trace_id = trace_id
        self.execution_id = execution_id
        super().__init__(message)


class RedisUnavailableError(StateManagerError):
    """Raised when Redis is unavailable (connection or timeout errors).

    This error is raised when Redis cannot be reached during
    create_state, get_state, or update_state operations.
    The caller should handle gracefully — PostgreSQL state is not affected.
    """

    pass


class PersistenceError(StateManagerError):
    """Raised when PostgreSQL persistence fails after all retries.

    This error is raised when persist_final_state exhausts all retry
    attempts. The execution_id and trace_id are always set for
    recovery and diagnosis.
    """

    pass


class NodeExecutionError(Exception):
    """Raised when a node fails during workflow execution.

    Attributes:
        node_id: The ID of the node that failed.
        node_type: The type of the node that failed.
        error_message: Descriptive error message (truncated to 1024 chars).
    """

    def __init__(
        self,
        node_id: str,
        node_type: str,
        error_message: str,
    ) -> None:
        self.node_id = node_id
        self.node_type = node_type
        self.error_message = error_message[:MAX_ERROR_MESSAGE_LENGTH]
        super().__init__(self.error_message)


class GuardrailViolationError(Exception):
    """Raised when a guardrail node detects rule violations.

    This error interrupts the workflow execution and reports
    which rules were violated at which node.

    Attributes:
        node_id: The ID of the guardrail node that triggered the violation.
        violations: List of violated rule descriptions.
    """

    def __init__(
        self,
        node_id: str,
        violations: list[str],
    ) -> None:
        self.node_id = node_id
        self.violations = violations
        message = f"Guardrail violation at node {node_id}: {violations}"
        super().__init__(message[:MAX_ERROR_MESSAGE_LENGTH])
