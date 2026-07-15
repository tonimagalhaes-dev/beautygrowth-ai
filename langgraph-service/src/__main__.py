"""Main entry point for the LangGraph Orchestration Service.

Initializes Redis client, asyncpg pool, Qdrant client, creates core components
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
from qdrant_client import AsyncQdrantClient

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
from .workflows.designer_agent import build_designer_agent_graph

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def _gemini_embed(text: str) -> list[float]:
    """Simple embedding function using Gemini's text-embedding model.

    Falls back to a zero vector if embedding fails (e.g., no Qdrant collection),
    allowing the workflow to proceed without Knowledge Hub context.
    """
    import google.generativeai as genai

    try:
        result = genai.embed_content(
            model="models/text-embedding-004",
            content=text,
        )
        return result["embedding"]
    except Exception as exc:
        logger.warning("Embedding failed (will return empty chunks): %s", str(exc))
        # Return a 768-dimensional zero vector as fallback
        return [0.0] * 768


async def main() -> None:
    """Initialize dependencies and start the gRPC server."""
    logger.info("Initializing LangGraph Orchestration Service...")

    # Redis configuration
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    redis_ttl = int(os.environ.get("REDIS_STATE_TTL", "3600"))

    # PostgreSQL configuration
    pg_host = os.environ.get("POSTGRES_HOST", "localhost")
    pg_port = int(os.environ.get("POSTGRES_PORT", "5432"))
    pg_database = os.environ.get("POSTGRES_DB", "beautygrowth_dev")
    pg_user = os.environ.get("POSTGRES_USER", "beautygrowth")
    pg_password = os.environ.get("POSTGRES_PASSWORD", "beautygrowth_dev")
    pg_min_pool = int(os.environ.get("POSTGRES_POOL_MIN", "2"))
    pg_max_pool = int(os.environ.get("POSTGRES_POOL_MAX", "10"))

    # Qdrant configuration
    qdrant_host = os.environ.get("QDRANT_HOST", "qdrant")
    qdrant_port = int(os.environ.get("QDRANT_PORT", "6333"))

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

    # Initialize Qdrant client
    logger.info("Connecting to Qdrant at %s:%d", qdrant_host, qdrant_port)
    qdrant_client = AsyncQdrantClient(host=qdrant_host, port=qdrant_port)

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
    content_agent_graph = build_content_agent_graph(
        pg_pool=pg_pool,
        qdrant_client=qdrant_client,
        embed_fn=_gemini_embed,
        collection_name="knowledge_hub",
        llm_client=llm_client,
    )
    workflow_engine.register_workflow("content", content_agent_graph)
    logger.info("Registered workflow: content (Content Agent)")

    designer_agent_graph = build_designer_agent_graph(
        pg_pool=pg_pool,
        qdrant_client=qdrant_client,
        embed_fn=_gemini_embed,
        collection_name="knowledge_hub",
    )
    workflow_engine.register_workflow("designer", designer_agent_graph)
    logger.info("Registered workflow: designer (Designer Agent)")

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
        await qdrant_client.close()
        await redis_client.aclose()
        await pg_pool.close()
        logger.info("Cleanup complete")


if __name__ == "__main__":
    asyncio.run(main())
