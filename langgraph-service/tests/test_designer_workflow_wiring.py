"""Tests for Designer Agent workflow graph wiring and registration (Task 14.2).

Comprehensive integration tests verifying:
- All 6 nodes are present in the compiled graph
- Entry point is correctly set to load_context
- Linear edges are correctly wired
- Conditional edge routing works for all 3 cases (pass/retry/block)
- Graph compiles without errors
- Registration in __main__.py passes required parameters
- Parallel generation respects the Model Registry pattern (asyncio.gather)

Requirements: 3.2, 7.3
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.workflows.designer_agent import (
    DesignerAgentState,
    build_designer_agent_graph,
    should_rebuild_or_generate,
)


# --- Helpers ---


def _make_full_state(
    guardrail_violations: list | None = None,
    guardrail_attempt: int = 0,
) -> DesignerAgentState:
    """Create a full DesignerAgentState for conditional edge testing."""
    return {
        "tenant_id": "tenant-001",
        "user_id": "user-001",
        "trace_id": "trace-001",
        "execution_id": "exec-001",
        "request": {"descricao_visual": "test", "redes_sociais": ["instagram"]},
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
        "visual_prompts": {},
        "negative_prompts": [],
        "guardrail_attempt": guardrail_attempt,
        "guardrail_violations": guardrail_violations or [],
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
        "tokens_consumed": 0,
        "duration_ms": 0,
        "warnings": [],
        "output": "",
    }


# --- Tests: Graph Compilation ---


class TestGraphCompilation:
    """Tests verifying the graph compiles correctly with expected structure."""

    def test_compiles_without_dependencies(self):
        """Graph should compile without any dependencies (stubs are used)."""
        graph = build_designer_agent_graph()
        assert graph is not None

    def test_compiled_graph_is_invocable(self):
        """Compiled graph should have ainvoke method (executable)."""
        graph = build_designer_agent_graph()
        assert hasattr(graph, "ainvoke")

    def test_compiled_graph_has_astream(self):
        """Compiled graph should support streaming via astream."""
        graph = build_designer_agent_graph()
        assert hasattr(graph, "astream")


# --- Tests: Node Presence ---


class TestGraphNodes:
    """Tests verifying all required nodes are present in the graph."""

    def test_all_six_nodes_present(self):
        """Graph must contain all 6 workflow nodes: load_context, build_visual_prompt,
        validate_guardrails_pre, generate_images, post_process, upload_and_persist."""
        graph = build_designer_agent_graph()
        node_names = set(graph.nodes.keys())

        expected_nodes = {
            "load_context",
            "build_visual_prompt",
            "validate_guardrails_pre",
            "generate_images",
            "post_process",
            "upload_and_persist",
        }
        for node in expected_nodes:
            assert node in node_names, f"Missing node: {node}"

    def test_start_node_present(self):
        """Graph must have __start__ pseudo-node."""
        graph = build_designer_agent_graph()
        assert "__start__" in graph.nodes

    def test_no_extra_unexpected_nodes(self):
        """Graph should only contain the 6 workflow nodes plus __start__ and __end__."""
        graph = build_designer_agent_graph()
        node_names = set(graph.nodes.keys())

        allowed_nodes = {
            "__start__",
            "load_context",
            "build_visual_prompt",
            "validate_guardrails_pre",
            "generate_images",
            "post_process",
            "upload_and_persist",
        }
        # LangGraph may include __end__ as a node in some versions
        unexpected = node_names - allowed_nodes - {"__end__"}
        assert unexpected == set(), f"Unexpected nodes in graph: {unexpected}"


# --- Tests: Entry Point ---


class TestGraphEntryPoint:
    """Tests verifying the graph entry point is correctly configured."""

    def test_entry_point_is_load_context(self):
        """The entry point (first node) must be load_context.

        The __start__ pseudo-node should route to load_context.
        """
        graph = build_designer_agent_graph()

        # In LangGraph, the entry point is set via set_entry_point which
        # creates an edge from __start__ to the specified node.
        # We can verify by checking the graph structure.
        # The graph.nodes["__start__"] should route to "load_context"
        # We verify by checking that there's an edge from __start__ to load_context
        # using the graph's internal structure.

        # Access the underlying graph definition to check edges
        # Different LangGraph versions expose this differently
        # The compiled graph's get_graph() method returns the draw graph
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        # Find edges from __start__
        start_edges = [e for e in edges if e.source == "__start__"]
        assert len(start_edges) == 1, (
            f"Expected exactly 1 edge from __start__, got {len(start_edges)}"
        )
        assert start_edges[0].target == "load_context", (
            f"Entry point should be load_context, got {start_edges[0].target}"
        )


# --- Tests: Linear Edges ---


class TestGraphLinearEdges:
    """Tests verifying the linear (non-conditional) edges are correct."""

    def test_load_context_to_build_visual_prompt(self):
        """load_context -> build_visual_prompt edge exists."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge = [
            e for e in edges
            if e.source == "load_context" and e.target == "build_visual_prompt"
        ]
        assert len(edge) == 1, "Missing edge: load_context -> build_visual_prompt"

    def test_build_visual_prompt_to_validate_guardrails_pre(self):
        """build_visual_prompt -> validate_guardrails_pre edge exists."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge = [
            e for e in edges
            if e.source == "build_visual_prompt"
            and e.target == "validate_guardrails_pre"
        ]
        assert len(edge) == 1, (
            "Missing edge: build_visual_prompt -> validate_guardrails_pre"
        )

    def test_generate_images_to_post_process(self):
        """generate_images -> post_process edge exists."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge = [
            e for e in edges
            if e.source == "generate_images" and e.target == "post_process"
        ]
        assert len(edge) == 1, "Missing edge: generate_images -> post_process"

    def test_post_process_to_upload_and_persist(self):
        """post_process -> upload_and_persist edge exists."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge = [
            e for e in edges
            if e.source == "post_process" and e.target == "upload_and_persist"
        ]
        assert len(edge) == 1, "Missing edge: post_process -> upload_and_persist"

    def test_upload_and_persist_to_end(self):
        """upload_and_persist -> __end__ edge exists."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge = [
            e for e in edges
            if e.source == "upload_and_persist" and e.target == "__end__"
        ]
        assert len(edge) == 1, "Missing edge: upload_and_persist -> __end__"


