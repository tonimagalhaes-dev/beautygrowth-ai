"""Tests for ParallelExecutor: concurrent node execution."""

import asyncio
import time

import pytest

from src.core.graph_builder import WorkflowState
from src.core.parallel_executor import ParallelExecutor, ParallelTaskResult


@pytest.fixture
def executor() -> ParallelExecutor:
    """Create a ParallelExecutor instance."""
    return ParallelExecutor()


@pytest.fixture
def sample_state() -> WorkflowState:
    """Create a sample workflow state for testing."""
    return WorkflowState(
        user_input="test input",
        tenant_id="test-tenant",
        agent_id="test-agent",
        messages=[],
        intermediate_results={},
        output="",
        steps=[],
    )


def _make_async_task(delay: float, node_id: str):
    """Create an async task that sleeps for `delay` seconds then returns output."""

    async def task(state: WorkflowState) -> dict:
        await asyncio.sleep(delay)
        return {"output": f"result from {node_id}", "node_id": node_id}

    return task


def _make_failing_task(delay: float, error_msg: str):
    """Create an async task that raises an exception after `delay` seconds."""

    async def task(state: WorkflowState) -> dict:
        await asyncio.sleep(delay)
        raise RuntimeError(error_msg)

    return task


class TestParallelExecution:
    """Tests verifying concurrent execution behavior."""

    @pytest.mark.asyncio
    async def test_multiple_tasks_run_concurrently(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """Multiple async tasks should run concurrently.

        Verify total time is approximately max of individual delays, not sum.
        Three tasks each taking 0.1s should complete in ~0.1s total, not 0.3s.
        """
        delay = 0.1
        tasks = [
            _make_async_task(delay, "node_a"),
            _make_async_task(delay, "node_b"),
            _make_async_task(delay, "node_c"),
        ]
        node_ids = ["node_a", "node_b", "node_c"]

        start = time.monotonic()
        results = await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )
        elapsed = time.monotonic() - start

        # Total time should be close to max delay (0.1s), not sum (0.3s)
        # Allow generous tolerance for CI/test environments
        assert elapsed < delay * 2, (
            f"Expected parallel execution in ~{delay}s, but took {elapsed:.3f}s "
            f"(sum would be {delay * 3:.3f}s)"
        )
        assert len(results) == 3
        assert all(r.status == "completed" for r in results)

    @pytest.mark.asyncio
    async def test_results_maintain_order(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """Results should maintain the same order as input tasks.

        Even if tasks finish in different order (different delays),
        the result list should correspond to the input order.
        """
        tasks = [
            _make_async_task(0.15, "slow"),
            _make_async_task(0.05, "fast"),
            _make_async_task(0.10, "medium"),
        ]
        node_ids = ["slow", "fast", "medium"]

        results = await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )

        assert len(results) == 3
        assert results[0].node_id == "slow"
        assert results[1].node_id == "fast"
        assert results[2].node_id == "medium"
        # Verify outputs match expected order
        assert "slow" in results[0].output.get("output", "")
        assert "fast" in results[1].output.get("output", "")
        assert "medium" in results[2].output.get("output", "")

    @pytest.mark.asyncio
    async def test_error_in_one_task_doesnt_prevent_others(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """If one task fails, others should still complete successfully.

        Uses return_exceptions=True behavior to collect errors without
        canceling sibling tasks.
        """
        tasks = [
            _make_async_task(0.05, "success_1"),
            _make_failing_task(0.05, "intentional failure"),
            _make_async_task(0.05, "success_2"),
        ]
        node_ids = ["success_1", "failing", "success_2"]

        results = await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )

        assert len(results) == 3

        # First task succeeded
        assert results[0].status == "completed"
        assert results[0].node_id == "success_1"

        # Second task failed
        assert results[1].status == "failed"
        assert results[1].node_id == "failing"
        assert "intentional failure" in results[1].error

        # Third task succeeded despite second failing
        assert results[2].status == "completed"
        assert results[2].node_id == "success_2"

    @pytest.mark.asyncio
    async def test_empty_task_list_returns_empty(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """Executing with no tasks should return empty list."""
        results = await executor.execute_parallel(
            tasks=[], state=sample_state, node_ids=[]
        )
        assert results == []

    @pytest.mark.asyncio
    async def test_single_task_executes_normally(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """A single task should execute and return normally."""
        tasks = [_make_async_task(0.01, "only_node")]
        node_ids = ["only_node"]

        results = await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )

        assert len(results) == 1
        assert results[0].status == "completed"
        assert results[0].node_id == "only_node"
        assert "only_node" in results[0].output.get("output", "")

    @pytest.mark.asyncio
    async def test_all_tasks_fail_returns_all_errors(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """When all tasks fail, all results should have failed status."""
        tasks = [
            _make_failing_task(0.01, "error_1"),
            _make_failing_task(0.01, "error_2"),
        ]
        node_ids = ["fail_1", "fail_2"]

        results = await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )

        assert len(results) == 2
        assert all(r.status == "failed" for r in results)
        assert "error_1" in results[0].error
        assert "error_2" in results[1].error

    @pytest.mark.asyncio
    async def test_state_is_passed_to_all_tasks(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """Each task should receive the same workflow state."""
        received_states = []

        async def capture_state_task(state: WorkflowState) -> dict:
            received_states.append(state)
            return {"output": "captured"}

        tasks = [capture_state_task, capture_state_task, capture_state_task]
        node_ids = ["t1", "t2", "t3"]

        await executor.execute_parallel(
            tasks=tasks, state=sample_state, node_ids=node_ids
        )

        assert len(received_states) == 3
        for s in received_states:
            assert s["user_input"] == "test input"
            assert s["tenant_id"] == "test-tenant"

    @pytest.mark.asyncio
    async def test_default_node_ids_when_not_provided(
        self, executor: ParallelExecutor, sample_state: WorkflowState
    ):
        """When node_ids is not provided, uses index-based IDs."""
        tasks = [
            _make_async_task(0.01, "x"),
            _make_async_task(0.01, "y"),
        ]

        results = await executor.execute_parallel(tasks=tasks, state=sample_state)

        assert results[0].node_id == "parallel_task_0"
        assert results[1].node_id == "parallel_task_1"


class TestParallelNodeInGraphBuilder:
    """Tests verifying the parallel node integration in graph_builder."""

    @pytest.mark.asyncio
    async def test_parallel_node_with_sub_nodes_executes(self):
        """A parallel node with sub_nodes config should execute them concurrently."""
        from src.core.agent_router import NodeDefinition
        from src.core.graph_builder import resolve_node_function

        node_def = NodeDefinition(
            node_id="parallel_1",
            node_type="parallel",
            config={
                "sub_nodes": ["sub_a", "sub_b"],
                "sub_node_configs": {
                    "sub_a": {"node_type": "llm_call", "config": {}},
                    "sub_b": {"node_type": "tool_call", "config": {}},
                },
            },
        )

        parallel_fn = resolve_node_function(node_def)
        state: WorkflowState = WorkflowState(
            user_input="test",
            tenant_id="t1",
            agent_id="a1",
            messages=[],
            intermediate_results={},
            output="",
            steps=[],
        )

        result = await parallel_fn(state)

        assert "output" in result
        assert "steps" in result
        assert len(result["steps"]) == 1
        step = result["steps"][0]
        assert step["node_id"] == "parallel_1"
        assert step["node_type"] == "parallel"
        assert "sub_steps" in step
        assert len(step["sub_steps"]) == 2

    @pytest.mark.asyncio
    async def test_parallel_node_without_sub_nodes_passes_through(self):
        """A parallel node without sub_nodes should act as pass-through."""
        from src.core.agent_router import NodeDefinition
        from src.core.graph_builder import resolve_node_function

        node_def = NodeDefinition(
            node_id="parallel_empty",
            node_type="parallel",
            config={},
        )

        parallel_fn = resolve_node_function(node_def)
        state: WorkflowState = WorkflowState(
            user_input="test",
            tenant_id="t1",
            agent_id="a1",
            messages=[],
            intermediate_results={},
            output="",
            steps=[],
        )

        result = await parallel_fn(state)

        assert "no sub_nodes configured" in result["output"]
        assert result["steps"][0]["status"] == "completed"
