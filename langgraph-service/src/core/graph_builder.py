"""Graph Builder: constructs LangGraph StateGraph from WorkflowDefinition."""

import time
from collections import deque
from typing import Any, Callable, TypedDict

from langgraph.graph import END, StateGraph

from .agent_router import EdgeDefinition, NodeDefinition, WorkflowDefinition
from .exceptions import (
    GuardrailViolationError,
    NodeExecutionError,
    MAX_ERROR_MESSAGE_LENGTH,
)


class InvalidWorkflowError(Exception):
    """Raised when a WorkflowDefinition is invalid (cycles, missing nodes, etc.)."""

    pass


class WorkflowState(TypedDict):
    """State schema for workflow execution graphs."""

    user_input: str
    tenant_id: str
    agent_id: str
    messages: list[dict[str, Any]]
    intermediate_results: dict[str, Any]
    output: str
    steps: list[dict[str, Any]]


def validate_workflow_definition(definition: WorkflowDefinition) -> None:
    """Validate that a WorkflowDefinition produces a valid DAG.

    Checks:
    - At least one node exists
    - entry_point references an existing node
    - The graph is acyclic (DAG)

    Raises:
        InvalidWorkflowError: If validation fails with a descriptive message.
    """
    # Check at least one node
    if not definition.nodes:
        raise InvalidWorkflowError(
            "WorkflowDefinition must contain at least one node."
        )

    # Build set of node IDs for lookup
    node_ids = {node.node_id for node in definition.nodes}

    # Check entry_point references an existing node
    if definition.entry_point not in node_ids:
        raise InvalidWorkflowError(
            f"entry_point '{definition.entry_point}' does not reference an existing node. "
            f"Available nodes: {sorted(node_ids)}"
        )

    # Check for cycles using DFS-based topological sort
    _check_acyclic(node_ids, definition.edges)


def _check_acyclic(node_ids: set[str], edges: list[EdgeDefinition]) -> None:
    """Check that the graph defined by nodes and edges is acyclic (DAG).

    Uses Kahn's algorithm (BFS topological sort) for cycle detection.

    Raises:
        InvalidWorkflowError: If a cycle is detected.
    """
    # Build adjacency list and in-degree count (only for internal nodes, skip __end__)
    adjacency: dict[str, list[str]] = {node_id: [] for node_id in node_ids}
    in_degree: dict[str, int] = {node_id: 0 for node_id in node_ids}

    for edge in edges:
        # Skip edges pointing to END (__end__) — they don't form cycles
        if edge.target == "__end__" or edge.target not in node_ids:
            continue
        if edge.source not in node_ids:
            continue
        adjacency[edge.source].append(edge.target)
        in_degree[edge.target] += 1

    # Kahn's algorithm
    queue: deque[str] = deque()
    for node_id in node_ids:
        if in_degree[node_id] == 0:
            queue.append(node_id)

    visited_count = 0
    while queue:
        current = queue.popleft()
        visited_count += 1
        for neighbor in adjacency[current]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if visited_count != len(node_ids):
        # Some nodes are part of a cycle
        cycle_nodes = {nid for nid, deg in in_degree.items() if deg > 0}
        raise InvalidWorkflowError(
            f"Graph contains a cycle. Nodes involved in cycle: {sorted(cycle_nodes)}"
        )


def resolve_node_function(node_def: NodeDefinition) -> Callable[..., Any]:
    """Resolve the execution function for a given node type.

    Returns a placeholder async function for the node type.
    These placeholders will be replaced with real implementations in later tasks.

    Args:
        node_def: The node definition containing type and config.

    Returns:
        A callable function to be used as the node handler.

    Raises:
        ValueError: If node_type is unknown.
    """
    node_type = node_def.node_type
    if node_type == "llm_call":
        return _create_llm_call_placeholder(node_def)
    elif node_type == "tool_call":
        return _create_tool_call_placeholder(node_def)
    elif node_type == "condition":
        return _create_condition_placeholder(node_def)
    elif node_type == "parallel":
        return _create_parallel_placeholder(node_def)
    elif node_type == "guardrail":
        return _create_guardrail_node(node_def)
    else:
        raise ValueError(
            f"Unknown node type: '{node_def.node_type}'. "
            f"Supported types: llm_call, tool_call, condition, parallel, guardrail"
        )


