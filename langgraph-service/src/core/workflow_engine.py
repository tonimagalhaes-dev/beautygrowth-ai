"""Workflow Engine: executes DAG-based agent workflows using LangGraph."""

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional, Protocol

from .exceptions import GuardrailViolationError, NodeExecutionError, MAX_ERROR_MESSAGE_LENGTH


@dataclass
class ExecutionConfig:
    """Configuração para uma execução de workflow."""

    tenant_id: str
    user_id: str
    trace_id: str
    max_steps: int = 50
    timeout_ms: int = 120_000
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass
class TokenUsage:
    """Contabilização de tokens consumidos."""

    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class StepResult:
    """Resultado de um passo individual do workflow."""

    node_id: str
    node_type: str
    output: str
    duration_ms: int
    status: str
    tokens_used: TokenUsage = field(default_factory=TokenUsage)
    error_message: Optional[str] = None


@dataclass
class ExecutionResult:
    """Resultado de uma execução de workflow."""

    success: bool
    output: str
    trace_id: str
    model_id: str
    used_fallback: bool
    tokens_used: TokenUsage
    duration_ms: int
    steps: List[StepResult]
    final_state: Dict[str, Any]
    blocked_reason: Optional[str] = None
    guardrail_violations: Optional[List[str]] = None


@dataclass
class WorkflowEvent:
    """Evento emitido durante execução de workflow (streaming)."""

    event_type: str
    node_id: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)


class WorkflowEngine(Protocol):
    """Interface do motor de execução de workflows baseados em grafos."""

    async def execute(
        self,
        workflow_id: str,
        initial_state: Dict[str, Any],
        config: ExecutionConfig,
    ) -> ExecutionResult:
        """Executa um workflow completo e retorna o resultado."""
        ...

    async def execute_stream(
        self,
        workflow_id: str,
        initial_state: Dict[str, Any],
        config: ExecutionConfig,
    ) -> AsyncIterator[WorkflowEvent]:
        """Executa um workflow com streaming de eventos parciais."""
        ...

    def register_workflow(
        self,
        workflow_id: str,
        graph: Any,
    ) -> None:
        """Registra um grafo StateGraph compilado para um workflow_id."""
        ...


class WorkflowNotFoundError(Exception):
    """Raised when a workflow_id is not found in the registry."""

    pass