# --- Tests: Conditional Edge Routing ---


class TestConditionalEdgeRouting:
    """Tests verifying the conditional edge after validate_guardrails_pre.

    Requirements: 7.3
    The conditional edge must route:
    - No violation → generate_images (pass)
    - Violation & attempt < 3 → build_visual_prompt (retry)
    - Violation & attempt >= 3 → __end__ (block)
    """

    def test_pass_no_violations_routes_to_generate(self):
        """No guardrail violations → route to generate_images."""
        state = _make_full_state(guardrail_violations=[], guardrail_attempt=0)
        assert should_rebuild_or_generate(state) == "generate_images"

    def test_pass_empty_violations_list(self):
        """Empty violations list → route to generate_images."""
        state = _make_full_state(guardrail_violations=[], guardrail_attempt=2)
        assert should_rebuild_or_generate(state) == "generate_images"

    def test_pass_none_violations(self):
        """None violations (field not yet populated) → route to generate_images."""
        state = _make_full_state()
        state["guardrail_violations"] = None  # type: ignore
        assert should_rebuild_or_generate(state) == "generate_images"

    def test_retry_violation_attempt_0(self):
        """Violation with attempt=0 → retry (route to build_visual_prompt)."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 1}],
            guardrail_attempt=0,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_retry_violation_attempt_1(self):
        """Violation with attempt=1 → retry (route to build_visual_prompt)."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 2}],
            guardrail_attempt=1,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_retry_violation_attempt_2(self):
        """Violation with attempt=2 → retry (route to build_visual_prompt)."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 3}],
            guardrail_attempt=2,
        )
        assert should_rebuild_or_generate(state) == "build_visual_prompt"

    def test_block_violation_attempt_3(self):
        """Violation with attempt=3 → block (route to __end__)."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 3}],
            guardrail_attempt=3,
        )
        assert should_rebuild_or_generate(state) == "__end__"

    def test_block_violation_attempt_4(self):
        """Violation with attempt=4 (exceeded) → block (route to __end__)."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 4}],
            guardrail_attempt=4,
        )
        assert should_rebuild_or_generate(state) == "__end__"

    def test_block_violation_attempt_10(self):
        """Violation with very high attempt count → still blocks."""
        state = _make_full_state(
            guardrail_violations=[{"regra": "r1", "trecho": "t1", "tentativa": 10}],
            guardrail_attempt=10,
        )
        assert should_rebuild_or_generate(state) == "__end__"

    def test_conditional_edge_exists_in_graph(self):
        """validate_guardrails_pre should have conditional edges to multiple targets."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        # Find edges from validate_guardrails_pre
        guardrail_edges = [
            e for e in edges if e.source == "validate_guardrails_pre"
        ]
        # Should have at least 2 targets: generate_images and build_visual_prompt
        targets = {e.target for e in guardrail_edges}
        assert "generate_images" in targets, (
            "Missing conditional edge: validate_guardrails_pre -> generate_images"
        )
        assert "build_visual_prompt" in targets, (
            "Missing conditional edge: validate_guardrails_pre -> build_visual_prompt"
        )
        # __end__ should also be a target
        assert "__end__" in targets, (
            "Missing conditional edge: validate_guardrails_pre -> __end__"
        )