def _create_llm_call_placeholder(node_def: NodeDefinition) -> Callable[..., Any]:
    """Create a placeholder function for llm_call nodes.

    In the real implementation, token usage comes from the LLM provider response.
    The placeholder simulates token usage from config or defaults to a warning.
    """
    import logging

    logger = logging.getLogger(__name__)

    async def llm_call_node(state: WorkflowState) -> dict[str, Any]:
        """Placeholder LLM call node — will be replaced with real LLM integration."""
        # Simulate token usage from config (real impl gets this from LLM response)
        simulated_tokens = node_def.config.get("simulated_tokens", None)

        if simulated_tokens and isinstance(simulated_tokens, dict):
            input_tokens = simulated_tokens.get("input_tokens", 0)
            output_tokens = simulated_tokens.get("output_tokens", 0)
        else:
            # LLM provider did not return token usage — log warning per Req 11.5
            input_tokens = 0
            output_tokens = 0
            trace_id = state.get("trace_id", "unknown")
            logger.warning(
                "LLM provider did not return token usage info. "
                "Recording input_tokens=0, output_tokens=0. "
                "trace_id=%s, node_id=%s",
                trace_id,
                node_def.node_id,
            )

        return {
            "output": f"[llm_call:{node_def.node_id}] placeholder output",
            "steps": state.get("steps", [])
            + [
                {
                    "node_id": node_def.node_id,
                    "node_type": "llm_call",
                    "output": "placeholder",
                    "duration_ms": 0,
                    "status": "completed",
                    "tokens_used": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    },
                }
            ],
        }

    return llm_call_node


def _create_tool_call_placeholder(node_def: NodeDefinition) -> Callable[..., Any]:
    """Create a placeholder function for tool_call nodes.

    Tool call nodes always report tokens = 0 per Requirement 11.4.
    """

    async def tool_call_node(state: WorkflowState) -> dict[str, Any]:
        """Placeholder tool call node — will be replaced with real tool integration."""
        return {
            "output": f"[tool_call:{node_def.node_id}] placeholder output",
            "steps": state.get("steps", [])
            + [
                {
                    "node_id": node_def.node_id,
                    "node_type": "tool_call",
                    "output": "placeholder",
                    "duration_ms": 0,
                    "status": "completed",
                    "tokens_used": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                    },
                }
            ],
        }

    return tool_call_node


def _create_condition_placeholder(node_def: NodeDefinition) -> Callable[..., Any]:
    """Create a placeholder function for condition nodes.

    Condition nodes always report tokens = 0 per Requirement 11.4.
    """

    async def condition_node(state: WorkflowState) -> dict[str, Any]:
        """Placeholder condition node — will be replaced with real condition evaluation."""
        return {
            "output": f"[condition:{node_def.node_id}] placeholder output",
            "steps": state.get("steps", [])
            + [
                {
                    "node_id": node_def.node_id,
                    "node_type": "condition",
                    "output": "placeholder",
                    "duration_ms": 0,
                    "status": "completed",
                    "tokens_used": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                    },
                }
            ],
        }

    return condition_node