class LangGraphWorkflowEngine:
    """Concrete implementation of WorkflowEngine using LangGraph compiled graphs.

    Executes DAG-based workflows with timeout enforcement via asyncio.wait_for
    and recursion_limit via LangGraph's native config. Tracks each node execution
    as a StepResult with timing and status information.
    """

    def __init__(self, workflows: Optional[Dict[str, Any]] = None) -> None:
        """Initialize the engine with an optional dict of registered workflows.

        Args:
            workflows: Optional mapping of workflow_id -> compiled StateGraph.
        """
        self._workflows: Dict[str, Any] = workflows.copy() if workflows else {}

    def register_workflow(self, workflow_id: str, graph: Any) -> None:
        """Register a compiled StateGraph for a given workflow_id.

        Args:
            workflow_id: Unique identifier for the workflow.
            graph: A compiled LangGraph StateGraph ready for execution.
        """
        self._workflows[workflow_id] = graph

    async def execute(
        self,
        workflow_id: str,
        initial_state: Dict[str, Any],
        config: ExecutionConfig,
    ) -> ExecutionResult:
        """Execute a workflow and return the result.

        Looks up the compiled graph by workflow_id, configures recursion_limit,
        and enforces timeout via asyncio.wait_for. Collects step results from
        the graph execution output.

        Args:
            workflow_id: The registered workflow to execute.
            initial_state: Initial state dict to pass to the graph.
            config: Execution configuration (timeout, max_steps, tenant info).

        Returns:
            ExecutionResult with success status, output, steps, and timing.

        Raises:
            WorkflowNotFoundError: If workflow_id is not registered.
        """
        if workflow_id not in self._workflows:
            raise WorkflowNotFoundError(
                f"Workflow '{workflow_id}' not found. "
                f"Registered workflows: {sorted(self._workflows.keys())}"
            )

        graph = self._workflows[workflow_id]
        execution_id = str(uuid.uuid4())

        # Build LangGraph config with recursion_limit and thread_id
        lg_config = {
            "configurable": {"thread_id": execution_id},
            "recursion_limit": config.max_steps,
        }

        start_time = time.perf_counter()
        timeout_seconds = config.timeout_ms / 1000

        try:
            # Execute with timeout enforcement
            result = await asyncio.wait_for(
                graph.ainvoke(initial_state, config=lg_config),
                timeout=timeout_seconds,
            )

            duration_ms = int((time.perf_counter() - start_time) * 1000)

            # Extract steps from graph result
            steps = self._extract_steps(result)

            # Aggregate token usage from steps
            tokens_used = self._aggregate_tokens(steps)

            output = result.get("output", "")

            return ExecutionResult(
                success=True,
                output=output,
                trace_id=config.trace_id,
                model_id=result.get("model_id", ""),
                used_fallback=False,
                tokens_used=tokens_used,
                duration_ms=duration_ms,
                steps=steps,
                final_state=dict(result) if result else {},
            )

        except asyncio.TimeoutError:
            duration_ms = int((time.perf_counter() - start_time) * 1000)

            return ExecutionResult(
                success=False,
                output="",
                trace_id=config.trace_id,
                model_id="",
                used_fallback=False,
                tokens_used=TokenUsage(),
                duration_ms=duration_ms,
                steps=[],
                final_state={},
                blocked_reason=f"TIMEOUT: Execution exceeded {config.timeout_ms}ms limit",
            )

        except GuardrailViolationError as e:
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            blocked_reason = (
                f"Guardrail violation at node {e.node_id}: {e.violations}"
            )[:MAX_ERROR_MESSAGE_LENGTH]

            return ExecutionResult(
                success=False,
                output="",
                trace_id=config.trace_id,
                model_id="",
                used_fallback=False,
                tokens_used=TokenUsage(),
                duration_ms=duration_ms,
                steps=[],
                final_state={},
                blocked_reason=blocked_reason,
                guardrail_violations=e.violations,
            )

        except NodeExecutionError as e:
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            blocked_reason = (
                f"Node '{e.node_id}' ({e.node_type}) failed: {e.error_message}"
            )[:MAX_ERROR_MESSAGE_LENGTH]

            # Record the failed node as a step
            failed_step = StepResult(
                node_id=e.node_id,
                node_type=e.node_type,
                output="",
                duration_ms=0,
                status="failed",
                error_message=e.error_message,
            )

            return ExecutionResult(
                success=False,
                output="",
                trace_id=config.trace_id,
                model_id="",
                used_fallback=False,
                tokens_used=TokenUsage(),
                duration_ms=duration_ms,
                steps=[failed_step],
                final_state={},
                blocked_reason=blocked_reason,
            )

        except Exception as e:
            # Catch GraphRecursionError and other unexpected errors
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            error_type = type(e).__name__
            error_msg = str(e)[:MAX_ERROR_MESSAGE_LENGTH]

            # Check if it's a recursion limit error
            is_recursion_error = "recursion" in error_type.lower() or (
                "recursion" in error_msg.lower()
            )

            if is_recursion_error:
                blocked_reason = (
                    f"RECURSION_LIMIT: Execution exceeded recursion_limit "
                    f"of {config.max_steps} steps"
                )[:MAX_ERROR_MESSAGE_LENGTH]
            else:
                blocked_reason = f"{error_type}: {error_msg}"
                blocked_reason = blocked_reason[:MAX_ERROR_MESSAGE_LENGTH]

            return ExecutionResult(
                success=False,
                output="",
                trace_id=config.trace_id,
                model_id="",
                used_fallback=False,
                tokens_used=TokenUsage(),
                duration_ms=duration_ms,
                steps=[],
                final_state={},
                blocked_reason=blocked_reason,
            )

    async def execute_stream(
        self,
        workflow_id: str,
        initial_state: Dict[str, Any],
        config: ExecutionConfig,
    ) -> AsyncIterator[WorkflowEvent]:
        """Execute a workflow with streaming of partial events.

        Placeholder implementation — will be fully implemented in a later task.
        """
        result = await self.execute(workflow_id, initial_state, config)
        yield WorkflowEvent(
            event_type="workflow_completed",
            data={"output": result.output, "success": result.success},
        )

    def _extract_steps(self, result: Dict[str, Any]) -> List[StepResult]:
        """Extract StepResult list from graph execution result.

        The graph nodes append step dicts to the 'steps' key in state.
        Each step dict contains: node_id, node_type, output, duration_ms, status.

        Args:
            result: The final state dict returned by graph.ainvoke.

        Returns:
            List of StepResult dataclasses.
        """
        raw_steps = result.get("steps", [])
        steps: List[StepResult] = []

        for raw in raw_steps:
            if isinstance(raw, dict):
                tokens_data = raw.get("tokens_used", {})
                if isinstance(tokens_data, TokenUsage):
                    tokens_used = tokens_data
                elif isinstance(tokens_data, dict):
                    tokens_used = TokenUsage(
                        input_tokens=tokens_data.get("input_tokens", 0),
                        output_tokens=tokens_data.get("output_tokens", 0),
                    )
                else:
                    tokens_used = TokenUsage()

                steps.append(
                    StepResult(
                        node_id=raw.get("node_id", ""),
                        node_type=raw.get("node_type", ""),
                        output=raw.get("output", ""),
                        duration_ms=raw.get("duration_ms", 0),
                        status=raw.get("status", "completed"),
                        tokens_used=tokens_used,
                        error_message=raw.get("error_message"),
                    )
                )
            elif isinstance(raw, StepResult):
                steps.append(raw)

        return steps

    def _aggregate_tokens(self, steps: List[StepResult]) -> TokenUsage:
        """Aggregate token usage across all steps.

        Args:
            steps: List of step results with individual token counts.

        Returns:
            TokenUsage with summed input and output tokens.
        """
        total_input = sum(s.tokens_used.input_tokens for s in steps)
        total_output = sum(s.tokens_used.output_tokens for s in steps)
        return TokenUsage(input_tokens=total_input, output_tokens=total_output)