# --- Tests: Factory Dependency Injection ---


class TestGraphWithDependencies:
    """Tests verifying graph construction with various dependency combinations."""

    def test_builds_with_pg_pool_only(self):
        """Graph builds correctly with only pg_pool provided."""
        mock_pool = MagicMock()
        graph = build_designer_agent_graph(pg_pool=mock_pool)
        assert graph is not None
        assert "load_context" in graph.nodes

    def test_builds_with_all_dependencies(self):
        """Graph builds correctly with all dependencies provided."""
        mock_pool = MagicMock()
        mock_qdrant = MagicMock()
        mock_embed_fn = AsyncMock()
        mock_image_client = AsyncMock()
        mock_logo_downloader = AsyncMock()
        mock_storage_client = MagicMock()

        graph = build_designer_agent_graph(
            pg_pool=mock_pool,
            qdrant_client=mock_qdrant,
            embed_fn=mock_embed_fn,
            collection_name="test_collection",
            image_client=mock_image_client,
            logo_downloader=mock_logo_downloader,
            storage_client=mock_storage_client,
        )
        assert graph is not None
        assert "generate_images" in graph.nodes
        assert "post_process" in graph.nodes
        assert "upload_and_persist" in graph.nodes

    def test_builds_with_image_client_requires_pg_pool(self):
        """image_client without pg_pool still compiles (uses stub for load_context)."""
        mock_image_client = AsyncMock()

        # image_client alone won't create make_generate_images (needs pg_pool too)
        graph = build_designer_agent_graph(image_client=mock_image_client)
        assert graph is not None


# --- Tests: Registration in __main__.py ---


class TestMainRegistration:
    """Tests verifying the __main__.py registration pattern is correct."""

    def test_build_designer_agent_graph_accepts_main_params(self):
        """build_designer_agent_graph accepts the parameters passed by __main__.py:
        pg_pool, qdrant_client, embed_fn, collection_name."""
        mock_pool = MagicMock()
        mock_qdrant = MagicMock()
        mock_embed_fn = AsyncMock()

        # This mirrors the exact call in __main__.py
        graph = build_designer_agent_graph(
            pg_pool=mock_pool,
            qdrant_client=mock_qdrant,
            embed_fn=mock_embed_fn,
            collection_name="knowledge_hub",
        )
        assert graph is not None
        assert hasattr(graph, "ainvoke")

    def test_registered_graph_compatible_with_workflow_engine(self):
        """The compiled graph should be compatible with LangGraphWorkflowEngine.register_workflow."""
        from src.core.workflow_engine import LangGraphWorkflowEngine

        engine = LangGraphWorkflowEngine()
        graph = build_designer_agent_graph()

        # This should not raise
        engine.register_workflow("designer", graph)
        assert "designer" in engine._workflows

    def test_registered_graph_is_retrievable(self):
        """After registration, the graph should be retrievable by workflow_id."""
        from src.core.workflow_engine import LangGraphWorkflowEngine

        engine = LangGraphWorkflowEngine()
        graph = build_designer_agent_graph()
        engine.register_workflow("designer", graph)

        assert engine._workflows["designer"] is graph


# --- Tests: Parallel Generation Pattern ---