def _create_guardrail_node(node_def: NodeDefinition) -> Callable[..., Any]:
    """Create a function for guardrail nodes that checks rules from config.

    A guardrail node's config should contain `rules: list[dict]` where each
    rule has a `field` and `condition` key. The node evaluates each rule
    against the current state. If any rule is violated, it raises
    GuardrailViolationError.

    Config format:
        rules: list[dict] — each dict has:
            - field: str — state key to check
            - condition: str — condition type (e.g., "not_empty", "max_length")
            - value: Any — optional parameter for the condition
            - message: str — description of the rule for violation reporting
    """
    rules: list[dict[str, Any]] = node_def.config.get("rules", [])

    async def guardrail_node(state: WorkflowState) -> dict[str, Any]:
        """Evaluate guardrail rules against current state."""
        start = time.perf_counter()
        violations: list[str] = []

        for rule in rules:
            field = rule.get("field", "")
            condition = rule.get("condition", "")
            value = rule.get("value")
            message = rule.get("message", f"Rule violated: {condition} on {field}")

            state_value = state.get(field)

            if condition == "not_empty":
                if not state_value:
                    violations.append(message)
            elif condition == "max_length":
                if state_value and len(str(state_value)) > (value or 0):
                    violations.append(message)
            elif condition == "blocked_words":
                blocked = value or []
                if state_value and any(
                    word in str(state_value).lower() for word in blocked
                ):
                    violations.append(message)
            elif condition == "required_field":
                if field not in state or state_value is None:
                    violations.append(message)
            else:
                # Unknown condition type — treat as violation
                violations.append(f"Unknown guardrail condition: {condition}")

        duration_ms = int((time.perf_counter() - start) * 1000)

        if violations:
            raise GuardrailViolationError(
                node_id=node_def.node_id,
                violations=violations,
            )

        return {
            "output": f"[guardrail:{node_def.node_id}] all rules passed",
            "steps": state.get("steps", [])
            + [
                {
                    "node_id": node_def.node_id,
                    "node_type": "guardrail",
                    "output": "all rules passed",
                    "duration_ms": duration_ms,
                    "status": "completed",
                }
            ],
        }

    return guardrail_node


def create_safe_node_wrapper(
    node_fn: Callable[..., Any], node_def: NodeDefinition
) -> Callable[..., Any]:
    """Wrap a node function with error handling that records failures in StepResult.

    If the wrapped function raises an exception (other than GuardrailViolationError),
    it records the node with status FAILED and the error message (truncated to 1024 chars)
    in the StepResult, then raises NodeExecutionError to interrupt the workflow path.

    GuardrailViolationError is re-raised directly to be handled by the engine.

    Args:
        node_fn: The original node function.
        node_def: The node definition for metadata.

    Returns:
        A wrapped async function with error handling.
    """

    async def safe_node(state: WorkflowState) -> dict[str, Any]:
        start = time.perf_counter()
        try:
            return await node_fn(state)
        except GuardrailViolationError:
            # Let guardrail violations propagate directly
            raise
        except NodeExecutionError:
            # Already wrapped — re-raise
            raise
        except Exception as e:
            duration_ms = int((time.perf_counter() - start) * 1000)
            error_message = str(e)[:MAX_ERROR_MESSAGE_LENGTH]

            raise NodeExecutionError(
                node_id=node_def.node_id,
                node_type=node_def.node_type,
                error_message=error_message,
            )

    return safe_node


