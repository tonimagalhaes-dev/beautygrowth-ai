"""Tests for graph_builder module: DAG construction and validation."""

import pytest

from src.core.agent_router import EdgeDefinition, NodeDefinition, WorkflowDefinition
from src.core.graph_builder import (
    InvalidWorkflowError,
    build_agent_graph,
    resolve_node_function,
    validate_workflow_definition,
)


# --- Fixtures ---


def _simple_linear_workflow() -> WorkflowDefinition:
    """Create a simple linear DAG: A -> B -> C -> END."""
    return WorkflowDefinition(
        workflow_id="wf-linear",
        agent_type="campaign",
        nodes=[
            NodeDefinition(node_id="a", node_type="llm_call"),
            NodeDefinition(node_id="b", node_type="tool_call"),
            NodeDefinition(node_id="c", node_type="llm_call"),
        ],
        edges=[
            EdgeDefinition(source="a", target="b"),
            EdgeDefinition(source="b", target="c"),
            EdgeDefinition(source="c", target="__end__"),
        ],
        entry_point="a",
    )


def _diamond_workflow() -> WorkflowDefinition:
    """Create a diamond DAG: A -> B, A -> C, B -> D, C -> D, D -> END."""
    return WorkflowDefinition(
        workflow_id="wf-diamond",
        agent_type="campaign",
        nodes=[
            NodeDefinition(node_id="a", node_type="llm_call"),
            NodeDefinition(node_id="b", node_type="tool_call"),
            NodeDefinition(node_id="c", node_type="parallel"),
            NodeDefinition(node_id="d", node_type="llm_call"),
        ],
        edges=[
            EdgeDefinition(source="a", target="b"),
            EdgeDefinition(source="a", target="c"),
            EdgeDefinition(source="b", target="d"),
            EdgeDefinition(source="c", target="d"),
            EdgeDefinition(source="d", target="__end__"),
        ],
        entry_point="a",
    )


def _single_node_workflow() -> WorkflowDefinition:
    """Create a workflow with a single node going to END."""
    return WorkflowDefinition(
        workflow_id="wf-single",
        agent_type="simple",
        nodes=[
            NodeDefinition(node_id="only_node", node_type="llm_call"),
        ],
        edges=[
            EdgeDefinition(source="only_node", target="__end__"),
        ],
        entry_point="only_node",
    )


def _cyclic_workflow() -> WorkflowDefinition:
    """Create a workflow with a cycle: A -> B -> C -> A."""
    return WorkflowDefinition(
        workflow_id="wf-cycle",
        agent_type="bad",
        nodes=[
            NodeDefinition(node_id="a", node_type="llm_call"),
            NodeDefinition(node_id="b", node_type="tool_call"),
            NodeDefinition(node_id="c", node_type="condition"),
        ],
        edges=[
            EdgeDefinition(source="a", target="b"),
            EdgeDefinition(source="b", target="c"),
            EdgeDefinition(source="c", target="a"),
        ],
        entry_point="a",
    )


# --- Tests: validate_workflow_definition ---


class TestValidateWorkflowDefinition:
    """Tests for validate_workflow_definition function."""

    def test_valid_linear_dag_passes(self):
        """A valid linear DAG should pass validation without errors."""
        definition = _simple_linear_workflow()
        # Should not raise
        validate_workflow_definition(definition)

    def test_valid_diamond_dag_passes(self):
        """A valid diamond DAG should pass validation without errors."""
        definition = _diamond_workflow()
        validate_workflow_definition(definition)

    def test_valid_single_node_passes(self):
        """A workflow with a single node should pass validation."""
        definition = _single_node_workflow()
        validate_workflow_definition(definition)

    def test_empty_nodes_raises_error(self):
        """A workflow with no nodes should raise InvalidWorkflowError."""
        definition = WorkflowDefinition(
            workflow_id="wf-empty",
            agent_type="bad",
            nodes=[],
            edges=[],
            entry_point="nonexistent",
        )
        with pytest.raises(InvalidWorkflowError, match="at least one node"):
            validate_workflow_definition(definition)

    def test_missing_entry_point_raises_error(self):
        """entry_point referencing a non-existent node should raise InvalidWorkflowError."""
        definition = WorkflowDefinition(
            workflow_id="wf-bad-entry",
            agent_type="bad",
            nodes=[
                NodeDefinition(node_id="a", node_type="llm_call"),
            ],
            edges=[
                EdgeDefinition(source="a", target="__end__"),
            ],
            entry_point="nonexistent_node",
        )
        with pytest.raises(InvalidWorkflowError, match="entry_point.*nonexistent_node"):
            validate_workflow_definition(definition)

    def test_cycle_raises_error(self):
        """A graph with a cycle should raise InvalidWorkflowError."""
        definition = _cyclic_workflow()
        with pytest.raises(InvalidWorkflowError, match="cycle"):
            validate_workflow_definition(definition)

    def test_self_loop_raises_error(self):
        """A node with a self-loop should raise InvalidWorkflowError."""
        definition = WorkflowDefinition(
            workflow_id="wf-self-loop",
            agent_type="bad",
            nodes=[
                NodeDefinition(node_id="a", node_type="llm_call"),
            ],
            edges=[
                EdgeDefinition(source="a", target="a"),
            ],
            entry_point="a",
        )
        with pytest.raises(InvalidWorkflowError, match="cycle"):
            validate_workflow_definition(definition)


