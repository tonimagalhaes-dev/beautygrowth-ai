"""Main entry point for the LangGraph Orchestration Service.

Initializes Redis client, asyncpg pool, creates core components
(StateManager, WorkflowEngine, AgentRouter), and starts the gRPC server.

Usage:
    python -m src
"""

import asyncio
import logging
import os
import sys

import asyncpg
import redis.asyncio as redis

from .core.agent_router import PostgresAgentRouter
from .core.llm_clients import GeminiLLMClient
from .core.state_manager import RedisStateManager
from .core.workflow_engine import LangGraphWorkflowEngine
from .grpc.interceptors import (
    CrossTenantValidationInterceptor,
    PostgresAuditLogStore,
    TenantValidationInterceptor,
)
from .grpc.server import AgentOrchestrationServicer, serve
from .workflows.content_agent import build_content_agent_graph

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def main() -> None:
    """Initialize dependencies and start the gRPC server."""
    logger.info("Initializing LangGraph Orchestration Service...")

    # Redis configuration
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    redis_ttl = int(os.environ.get("REDIS_STATE_TTL", "3600"))

    # PostgreSQL configuration
    pg_host = os.environ.get("POSTGRES_HOST", "localhost")
    pg_port = int(os.environ.get("POSTGRES_PORT", "5432"))
    pg_database = os.environ.get("POSTGRES_DB", "beautygrowth")
    pg_user = os.environ.get("POSTGRES_USER", "postgres")
    pg_password = os.environ.get("POSTGRES_PASSWORD", "postgres")
    pg_min_pool = int(os.environ.get("POSTGRES_POOL_MIN", "2"))
    pg_max_pool = int(os.environ.get("POSTGRES_POOL_MAX", "10"))

    # Initialize Redis client
    logger.info("Connecting to Redis at %s", redis_url)
    redis_client = redis.from_url(redis_url, decode_responses=True)

    # Initialize asyncpg pool
    logger.info("Connecting to PostgreSQL at %s:%d/%s", pg_host, pg_port, pg_database)
    pg_pool = await asyncpg.create_pool(
        host=pg_host,
        port=pg_port,
        database=pg_database,
        user=pg_user,
        password=pg_password,
        min_size=pg_min_pool,
        max_size=pg_max_pool,
    )

    # Create core components
    state_manager = RedisStateManager(
        redis_client=redis_client,
        ttl=redis_ttl,
        pg_pool=pg_pool,
    )

    workflow_engine = LangGraphWorkflowEngine()

    # Initialize LLM client (Gemini adapter)
    # To switch providers, replace GeminiLLMClient with another adapter
    # (e.g., OpenAILLMClient) that implements the same LLMClient interface.
    llm_client = GeminiLLMClient()
    logger.info("LLM client initialized: GeminiLLMClient")

    # Register domain-specific workflows
    content_agent_graph = build_content_agent_graph(pg_pool=pg_pool, llm_client=llm_client)
    workflow_engine.register_workflow("content", content_agent_graph)
    logger.info("Registered workflow: content (Content Agent)")

    agent_router = PostgresAgentRouter(pool=pg_pool)

    # Create servicer
    servicer = AgentOrchestrationServicer(
        state_manager=state_manager,
        workflow_engine=workflow_engine,
        agent_router=agent_router,
    )

    # Create interceptors for cross-cutting tenant validation
    audit_log_store = PostgresAuditLogStore(pg_pool=pg_pool)
    interceptors = [
        TenantValidationInterceptor(),
        CrossTenantValidationInterceptor(audit_log_store=audit_log_store),
    ]

    logger.info("All components initialized successfully")

    try:
        # Start gRPC server (blocks until shutdown signal)
        await serve(servicer, interceptors=interceptors)
    finally:
        # Cleanup
        logger.info("Cleaning up connections...")
        await redis_client.aclose()
        await pg_pool.close()
        logger.info("Cleanup complete")


if __name__ == "__main__":
    asyncio.run(main())