def _create_parallel_placeholder(node_def: NodeDefinition) -> Callable[..., Any]:
    """Create a function for parallel nodes that executes sub-nodes concurrently.

    A parallel node's config should contain `sub_nodes: list[str]` — the node_ids
    to execute in parallel. Each sub-node is resolved via resolve_node_function
    and executed concurrently using asyncio.gather.

    If no sub_nodes are configured, the node acts as a pass-through.

    Parallel nodes always report tokens = 0 per Requirement 11.4.
    """
    from .parallel_executor import ParallelExecutor

    sub_node_ids: list[str] = node_def.config.get("sub_nodes", [])

    async def parallel_node(state: WorkflowState) -> dict[str, Any]:
        """Execute sub-nodes in parallel using ParallelExecutor."""
        if not sub_node_ids:
            # No sub-nodes configured — act as pass-through
            return {
                "output": f"[parallel:{node_def.node_id}] no sub_nodes configured",
                "steps": state.get("steps", [])
                + [
                    {
                        "node_id": node_def.node_id,
                        "node_type": "parallel",
                        "output": "no sub_nodes configured",
                        "duration_ms": 0,
                        "status": "completed",
                        "tokens_used": {
                            "input_tokens": 0,
                            "output_tokens": 0,
                        },
                    }
                ],
            }

        # Resolve sub-node functions
        sub_node_fns = []
        for sub_id in sub_node_ids:
            sub_node_def = NodeDefinition(
                node_id=sub_id,
                node_type="llm_call",  # Default type for sub-nodes
                config=node_def.config.get(f"sub_node_config_{sub_id}", {}),
            )
            # Check if a specific node_type was provided for this sub-node
            sub_configs = node_def.config.get("sub_node_configs", {})
            if sub_id in sub_configs:
                sub_node_def = NodeDefinition(
                    node_id=sub_id,
                    node_type=sub_configs[sub_id].get("node_type", "llm_call"),
                    config=sub_configs[sub_id].get("config", {}),
                )
            sub_node_fns.append(resolve_node_function(sub_node_def))

        # Execute all sub-nodes in parallel
        executor = ParallelExecutor()
        results = await executor.execute_parallel(
            tasks=sub_node_fns,
            state=state,
            node_ids=sub_node_ids,
        )

        # Aggregate results
        sub_steps = []
        outputs = []
        for result in results:
            sub_steps.append(
                {
                    "node_id": result.node_id,
                    "node_type": "parallel_sub",
                    "output": result.output.get("output", ""),
                    "duration_ms": result.duration_ms,
                    "status": result.status,
                    "error": result.error,
                }
            )
            if result.status == "completed":
                outputs.append(result.output.get("output", ""))

        combined_output = "; ".join(outputs) if outputs else ""

        return {
            "output": f"[parallel:{node_def.node_id}] {combined_output}",
            "steps": state.get("steps", [])
            + [
                {
                    "node_id": node_def.node_id,
                    "node_type": "parallel",
                    "output": combined_output,
                    "duration_ms": max(
                        (r.duration_ms for r in results), default=0
                    ),
                    "status": "completed"
                    if all(r.status == "completed" for r in results)
                    else "partial_failure",
                    "sub_steps": sub_steps,
                    "tokens_used": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                    },
                }
            ],
        }

    return parallel_node


def build_agent_graph(definition: WorkflowDefinition) -> Any:
    """Build a compiled LangGraph StateGraph from a WorkflowDefinition.

    This function:
    1. Validates the workflow definition (acyclic, has nodes, valid entry_point)
    2. Creates a StateGraph with WorkflowState schema
    3. Adds nodes with resolved handler functions
    4. Adds edges (direct and conditional)
    5. Sets the entry point
    6. Compiles and returns the graph

    Args:
        definition: The workflow definition to convert into a compiled graph.

    Returns:
        A compiled StateGraph (CompiledStateGraph) ready for execution.

    Raises:
        InvalidWorkflowError: If the definition is invalid.
        ValueError: If a node has an unknown type.
    """
    # Step 1: Validate
    validate_workflow_definition(definition)

    # Step 2: Create StateGraph
    graph = StateGraph(WorkflowState)

    # Step 3: Add nodes
    for node_def in definition.nodes:
        node_fn = resolve_node_function(node_def)
        graph.add_node(node_def.node_id, node_fn)

    # Step 4: Add edges
    for edge_def in definition.edges:
        if edge_def.condition:
            # Conditional edge: route based on condition evaluation
            condition_fn = _build_condition_router(edge_def)
            graph.add_conditional_edges(
                edge_def.source,
                condition_fn,
                {True: edge_def.target, False: END},
            )
        else:
            # Direct edge
            target = END if edge_def.target == "__end__" else edge_def.target
            graph.add_edge(edge_def.source, target)

    # Step 5: Set entry point
    graph.set_entry_point(definition.entry_point)

    # Step 6: Compile and return
    return graph.compile()


def _build_condition_router(
    edge_def: EdgeDefinition,
) -> Callable[[WorkflowState], bool]:
    """Build a condition router function for conditional edges.

    This is a placeholder that always returns True.
    Real condition evaluation will be implemented in a later task.
    """

    def route(state: WorkflowState) -> bool:
        """Evaluate condition for routing — placeholder always returns True."""
        return True

    return route