# --- Tests: resolve_node_function ---


class TestResolveNodeFunction:
    """Tests for resolve_node_function."""

    def test_llm_call_returns_callable(self):
        """resolve_node_function should return a callable for llm_call."""
        node = NodeDefinition(node_id="n1", node_type="llm_call")
        fn = resolve_node_function(node)
        assert callable(fn)

    def test_tool_call_returns_callable(self):
        """resolve_node_function should return a callable for tool_call."""
        node = NodeDefinition(node_id="n2", node_type="tool_call")
        fn = resolve_node_function(node)
        assert callable(fn)

    def test_condition_returns_callable(self):
        """resolve_node_function should return a callable for condition."""
        node = NodeDefinition(node_id="n3", node_type="condition")
        fn = resolve_node_function(node)
        assert callable(fn)

    def test_parallel_returns_callable(self):
        """resolve_node_function should return a callable for parallel."""
        node = NodeDefinition(node_id="n4", node_type="parallel")
        fn = resolve_node_function(node)
        assert callable(fn)

    def test_unknown_type_raises_value_error(self):
        """An unknown node type should raise ValueError."""
        node = NodeDefinition(node_id="n5", node_type="unknown_type")
        with pytest.raises(ValueError, match="Unknown node type.*unknown_type"):
            resolve_node_function(node)


# --- Tests: build_agent_graph ---


class TestBuildAgentGraph:
    """Tests for build_agent_graph."""

    def test_simple_dag_builds_successfully(self):
        """A valid simple DAG should compile into a graph."""
        definition = _simple_linear_workflow()
        compiled_graph = build_agent_graph(definition)
        # The compiled graph should not be None
        assert compiled_graph is not None

    def test_diamond_dag_builds_successfully(self):
        """A valid diamond DAG should compile into a graph."""
        definition = _diamond_workflow()
        compiled_graph = build_agent_graph(definition)
        assert compiled_graph is not None

    def test_single_node_builds_successfully(self):
        """A single-node workflow should compile into a graph."""
        definition = _single_node_workflow()
        compiled_graph = build_agent_graph(definition)
        assert compiled_graph is not None

    def test_cycle_detection_raises_error(self):
        """build_agent_graph should reject cyclic workflows."""
        definition = _cyclic_workflow()
        with pytest.raises(InvalidWorkflowError, match="cycle"):
            build_agent_graph(definition)

    def test_empty_nodes_raises_error(self):
        """build_agent_graph should reject workflows with no nodes."""
        definition = WorkflowDefinition(
            workflow_id="wf-empty",
            agent_type="bad",
            nodes=[],
            edges=[],
            entry_point="a",
        )
        with pytest.raises(InvalidWorkflowError, match="at least one node"):
            build_agent_graph(definition)

    def test_missing_entry_point_raises_error(self):
        """build_agent_graph should reject when entry_point references non-existent node."""
        definition = WorkflowDefinition(
            workflow_id="wf-bad",
            agent_type="bad",
            nodes=[
                NodeDefinition(node_id="a", node_type="llm_call"),
            ],
            edges=[
                EdgeDefinition(source="a", target="__end__"),
            ],
            entry_point="does_not_exist",
        )
        with pytest.raises(InvalidWorkflowError, match="entry_point.*does_not_exist"):
            build_agent_graph(definition)

    def test_unknown_node_type_raises_value_error(self):
        """build_agent_graph should raise ValueError for unknown node types."""
        definition = WorkflowDefinition(
            workflow_id="wf-bad-type",
            agent_type="bad",
            nodes=[
                NodeDefinition(node_id="a", node_type="invalid_type"),
            ],
            edges=[
                EdgeDefinition(source="a", target="__end__"),
            ],
            entry_point="a",
        )
        with pytest.raises(ValueError, match="Unknown node type.*invalid_type"):
            build_agent_graph(definition)

    def test_conditional_edge_builds_successfully(self):
        """A workflow with conditional edges should compile."""
        definition = WorkflowDefinition(
            workflow_id="wf-conditional",
            agent_type="campaign",
            nodes=[
                NodeDefinition(node_id="check", node_type="condition"),
                NodeDefinition(node_id="process", node_type="llm_call"),
            ],
            edges=[
                EdgeDefinition(
                    source="check", target="process", condition="state.score > 0.5"
                ),
                EdgeDefinition(source="process", target="__end__"),
            ],
            entry_point="check",
        )
        compiled_graph = build_agent_graph(definition)
        assert compiled_graph is not None

    def test_all_node_types_in_one_workflow(self):
        """A workflow using all 4 node types should compile."""
        definition = WorkflowDefinition(
            workflow_id="wf-all-types",
            agent_type="complex",
            nodes=[
                NodeDefinition(node_id="start", node_type="llm_call"),
                NodeDefinition(node_id="fetch", node_type="tool_call"),
                NodeDefinition(node_id="decide", node_type="condition"),
                NodeDefinition(node_id="batch", node_type="parallel"),
            ],
            edges=[
                EdgeDefinition(source="start", target="fetch"),
                EdgeDefinition(source="fetch", target="decide"),
                EdgeDefinition(source="decide", target="batch"),
                EdgeDefinition(source="batch", target="__end__"),
            ],
            entry_point="start",
        )
        compiled_graph = build_agent_graph(definition)
        assert compiled_graph is not None