class TestParallelGenerationPattern:
    """Tests verifying that generate_images supports parallel generation.

    Requirement 3.2: Generate images in parallel, respecting rate limiting
    from the Model Registry.
    """

    def test_generate_images_node_is_single_node(self):
        """generate_images is a single node (parallelism happens internally via asyncio.gather).

        The graph itself doesn't have parallel branches for image generation —
        the parallelism is encapsulated within the generate_images node function.
        """
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        # Only one edge leads INTO generate_images
        incoming = [e for e in edges if e.target == "generate_images"]
        assert len(incoming) >= 1  # conditional edge routes here

        # Only one edge goes OUT of generate_images
        outgoing = [e for e in edges if e.source == "generate_images"]
        assert len(outgoing) == 1
        assert outgoing[0].target == "post_process"

    @pytest.mark.asyncio
    async def test_make_generate_images_calls_parallel(self):
        """make_generate_images should call image_client in parallel for multiple networks."""
        from src.workflows.designer_agent import (
            ImageGenerationResponse,
            make_generate_images,
        )

        call_times = []

        async def mock_image_client(
            prompt, negative_prompt, model_name, width, height
        ):
            call_times.append(asyncio.get_event_loop().time())
            await asyncio.sleep(0.05)  # Simulate small latency
            return ImageGenerationResponse(
                image_bytes=b"\x89PNG" + b"\x00" * 100,
                format="PNG",
                model_id=model_name,
                width=width,
                height=height,
                input_tokens=100,
                output_tokens=0,
            )

        mock_pool = MagicMock()
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)

        # Patch tenant_connection to provide mock connection
        with patch(
            "src.workflows.designer_agent.tenant_connection",
        ) as mock_tc:
            mock_tc.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
            mock_tc.return_value.__aexit__ = AsyncMock(return_value=False)

            node = make_generate_images(
                pg_pool=mock_pool,
                image_client=mock_image_client,
            )

            state = _make_full_state()
            state["visual_prompts"] = {
                "instagram": "prompt for instagram",
                "facebook": "prompt for facebook",
                "tiktok": "prompt for tiktok",
            }
            state["negative_prompts"] = ["no nudity"]
            state["request"] = {
                "descricao_visual": "test",
                "redes_sociais": ["instagram", "facebook", "tiktok"],
            }

            result = await node(state)

        # All 3 calls should have been made
        assert len(call_times) == 3
        # They should start approximately at the same time (parallel)
        # Allow 0.1s tolerance for test environment variance
        if len(call_times) >= 2:
            time_diff = max(call_times) - min(call_times)
            assert time_diff < 0.1, (
                f"Calls don't appear parallel: time spread {time_diff:.3f}s"
            )


# --- Tests: Complete DAG Path ---


class TestCompleteDAGPaths:
    """Tests verifying the complete paths through the DAG are valid."""

    def test_happy_path_edges(self):
        """Happy path: load_context → build_visual_prompt → validate_guardrails_pre
        → generate_images → post_process → upload_and_persist → END."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        # Build adjacency set for easy lookup
        edge_set = {(e.source, e.target) for e in edges}

        # Verify complete happy path
        assert ("__start__", "load_context") in edge_set
        assert ("load_context", "build_visual_prompt") in edge_set
        assert ("build_visual_prompt", "validate_guardrails_pre") in edge_set
        assert ("validate_guardrails_pre", "generate_images") in edge_set
        assert ("generate_images", "post_process") in edge_set
        assert ("post_process", "upload_and_persist") in edge_set
        assert ("upload_and_persist", "__end__") in edge_set

    def test_retry_path_edges(self):
        """Retry path: validate_guardrails_pre → build_visual_prompt (loop back)."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge_set = {(e.source, e.target) for e in edges}
        assert ("validate_guardrails_pre", "build_visual_prompt") in edge_set

    def test_block_path_edges(self):
        """Block path: validate_guardrails_pre → __end__ (blocked)."""
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        edge_set = {(e.source, e.target) for e in edges}
        assert ("validate_guardrails_pre", "__end__") in edge_set

    def test_total_edge_count(self):
        """Graph should have exactly 9 edges:
        __start__→load_context, load_context→build, build→validate,
        validate→generate (conditional), validate→build (conditional),
        validate→__end__ (conditional), generate→post, post→upload, upload→END.
        """
        graph = build_designer_agent_graph()
        draw_graph = graph.get_graph()
        edges = draw_graph.edges

        # At minimum we need 9 edges for the DAG structure
        assert len(edges) == 9, (
            f"Expected 9 edges, got {len(edges)}. "
            f"Edges: {[(e.source, e.target) for e in edges]}"
        )
