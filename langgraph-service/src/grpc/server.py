"""gRPC Server: serves the AgentOrchestrationService over gRPC.

Implements the AgentOrchestrationServicer with handlers for:
- ExecuteWorkflow: orchestrates Agent Router + Workflow Engine + State Manager
- GetExecutionState: queries execution state from State Manager
- CancelExecution: cancels a running execution and persists partial state

The server uses grpc.aio for async operation and supports graceful shutdown.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import uuid
from concurrent import futures
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import grpc
import grpc.aio

from ..core.agent_router import (
    AgentNotFoundError,
    PostgresAgentRouter,
    ResolvedWorkflow,
    RouterConnectionError,
    WorkflowDefinition,
    WorkflowNotFoundError as RouterWorkflowNotFoundError,
    NodeDefinition,
    EdgeDefinition,
)
from ..core.exceptions import PersistenceError
from ..core.graph_builder import build_agent_graph
from ..core.state_manager import RedisStateManager
from ..core.workflow_engine import (
    ExecutionConfig,
    ExecutionResult,
    LangGraphWorkflowEngine,
    WorkflowEvent,
    WorkflowNotFoundError as EngineWorkflowNotFoundError,
)

logger = logging.getLogger(__name__)

DEFAULT_PORT = 50051
MAX_WORKERS = 10


# ============================================================
# Response dataclasses (map to protobuf messages)
# ============================================================


@dataclass
class TokenUsageResponse:
    """Maps to protobuf TokenUsage message."""

    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class StepResultResponse:
    """Maps to protobuf StepResult message."""

    node_id: str = ""
    node_type: str = ""
    output: str = ""
    duration_ms: int = 0
    tokens_used: TokenUsageResponse = field(default_factory=TokenUsageResponse)
    status: str = "completed"
    error_message: str = ""


@dataclass
class ExecutionStateResponse:
    """Maps to protobuf ExecutionState message."""

    execution_id: str = ""
    workflow_id: str = ""
    tenant_id: str = ""
    status: str = "pending"
    state_data: Dict[str, Any] = field(default_factory=dict)
    current_node: str = ""
    completed_nodes: List[str] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


@dataclass
class CancelExecutionResponse:
    """Maps to protobuf CancelExecutionResponse message."""

    success: bool = False
    message: str = ""


@dataclass
class ExecuteWorkflowResponse:
    """Maps to protobuf ExecuteWorkflowResponse message."""

    success: bool = False
    output: str = ""
    trace_id: str = ""
    model_id: str = ""
    used_fallback: bool = False
    tokens_used: TokenUsageResponse = field(default_factory=TokenUsageResponse)
    duration_ms: int = 0
    blocked_reason: str = ""
    guardrail_violations: List[str] = field(default_factory=list)
    final_state: Optional[ExecutionStateResponse] = None
    steps: List[StepResultResponse] = field(default_factory=list)


# ============================================================
# AgentOrchestrationServicer
# ============================================================


class AgentOrchestrationServicer:
    """Implements the AgentOrchestrationService gRPC service.

    Integrates Agent Router, Workflow Engine, and State Manager to
    handle workflow execution and state queries with multi-tenant isolation.
    """

    def __init__(
        self,
        state_manager: RedisStateManager,
        workflow_engine: LangGraphWorkflowEngine,
        agent_router: PostgresAgentRouter,
    ) -> None:
        """Initialize the servicer with core dependencies.

        Args:
            state_manager: Manages execution state in Redis/PostgreSQL.
            workflow_engine: Executes DAG-based workflows.
            agent_router: Resolves which workflow to execute per agent.
        """
        self._state_manager = state_manager
        self._workflow_engine = workflow_engine
        self._agent_router = agent_router

    async def ExecuteWorkflow(
        self,
        request: Any,
        context: grpc.aio.ServicerContext,
    ) -> Dict[str, Any]:
        """Handle ExecuteWorkflow RPC.

        Orchestrates the full execution flow:
        1. Extract tenant_id, agent_id, user_input from request
        2. Generate execution_id (UUID)
        3. Resolve workflow via agent_router
        4. Build graph from resolved workflow definition
        5. Register workflow in engine
        6. Create initial state via state_manager
        7. Execute workflow via engine
        8. Persist final state via state_manager
        9. Return ExecuteWorkflowResponse

        Args:
            request: ExecuteWorkflowRequest (dict-like or protobuf message).
            context: gRPC servicer context for error handling.

        Returns:
            Dict representing ExecuteWorkflowResponse.
        """
        # Extract fields from request (supports both dict and protobuf-like objects)
        tenant_id = _get_field(request, "tenant_id", "")
        agent_id = _get_field(request, "agent_id", "")
        user_input = _get_field(request, "user_input", "")
        user_id = _get_field(request, "user_id", "")
        conversation_id = _get_field(request, "conversation_id", "")
        workflow_id_hint = _get_field(request, "workflow_id", "")
        tenant_context = _get_field(request, "tenant_context", {})

        # Extract execution options
        options = _get_field(request, "options", {})
        max_steps = _get_nested_field(options, "max_steps", 50)
        timeout_ms = _get_nested_field(options, "timeout_ms", 120_000)

        # Generate identifiers
        execution_id = str(uuid.uuid4())
        trace_id = str(uuid.uuid4())

        logger.info(
            "ExecuteWorkflow started: execution_id=%s, agent_id=%s, tenant_id=%s",
            execution_id,
            agent_id,
            tenant_id,
        )

        try:
            # Step 1: Resolve workflow via Agent Router
            resolved = await self._agent_router.resolve_workflow(
                agent_id=agent_id,
                tenant_id=tenant_id,
                context=tenant_context if tenant_context else None,
            )

            resolved_workflow_id = resolved.workflow_id

            # Step 2: Only build & register if workflow not already registered
            if resolved_workflow_id not in self._workflow_engine._workflows:
                workflow_definition = _build_workflow_definition_from_resolved(resolved)
                compiled_graph = build_agent_graph(workflow_definition)
                self._workflow_engine.register_workflow(resolved_workflow_id, compiled_graph)








            # Step 4: Create initial state via State Manager
            initial_state = {
                "user_input": user_input,
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "conversation_id": conversation_id,
                "messages": [],
                "intermediate_results": {},
                "output": "",
                "steps": [],
            }

            await self._state_manager.create_state(
                execution_id=execution_id,
                tenant_id=tenant_id,
                workflow_id=resolved_workflow_id,
                initial_state=initial_state,
                trace_id=trace_id,
            )

            # Step 5: Execute workflow via engine
            config = ExecutionConfig(
                tenant_id=tenant_id,
                user_id=user_id,
                trace_id=trace_id,
                max_steps=max_steps or 50,
                timeout_ms=timeout_ms or 120_000,
            )

            result: ExecutionResult = await self._workflow_engine.execute(
                workflow_id=resolved_workflow_id,
                initial_state=initial_state,
                config=config,
            )

            # Step 6: Determine terminal status from result
            terminal_status = _determine_terminal_status(result)

            # Step 7: Persist final state (all terminal states must be persisted)
            final_state_data = {
                "execution_id": execution_id,
                "workflow_id": resolved_workflow_id,
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "conversation_id": conversation_id,
                "user_id": user_id,
                "user_input": user_input,
                "status": terminal_status,
                "output": result.output,
                "state_data": result.final_state,
                "steps": [_step_result_to_dict(s) for s in result.steps],
                "tokens_input": result.tokens_used.input_tokens,
                "tokens_output": result.tokens_used.output_tokens,
                "duration_ms": result.duration_ms,
                "model_id": result.model_id,
                "used_fallback": result.used_fallback,
                "error_message": result.blocked_reason,
                "blocked_reason": result.blocked_reason,
                "guardrail_violations": result.guardrail_violations,
                "completed_at": datetime.now(timezone.utc),
            }

            persistence_failed = False
            try:
                await self._state_manager.persist_final_state(
                    execution_id=execution_id,
                    tenant_id=tenant_id,
                    final_state=final_state_data,
                    trace_id=trace_id,
                )
            except PersistenceError as pe:
                # Requirement 10.5: If persistence fails, log with trace_id
                # and execution_id for recovery, but still return the result
                persistence_failed = True
                logger.error(
                    "Failed to persist final state for execution: "
                    "trace_id=%s, execution_id=%s, error=%s",
                    trace_id,
                    execution_id,
                    str(pe),
                    extra={
                        "trace_id": trace_id,
                        "execution_id": execution_id,
                        "tenant_id": tenant_id,
                        "status": terminal_status,
                    },
                )

            # Step 8: Build and return response
            # If persistence failed, indicate in blocked_reason but still return result
            effective_blocked_reason = result.blocked_reason or ""
            if persistence_failed and not effective_blocked_reason:
                effective_blocked_reason = (
                    "State may not have been persisted due to storage failure"
                )

            response = ExecuteWorkflowResponse(
                success=result.success if not persistence_failed else False,
                output=result.output,
                trace_id=trace_id,
                model_id=result.model_id,
                used_fallback=result.used_fallback,
                tokens_used=TokenUsageResponse(
                    input_tokens=result.tokens_used.input_tokens,
                    output_tokens=result.tokens_used.output_tokens,
                ),
                duration_ms=result.duration_ms,
                blocked_reason=effective_blocked_reason,
                guardrail_violations=result.guardrail_violations or [],
                final_state=ExecutionStateResponse(
                    execution_id=execution_id,
                    workflow_id=resolved_workflow_id,
                    tenant_id=tenant_id,
                    status=terminal_status if not persistence_failed else "failed",
                    state_data=result.final_state,
                    current_node="",
                    completed_nodes=[s.node_id for s in result.steps],
                    created_at=datetime.now(timezone.utc).isoformat(),
                    updated_at=datetime.now(timezone.utc).isoformat(),
                ),
                steps=[
                    StepResultResponse(
                        node_id=s.node_id,
                        node_type=s.node_type,
                        output=s.output,
                        duration_ms=s.duration_ms,
                        tokens_used=TokenUsageResponse(
                            input_tokens=s.tokens_used.input_tokens,
                            output_tokens=s.tokens_used.output_tokens,
                        ),
                        status=s.status,
                        error_message=s.error_message or "",
                    )
                    for s in result.steps
                ],
            )

            logger.info(
                "ExecuteWorkflow completed: execution_id=%s, success=%s, "
                "status=%s, duration_ms=%d, tokens_input=%d, tokens_output=%d",
                execution_id,
                result.success,
                terminal_status,
                result.duration_ms,
                result.tokens_used.input_tokens,
                result.tokens_used.output_tokens,
            )

            return asdict(response)

        except AgentNotFoundError as e:
            logger.warning(
                "Agent not found: agent_id=%s, tenant_id=%s, error=%s",
                agent_id,
                tenant_id,
                str(e),
            )
            await context.abort(
                grpc.StatusCode.NOT_FOUND,
                f"Agent not found: {agent_id}",
            )

        except RouterWorkflowNotFoundError as e:
            logger.warning(
                "Workflow not found for agent: agent_id=%s, tenant_id=%s",
                agent_id,
                tenant_id,
            )
            await context.abort(
                grpc.StatusCode.NOT_FOUND,
                f"No active workflow found for agent_id={agent_id}, tenant_id={tenant_id}",
            )

        except RouterConnectionError as e:
            logger.error(
                "Router connection error: agent_id=%s, tenant_id=%s, error=%s",
                agent_id,
                tenant_id,
                str(e),
            )
            await context.abort(
                grpc.StatusCode.UNAVAILABLE,
                "Service temporarily unavailable: database connection error",
            )

        except grpc.aio.AbortError:
            # Re-raise gRPC abort errors (from context.abort above)
            raise

        except Exception as e:
            logger.exception(
                "Unexpected error in ExecuteWorkflow: execution_id=%s, error=%s",
                execution_id,
                str(e),
            )
            await context.abort(
                grpc.StatusCode.INTERNAL,
                f"Internal error during workflow execution: {type(e).__name__}",
            )

    async def ExecuteWorkflowStream(
        self,
        request: Any,
        context: grpc.aio.ServicerContext,
    ):
        """Handle ExecuteWorkflowStream RPC (server-side streaming).

        Orchestrates workflow execution with streaming events:
        1. Extract tenant_id, agent_id, user_input from request
        2. Generate execution_id (UUID)
        3. Resolve workflow via agent_router
        4. Build graph from resolved workflow definition
        5. Register workflow in engine
        6. Create initial state via state_manager
        7. Execute workflow with streaming via engine.execute_stream()
        8. Map internal WorkflowEvent to proto-compatible stream event dicts
        9. Yield events to the client
        10. If enable_streaming=false: skip intermediate events, only emit terminal

        Args:
            request: ExecuteWorkflowRequest (dict-like or protobuf message).
            context: gRPC servicer context for error handling.

        Yields:
            Dicts representing WorkflowStreamEvent messages.
        """
        # Extract fields from request
        tenant_id = _get_field(request, "tenant_id", "")
        agent_id = _get_field(request, "agent_id", "")
        user_input = _get_field(request, "user_input", "")
        user_id = _get_field(request, "user_id", "")
        conversation_id = _get_field(request, "conversation_id", "")
        tenant_context = _get_field(request, "tenant_context", {})

        # Extract execution options
        options = _get_field(request, "options", {})
        max_steps = _get_nested_field(options, "max_steps", 50)
        timeout_ms = _get_nested_field(options, "timeout_ms", 120_000)
        enable_streaming = _get_nested_field(options, "enable_streaming", True)

        # Generate identifiers
        execution_id = str(uuid.uuid4())
        trace_id = str(uuid.uuid4())

        logger.info(
            "ExecuteWorkflowStream started: execution_id=%s, agent_id=%s, tenant_id=%s, streaming=%s",
            execution_id,
            agent_id,
            tenant_id,
            enable_streaming,
        )

        try:
            # Step 1: Resolve workflow via Agent Router
            resolved = await self._agent_router.resolve_workflow(
                agent_id=agent_id,
                tenant_id=tenant_id,
                context=tenant_context if tenant_context else None,
            )

            resolved_workflow_id = resolved.workflow_id

            # Step 2: Only build & register if workflow not already registered
            if resolved_workflow_id not in self._workflow_engine._workflows:
                workflow_definition = _build_workflow_definition_from_resolved(resolved)
                compiled_graph = build_agent_graph(workflow_definition)
                self._workflow_engine.register_workflow(resolved_workflow_id, compiled_graph)








            # Step 4: Create initial state via State Manager
            initial_state = {
                "user_input": user_input,
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "conversation_id": conversation_id,
                "messages": [],
                "intermediate_results": {},
                "output": "",
                "steps": [],
            }

            await self._state_manager.create_state(
                execution_id=execution_id,
                tenant_id=tenant_id,
                workflow_id=resolved_workflow_id,
                initial_state=initial_state,
                trace_id=trace_id,
            )

            # Step 5: Execute workflow with streaming
            config = ExecutionConfig(
                tenant_id=tenant_id,
                user_id=user_id,
                trace_id=trace_id,
                max_steps=max_steps or 50,
                timeout_ms=timeout_ms or 120_000,
            )

            async for event in self._workflow_engine.execute_stream(
                workflow_id=resolved_workflow_id,
                initial_state=initial_state,
                config=config,
            ):
                stream_event = _map_workflow_event_to_stream(event)

                # If streaming is disabled, only emit terminal events
                if not enable_streaming:
                    if event.event_type in ("workflow_completed", "workflow_error"):
                        yield stream_event
                else:
                    yield stream_event

            logger.info(
                "ExecuteWorkflowStream completed: execution_id=%s",
                execution_id,
            )

        except AgentNotFoundError as e:
            logger.warning(
                "Agent not found: agent_id=%s, tenant_id=%s, error=%s",
                agent_id,
                tenant_id,
                str(e),
            )
            # Emit workflow_error event and close stream
            yield {
                "workflow_error": {
                    "error_code": "NOT_FOUND",
                    "error_message": f"Agent not found: {agent_id}",
                    "node_id": "",
                }
            }

        except RouterWorkflowNotFoundError as e:
            logger.warning(
                "Workflow not found for agent: agent_id=%s, tenant_id=%s",
                agent_id,
                tenant_id,
            )
            yield {
                "workflow_error": {
                    "error_code": "NOT_FOUND",
                    "error_message": f"No active workflow found for agent_id={agent_id}, tenant_id={tenant_id}",
                    "node_id": "",
                }
            }

        except RouterConnectionError as e:
            logger.error(
                "Router connection error: agent_id=%s, tenant_id=%s, error=%s",
                agent_id,
                tenant_id,
                str(e),
            )
            yield {
                "workflow_error": {
                    "error_code": "UNAVAILABLE",
                    "error_message": "Service temporarily unavailable: database connection error",
                    "node_id": "",
                }
            }

        except Exception as e:
            logger.exception(
                "Unexpected error in ExecuteWorkflowStream: execution_id=%s, error=%s",
                execution_id,
                str(e),
            )
            yield {
                "workflow_error": {
                    "error_code": "INTERNAL",
                    "error_message": f"Internal error during workflow execution: {type(e).__name__}",
                    "node_id": "",
                }
            }

    async def GetExecutionState(
        self,
        request: Any,
        context: grpc.aio.ServicerContext,
    ) -> Dict[str, Any]:
        """Handle GetExecutionState RPC.

        Queries the State Manager for execution state by execution_id and tenant_id.

        Args:
            request: GetExecutionStateRequest (dict-like or protobuf message).
            context: gRPC servicer context for error handling.

        Returns:
            Dict representing ExecutionState, or sets gRPC NOT_FOUND error.
        """
        execution_id = _get_field(request, "execution_id", "")
        tenant_id = _get_field(request, "tenant_id", "")

        logger.info(
            "GetExecutionState: execution_id=%s, tenant_id=%s",
            execution_id,
            tenant_id,
        )

        if not execution_id or not tenant_id:
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                "execution_id and tenant_id are required",
            )
            return {}

        try:
            state = await self._state_manager.get_state(
                execution_id=execution_id,
                tenant_id=tenant_id,
            )

            if state is None:
                await context.abort(
                    grpc.StatusCode.NOT_FOUND,
                    f"Execution state not found: execution_id={execution_id}",
                )
                return {}

            # Build response from state data
            response = ExecutionStateResponse(
                execution_id=state.get("execution_id", execution_id),
                workflow_id=state.get("workflow_id", ""),
                tenant_id=state.get("tenant_id", tenant_id),
                status=state.get("status", "unknown"),
                state_data=state,
                current_node=state.get("current_node", ""),
                completed_nodes=state.get("completed_nodes", []),
                created_at=state.get("created_at", ""),
                updated_at=state.get("updated_at", ""),
            )

            logger.info(
                "GetExecutionState found: execution_id=%s, status=%s",
                execution_id,
                response.status,
            )

            return asdict(response)

        except grpc.aio.AbortError:
            # Re-raise gRPC abort errors (from context.abort above)
            raise
        except Exception as e:
            logger.exception(
                "Error in GetExecutionState: execution_id=%s, error=%s",
                execution_id,
                str(e),
            )
            await context.abort(
                grpc.StatusCode.INTERNAL,
                f"Internal error retrieving execution state: {type(e).__name__}",
            )
            return {}

    async def CancelExecution(
        self,
        request: Any,
        context: grpc.aio.ServicerContext,
    ) -> Dict[str, Any]:
        """Handle CancelExecution RPC.

        Cancels a running execution, persists partial state, and returns
        a CancelExecutionResponse indicating success or failure.

        Multi-tenant isolation: if the execution_id doesn't exist or belongs
        to a different tenant, returns success=false with a generic
        "not found" message without revealing existence to another tenant.

        Args:
            request: CancelExecutionRequest (dict-like or protobuf message).
            context: gRPC servicer context for error handling.

        Returns:
            Dict representing CancelExecutionResponse.
        """
        execution_id = _get_field(request, "execution_id", "")
        tenant_id = _get_field(request, "tenant_id", "")

        logger.info(
            "CancelExecution: execution_id=%s, tenant_id=%s",
            execution_id,
            tenant_id,
        )

        if not execution_id or not tenant_id:
            return asdict(CancelExecutionResponse(
                success=False,
                message="execution_id and tenant_id are required",
            ))

        try:
            # Query current state from State Manager (tenant-scoped)
            state = await self._state_manager.get_state(
                execution_id=execution_id,
                tenant_id=tenant_id,
            )

            # If state is None: execution doesn't exist or doesn't belong to this tenant
            if state is None:
                logger.info(
                    "CancelExecution: execution not found for tenant: "
                    "execution_id=%s, tenant_id=%s",
                    execution_id,
                    tenant_id,
                )
                return asdict(CancelExecutionResponse(
                    success=False,
                    message="Execution not found",
                ))

            # Check if execution is already in a terminal status
            current_status = state.get("status", "")
            terminal_statuses = {"completed", "failed", "timeout", "cancelled"}

            if current_status in terminal_statuses:
                logger.info(
                    "CancelExecution: cannot cancel execution with terminal status: "
                    "execution_id=%s, status=%s",
                    execution_id,
                    current_status,
                )
                return asdict(CancelExecutionResponse(
                    success=False,
                    message=f"Cannot cancel execution with status: {current_status}",
                ))

            # Execution is running/pending — cancel it
            now = datetime.now(timezone.utc)
            created_at_str = state.get("created_at", "")
            duration_ms = 0
            if created_at_str:
                try:
                    created_at = datetime.fromisoformat(created_at_str)
                    duration_ms = int((now - created_at).total_seconds() * 1000)
                except (ValueError, TypeError):
                    duration_ms = 0

            # Build cancellation state update
            cancellation_update = {
                "status": "cancelled",
                "current_node": state.get("current_node", ""),
                "duration_ms": duration_ms,
                "completed_at": now.isoformat(),
                "updated_at": now.isoformat(),
            }

            # Update state in Redis
            await self._state_manager.update_state(
                execution_id=execution_id,
                tenant_id=tenant_id,
                state_update=cancellation_update,
            )

            # Persist final state to PostgreSQL
            # If persistence fails, log for recovery but still return success
            # to the client (the cancellation itself succeeded)
            final_state = {
                **state,
                **cancellation_update,
                "tokens_input": state.get("tokens_input", 0),
                "tokens_output": state.get("tokens_output", 0),
            }
            try:
                await self._state_manager.persist_final_state(
                    execution_id=execution_id,
                    tenant_id=tenant_id,
                    final_state=final_state,
                )
            except PersistenceError as pe:
                # Requirement 10.5: Log with trace_id and execution_id for recovery
                trace_id = state.get("trace_id", "unknown")
                logger.error(
                    "Failed to persist cancelled state: "
                    "trace_id=%s, execution_id=%s, error=%s",
                    trace_id,
                    execution_id,
                    str(pe),
                    extra={
                        "trace_id": trace_id,
                        "execution_id": execution_id,
                        "tenant_id": tenant_id,
                        "status": "cancelled",
                    },
                )

            logger.info(
                "CancelExecution succeeded: execution_id=%s, duration_ms=%d",
                execution_id,
                duration_ms,
            )

            return asdict(CancelExecutionResponse(
                success=True,
                message="Execution cancelled successfully",
            ))

        except grpc.aio.AbortError:
            raise
        except Exception as e:
            logger.exception(
                "Error in CancelExecution: execution_id=%s, error=%s",
                execution_id,
                str(e),
            )
            return asdict(CancelExecutionResponse(
                success=False,
                message=f"Internal error during cancellation: {type(e).__name__}",
            ))


# ============================================================
# serve() function
# ============================================================


async def serve(
    servicer: AgentOrchestrationServicer,
    port: Optional[int] = None,
    interceptors: Optional[List[Any]] = None,
) -> None:
    """Start the gRPC server with graceful shutdown support.

    Creates a gRPC async server, registers the servicer, and listens
    on the specified port. Handles SIGTERM and SIGINT for graceful shutdown.

    Args:
        servicer: The AgentOrchestrationServicer instance to register.
        port: Port to listen on. Defaults to GRPC_PORT env var or 50051.
        interceptors: List of gRPC server interceptors to apply.
    """
    if port is None:
        port = int(os.environ.get("GRPC_PORT", str(DEFAULT_PORT)))

    server = grpc.aio.server(
        futures.ThreadPoolExecutor(max_workers=MAX_WORKERS),
        interceptors=interceptors or [],
    )

    # Register servicer — in production this would use the generated
    # add_AgentOrchestrationServiceServicer_to_server function.
    # For now, we register handlers manually via generic service.
    _register_servicer(server, servicer)

    listen_addr = f"[::]:{port}"
    server.add_insecure_port(listen_addr)

    logger.info("Starting gRPC server on %s", listen_addr)
    await server.start()
    logger.info("gRPC server started successfully on port %d", port)

    # Setup graceful shutdown handlers
    shutdown_event = asyncio.Event()

    def _signal_handler(sig: int) -> None:
        logger.info("Received signal %s, initiating graceful shutdown...", sig)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _signal_handler, sig)
        except NotImplementedError:
            # Windows doesn't support add_signal_handler
            pass

    # Wait for shutdown signal
    await shutdown_event.wait()

    # Graceful shutdown with grace period
    grace_period = float(os.environ.get("GRPC_SHUTDOWN_GRACE_SECONDS", "5"))
    logger.info("Shutting down gRPC server with %.1fs grace period...", grace_period)
    await server.stop(grace_period)
    logger.info("gRPC server stopped")


def _register_servicer(
    server: grpc.aio.Server,
    servicer: AgentOrchestrationServicer,
) -> None:
    """Register the servicer's handlers with the gRPC server using generated stubs.

    Wraps the dict-returning servicer into a proto-compatible servicer
    that serializes responses to protobuf messages.

    Args:
        server: The gRPC async server instance.
        servicer: The servicer to register.
    """
    from google.protobuf import json_format, struct_pb2
    from src.grpc.generated import agent_orchestration_pb2, agent_orchestration_pb2_grpc

    class _ProtoServicer(agent_orchestration_pb2_grpc.AgentOrchestrationServiceServicer):
        """Adapter that converts dict responses from servicer to proto messages."""

        def _request_to_dict(self, request):
            """Convert protobuf request to dict for the servicer.
            
            Directly extracts fields from protobuf message using attribute access.
            This avoids issues with MessageToDict not including empty-string fields.
            """
            result = {}
            # Extract all string fields directly
            for field_name in ['agent_id', 'tenant_id', 'user_input', 'user_id', 
                             'workflow_id', 'conversation_id']:
                val = getattr(request, field_name, '')
                result[field_name] = val

            # Extract tenant_context (map field)
            tc = getattr(request, 'tenant_context', None)
            result['tenant_context'] = dict(tc) if tc else {}

            # Extract options (nested message)
            opts = getattr(request, 'options', None)
            if opts:
                result['options'] = {
                    'max_steps': getattr(opts, 'max_steps', 50),
                    'timeout_ms': getattr(opts, 'timeout_ms', 120000),
                    'enable_streaming': getattr(opts, 'enable_streaming', False),
                    'metadata': dict(getattr(opts, 'metadata', {})),
                }
            else:
                result['options'] = {}

            return result

        async def ExecuteWorkflow(self, request, context):
            request_dict = self._request_to_dict(request)
            result = await servicer.ExecuteWorkflow(request_dict, context)
            if result is None:
                return agent_orchestration_pb2.ExecuteWorkflowResponse()
            return _dict_to_execute_response(result)

        async def ExecuteWorkflowStream(self, request, context):
            request_dict = self._request_to_dict(request)
            async for event_dict in servicer.ExecuteWorkflowStream(request_dict, context):
                yield _dict_to_stream_event(event_dict)

        async def GetExecutionState(self, request, context):
            request_dict = self._request_to_dict(request)
            result = await servicer.GetExecutionState(request_dict, context)
            if result is None:
                return agent_orchestration_pb2.ExecutionState()
            return _dict_to_execution_state(result)

        async def CancelExecution(self, request, context):
            request_dict = self._request_to_dict(request)
            result = await servicer.CancelExecution(request_dict, context)
            if result is None:
                return agent_orchestration_pb2.CancelExecutionResponse()
            resp = agent_orchestration_pb2.CancelExecutionResponse()
            resp.success = result.get("success", False)
            resp.message = result.get("message", "")
            return resp

        async def HealthCheck(self, request, context):
            resp = agent_orchestration_pb2.HealthCheckResponse()
            resp.status = agent_orchestration_pb2.SERVICE_STATUS_SERVING
            resp.version = os.environ.get("SERVICE_VERSION", "0.1.0")
            return resp

    def _dict_to_execute_response(d: dict) -> agent_orchestration_pb2.ExecuteWorkflowResponse:
        resp = agent_orchestration_pb2.ExecuteWorkflowResponse()
        resp.success = d.get("success", False)
        resp.output = d.get("output", "")
        resp.trace_id = d.get("trace_id", "")
        resp.model_id = d.get("model_id", "")
        resp.used_fallback = d.get("used_fallback", False)
        resp.duration_ms = d.get("duration_ms", 0)
        resp.blocked_reason = d.get("blocked_reason", "")
        for v in d.get("guardrail_violations", []):
            resp.guardrail_violations.append(v)

        tokens = d.get("tokens_used", {})
        if tokens:
            resp.tokens_used.input_tokens = tokens.get("input_tokens", 0)
            resp.tokens_used.output_tokens = tokens.get("output_tokens", 0)

        steps = d.get("steps", [])
        for step in steps:
            s = resp.steps.add()
            s.node_id = step.get("node_id", "")
            s.node_type = step.get("node_type", "")
            s.output = step.get("output", "")
            s.duration_ms = step.get("duration_ms", 0)
            s.error_message = step.get("error_message", "")
            step_tokens = step.get("tokens_used", {})
            if step_tokens:
                s.tokens_used.input_tokens = step_tokens.get("input_tokens", 0)
                s.tokens_used.output_tokens = step_tokens.get("output_tokens", 0)

        return resp

    def _dict_to_execution_state(d: dict) -> agent_orchestration_pb2.ExecutionState:
        state = agent_orchestration_pb2.ExecutionState()
        state.execution_id = d.get("execution_id", "")
        state.workflow_id = d.get("workflow_id", "")
        state.tenant_id = d.get("tenant_id", "")
        state.current_node = d.get("current_node", "")
        for n in d.get("completed_nodes", []):
            state.completed_nodes.append(n)
        # state_data as Struct
        state_data = d.get("state_data", {})
        if state_data and isinstance(state_data, dict):
            try:
                json_format.ParseDict(state_data, state.state_data)
            except Exception:
                pass
        return state

    def _dict_to_stream_event(d: dict) -> agent_orchestration_pb2.WorkflowStreamEvent:
        event = agent_orchestration_pb2.WorkflowStreamEvent()
        if "step_started" in d:
            ss = d["step_started"]
            event.step_started.node_id = ss.get("node_id", "")
            event.step_started.node_type = ss.get("node_type", "")
        elif "step_completed" in d:
            sc = d["step_completed"]
            result = sc.get("result", {})
            event.step_completed.result.node_id = result.get("node_id", "")
            event.step_completed.result.node_type = result.get("node_type", "")
            event.step_completed.result.output = result.get("output", "")
            event.step_completed.result.duration_ms = result.get("duration_ms", 0)
        elif "workflow_completed" in d:
            wc = d["workflow_completed"]
            resp = wc.get("response", {})
            event.workflow_completed.response.CopyFrom(_dict_to_execute_response(resp))
        elif "workflow_error" in d:
            we = d["workflow_error"]
            event.workflow_error.error_code = we.get("error_code", "")
            event.workflow_error.error_message = we.get("error_message", "")
            event.workflow_error.node_id = we.get("node_id", "")
        return event

    agent_orchestration_pb2_grpc.add_AgentOrchestrationServiceServicer_to_server(
        _ProtoServicer(), server
    )
    logger.info("Servicer registered via proto stubs for: beautygrowth.orchestration.v1.AgentOrchestrationService")


# ============================================================
# Helper functions
# ============================================================


def _get_field(obj: Any, field_name: str, default: Any = None) -> Any:
    """Get a field from a dict-like or protobuf-like object.

    Args:
        obj: The source object (dict or protobuf message).
        field_name: The field name to retrieve.
        default: Default value if field not found.

    Returns:
        The field value or default.
    """
    if isinstance(obj, dict):
        return obj.get(field_name, default)
    return getattr(obj, field_name, default)


def _get_nested_field(obj: Any, field_name: str, default: Any = None) -> Any:
    """Get a field from a nested dict-like or protobuf-like object.

    Args:
        obj: The source object (dict or protobuf message).
        field_name: The field name to retrieve.
        default: Default value if field not found.

    Returns:
        The field value or default.
    """
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(field_name, default)
    return getattr(obj, field_name, default)


def _step_result_to_dict(step: Any) -> Dict[str, Any]:
    """Convert a StepResult dataclass to a dict for persistence.

    Args:
        step: A StepResult instance from the workflow engine.

    Returns:
        Dict representation suitable for JSON serialization.
    """
    return {
        "node_id": step.node_id,
        "node_type": step.node_type,
        "output": step.output,
        "duration_ms": step.duration_ms,
        "status": step.status,
        "tokens_used": {
            "input_tokens": step.tokens_used.input_tokens,
            "output_tokens": step.tokens_used.output_tokens,
        },
        "error_message": step.error_message or "",
    }


def _determine_terminal_status(result: ExecutionResult) -> str:
    """Determine the terminal status from an ExecutionResult.

    Maps the execution result to one of the terminal statuses:
    - 'completed': successful execution
    - 'timeout': execution exceeded timeout_ms
    - 'failed': any other failure (guardrail, node error, recursion limit, etc.)

    Args:
        result: The ExecutionResult from the workflow engine.

    Returns:
        Terminal status string: 'completed', 'timeout', or 'failed'.
    """
    if result.success:
        return "completed"

    # Check if it's a timeout by inspecting blocked_reason
    if result.blocked_reason and "TIMEOUT" in result.blocked_reason.upper():
        return "timeout"

    return "failed"


def _build_workflow_definition_from_resolved(
    resolved: ResolvedWorkflow,
) -> WorkflowDefinition:
    """Build a WorkflowDefinition from a ResolvedWorkflow's graph_definition.

    The graph_definition JSON contains nodes, edges, and entry_point.

    Args:
        resolved: The resolved workflow from the agent router.

    Returns:
        A WorkflowDefinition ready for build_agent_graph.
    """
    graph_def = resolved.graph_definition

    # Parse nodes
    raw_nodes = graph_def.get("nodes", [])
    nodes = [
        NodeDefinition(
            node_id=n.get("node_id", ""),
            node_type=n.get("node_type", "llm_call"),
            config=n.get("config", {}),
        )
        for n in raw_nodes
    ]

    # Parse edges
    raw_edges = graph_def.get("edges", [])
    edges = [
        EdgeDefinition(
            source=e.get("source", ""),
            target=e.get("target", ""),
            condition=e.get("condition"),
        )
        for e in raw_edges
    ]

    # Entry point
    entry_point = graph_def.get("entry_point", "")

    return WorkflowDefinition(
        workflow_id=resolved.workflow_id,
        agent_type=resolved.agent_type,
        nodes=nodes,
        edges=edges,
        entry_point=entry_point,
    )


def _map_workflow_event_to_stream(event: WorkflowEvent) -> Dict[str, Any]:
    """Map an internal WorkflowEvent to a proto-compatible stream event dict.

    Maps event_type to the appropriate oneof field in WorkflowStreamEvent:
      - "step_started" → {"step_started": {"node_id": ..., "node_type": ...}}
      - "step_completed" → {"step_completed": {"result": {...}}}
      - "token_generated" → {"token_generated": {"token": ..., "node_id": ...}}
      - "workflow_completed" → {"workflow_completed": {"response": {...}}}
      - "workflow_error" → {"workflow_error": {"error_code": ..., "error_message": ..., "node_id": ...}}

    Args:
        event: The WorkflowEvent from the workflow engine.

    Returns:
        Dict representing a WorkflowStreamEvent protobuf message.
    """
    if event.event_type == "step_started":
        return {
            "step_started": {
                "node_id": event.node_id or "",
                "node_type": event.data.get("node_type", ""),
            }
        }
    elif event.event_type == "step_completed":
        return {
            "step_completed": {
                "result": event.data.get("result", {}),
            }
        }
    elif event.event_type == "token_generated":
        return {
            "token_generated": {
                "token": event.data.get("token", ""),
                "node_id": event.node_id or "",
            }
        }
    elif event.event_type == "workflow_completed":
        return {
            "workflow_completed": {
                "response": event.data,
            }
        }
    elif event.event_type == "workflow_error":
        return {
            "workflow_error": {
                "error_code": event.data.get("error_code", "UNKNOWN"),
                "error_message": event.data.get("error_message", ""),
                "node_id": event.node_id or "",
            }
        }
    else:
        # Unknown event type — wrap as generic
        return {
            "workflow_error": {
                "error_code": "UNKNOWN_EVENT",
                "error_message": f"Unknown event type: {event.event_type}",
                "node_id": event.node_id or "",
            }
        }
