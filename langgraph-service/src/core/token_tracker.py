"""Token Tracker: utility for per-node token accounting and aggregation."""

import logging
from dataclasses import dataclass, field
from typing import Any

from .workflow_engine import TokenUsage

logger = logging.getLogger(__name__)


@dataclass
class NodeTokenRecord:
    """Token usage record for a single node execution."""

    node_id: str
    node_type: str
    input_tokens: int = 0
    output_tokens: int = 0


class TokenTracker:
    """Tracks token usage per-node and aggregates totals.

    Used during workflow execution to accumulate token consumption
    across all nodes, with support for warning when LLM providers
    don't return token information.
    """

    def __init__(self) -> None:
        """Initialize an empty token tracker."""
        self._records: list[NodeTokenRecord] = []

    def record_tokens(
        self,
        node_id: str,
        node_type: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        """Record token usage for a node execution.

        Args:
            node_id: Identifier of the executed node.
            node_type: Type of the node (llm_call, tool_call, condition, parallel).
            input_tokens: Number of input tokens consumed.
            output_tokens: Number of output tokens produced.
        """
        self._records.append(
            NodeTokenRecord(
                node_id=node_id,
                node_type=node_type,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
        )

    def get_total(self) -> TokenUsage:
        """Return aggregated total token usage across all recorded nodes.

        Returns:
            TokenUsage with summed input and output tokens.
        """
        total_input = sum(r.input_tokens for r in self._records)
        total_output = sum(r.output_tokens for r in self._records)
        return TokenUsage(input_tokens=total_input, output_tokens=total_output)

    def get_per_node(self) -> list[dict[str, Any]]:
        """Return per-node token usage breakdown.

        Returns:
            List of dicts with node_id, node_type, input_tokens, output_tokens.
        """
        return [
            {
                "node_id": r.node_id,
                "node_type": r.node_type,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
            }
            for r in self._records
        ]

    def warn_missing_tokens(self, node_id: str, trace_id: str) -> None:
        """Log a warning when the LLM provider doesn't return token usage info.

        This is called when a llm_call node completes but the provider response
        does not include token counts.

        Args:
            node_id: The node that didn't receive token info.
            trace_id: The trace ID for the current execution.
        """
        logger.warning(
            "LLM provider did not return token usage info. "
            "Recording input_tokens=0, output_tokens=0. "
            "trace_id=%s, node_id=%s",
            trace_id,
            node_id,
        )
