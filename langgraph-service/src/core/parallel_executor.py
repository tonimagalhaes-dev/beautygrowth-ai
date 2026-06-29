"""Parallel Executor: runs independent node functions concurrently via asyncio.gather."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, List, Optional

from .graph_builder import WorkflowState


@dataclass
class ParallelTaskResult:
    """Result of a single parallel task execution."""

    node_id: str
    output: dict
    duration_ms: int
    status: str  # "completed" or "failed"
    error: str | None = None


@dataclass
class ParallelExecutionResult:
    """Aggregated result of parallel execution."""

    results: list[ParallelTaskResult] = field(default_factory=list)

    @property
    def all_successful(self) -> bool:
        """Return True if all tasks completed successfully."""
        return all(r.status == "completed" for r in self.results)


class ParallelExecutor:
    """Executes multiple node functions in parallel using asyncio.gather.

    When a parallel node is encountered in the workflow, this executor:
    1. Resolves sub-node functions from the node registry
    2. Runs them all concurrently via asyncio.gather(return_exceptions=True)
    3. Collects results (including errors) without stopping other tasks
    4. Returns results in the same order as input tasks
    """

    async def execute_parallel(
        self,
        tasks: list[Callable[[WorkflowState], Coroutine[Any, Any, dict[str, Any]]]],
        state: WorkflowState,
        node_ids: list[str] | None = None,
    ) -> list[ParallelTaskResult]:
        """Execute multiple async node functions in parallel.

        Args:
            tasks: List of async callable node functions to execute concurrently.
            state: The current workflow state to pass to each task.
            node_ids: Optional list of node IDs corresponding to each task.
                      If not provided, uses index-based IDs.

        Returns:
            List of ParallelTaskResult in the same order as input tasks.
            If a task fails, its result contains the error but other tasks
            continue executing (return_exceptions=True behavior).
        """
        if not tasks:
            return []

        if node_ids is None:
            node_ids = [f"parallel_task_{i}" for i in range(len(tasks))]

        # Execute all tasks concurrently with time tracking
        start_times_map: dict[int, float] = {}

        async def _tracked_task(
            index: int,
            task_fn: Callable[[WorkflowState], Coroutine[Any, Any, dict[str, Any]]],
        ) -> dict[str, Any]:
            """Execute a task with time tracking."""
            start_times_map[index] = time.monotonic()
            result = await task_fn(state)
            return result

        # Use gather with return_exceptions=True to not fail on individual task errors
        coroutines = []
        for i, task_fn in enumerate(tasks):
            coroutines.append(_tracked_task(i, task_fn))

        overall_start = time.monotonic()
        raw_results = await asyncio.gather(*coroutines, return_exceptions=True)
        overall_end = time.monotonic()

        # Build ParallelTaskResult for each result
        parallel_results: list[ParallelTaskResult] = []
        for i, raw in enumerate(raw_results):
            task_start = start_times_map.get(i, overall_start)
            if isinstance(raw, BaseException):
                duration_ms = int((overall_end - task_start) * 1000)
                parallel_results.append(
                    ParallelTaskResult(
                        node_id=node_ids[i],
                        output={},
                        duration_ms=duration_ms,
                        status="failed",
                        error=str(raw),
                    )
                )
            else:
                duration_ms = int((overall_end - task_start) * 1000)
                parallel_results.append(
                    ParallelTaskResult(
                        node_id=node_ids[i],
                        output=raw if isinstance(raw, dict) else {},
                        duration_ms=duration_ms,
                        status="completed",
                        error=None,
                    )
                )

        return parallel_results
