"""Agent Router: resolves which workflow to execute based on agent configuration."""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Protocol

import asyncpg

from .tenant_context import tenant_connection

logger = logging.getLogger(__name__)

# UUID v4 pattern (also accepts other UUID versions for flexibility)
_UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


# --- Custom Exceptions ---


class RouterError(Exception):
    """Base exception for all Agent Router errors."""

    pass


class AgentNotFoundError(RouterError):
    """Raised when agent_id does not exist in agent_configs or is invalid."""

    def __init__(self, agent_id: str, message: Optional[str] = None) -> None:
        self.agent_id = agent_id
        msg = message or f"Agent not found: {agent_id}"
        super().__init__(msg)


class WorkflowNotFoundError(RouterError):
    """Raised when no active workflow is found for the agent."""

    def __init__(self, agent_id: str, tenant_id: str) -> None:
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        super().__init__(
            f"No active workflow found for agent_id={agent_id}, tenant_id={tenant_id}"
        )


class RouterConnectionError(RouterError):
    """Raised when a database connection error occurs during workflow resolution."""

    def __init__(self, agent_id: str, tenant_id: str) -> None:
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        super().__init__(
            f"Failed to resolve workflow due to a connection error "
            f"(agent_id={agent_id}, tenant_id={tenant_id})"
        )


# --- Data Classes ---


@dataclass
class NodeDefinition:
    """Definição de um nó no grafo."""

    node_id: str
    node_type: str  # "llm_call", "tool_call", "condition", "parallel"
    config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class EdgeDefinition:
    """Definição de uma aresta no grafo."""

    source: str
    target: str
    condition: Optional[str] = None


@dataclass
class WorkflowDefinition:
    """Definição de um workflow de agente."""

    workflow_id: str
    agent_type: str
    nodes: List[NodeDefinition] = field(default_factory=list)
    edges: List[EdgeDefinition] = field(default_factory=list)
    entry_point: str = ""


@dataclass
class ResolvedWorkflow:
    """Workflow resolvido para execução."""

    workflow_id: str
    graph_definition: Dict[str, Any] = field(default_factory=dict)
    config: Dict[str, Any] = field(default_factory=dict)
    agent_type: str = ""


# --- Protocol ---


class AgentRouter(Protocol):
    """Roteia requests para o workflow correto baseado em configuração."""

    async def resolve_workflow(
        self,
        agent_id: str,
        tenant_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> ResolvedWorkflow:
        """Resolve o workflow a ser executado para um agente."""
        ...


# --- Implementation ---


class PostgresAgentRouter:
    """Resolves workflows from PostgreSQL based on agent configuration.

    Implements the AgentRouter protocol using asyncpg for database access.
    Supports tenant-specific workflow prioritization and version selection.
    """

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def resolve_workflow(
        self,
        agent_id: str,
        tenant_id: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> ResolvedWorkflow:
        """Resolve the workflow to execute for an agent.

        Algorithm:
        1. Validate agent_id format (must be a valid UUID)
        2. Acquire connection with tenant context (SET LOCAL app.current_tenant)
        3. Query agent_configs to get agent_type for the given agent_id
        4. Query workflow_definitions for active workflows matching agent_type
        5. Prioritize tenant-specific workflow over global (tenant_id IS NULL)
        6. If multiple versions exist for the winning scope, pick highest version

        Uses tenant_connection context manager to ensure RLS policies are
        enforced via SET LOCAL within a transaction.

        Args:
            agent_id: UUID of the agent to resolve workflow for.
            tenant_id: UUID of the tenant making the request.
            context: Optional additional context for resolution.

        Returns:
            ResolvedWorkflow with the resolved workflow data.

        Raises:
            AgentNotFoundError: If agent_id is invalid or does not exist in agent_configs.
            WorkflowNotFoundError: If no active workflow is found.
            RouterConnectionError: If a database connection error occurs.
        """
        # Validate agent_id format before hitting the database
        # If agent_id is not a UUID, treat it as a workflow_id directly
        # (the NestJS Content Agent sends agent_id='content' which matches
        # the workflow registered in __main__.py)
        is_uuid = bool(_UUID_PATTERN.match(agent_id))

        if not is_uuid:
            # Direct workflow resolution — agent_id IS the workflow_id
            logger.info(
                "Non-UUID agent_id '%s' — resolving as direct workflow_id (tenant=%s)",
                agent_id,
                tenant_id,
            )
            return ResolvedWorkflow(
                workflow_id=agent_id,
                agent_type=agent_id,
            )

        try:
            async with tenant_connection(self._pool, tenant_id) as conn:
                # Step 1: Get agent_type from agent_configs
                agent_row = await conn.fetchrow(
                    "SELECT agent_type FROM agent_configs WHERE id = $1",
                    agent_id,
                )

                if agent_row is None:
                    logger.warning(
                        "Agent not found in agent_configs: agent_id=%s, tenant_id=%s",
                        agent_id,
                        tenant_id,
                    )
                    raise AgentNotFoundError(agent_id)

                agent_type: str = agent_row["agent_type"]

                # Step 2: Query active workflow definitions for this agent_type
                # Fetch all active workflows matching agent_type that are either
                # tenant-specific or global (tenant_id IS NULL)
                rows = await conn.fetch(
                    """
                    SELECT workflow_id, tenant_id, graph_definition, version
                    FROM workflow_definitions
                    WHERE agent_type = $1
                      AND is_active = true
                      AND (tenant_id = $2 OR tenant_id IS NULL)
                    ORDER BY
                      CASE WHEN tenant_id IS NOT NULL THEN 0 ELSE 1 END,
                      version DESC
                    LIMIT 1
                    """,
                    agent_type,
                    tenant_id,
                )

                if not rows:
                    logger.warning(
                        "No active workflow found: agent_id=%s, tenant_id=%s, agent_type=%s",
                        agent_id,
                        tenant_id,
                        agent_type,
                    )
                    raise WorkflowNotFoundError(agent_id, tenant_id)

                # The query already handles prioritization:
                # - tenant-specific (tenant_id = Y) ordered first (CASE 0)
                # - global (tenant_id IS NULL) ordered second (CASE 1)
                # - within same scope, highest version first
                winner = rows[0]

                # Parse graph_definition (asyncpg returns JSONB as Python dict)
                graph_definition = winner["graph_definition"]
                if isinstance(graph_definition, str):
                    import json

                    graph_definition = json.loads(graph_definition)

                return ResolvedWorkflow(
                    workflow_id=winner["workflow_id"],
                    graph_definition=graph_definition,
                    config=context or {},
                    agent_type=agent_type,
                )

        except RouterError:
            # Re-raise our own errors without wrapping
            raise
        except (
            OSError,
            asyncpg.PostgresConnectionError,
            asyncpg.InterfaceError,
        ) as exc:
            logger.error(
                "Database connection error during workflow resolution: "
                "agent_id=%s, tenant_id=%s, error=%s",
                agent_id,
                tenant_id,
                str(exc),
            )
            raise RouterConnectionError(agent_id, tenant_id) from exc
