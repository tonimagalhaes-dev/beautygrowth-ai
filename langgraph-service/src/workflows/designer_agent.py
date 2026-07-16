"""Designer Agent Workflow: DAG-based workflow for social media image generation.

This module defines the Designer Agent state schema and graph structure.
The workflow consists of 6 nodes:
  1. load_context - loads clinic context (Business Memory, logo, Knowledge Hub, Content Agent data)
  2. build_visual_prompt - constructs visual prompts per social network
  3. validate_guardrails_pre - validates prompts against regulatory guardrails (pre-generation)
  4. generate_images - generates images via Gemini Image API (parallel per network)
  5. post_process - applies logo overlay and generates thumbnails
  6. upload_and_persist - uploads to MinIO and persists metadata

The conditional edge after validate_guardrails_pre implements retry logic:
  - No violation -> generate_images
  - Violation & attempt < 3 -> build_visual_prompt (retry with cleaned prompt)
  - Violation & attempt >= 3 -> END (blocked)
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Protocol, TypedDict

import asyncpg
from langgraph.graph import END, StateGraph
from qdrant_client import AsyncQdrantClient

from src.core.exceptions import ContextLoadError
from src.core.tenant_context import tenant_connection

logger = logging.getLogger(__name__)


# --- Constants ---

# Default color palette used when tenant has no paleta_cores configured
DEFAULT_COLOR_PALETTE = ["#FFFFFF", "#9E9E9E", "#D4AF37"]

# Timeout for Business Memory loading (seconds)
BUSINESS_MEMORY_TIMEOUT_SECONDS = 10

# Maximum number of iterative edits allowed per social network per execution
MAX_EDITS_PER_SOCIAL = 5

# Aspect ratio mapping: rede_social -> "ratio (WIDTHxHEIGHTpx)"
ASPECT_RATIO_MAP: dict[str, str] = {
    "instagram": "4:5 (1080x1350px)",
    "facebook": "1.91:1 (1200x628px)",
    "tiktok": "9:16 (1080x1920px)",
}

# Resolution mapping: rede_social -> (width, height)
RESOLUTION_MAP: dict[str, tuple[int, int]] = {
    "instagram": (1080, 1350),
    "facebook": (1200, 628),
    "tiktok": (1080, 1920),
}

# Timeout for image generation per model attempt (seconds)
IMAGE_GENERATION_TIMEOUT_SECONDS = 30

# Maximum image size in bytes (10 MB)
MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024

# Minimum DPI for generated images
MIN_IMAGE_DPI = 72

# Default embedded prompt template used when Prompt Registry has no designer template
DEFAULT_DESIGNER_PROMPT_TEMPLATE = """Gere uma imagem profissional para {{rede_social}} com as seguintes especificações:

DESCRIÇÃO VISUAL:
{{descricao_visual}}

IDENTIDADE DA MARCA:
- Clínica: {{nome_clinica}}
- Paleta de Cores: {{paleta_cores}}
- Estilo Visual: {{estilo_visual}}
- Elementos Recorrentes: {{elementos_recorrentes}}

ESPECIFICAÇÕES TÉCNICAS:
- Aspecto Ratio: {{aspecto_ratio}}
- Qualidade: Alta resolução, profissional, pronta para publicação

DIRETRIZES:
- A imagem deve ser coerente com a identidade visual da marca
- Usar as cores da paleta como elementos dominantes
- Manter estilo visual consistente com a comunicação da clínica
- Adequada para publicação em {{rede_social}}"""


# --- Custom Exceptions for Edit Context ---


class ExecutionNotFoundError(Exception):
    """Raised when a referenced execution_id does not exist or does not belong to the tenant.

    Maps to HTTP 404 Not Found. Does not reveal whether the execution exists
    for another tenant (security: avoids information leakage).

    Attributes:
        execution_id: The execution_id that was not found.
        http_status: The HTTP status code to map to (404).
    """

    http_status: int = 404

    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        super().__init__(
            f"Execution {execution_id} not found or does not belong to the current tenant."
        )


class EditLimitExceededError(Exception):
    """Raised when the maximum number of edits per social network has been reached.

    Maps to HTTP 429 Too Many Requests.

    Attributes:
        execution_id: The execution_id being edited.
        rede_social: The social network that reached the limit.
        max_edits: The maximum number of edits allowed.
        http_status: The HTTP status code to map to (429).
    """

    http_status: int = 429

    def __init__(self, execution_id: str, rede_social: str, max_edits: int) -> None:
        self.execution_id = execution_id
        self.rede_social = rede_social
        self.max_edits = max_edits
        super().__init__(
            f"Edit limit reached for execution {execution_id}, "
            f"rede_social '{rede_social}': maximum {max_edits} edits allowed."
        )


class ContentAgentNotFoundError(Exception):
    """Raised when the referenced Content Agent execution is not found.

    Maps to HTTP 404 — the execution_id does not exist or does not belong
    to the requesting tenant. The error message intentionally does not reveal
    whether the execution exists for another tenant (security requirement).

    Requirements: 1.7, 9.5

    Attributes:
        execution_id: The Content Agent execution_id that was not found.
        http_status: The HTTP status code to map to (404).
    """

    http_status: int = 404

    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        super().__init__(
            "A execução de conteúdo referenciada não foi encontrada."
        )


class ContentAgentStatusIncompatibleError(Exception):
    """Raised when the Content Agent execution has an incompatible status.

    Maps to HTTP 409 Conflict — the content has a status that is not
    'draft' or 'approved'. The error message intentionally does not
    reveal the actual current status of the content.

    Requirements: 9.4

    Attributes:
        execution_id: The Content Agent execution_id with incompatible status.
        http_status: The HTTP status code to map to (409).
    """

    http_status: int = 409

    def __init__(self, execution_id: str) -> None:
        self.execution_id = execution_id
        super().__init__(
            "O conteúdo vinculado possui status incompatível para geração de imagens."
        )


class ContentAgentMissingVisualSuggestionsError(Exception):
    """Raised when Content Agent execution lacks visual suggestions for requested networks.

    Maps to HTTP 422 — the referenced content does not have visual suggestions
    available for at least one of the requested social networks.

    Requirements: 9.6

    Attributes:
        execution_id: The Content Agent execution_id missing suggestions.
        missing_networks: List of social networks without visual suggestions.
        http_status: The HTTP status code to map to (422).
    """

    http_status: int = 422

    def __init__(self, execution_id: str, missing_networks: list[str]) -> None:
        self.execution_id = execution_id
        self.missing_networks = missing_networks
        networks_str = ", ".join(missing_networks)
        super().__init__(
            f"O conteúdo vinculado não possui sugestão visual disponível "
            f"para as redes solicitadas: {networks_str}."
        )


# --- State Schema ---


class DesignerAgentState(TypedDict):
    """State schema for the Designer Agent workflow.

    Organized in logical sections:
    - Input: data received from the API request
    - Context: data loaded from Business Memory, Content Agent, Knowledge Hub
    - Prompt: resolved visual prompts per social network
    - Guardrails: pre-generation validation results
    - Generation: image generation results
    - Post-processing: logo overlay and thumbnail generation
    - Upload: MinIO URLs and persisted metadata
    - Execution: metadata for observability and output
    """

    # --- Input ---
    tenant_id: str
    user_id: str
    trace_id: str
    execution_id: str
    request: dict  # {descricao_visual, redes_sociais, content_execution_id, ...}
    is_edit: bool
    original_execution_id: Optional[str]
    edit_instruction: Optional[str]
    target_social: Optional[str]  # rede social alvo da edição
    version: int

    # --- Context (populated by load_context) ---
    brand_identity: dict  # {paleta_cores, estilo_visual, valores, elementos_recorrentes}
    brand_identity_defaults_used: bool  # flag se usou defaults
    clinic_logo_url: Optional[str]  # URL do logo no MinIO
    content_agent_data: Optional[dict]  # dados do Content Agent se vinculado
    knowledge_chunks: list[dict]  # contexto visual da Knowledge Hub
    edit_history: list[dict]  # histórico de edições anteriores

    # --- Prompt (populated by build_visual_prompt) ---
    visual_prompts: dict[str, str]  # rede_social -> prompt completo
    negative_prompts: list[str]  # instruções negativas (guardrails)

    # --- Guardrails ---
    guardrail_attempt: int
    guardrail_violations: list[dict]  # {regra, trecho, tentativa}

    # --- Generation (populated by generate_images) ---
    generated_images: dict[str, dict]  # rede_social -> {bytes, format, model_id}
    generation_errors: dict[str, str]  # rede_social -> erro (se parcial)
    model_id: str
    used_fallback: bool

    # --- Post-processing (populated by post_process) ---
    processed_images: dict[str, dict]  # rede_social -> {original_bytes, thumbnail_bytes, overlay_bytes}
    logo_overlay_applied: bool
    logo_overlay_warnings: list[str]

    # --- Upload (populated by upload_and_persist) ---
    image_urls: dict[str, dict]  # rede_social -> {url, url_thumbnail, url_sem_overlay}
    image_metadata: list[dict]  # metadados persistidos

    # --- Execution metadata ---
    steps: list[dict]
    tokens_consumed: int
    duration_ms: int
    warnings: list[str]
    output: str  # JSON serializado da resposta final


# --- Business Memory Loading ---


async def _load_designer_business_memory(
    conn: asyncpg.Connection,
) -> dict[str, Any]:
    """Load business memory entries relevant for the Designer Agent.

    Queries business_memory_entries for brand identity fields needed
    for visual prompt construction: paleta_cores, estilo_visual, valores,
    elementos_recorrentes, nome_clinica, and logo_url.

    Returns:
        Dict with keys: paleta_cores, estilo_visual, valores,
        elementos_recorrentes, nome_clinica, logo_url.
    """
    rows = await conn.fetch(
        """
        SELECT category, key, value
        FROM business_memory_entries
        WHERE category IN ('brand', 'preferences')
        """,
    )

    result: dict[str, Any] = {
        "paleta_cores": None,
        "estilo_visual": None,
        "valores": None,
        "elementos_recorrentes": None,
        "nome_clinica": None,
        "logo_url": None,
    }

    for row in rows:
        category = row["category"]
        key = row["key"]
        value = row["value"]

        if category == "brand":
            if key in ("paleta_cores", "color_palette"):
                result["paleta_cores"] = value
            elif key in ("estilo_visual", "visual_style"):
                result["estilo_visual"] = value
            elif key in ("valores", "values"):
                result["valores"] = value
            elif key in ("elementos_recorrentes", "recurring_elements"):
                result["elementos_recorrentes"] = value
            elif key in ("nome_clinica", "clinic_name"):
                result["nome_clinica"] = value
            elif key in ("logo_url", "clinic_logo"):
                result["logo_url"] = value
        elif category == "preferences":
            if key in ("estilo_visual", "visual_style"):
                # estilo_visual can also be in preferences
                if result["estilo_visual"] is None:
                    result["estilo_visual"] = value

    return result


# --- Factory: load_context node ---


def make_load_context(
    pg_pool: asyncpg.Pool,
    qdrant_client: AsyncQdrantClient | None = None,
    embed_fn: Callable[[str], Any] | None = None,
    collection_name: str = "knowledge_hub",
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the load_context node with injected dependencies.

    Uses closure pattern to inject pg_pool, qdrant_client, and embed_fn
    into the node function without polluting the state schema.

    Args:
        pg_pool: asyncpg connection pool for PostgreSQL access.
        qdrant_client: Async Qdrant client for vector search (optional).
        embed_fn: Async callable that converts text to embedding vector (optional).
        collection_name: Qdrant collection name (default: 'knowledge_hub').

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _load_context(state: DesignerAgentState) -> dict[str, Any]:
        """Load clinic context for Designer Agent image generation.

        Steps:
        1. Load Business Memory (brand identity: paleta_cores, estilo_visual,
           valores, elementos_recorrentes, nome_clinica, logo_url)
           with 10s timeout → 503 on timeout
        2. If paleta_cores is absent → use defaults and set flag
        3. If aplicar_logo_overlay=true → include clinic_logo_url in state
        4. Initialize execution metadata (steps, warnings, etc.)
        5. If content_execution_id is present → load Content Agent data
           (validates existence, tenant, status, and visual suggestions)
        6. If is_edit=true → load original execution + cumulative edit history

        Returns:
            Dict with: brand_identity, brand_identity_defaults_used,
            clinic_logo_url, content_agent_data, warnings, steps,
            knowledge_chunks, edit_history.

        Raises:
            ContextLoadError: If Business Memory does not respond within 10s (HTTP 503).
            ContentAgentNotFoundError: If content execution not found (HTTP 404).
            ContentAgentStatusIncompatibleError: If content status incompatible (HTTP 409).
            ContentAgentMissingVisualSuggestionsError: If visual suggestions missing (HTTP 422).
        """
        tenant_id = state["tenant_id"]
        request = state.get("request") or {}
        start_time = time.time()

        # 1. Load Business Memory with 10s timeout
        try:
            bm_data = await asyncio.wait_for(
                _fetch_business_memory(pg_pool, tenant_id),
                timeout=BUSINESS_MEMORY_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.critical(
                "Business Memory timeout (>%ds): tenant_id=%s, trace_id=%s",
                BUSINESS_MEMORY_TIMEOUT_SECONDS,
                tenant_id,
                state.get("trace_id", "unknown"),
            )
            raise ContextLoadError(
                "business_memory",
                tenant_id,
                f"Timeout after {BUSINESS_MEMORY_TIMEOUT_SECONDS}s",
            )
        except (OSError, asyncpg.PostgresConnectionError, asyncpg.InterfaceError) as exc:
            logger.critical(
                "Failed to load Business Memory: tenant_id=%s, error=%s",
                tenant_id,
                str(exc),
            )
            raise ContextLoadError("business_memory", tenant_id, str(exc)) from exc

        # 2. Check paleta_cores - use defaults if absent
        paleta_cores = bm_data.get("paleta_cores")
        brand_identity_defaults_used = False

        if not paleta_cores:
            paleta_cores = DEFAULT_COLOR_PALETTE
            brand_identity_defaults_used = True
            logger.info(
                "Using default color palette for tenant_id=%s (paleta_cores absent)",
                tenant_id,
            )

        # Build brand_identity dict
        brand_identity = {
            "paleta_cores": paleta_cores,
            "estilo_visual": bm_data.get("estilo_visual"),
            "valores": bm_data.get("valores"),
            "elementos_recorrentes": bm_data.get("elementos_recorrentes"),
            "nome_clinica": bm_data.get("nome_clinica", ""),
        }

        # 3. Determine clinic_logo_url
        clinic_logo_url: str | None = None
        if request.get("aplicar_logo_overlay"):
            clinic_logo_url = bm_data.get("logo_url")

        # 4. Initialize warnings with defaults flag info
        warnings: list[str] = []
        if brand_identity_defaults_used:
            warnings.append(
                "Identidade de marca não configurada: paleta de cores padrão utilizada "
                "(branco #FFFFFF, cinza #9E9E9E, dourado #D4AF37)."
            )

        # Record step for observability
        elapsed_ms = int((time.time() - start_time) * 1000)
        steps: list[dict] = [
            {
                "node": "load_context",
                "action": "load_business_memory",
                "duration_ms": elapsed_ms,
                "brand_identity_defaults_used": brand_identity_defaults_used,
            }
        ]

        # 5. Load Content Agent data if content_execution_id is present
        content_agent_data: dict[str, Any] | None = None
        content_execution_id = request.get("content_execution_id")

        if content_execution_id:
            content_start = time.time()
            requested_networks = request.get("redes_sociais", [])

            try:
                async with tenant_connection(pg_pool, tenant_id) as conn:
                    content_agent_data = await _load_content_agent_data(
                        conn,
                        content_execution_id,
                        requested_networks,
                        tenant_id,
                    )
            except (
                ContentAgentNotFoundError,
                ContentAgentStatusIncompatibleError,
                ContentAgentMissingVisualSuggestionsError,
            ):
                # Re-raise domain errors (404, 409, 422) — handled upstream
                raise
            except (
                OSError,
                asyncpg.PostgresConnectionError,
                asyncpg.InterfaceError,
            ) as exc:
                logger.error(
                    "Failed to load Content Agent data: "
                    "content_execution_id=%s, tenant_id=%s, error=%s",
                    content_execution_id,
                    tenant_id,
                    str(exc),
                )
                raise ContextLoadError(
                    "content_agent", tenant_id, str(exc)
                ) from exc

            content_elapsed_ms = int((time.time() - content_start) * 1000)
            steps.append({
                "node": "load_context",
                "action": "load_content_agent_data",
                "duration_ms": content_elapsed_ms,
                "content_execution_id": content_execution_id,
                "status": content_agent_data.get("status") if content_agent_data else None,
            })

            logger.info(
                "Content Agent data loaded in %dms: "
                "content_execution_id=%s, tenant_id=%s",
                content_elapsed_ms,
                content_execution_id,
                tenant_id,
            )

        # 6. If is_edit=true: load original execution + cumulative edit history
        edit_history: list[dict] = []
        if state.get("is_edit") and state.get("original_execution_id"):
            target_social = state.get("target_social", "")
            original_execution_id = state["original_execution_id"]

            if not target_social:
                logger.error(
                    "Edit mode enabled but target_social is missing: "
                    "execution_id=%s, tenant_id=%s",
                    original_execution_id,
                    tenant_id,
                )
                raise ValueError(
                    "target_social is required when is_edit=true"
                )

            edit_start = time.time()
            try:
                async with tenant_connection(pg_pool, tenant_id) as conn:
                    edit_context = await _load_edit_context(
                        conn,
                        original_execution_id,
                        target_social,
                        tenant_id,
                    )
            except (ExecutionNotFoundError, EditLimitExceededError):
                # Re-raise domain errors (404, 429) — handled upstream
                raise
            except (
                OSError,
                asyncpg.PostgresConnectionError,
                asyncpg.InterfaceError,
            ) as exc:
                logger.error(
                    "Failed to load edit context: execution_id=%s, "
                    "tenant_id=%s, error=%s",
                    original_execution_id,
                    tenant_id,
                    str(exc),
                )
                raise ContextLoadError(
                    "designer_edit_history", tenant_id, str(exc)
                ) from exc

            edit_history = edit_context.get("edit_history", [])
            edit_elapsed_ms = int((time.time() - edit_start) * 1000)
            steps.append({
                "node": "load_context",
                "action": "load_edit_context",
                "duration_ms": edit_elapsed_ms,
                "execution_id": original_execution_id,
                "target_social": target_social,
                "edit_count": edit_context.get("edit_count", 0),
            })

            logger.info(
                "Edit context loaded in %dms: execution_id=%s, "
                "target_social=%s, history_entries=%d",
                edit_elapsed_ms,
                original_execution_id,
                target_social,
                len(edit_history),
            )

        return {
            "brand_identity": brand_identity,
            "brand_identity_defaults_used": brand_identity_defaults_used,
            "clinic_logo_url": clinic_logo_url,
            "content_agent_data": content_agent_data,
            "warnings": warnings,
            "steps": steps,
            "knowledge_chunks": [],
            "edit_history": edit_history,
        }

    return _load_context


async def _fetch_business_memory(
    pg_pool: asyncpg.Pool,
    tenant_id: str,
) -> dict[str, Any]:
    """Fetch business memory from PostgreSQL with tenant RLS.

    Extracted as a separate coroutine so it can be wrapped with
    asyncio.wait_for for timeout enforcement.

    Args:
        pg_pool: asyncpg connection pool.
        tenant_id: Tenant ID for RLS enforcement.

    Returns:
        Dict with business memory fields for the designer agent.
    """
    async with tenant_connection(pg_pool, tenant_id) as conn:
        return await _load_designer_business_memory(conn)


# --- Content Agent Data Loading (Task 3.2) ---

# Acceptable Content Agent statuses for linking to Designer Agent.
# "draft" = completed execution not yet approved by user.
# "approved" = explicitly approved by user.
# DB-level status "completed" without blocked_reason maps to "draft".
ACCEPTABLE_CONTENT_STATUSES = {"draft", "approved"}


def _resolve_content_agent_status(
    db_status: str,
    blocked_reason: str | None,
    metadata: dict[str, Any] | None,
) -> str:
    """Resolve the logical content status from workflow_executions fields.

    The workflow_executions table stores DB-level statuses ('pending', 'running',
    'completed', 'failed', 'cancelled', 'timeout'). The Content Agent NestJS layer
    maps 'completed' (without blocked_reason) to 'draft' in the API response.
    An 'approved' status may be stored in the metadata field by user action.

    Args:
        db_status: The raw status from workflow_executions.status column.
        blocked_reason: The blocked_reason field (indicates guardrail block).
        metadata: The JSONB metadata field from workflow_executions.

    Returns:
        Resolved logical status: 'draft', 'approved', 'guardrail_blocked',
        'error', 'pending', or the raw DB status.
    """
    # Check if metadata has an explicit content_status (set by user approval)
    if metadata and metadata.get("content_status"):
        return metadata["content_status"]

    # Map DB-level statuses to content-level statuses
    if db_status in ("completed", "success"):
        if blocked_reason and not blocked_reason.startswith("persisted due to"):
            return "guardrail_blocked"
        return "draft"
    elif db_status == "failed":
        return "error"
    else:
        # pending, running, cancelled, timeout
        return db_status


async def _load_content_agent_data(
    conn: asyncpg.Connection,
    content_execution_id: str,
    requested_networks: list[str],
    tenant_id: str,
) -> dict[str, Any]:
    """Load Content Agent execution data and validate for Designer Agent use.

    This function is called when the Designer Agent request references a
    content_execution_id. It performs the following validations:

    1. Existence: The execution_id must exist in workflow_executions for
       the current tenant (RLS enforces tenant isolation).
    2. Tenant match: RLS ensures only rows for the current tenant are visible.
       If not found → 404 without revealing existence for other tenants.
    3. Status: Only 'draft' or 'approved' content can be used. Other statuses
       (e.g., 'error', 'guardrail_blocked', 'pending') → 409.
    4. Visual suggestions: The output must contain sugestoes_visuais with
       a 'descricao' field for each requested social network → 422 if missing.

    Args:
        conn: asyncpg connection with tenant RLS context already set.
        content_execution_id: The Content Agent execution_id to load.
        requested_networks: List of social networks that need visual suggestions.
        tenant_id: The tenant_id for logging purposes.

    Returns:
        Dict with:
            - execution_id: The content execution ID
            - status: Resolved content status ('draft' or 'approved')
            - sugestoes_visuais: Dict[rede_social, dict] with visual suggestions
            - redes_sociais: Social networks from the content execution

    Raises:
        ContentAgentNotFoundError: If not found or belongs to another tenant (HTTP 404).
        ContentAgentStatusIncompatibleError: If status is not 'draft'/'approved' (HTTP 409).
        ContentAgentMissingVisualSuggestionsError: If visual suggestions missing (HTTP 422).
    """
    # 1. Query workflow_executions for the content agent execution
    # RLS on workflow_executions ensures tenant isolation automatically
    row = await conn.fetchrow(
        """
        SELECT id, tenant_id, workflow_id, status, output,
               blocked_reason, metadata
        FROM workflow_executions
        WHERE conversation_id = $1
          AND workflow_id IN ('content', 'content_agent')
        ORDER BY created_at DESC
        LIMIT 1
        """,
        content_execution_id,
    )

    # 2. Validate existence (RLS filters other tenants' rows → empty result = 404)
    if row is None:
        logger.warning(
            "Content Agent execution not found or tenant mismatch: "
            "content_execution_id=%s, tenant_id=%s",
            content_execution_id,
            tenant_id,
        )
        raise ContentAgentNotFoundError(content_execution_id)

    # 3. Validate status (only 'draft' or 'approved' are acceptable)
    db_status = row["status"]
    blocked_reason = row["blocked_reason"]
    metadata_raw = row["metadata"]

    # Parse metadata JSON if it's a string
    metadata: dict[str, Any] = {}
    if metadata_raw:
        if isinstance(metadata_raw, str):
            try:
                metadata = json.loads(metadata_raw)
            except (json.JSONDecodeError, TypeError):
                metadata = {}
        elif isinstance(metadata_raw, dict):
            metadata = metadata_raw

    resolved_status = _resolve_content_agent_status(
        db_status, blocked_reason, metadata
    )

    if resolved_status not in ACCEPTABLE_CONTENT_STATUSES:
        logger.warning(
            "Content Agent status incompatible: content_execution_id=%s, "
            "resolved_status=%s, tenant_id=%s",
            content_execution_id,
            resolved_status,
            tenant_id,
        )
        raise ContentAgentStatusIncompatibleError(content_execution_id)

    # 4. Parse output and validate visual suggestions exist for requested networks
    output_raw = row["output"]
    if not output_raw:
        logger.warning(
            "Content Agent execution has no output: "
            "content_execution_id=%s, tenant_id=%s",
            content_execution_id,
            tenant_id,
        )
        raise ContentAgentMissingVisualSuggestionsError(
            content_execution_id, requested_networks
        )

    # Parse the output JSON (contains legendas, hashtags, sugestoes_visuais)
    try:
        output_data = json.loads(output_raw) if isinstance(output_raw, str) else output_raw
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "Failed to parse Content Agent output JSON: "
            "content_execution_id=%s, tenant_id=%s",
            content_execution_id,
            tenant_id,
        )
        raise ContentAgentMissingVisualSuggestionsError(
            content_execution_id, requested_networks
        )

    sugestoes_visuais = output_data.get("sugestoes_visuais", {})

    # Validate that visual suggestions with 'descricao' exist for each requested network
    missing_networks: list[str] = []
    for rede in requested_networks:
        suggestion = sugestoes_visuais.get(rede)
        if not suggestion or not isinstance(suggestion, dict):
            missing_networks.append(rede)
        elif not suggestion.get("descricao"):
            missing_networks.append(rede)

    if missing_networks:
        logger.warning(
            "Content Agent missing visual suggestions for networks: "
            "content_execution_id=%s, missing=%s, tenant_id=%s",
            content_execution_id,
            missing_networks,
            tenant_id,
        )
        raise ContentAgentMissingVisualSuggestionsError(
            content_execution_id, missing_networks
        )

    # 5. Build result with visual suggestions indexed by social network
    # Extract only the 'descricao' field per network as specified in requirements
    visual_suggestions_by_network: dict[str, dict[str, str]] = {}
    for rede in requested_networks:
        suggestion = sugestoes_visuais[rede]
        visual_suggestions_by_network[rede] = {
            "descricao": suggestion["descricao"],
            "formato": suggestion.get("formato", ""),
        }

    # Also extract the original redes_sociais from the content execution input
    input_raw = row.get("input") if hasattr(row, "get") else None
    content_redes_sociais: list[str] = []
    if input_raw:
        try:
            input_data = json.loads(input_raw) if isinstance(input_raw, str) else input_raw
            content_redes_sociais = input_data.get("redes_sociais", [])
        except (json.JSONDecodeError, TypeError):
            pass

    logger.info(
        "Content Agent data loaded: content_execution_id=%s, "
        "status=%s, networks_loaded=%s, tenant_id=%s",
        content_execution_id,
        resolved_status,
        list(visual_suggestions_by_network.keys()),
        tenant_id,
    )

    return {
        "execution_id": content_execution_id,
        "status": resolved_status,
        "sugestoes_visuais": visual_suggestions_by_network,
        "redes_sociais": content_redes_sociais,
    }


# --- Edit Context Loading (Task 3.3) ---


async def _load_edit_context(
    conn: asyncpg.Connection,
    execution_id: str,
    target_social: str,
    tenant_id: str,
) -> dict[str, Any]:
    """Load the original execution and cumulative edit history for iterative editing.

    This function is called when state["is_edit"] is True. It:
    1. Queries designer_executions for the original execution (tenant isolation via RLS).
    2. Queries designer_edit_history for all prior edits on the target social network,
       ordered by version ascending (cumulative history).
    3. Validates the edit count has not exceeded MAX_EDITS_PER_SOCIAL.

    Args:
        conn: asyncpg connection with tenant RLS context already set.
        execution_id: The original execution_id to load context for.
        target_social: The social network being edited (e.g., 'instagram').
        tenant_id: The tenant_id for logging purposes.

    Returns:
        Dict with:
            - original_execution: dict with original execution data
            - edit_history: list of prior edit records ordered by version
            - edit_count: number of existing edits for this social network

    Raises:
        ExecutionNotFoundError: If execution_id does not exist or belongs to another tenant (404).
        EditLimitExceededError: If edit count >= MAX_EDITS_PER_SOCIAL for target social (429).
    """
    # 1. Load original execution (RLS ensures tenant isolation)
    execution_row = await conn.fetchrow(
        """
        SELECT execution_id, tenant_id, descricao_visual, redes_sociais,
               estilo_visual_adicional, aplicar_logo_overlay, version,
               content_execution_id, status, created_at
        FROM designer_executions
        WHERE execution_id = $1
        """,
        execution_id,
    )

    # If not found (RLS filters out other tenants' data), return 404
    if execution_row is None:
        logger.warning(
            "Edit context: execution not found or tenant mismatch: "
            "execution_id=%s, tenant_id=%s",
            execution_id,
            tenant_id,
        )
        raise ExecutionNotFoundError(execution_id)

    # 2. Load cumulative edit history for the target social network, ordered by version
    edit_rows = await conn.fetch(
        """
        SELECT id, version, instrucao_edicao, prompt_visual_utilizado, created_at
        FROM designer_edit_history
        WHERE execution_id = $1
          AND rede_social = $2
        ORDER BY version ASC
        """,
        execution_id,
        target_social,
    )

    # 3. Validate edit count limit
    edit_count = len(edit_rows)
    if edit_count >= MAX_EDITS_PER_SOCIAL:
        logger.warning(
            "Edit limit exceeded: execution_id=%s, rede_social=%s, "
            "edit_count=%d, max=%d",
            execution_id,
            target_social,
            edit_count,
            MAX_EDITS_PER_SOCIAL,
        )
        raise EditLimitExceededError(execution_id, target_social, MAX_EDITS_PER_SOCIAL)

    # Build structured response
    original_execution = {
        "execution_id": str(execution_row["execution_id"]),
        "descricao_visual": execution_row["descricao_visual"],
        "redes_sociais": list(execution_row["redes_sociais"]),
        "estilo_visual_adicional": execution_row["estilo_visual_adicional"],
        "aplicar_logo_overlay": execution_row["aplicar_logo_overlay"],
        "version": execution_row["version"],
        "content_execution_id": (
            str(execution_row["content_execution_id"])
            if execution_row["content_execution_id"]
            else None
        ),
        "status": execution_row["status"],
        "created_at": str(execution_row["created_at"]),
    }

    edit_history = [
        {
            "id": str(row["id"]),
            "version": row["version"],
            "instrucao_edicao": row["instrucao_edicao"],
            "prompt_visual_utilizado": row["prompt_visual_utilizado"],
            "created_at": str(row["created_at"]),
        }
        for row in edit_rows
    ]

    logger.info(
        "Edit context loaded: execution_id=%s, rede_social=%s, "
        "edit_count=%d/%d",
        execution_id,
        target_social,
        edit_count,
        MAX_EDITS_PER_SOCIAL,
    )

    return {
        "original_execution": original_execution,
        "edit_history": edit_history,
        "edit_count": edit_count,
    }


# --- Backward-compatible stub for testing ---
# Standalone load_context stub used by graph construction when no deps provided.


async def load_context(state: DesignerAgentState) -> dict[str, Any]:
    """Standalone load_context stub (no dependencies injected).

    Used when build_designer_agent_graph is called without dependencies,
    or for testing graph structure in isolation.
    """
    return {}


# --- Stub Node Implementations ---
# These stubs will be replaced by real implementations in subsequent tasks.


def _generate_negative_prompts() -> list[str]:
    """Generate negative prompts (regulatory guardrails) for image generation.

    Returns a list of negative prompt strings in Portuguese that instruct
    the image generation model to avoid producing content that violates
    ANVISA/CFM regulations for healthcare advertising in Brazil.

    The negative prompts cover 5 regulatory categories:
    1. Before/after comparison images of procedures
    2. Unidentified health professionals
    3. Explicit nudity
    4. Irregular advertising of health services
    5. Unauthorized third-party brand logos/trademarks

    Requirements: 7.1

    Returns:
        List of negative prompt strings (in Portuguese).
    """
    return [
        (
            "NÃO gerar imagens de antes e depois de procedimentos estéticos ou "
            "médicos. Proibido qualquer comparação visual de resultados de "
            "tratamentos, cirurgias ou intervenções."
        ),
        (
            "NÃO incluir representações de profissionais de saúde não identificados. "
            "Proibido mostrar médicos, enfermeiros ou outros profissionais sem "
            "identificação clara (nome e registro profissional)."
        ),
        (
            "NÃO gerar nudez explícita ou conteúdo sexualmente sugestivo. "
            "Proibido expor partes íntimas do corpo humano, mesmo em contexto "
            "clínico ou de procedimentos estéticos."
        ),
        (
            "NÃO incluir elementos que configurem propaganda irregular de "
            "serviços de saúde. Proibido promessas de resultados, garantias de "
            "cura, preços promocionais de procedimentos médicos ou estéticos, "
            "e qualquer conteúdo que viole normas da ANVISA e do CFM."
        ),
        (
            "NÃO incluir logotipos, marcas registradas ou elementos visuais "
            "de terceiros não autorizados. Proibido reproduzir marcas comerciais, "
            "logos de laboratórios, fabricantes de produtos ou qualquer propriedade "
            "intelectual sem autorização expressa."
        ),
    ]


async def build_visual_prompt(state: DesignerAgentState) -> dict[str, Any]:
    """Construct visual prompts for each social network.

    Standalone stub (no dependencies injected).
    Used when build_designer_agent_graph is called without pg_pool,
    or for testing graph structure in isolation.

    Generates only negative_prompts; visual_prompts remain empty.
    """
    negative_prompts = _generate_negative_prompts()

    return {
        "visual_prompts": {},
        "negative_prompts": negative_prompts,
    }


# --- Prompt Template Variable Substitution ---


def _substitute_designer_template_variables(
    template: str,
    variables: dict[str, str],
) -> str:
    """Replace {{variable_name}} placeholders in a designer prompt template.

    Supports whitespace-flexible matching: {{ var }} and {{var}} both work.

    Args:
        template: The prompt template string with {{variable}} placeholders.
        variables: Dict mapping variable names to their string values.

    Returns:
        The template with all recognized variables substituted.
        Unrecognized variables are left as-is.
    """

    def _replacer(match: re.Match) -> str:
        var_name = match.group(1).strip()
        return variables.get(var_name, match.group(0))

    return re.sub(r"\{\{(\s*\w+\s*)\}\}", _replacer, template)


# --- Factory: build_visual_prompt node ---


def make_build_visual_prompt(
    pg_pool: asyncpg.Pool,
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the build_visual_prompt node with injected pg_pool.

    The returned async function:
    1. Queries the Prompt Registry (prompts + prompt_versions tables) for
       agent_type='designer' to resolve the active template.
    2. For each rede_social in the request, substitutes template variables
       with data from state (brand_identity, request, aspect_ratio mapping).
    3. Appends estilo_visual_adicional if provided.
    4. If content_agent_data is present: appends the visual suggestion (descricao)
       for each network.
    5. If edit_history is present (is_edit=true): appends cumulative edit
       instructions + new edit_instruction.

    Stores result in state as: visual_prompts = {rede_social: prompt_completo}

    Requirements: 2.2, 2.3, 2.5, 6.3

    Args:
        pg_pool: asyncpg connection pool for Prompt Registry access.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _build_visual_prompt(state: DesignerAgentState) -> dict[str, Any]:
        """Build visual prompts for each selected social network.

        Steps:
        1. Resolve template from Prompt Registry (agent_type='designer')
           - Falls back to DEFAULT_DESIGNER_PROMPT_TEMPLATE if not found
        2. For each rede_social in request.redes_sociais:
           a. Build variables dict from state (brand_identity + request)
           b. Substitute template variables
           c. Append estilo_visual_adicional if provided
           d. Append Content Agent visual suggestion if linked
           e. If edit: append cumulative edit history + new instruction
        3. Generate negative prompts (guardrails)
        4. Return visual_prompts + negative_prompts

        Returns:
            Dict with:
                - visual_prompts: {rede_social: prompt_completo}
                - negative_prompts: list[str]
        """
        tenant_id = state["tenant_id"]
        request = state.get("request") or {}
        brand_identity = state.get("brand_identity") or {}
        content_agent_data = state.get("content_agent_data")
        edit_history = state.get("edit_history") or []
        is_edit = state.get("is_edit", False)
        edit_instruction = state.get("edit_instruction")

        redes_sociais = request.get("redes_sociais", [])
        descricao_visual = request.get("descricao_visual", "")
        estilo_visual_adicional = request.get("estilo_visual_adicional")

        # 1. Resolve prompt template from Prompt Registry
        template = await _fetch_designer_template(pg_pool, tenant_id)

        # 2. Build prompt for each social network
        visual_prompts: dict[str, str] = {}

        for rede in redes_sociais:
            # Build substitution variables
            paleta_cores_value = brand_identity.get("paleta_cores", [])
            if isinstance(paleta_cores_value, list):
                paleta_cores_str = ", ".join(str(c) for c in paleta_cores_value)
            else:
                paleta_cores_str = str(paleta_cores_value) if paleta_cores_value else ""

            elementos_recorrentes = brand_identity.get("elementos_recorrentes", "")
            if isinstance(elementos_recorrentes, list):
                elementos_recorrentes_str = ", ".join(
                    str(e) for e in elementos_recorrentes
                )
            else:
                elementos_recorrentes_str = (
                    str(elementos_recorrentes) if elementos_recorrentes else ""
                )

            variables: dict[str, str] = {
                "descricao_visual": descricao_visual,
                "paleta_cores": paleta_cores_str,
                "estilo_visual": brand_identity.get("estilo_visual") or "",
                "aspecto_ratio": ASPECT_RATIO_MAP.get(rede, "1:1"),
                "nome_clinica": brand_identity.get("nome_clinica") or "",
                "elementos_recorrentes": elementos_recorrentes_str,
                "rede_social": rede,
            }

            # Substitute template variables
            prompt = _substitute_designer_template_variables(template, variables)

            # 3. Append estilo_visual_adicional if provided
            if estilo_visual_adicional:
                prompt += f"\n\nESTILO VISUAL ADICIONAL:\n{estilo_visual_adicional}"

            # 4. Append Content Agent visual suggestion if linked
            if content_agent_data:
                sugestoes = content_agent_data.get("sugestoes_visuais", {})
                suggestion = sugestoes.get(rede)
                if suggestion and isinstance(suggestion, dict):
                    descricao_sugestao = suggestion.get("descricao", "")
                    if descricao_sugestao:
                        prompt += (
                            f"\n\nSUGESTÃO VISUAL DO CONTENT AGENT ({rede}):\n"
                            f"{descricao_sugestao}"
                        )

            # 5. If edit: append cumulative edit history + new instruction
            if is_edit and (edit_history or edit_instruction):
                edit_section = "\n\nHISTÓRICO DE EDIÇÕES:"

                # Append all previous edit instructions in order
                for i, edit_entry in enumerate(edit_history, start=1):
                    instrucao = edit_entry.get("instrucao_edicao", "")
                    if instrucao:
                        edit_section += f"\n- Edição {i}: {instrucao}"

                # Append the current new edit instruction
                if edit_instruction:
                    edit_number = len(edit_history) + 1
                    edit_section += (
                        f"\n\nINSTRUÇÃO DE EDIÇÃO ATUAL (Edição {edit_number}):\n"
                        f"{edit_instruction}"
                    )
                    edit_section += (
                        "\n\nIMPORTANTE: Aplique TODAS as instruções de edição "
                        "anteriores cumulativamente, priorizando a instrução atual."
                    )

                prompt += edit_section

            visual_prompts[rede] = prompt

        # 6. Generate negative prompts (guardrails)
        negative_prompts = _generate_negative_prompts()

        logger.info(
            "Visual prompts built for %d networks: tenant_id=%s, "
            "template_source=%s, has_content_agent=%s, is_edit=%s",
            len(visual_prompts),
            tenant_id,
            "registry" if template != DEFAULT_DESIGNER_PROMPT_TEMPLATE else "default",
            bool(content_agent_data),
            is_edit,
        )

        return {
            "visual_prompts": visual_prompts,
            "negative_prompts": negative_prompts,
        }

    return _build_visual_prompt


async def _fetch_designer_template(
    pg_pool: asyncpg.Pool,
    tenant_id: str,
) -> str:
    """Fetch the active prompt template for agent_type='designer' from Prompt Registry.

    Queries the prompts + prompt_versions tables for the active 'task' function
    template for the designer agent. If no template is found, returns the
    DEFAULT_DESIGNER_PROMPT_TEMPLATE.

    Args:
        pg_pool: asyncpg connection pool.
        tenant_id: Tenant ID for RLS context.

    Returns:
        The prompt template string (from registry or default fallback).
    """
    query = """
        SELECT p."function", pv.content
        FROM prompts p
        JOIN prompt_versions pv ON pv.prompt_id = p.id
        WHERE p.agent_type = $1
          AND pv.is_active = TRUE
        ORDER BY p."function"
    """

    try:
        async with tenant_connection(pg_pool, tenant_id) as conn:
            rows = await conn.fetch(query, "designer")

        # Look for 'task' function template (primary prompt for image generation)
        for row in rows:
            if row["function"] == "task":
                template = row["content"]
                if template and template.strip():
                    logger.info(
                        "Designer prompt template resolved from Prompt Registry: "
                        "tenant_id=%s, length=%d chars",
                        tenant_id,
                        len(template),
                    )
                    return template

        # If no 'task' function, try 'system' or first available
        for row in rows:
            template = row["content"]
            if template and template.strip():
                logger.info(
                    "Designer prompt template resolved from Prompt Registry "
                    "(function='%s'): tenant_id=%s, length=%d chars",
                    row["function"],
                    tenant_id,
                    len(template),
                )
                return template

    except Exception as exc:
        logger.warning(
            "Failed to fetch designer template from Prompt Registry, "
            "using default: tenant_id=%s, error=%s",
            tenant_id,
            str(exc),
        )

    # Fallback to embedded default template
    logger.info(
        "Using default designer prompt template: tenant_id=%s "
        "(no active template found in Prompt Registry)",
        tenant_id,
    )
    return DEFAULT_DESIGNER_PROMPT_TEMPLATE


async def validate_guardrails_pre(state: DesignerAgentState) -> dict[str, Any]:
    """Validate visual prompts against regulatory guardrails before generation.

    Standalone stub (no dependencies injected).
    Used when build_designer_agent_graph is called without pg_pool,
    or for testing graph structure in isolation.

    Returns empty dict (no violations) so the conditional edge routes to generate_images.
    """
    return {}


# --- Platform Guardrails (ANVISA/CFM) ---
# Hardcoded prohibited terms/patterns for Brazilian healthcare advertising compliance.
# These are ALWAYS applied regardless of tenant configuration.

PLATFORM_GUARDRAIL_RULES: list[dict[str, Any]] = [
    {
        "name": "ANVISA/CFM - Comparação antes e depois",
        "keywords": ["antes e depois", "antes/depois", "resultado antes", "foto comparativa"],
        "pattern": r"(?i)\bantes\s+e\s+depois\b",
    },
    {
        "name": "ANVISA/CFM - Resultado garantido",
        "keywords": ["resultado garantido", "garantia de resultado", "resultado 100%", "resultado comprovado"],
        "pattern": r"(?i)\b(resultado\s+garantido|garantia\s+de\s+resultado|resultado\s+100%)\b",
    },
    {
        "name": "ANVISA/CFM - Promessa de cura",
        "keywords": ["cura", "curar", "cura definitiva", "cura total", "cura completa"],
        "pattern": r"(?i)\b(cura\s+(definitiva|total|completa)|curar)\b",
    },
    {
        "name": "ANVISA/CFM - Propaganda de preço",
        "keywords": ["preço", "promoção", "desconto", "oferta", "liquidação", "black friday", "grátis"],
        "pattern": r"(?i)\b(preço|promoção|desconto|oferta|liquidação|black\s*friday|grátis|de\s+R\$|por\s+apenas)\b",
    },
    {
        "name": "ANVISA/CFM - Alegações médicas não autorizadas",
        "keywords": [
            "tratamento milagroso",
            "sem dor",
            "sem efeitos colaterais",
            "substitui cirurgia",
            "melhor que cirurgia",
            "aprovado pela anvisa",
        ],
        "pattern": r"(?i)\b(tratamento\s+milagroso|sem\s+(dor|efeitos?\s+colaterais)|substitui\s+cirurgia)\b",
    },
    {
        "name": "ANVISA/CFM - Termos sensacionalistas",
        "keywords": [
            "revolucionário",
            "milagre",
            "sensacional",
            "inacreditável",
            "segredo",
            "fórmula secreta",
            "exclusivo",
        ],
        "pattern": r"(?i)\b(revolucion[aá]rio|milagre|sensacional|inacredit[aá]vel|f[oó]rmula\s+secreta)\b",
    },
]

# Timeout for loading tenant custom guardrails (seconds)
GUARDRAIL_CUSTOM_TIMEOUT_SECONDS = 10


def _check_prompt_against_guardrail(
    text: str,
    rule: dict[str, Any],
) -> str | None:
    """Check if prompt text violates a single guardrail rule.

    Checks both keyword matches (case-insensitive substring) and regex
    pattern matches against the prompt text.

    Args:
        text: The prompt text to validate.
        rule: Dict with 'keywords' (list[str]) and/or 'pattern' (str).

    Returns:
        The matched term/substring (max 200 chars) if violation found, None otherwise.
    """
    text_lower = text.lower()

    # Check keywords (substring match, case-insensitive)
    keywords = rule.get("keywords") or []
    for keyword in keywords:
        keyword_lower = keyword.lower()
        idx = text_lower.find(keyword_lower)
        if idx != -1:
            # Extract surrounding context (max 200 chars)
            start = max(0, idx - 30)
            end = min(len(text), idx + len(keyword) + 30)
            trecho = text[start:end]
            return trecho[:200]

    # Check regex pattern
    pattern = rule.get("pattern")
    if pattern:
        try:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                # Extract match with surrounding context (max 200 chars)
                start = max(0, match.start() - 30)
                end = min(len(text), match.end() + 30)
                trecho = text[start:end]
                return trecho[:200]
        except re.error:
            logger.warning(
                "Invalid regex pattern in guardrail rule: %s", pattern
            )

    return None


# --- Factory: validate_guardrails_pre node ---


def _remove_violating_terms_from_prompts(
    visual_prompts: dict[str, str],
    violations: list[dict[str, Any]],
    all_rules: list[dict[str, Any]],
) -> dict[str, str]:
    """Remove violating terms/patterns from visual prompts for rebuild.

    For each violated guardrail rule, removes matching keywords and regex
    pattern matches from all prompts so the rebuild loop can proceed
    with cleaned content.

    Args:
        visual_prompts: Dict of rede_social -> prompt text.
        violations: List of violation dicts with 'regra' key identifying the rule.
        all_rules: Full list of guardrail rules for pattern/keyword lookup.

    Returns:
        New dict with cleaned prompts (violating terms removed).
    """
    # Build set of violated rule names
    violated_names = {v["regra"] for v in violations}

    # Collect patterns and keywords from violated rules
    patterns_to_remove: list[str] = []
    keywords_to_remove: list[str] = []

    for rule in all_rules:
        if rule["name"] in violated_names:
            pattern = rule.get("pattern")
            if pattern:
                patterns_to_remove.append(pattern)
            keywords = rule.get("keywords") or []
            keywords_to_remove.extend(keywords)

    # Apply removal to each prompt
    cleaned_prompts: dict[str, str] = {}
    for rede, prompt in visual_prompts.items():
        cleaned = prompt

        # Remove regex pattern matches
        for pattern in patterns_to_remove:
            try:
                cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
            except re.error:
                pass

        # Remove keyword matches (case-insensitive)
        for keyword in keywords_to_remove:
            escaped = re.escape(keyword)
            try:
                cleaned = re.sub(escaped, "", cleaned, flags=re.IGNORECASE)
            except re.error:
                pass

        # Clean up leftover whitespace artifacts
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        cleaned = re.sub(r"  +", " ", cleaned)
        cleaned = cleaned.strip()

        cleaned_prompts[rede] = cleaned

    return cleaned_prompts


def make_validate_guardrails_pre(
    pg_pool: asyncpg.Pool,
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the validate_guardrails_pre node with injected pg_pool.

    The returned async function implements the full retry/block logic:
    1. Applies platform guardrails (hardcoded ANVISA/CFM rules) to all visual_prompts
    2. Tries to load tenant-specific custom guardrails from the guardrails table (10s timeout)
    3. If custom guardrails timeout/error → applies only platform guardrails + adds warning
    4. Scans all visual_prompts against prohibited terms
    5. If violations found and attempt < 3:
       - Registers violations in Observability (execution_id, trace_id, regra, tentativa, trecho)
       - Removes violating elements from visual_prompts
       - Increments guardrail_attempt
       - Returns state for conditional edge → build_visual_prompt (retry)
    6. If violations found and attempt >= 3:
       - Marks as blocked
       - Registers CRITICAL in Observability
       - Sets output field with 422 error JSON
       - Returns state for conditional edge → END (blocked)

    Violations accumulate across retries (appended, never replaced).

    Requirements: 7.2, 7.3, 7.4, 7.5, 7.6

    Args:
        pg_pool: asyncpg connection pool for database access.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _validate_guardrails_pre(state: DesignerAgentState) -> dict[str, Any]:
        """Validate visual prompts against regulatory guardrails (pre-generation).

        Implements the conditional retry/block logic:
        - No violations → route to generate_images
        - Violations & attempt < 3 → clean prompts, route to build_visual_prompt
        - Violations & attempt >= 3 → blocked, route to END with 422 output

        Returns:
            Dict with updated state fields for guardrail handling.
        """
        tenant_id = state["tenant_id"]
        execution_id = state.get("execution_id", "")
        trace_id = state.get("trace_id", "")
        visual_prompts = state.get("visual_prompts") or {}
        current_attempt = state.get("guardrail_attempt", 0)
        existing_violations = state.get("guardrail_violations") or []
        existing_warnings = list(state.get("warnings") or [])

        # 1. Platform guardrails are always applied (hardcoded)
        all_rules: list[dict[str, Any]] = list(PLATFORM_GUARDRAIL_RULES)

        # 2. Try to load tenant custom guardrails with 10s timeout
        custom_guardrails_applied = True
        try:
            custom_rules = await asyncio.wait_for(
                _fetch_tenant_custom_guardrails(pg_pool, tenant_id),
                timeout=GUARDRAIL_CUSTOM_TIMEOUT_SECONDS,
            )
            all_rules.extend(custom_rules)
        except asyncio.TimeoutError:
            custom_guardrails_applied = False
            logger.warning(
                "Tenant custom guardrails timeout (>%ds): execution_id=%s, "
                "trace_id=%s, tenant_id=%s. Applying platform guardrails only.",
                GUARDRAIL_CUSTOM_TIMEOUT_SECONDS,
                execution_id,
                trace_id,
                tenant_id,
            )
        except Exception as exc:
            custom_guardrails_applied = False
            logger.warning(
                "Failed to load tenant custom guardrails: execution_id=%s, "
                "trace_id=%s, tenant_id=%s, error=%s. "
                "Applying platform guardrails only.",
                execution_id,
                trace_id,
                tenant_id,
                str(exc),
            )

        # 3. Add warning if custom guardrails were not applied (Req 7.6)
        if not custom_guardrails_applied:
            warning_msg = "guardrails personalizados não foram aplicados"
            if warning_msg not in existing_warnings:
                existing_warnings.append(warning_msg)

        # 4. Scan all visual_prompts against combined guardrail rules
        new_violations: list[dict[str, Any]] = []
        tentativa = current_attempt + 1

        for rede_social, prompt_text in visual_prompts.items():
            if not prompt_text:
                continue

            for rule in all_rules:
                trecho = _check_prompt_against_guardrail(prompt_text, rule)
                if trecho:
                    new_violations.append({
                        "regra": rule["name"],
                        "trecho": trecho[:200],
                        "tentativa": tentativa,
                        "rede_social": rede_social,
                    })

        # 5. No violations → clear and route to generate_images
        if not new_violations:
            logger.info(
                "Guardrail pre-validation passed: execution_id=%s, "
                "trace_id=%s, tenant_id=%s, attempt=%d, rules_checked=%d",
                execution_id,
                trace_id,
                tenant_id,
                tentativa,
                len(all_rules),
            )
            result: dict[str, Any] = {"guardrail_violations": []}
            if not custom_guardrails_applied:
                result["warnings"] = existing_warnings
            return result

        # --- Violations detected ---

        # 6. Log each violation for observability (Req 7.5)
        # Required fields: execution_id, trace_id, regra violada, tentativa, trecho (max 200 chars)
        for violation in new_violations:
            logger.warning(
                "Guardrail violation: execution_id=%s, trace_id=%s, "
                "regra=%s, tentativa=%d, trecho=%.200s",
                execution_id,
                trace_id,
                violation["regra"],
                violation["tentativa"],
                violation["trecho"],
            )

        # Accumulate violations across retries (append new, don't replace)
        accumulated_violations = list(existing_violations) + new_violations

        # 7a. Violations & attempt < 3 → retry logic (Req 7.3)
        if tentativa < 3:
            logger.info(
                "Guardrail retry: execution_id=%s, trace_id=%s, "
                "tentativa=%d/3, violations=%d — "
                "removing violating elements and routing to rebuild",
                execution_id,
                trace_id,
                tentativa,
                len(new_violations),
            )

            # Remove violating terms from prompts so rebuild starts clean
            cleaned_prompts = _remove_violating_terms_from_prompts(
                visual_prompts, new_violations, all_rules
            )

            return {
                "guardrail_attempt": tentativa,
                "guardrail_violations": accumulated_violations,
                "visual_prompts": cleaned_prompts,
                "warnings": existing_warnings,
            }

        # 7b. Violations & attempt >= 3 → blocked (Req 7.4)
        logger.critical(
            "Guardrail BLOCKED: execution_id=%s, trace_id=%s, "
            "tentativa=%d, violated_rules=%s — "
            "returning 422, image cannot be generated in compliance",
            execution_id,
            trace_id,
            tentativa,
            [v["regra"] for v in new_violations],
        )

        # Build blocked error response JSON for output field
        all_violated_rules = sorted({v["regra"] for v in accumulated_violations})
        blocked_output = json.dumps(
            {
                "error": "guardrail_blocked",
                "status_code": 422,
                "message": (
                    "A imagem solicitada não pode ser gerada em conformidade "
                    "com as políticas vigentes."
                ),
                "details": {
                    "execution_id": execution_id,
                    "trace_id": trace_id,
                    "violated_rules": all_violated_rules,
                    "attempts": tentativa,
                },
            },
            ensure_ascii=False,
        )

        # Emit final structured log for blocked execution (Req 10.2, 10.7)
        _emit_final_structured_log(
            trace_id=trace_id,
            execution_id=execution_id,
            tenant_id=tenant_id,
            user_id=state.get("user_id", ""),
            duration_ms=0,
            tokens_consumed=0,
            model_id="",
            qtd_imagens=0,
            qtd_violacoes=len(accumulated_violations),
            status_final="guardrail_blocked",
        )

        return {
            "guardrail_attempt": tentativa,
            "guardrail_violations": accumulated_violations,
            "warnings": existing_warnings,
            "output": blocked_output,
        }

    return _validate_guardrails_pre


async def _fetch_tenant_custom_guardrails(
    pg_pool: asyncpg.Pool,
    tenant_id: str,
) -> list[dict[str, Any]]:
    """Fetch tenant-specific custom guardrails from the guardrails table.

    Queries only tenant-specific guardrails (tenant_id IS NOT NULL).
    Platform/system guardrails (tenant_id IS NULL) are handled separately
    via the hardcoded PLATFORM_GUARDRAIL_RULES.

    Args:
        pg_pool: asyncpg connection pool.
        tenant_id: The tenant ID for RLS context.

    Returns:
        List of guardrail rule dicts with 'name', 'keywords', and 'pattern' keys.
    """
    query = """
        SELECT name, rule
        FROM guardrails
        WHERE is_active = TRUE
          AND tenant_id = $1
    """

    async with tenant_connection(pg_pool, tenant_id) as conn:
        rows = await conn.fetch(query, tenant_id)

    custom_rules: list[dict[str, Any]] = []
    for row in rows:
        rule_data = row["rule"]
        # rule is JSONB - asyncpg returns it as dict or str
        if isinstance(rule_data, str):
            try:
                rule_data = json.loads(rule_data)
            except json.JSONDecodeError:
                logger.warning(
                    "Invalid JSON in tenant guardrail rule: name=%s, "
                    "tenant_id=%s",
                    row["name"],
                    tenant_id,
                )
                continue

        custom_rules.append({
            "name": row["name"],
            "keywords": rule_data.get("keywords") or [],
            "pattern": rule_data.get("pattern"),
        })

    logger.info(
        "Loaded %d custom guardrails for tenant_id=%s",
        len(custom_rules),
        tenant_id,
    )

    return custom_rules


class ImageGenerationError(Exception):
    """Raised when image generation fails for a specific network.

    Attributes:
        rede_social: The social network that failed.
        detail: Human-readable error description.
    """

    def __init__(self, rede_social: str, detail: str) -> None:
        self.rede_social = rede_social
        self.detail = detail
        super().__init__(f"Image generation failed for {rede_social}: {detail}")


class AllNetworksFailedError(Exception):
    """Raised when image generation fails for ALL selected networks.

    Maps to HTTP 503 Service Unavailable.

    Requirements: 3.7, 10.3

    Attributes:
        errors: Dict mapping rede_social -> error message.
        http_status: The HTTP status code to map to (503).
    """

    http_status: int = 503

    def __init__(self, errors: dict[str, str]) -> None:
        self.errors = errors
        networks = ", ".join(errors.keys())
        super().__init__(
            f"Falha na geração de imagens para todas as redes sociais ({networks}) "
            f"após tentativa com modelo primário e fallback."
        )


# --- Constants for generate_images ---

# Default primary model for image generation (when Model Registry has no config)
DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-image"


# --- Image Generation Client Interface ---


@dataclass
class ImageGenerationResponse:
    """Response from an image generation API call.

    Attributes:
        image_bytes: The generated image as raw PNG bytes.
        format: Image format (always 'PNG' for this workflow).
        width: Image width in pixels.
        height: Image height in pixels.
        model_id: Identifier of the model that generated the image.
        input_tokens: Number of input tokens consumed.
        output_tokens: Number of output tokens consumed.
    """

    image_bytes: bytes
    format: str
    width: int
    height: int
    model_id: str
    input_tokens: int = 0
    output_tokens: int = 0


class ImageGenerationClient(Protocol):
    """Protocol for image generation API clients.

    Abstraction that allows mocking for tests and swapping providers.
    """

    async def __call__(
        self,
        prompt: str,
        negative_prompt: str,
        model_name: str,
        width: int,
        height: int,
    ) -> ImageGenerationResponse:
        """Generate an image from a text prompt."""
        ...


# --- Model Registry for Image Generation ---


async def _get_image_model_config(
    conn: asyncpg.Connection,
    agent_type: str = "designer",
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Query ai_models and agent_configs for primary and fallback models.

    Args:
        conn: Database connection with tenant RLS set.
        agent_type: The agent type (default: 'designer').

    Returns:
        Tuple of (primary_config, fallback_config).
        Each config dict has: model_name. Returns None for missing.
    """
    row = await conn.fetchrow(
        """
        SELECT ac.model_id, ac.fallback_model_id
        FROM agent_configs ac
        WHERE ac.agent_type = $1
          AND ac.status = 'active'
        LIMIT 1
        """,
        agent_type,
    )

    if row is None:
        return None, None

    primary = None
    if row["model_id"]:
        model_row = await conn.fetchrow(
            "SELECT name FROM ai_models WHERE id = $1",
            row["model_id"],
        )
        if model_row:
            primary = {"model_name": model_row["name"]}

    fallback = None
    if row["fallback_model_id"]:
        fallback_row = await conn.fetchrow(
            "SELECT name FROM ai_models WHERE id = $1",
            row["fallback_model_id"],
        )
        if fallback_row:
            fallback = {"model_name": fallback_row["name"]}

    return primary, fallback


# --- Factory: generate_images node ---


def make_generate_images(
    pg_pool: asyncpg.Pool,
    image_client: ImageGenerationClient,
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the generate_images node with injected dependencies.

    Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.3

    Args:
        pg_pool: asyncpg connection pool for Model Registry queries.
        image_client: Implementation conforming to ImageGenerationClient protocol.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _generate_for_network(
        rede_social: str,
        prompt: str,
        negative_prompt: str,
        primary_model: str,
        fallback_model: str | None,
        execution_id: str,
    ) -> tuple[str, dict[str, Any] | None, str | None, bool]:
        """Generate image for one network with primary/fallback logic."""
        width, height = RESOLUTION_MAP.get(rede_social, (1080, 1080))
        primary_error = ""

        # Try primary model with 30s timeout
        try:
            response = await asyncio.wait_for(
                image_client(
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    model_name=primary_model,
                    width=width,
                    height=height,
                ),
                timeout=IMAGE_GENERATION_TIMEOUT_SECONDS,
            )
            if len(response.image_bytes) > MAX_IMAGE_SIZE_BYTES:
                primary_error = (
                    f"Image exceeds 10MB ({len(response.image_bytes)} bytes)"
                )
            else:
                return (
                    rede_social,
                    {
                        "image_bytes": response.image_bytes,
                        "format": response.format,
                        "model_id": response.model_id,
                        "width": response.width,
                        "height": response.height,
                        "input_tokens": response.input_tokens,
                        "output_tokens": response.output_tokens,
                    },
                    None,
                    False,
                )
        except asyncio.TimeoutError:
            primary_error = (
                f"Timeout ({IMAGE_GENERATION_TIMEOUT_SECONDS}s) "
                f"with model '{primary_model}'"
            )
            logger.warning(
                "Image generation timeout (primary): execution_id=%s, "
                "rede_social=%s, model=%s",
                execution_id, rede_social, primary_model,
            )
        except Exception as exc:
            primary_error = f"{type(exc).__name__}: {str(exc)}"
            logger.warning(
                "Image generation failed (primary): execution_id=%s, "
                "rede_social=%s, model=%s, error=%s",
                execution_id, rede_social, primary_model, primary_error,
            )

        # Try fallback model with 30s timeout
        if not fallback_model:
            return (rede_social, None, primary_error, False)

        fallback_error = ""
        try:
            response = await asyncio.wait_for(
                image_client(
                    prompt=prompt,
                    negative_prompt=negative_prompt,
                    model_name=fallback_model,
                    width=width,
                    height=height,
                ),
                timeout=IMAGE_GENERATION_TIMEOUT_SECONDS,
            )
            if len(response.image_bytes) > MAX_IMAGE_SIZE_BYTES:
                fallback_error = (
                    f"Fallback image exceeds 10MB "
                    f"({len(response.image_bytes)} bytes)"
                )
            else:
                logger.info(
                    "Image generation succeeded (fallback): "
                    "execution_id=%s, rede_social=%s, model=%s",
                    execution_id, rede_social, fallback_model,
                )
                return (
                    rede_social,
                    {
                        "image_bytes": response.image_bytes,
                        "format": response.format,
                        "model_id": response.model_id,
                        "width": response.width,
                        "height": response.height,
                        "input_tokens": response.input_tokens,
                        "output_tokens": response.output_tokens,
                    },
                    None,
                    True,
                )
        except asyncio.TimeoutError:
            fallback_error = (
                f"Timeout ({IMAGE_GENERATION_TIMEOUT_SECONDS}s) "
                f"with fallback model '{fallback_model}'"
            )
            logger.warning(
                "Image generation timeout (fallback): execution_id=%s, "
                "rede_social=%s, model=%s",
                execution_id, rede_social, fallback_model,
            )
        except Exception as exc:
            fallback_error = f"{type(exc).__name__}: {str(exc)}"
            logger.warning(
                "Image generation failed (fallback): execution_id=%s, "
                "rede_social=%s, model=%s, error=%s",
                execution_id, rede_social, fallback_model, fallback_error,
            )

        combined_error = f"Primary: {primary_error}; Fallback: {fallback_error}"
        return (rede_social, None, combined_error, True)

    async def _generate_images(state: DesignerAgentState) -> dict[str, Any]:
        """Generate images for all selected social networks in parallel."""
        tenant_id = state["tenant_id"]
        execution_id = state.get("execution_id", "")
        trace_id = state.get("trace_id", "")
        request = state.get("request") or {}
        visual_prompts = state.get("visual_prompts") or {}
        negative_prompts = state.get("negative_prompts") or []
        existing_tokens = state.get("tokens_consumed", 0)
        existing_steps = list(state.get("steps") or [])
        redes_sociais = request.get("redes_sociais", [])
        start_time = time.time()

        # 1. Load model config from Model Registry
        primary_model = DEFAULT_IMAGE_MODEL
        fallback_model: str | None = None
        try:
            async with tenant_connection(pg_pool, tenant_id) as conn:
                primary_config, fallback_config = await _get_image_model_config(
                    conn, "designer"
                )
            if primary_config:
                primary_model = primary_config["model_name"]
            if fallback_config:
                fallback_model = fallback_config["model_name"]
        except Exception as exc:
            logger.warning(
                "Model Registry query failed, using default: "
                "execution_id=%s, error=%s",
                execution_id, str(exc),
            )

        logger.info(
            "generate_images: primary=%s, fallback=%s, networks=%s, "
            "execution_id=%s",
            primary_model, fallback_model, redes_sociais, execution_id,
        )

        # 2. Build combined negative prompt
        combined_negative = "\n".join(negative_prompts)

        # 3. Create parallel tasks
        tasks = []
        for rede in redes_sociais:
            prompt = visual_prompts.get(rede, "")
            if not prompt:
                continue
            tasks.append(
                _generate_for_network(
                    rede_social=rede,
                    prompt=prompt,
                    negative_prompt=combined_negative,
                    primary_model=primary_model,
                    fallback_model=fallback_model,
                    execution_id=execution_id,
                )
            )

        if not tasks:
            raise AllNetworksFailedError(
                {r: "No visual prompt available" for r in redes_sociais}
            )

        # 4. Execute in parallel
        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 5. Collect results
        generated_images: dict[str, dict[str, Any]] = {}
        generation_errors: dict[str, str] = {}
        any_fallback_used = False
        total_input_tokens = 0
        total_output_tokens = 0

        for result in results:
            if isinstance(result, Exception):
                logger.error(
                    "Unexpected error in generation task: "
                    "execution_id=%s, error=%s",
                    execution_id, str(result),
                )
                generation_errors["unknown"] = str(result)
                continue

            rede_social, image_data, error, used_fb = result
            if image_data is not None:
                generated_images[rede_social] = image_data
                total_input_tokens += image_data.get("input_tokens", 0)
                total_output_tokens += image_data.get("output_tokens", 0)
                if used_fb:
                    any_fallback_used = True
            else:
                generation_errors[rede_social] = error or "Unknown error"
                if used_fb:
                    any_fallback_used = True

        tokens_consumed = (
            existing_tokens + total_input_tokens + total_output_tokens
        )

        # Record step
        elapsed_ms = int((time.time() - start_time) * 1000)
        existing_steps.append({
            "node": "generate_images",
            "action": "parallel_generation",
            "duration_ms": elapsed_ms,
            "redes_requested": redes_sociais,
            "redes_generated": list(generated_images.keys()),
            "redes_failed": list(generation_errors.keys()),
            "model_primary": primary_model,
            "model_fallback": fallback_model,
            "used_fallback": any_fallback_used,
            "tokens_input": total_input_tokens,
            "tokens_output": total_output_tokens,
        })

        # Total failure → 503 + CRITICAL (Req 3.7, 10.3)
        if not generated_images:
            logger.critical(
                "ALL networks failed: execution_id=%s, trace_id=%s, "
                "tenant_id=%s, errors=%s",
                execution_id, trace_id, tenant_id,
                json.dumps(generation_errors, ensure_ascii=False),
            )
            raise AllNetworksFailedError(generation_errors)

        if generation_errors:
            logger.warning(
                "Partial failure: execution_id=%s, ok=%s, failed=%s",
                execution_id,
                list(generated_images.keys()),
                list(generation_errors.keys()),
            )
        else:
            logger.info(
                "All images generated: execution_id=%s, networks=%s, "
                "fallback=%s, ms=%d",
                execution_id, list(generated_images.keys()),
                any_fallback_used, elapsed_ms,
            )

        return {
            "generated_images": generated_images,
            "generation_errors": generation_errors,
            "model_id": primary_model,
            "used_fallback": any_fallback_used,
            "tokens_consumed": tokens_consumed,
            "steps": existing_steps,
        }

    return _generate_images


async def generate_images(state: DesignerAgentState) -> dict[str, Any]:
    """Generate images stub (no dependencies injected)."""
    return {}


# --- Logo Overlay Constants ---

# Maximum logo width as a percentage of the base image width
LOGO_MAX_WIDTH_PERCENT = 0.15

# Margin from edges as a percentage of image dimensions
LOGO_MARGIN_PERCENT = 0.03

# Logo opacity (0-255 for alpha compositing), 80% = 204
LOGO_OPACITY = int(0.80 * 255)

# Thumbnail constants
THUMBNAIL_MAX_WIDTH = 400
THUMBNAIL_QUALITY = 80
THUMBNAIL_MAX_BYTES = 200 * 1024  # 200KB
THUMBNAIL_MIN_QUALITY = 40
THUMBNAIL_QUALITY_STEP = 5
THUMBNAIL_FALLBACK_WIDTH = 300


def _apply_logo_overlay(image_bytes: bytes, logo_bytes: bytes) -> bytes | None:
    """Apply a clinic logo overlay on the bottom-right of an image.

    The logo is:
    - Resized to at most 15% of the base image width, maintaining aspect ratio
    - Positioned at the bottom-right corner with a 3% margin from edges
    - Applied with 80% opacity

    Supports PNG logos (with alpha) and JPEG/other formats (no alpha).

    Args:
        image_bytes: The base image as PNG bytes.
        logo_bytes: The logo image as bytes (PNG, JPEG, etc.).

    Returns:
        The composited image as PNG bytes, or None if processing fails.
    """
    from io import BytesIO

    from PIL import Image, ImageEnhance

    try:
        # Load base image
        base_image = Image.open(BytesIO(image_bytes)).convert("RGBA")
        base_width, base_height = base_image.size

        # Load logo
        logo = Image.open(BytesIO(logo_bytes)).convert("RGBA")
        logo_width, logo_height = logo.size

        # Resize logo to max 15% of base image width, maintaining aspect ratio
        max_logo_width = int(base_width * LOGO_MAX_WIDTH_PERCENT)
        if logo_width > max_logo_width:
            scale_factor = max_logo_width / logo_width
            new_logo_width = max_logo_width
            new_logo_height = int(logo_height * scale_factor)
            logo = logo.resize(
                (new_logo_width, new_logo_height), Image.Resampling.LANCZOS
            )
        else:
            new_logo_width = logo_width
            new_logo_height = logo_height

        # Apply 80% opacity to the logo
        # Split alpha channel and multiply by opacity factor
        r, g, b, a = logo.split()
        # Scale alpha by opacity (80% = 204/255)
        a = a.point(lambda x: int(x * LOGO_OPACITY / 255))
        logo = Image.merge("RGBA", (r, g, b, a))

        # Calculate position: bottom-right with 3% margin
        margin_x = int(base_width * LOGO_MARGIN_PERCENT)
        margin_y = int(base_height * LOGO_MARGIN_PERCENT)
        x = base_width - new_logo_width - margin_x
        y = base_height - new_logo_height - margin_y

        # Composite the logo onto the base image
        composite = base_image.copy()
        composite.alpha_composite(logo, dest=(x, y))

        # Convert back to RGB (PNG output without alpha for final image)
        output = composite.convert("RGB")

        # Save as PNG
        buffer = BytesIO()
        output.save(buffer, format="PNG")
        return buffer.getvalue()

    except Exception as exc:
        logger.warning(
            "Logo overlay processing failed: %s: %s",
            type(exc).__name__,
            str(exc),
        )
        return None


def _generate_adaptive_thumbnail(image_bytes: bytes, max_width: int = THUMBNAIL_MAX_WIDTH) -> bytes | None:
    """Generate a JPEG thumbnail from image bytes.

    The thumbnail is:
    - Resized to max_width pixels wide, maintaining aspect ratio
    - Saved as JPEG with 80% quality
    - If > 200KB: iteratively reduce quality (75%, 70%, ... down to 40%)
    - If still > 200KB at min quality: reduce width to 300px and repeat

    Args:
        image_bytes: The source image as bytes.
        max_width: Maximum thumbnail width in pixels.

    Returns:
        The thumbnail as JPEG bytes, or None if processing fails.
    """
    from io import BytesIO

    from PIL import Image

    try:
        img = Image.open(BytesIO(image_bytes))
        img_width, img_height = img.size

        # Resize to max_width maintaining aspect ratio
        if img_width > max_width:
            scale = max_width / img_width
            new_height = int(img_height * scale)
            img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)

        # Convert to RGB for JPEG
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")

        # Try saving at decreasing quality until <= 200KB
        quality = THUMBNAIL_QUALITY
        while quality >= THUMBNAIL_MIN_QUALITY:
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=quality)
            if buffer.tell() <= THUMBNAIL_MAX_BYTES:
                return buffer.getvalue()
            quality -= THUMBNAIL_QUALITY_STEP

        # If still too big, reduce width to 300px and retry
        if max_width > THUMBNAIL_FALLBACK_WIDTH:
            return _generate_adaptive_thumbnail(image_bytes, max_width=THUMBNAIL_FALLBACK_WIDTH)

        # Last resort: return whatever we got at minimum quality
        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=THUMBNAIL_MIN_QUALITY)
        return buffer.getvalue()

    except Exception as exc:
        logger.warning(
            "Thumbnail generation failed: %s: %s",
            type(exc).__name__,
            str(exc),
        )
        return None


# --- Logo Download Interface ---


class LogoDownloader(Protocol):
    """Protocol for downloading logo bytes from storage (MinIO)."""

    async def __call__(self, logo_url: str) -> bytes | None:
        """Download logo bytes from the given URL.

        Returns:
            Logo bytes, or None if download fails.
        """
        ...


# --- Factory: post_process node ---


def make_post_process(
    logo_downloader: LogoDownloader | None = None,
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the post_process node with injected dependencies.

    The post_process node:
    1. For each generated image:
       a. Generates a JPEG thumbnail (400px width, 80% quality, max 200KB)
       b. If logo overlay requested and logo available:
          - Downloads logo via logo_downloader
          - Applies overlay (15% width, bottom-right, 3% margin, 80% opacity)
          - Stores both overlay version (principal) and original (variante)
       c. If logo overlay requested but not available: adds warning
       d. If logo processing fails: returns original + warning

    Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 8.2, 8.5

    Args:
        logo_downloader: Async callable that downloads logo bytes from a URL.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _post_process(state: DesignerAgentState) -> dict[str, Any]:
        """Post-process generated images: thumbnails + logo overlay."""
        request = state.get("request") or {}
        generated_images = state.get("generated_images") or {}
        clinic_logo_url = state.get("clinic_logo_url")
        apply_logo = request.get("aplicar_logo_overlay", False)
        existing_warnings = list(state.get("warnings") or [])
        existing_steps = list(state.get("steps") or [])
        start_time = time.time()

        processed_images: dict[str, dict[str, Any]] = {}
        logo_overlay_applied = False
        logo_overlay_warnings: list[str] = []
        thumbnail_warnings: list[str] = []

        # Download logo once if overlay is requested and URL is available
        logo_bytes: bytes | None = None
        if apply_logo:
            if clinic_logo_url:
                if logo_downloader:
                    try:
                        logo_bytes = await logo_downloader(clinic_logo_url)
                        if logo_bytes is None:
                            logo_overlay_warnings.append(
                                "Falha ao baixar o logo da clínica para overlay."
                            )
                    except Exception as exc:
                        logger.warning(
                            "Logo download failed: url=%s, error=%s",
                            clinic_logo_url,
                            str(exc),
                        )
                        logo_overlay_warnings.append(
                            "Falha ao baixar o logo da clínica para overlay."
                        )
                else:
                    # No downloader available — can't download logo
                    logo_overlay_warnings.append(
                        "Serviço de download de logo não disponível."
                    )
            else:
                # Logo URL not registered in Business Memory (Req 5.4)
                logo_overlay_warnings.append(
                    "Logo da clínica não está cadastrado na Business Memory."
                )

        # Process each generated image
        for rede_social, image_data in generated_images.items():
            image_bytes = image_data.get("image_bytes")
            if not image_bytes:
                continue

            result: dict[str, Any] = {
                "original_bytes": image_bytes,
                "thumbnail_bytes": None,
                "overlay_bytes": None,
            }

            # Generate thumbnail
            thumbnail_bytes = _generate_adaptive_thumbnail(image_bytes)
            if thumbnail_bytes:
                result["thumbnail_bytes"] = thumbnail_bytes
            else:
                thumbnail_warnings.append(
                    f"Falha na geração de thumbnail para {rede_social}"
                )

            # Apply logo overlay if requested and logo bytes available
            if apply_logo and logo_bytes:
                overlay_result = _apply_logo_overlay(image_bytes, logo_bytes)
                if overlay_result:
                    # Overlay is the principal version (Req 5.5)
                    result["overlay_bytes"] = overlay_result
                    logo_overlay_applied = True
                else:
                    # Processing failed (Req 5.6) — return image without overlay + warning
                    logo_overlay_warnings.append(
                        f"Falha na aplicação do logo overlay para {rede_social}."
                    )

            processed_images[rede_social] = result

        # Combine warnings
        all_warnings = existing_warnings + logo_overlay_warnings + thumbnail_warnings

        # Record step
        elapsed_ms = int((time.time() - start_time) * 1000)
        existing_steps.append({
            "node": "post_process",
            "action": "thumbnails_and_overlay",
            "duration_ms": elapsed_ms,
            "logo_overlay_applied": logo_overlay_applied,
            "logo_overlay_requested": apply_logo,
            "logo_available": logo_bytes is not None,
            "networks_processed": list(processed_images.keys()),
        })

        logger.info(
            "post_process completed: networks=%s, overlay_applied=%s, "
            "overlay_warnings=%d, thumbnail_warnings=%d, ms=%d",
            list(processed_images.keys()),
            logo_overlay_applied,
            len(logo_overlay_warnings),
            len(thumbnail_warnings),
            elapsed_ms,
        )

        return {
            "processed_images": processed_images,
            "logo_overlay_applied": logo_overlay_applied,
            "logo_overlay_warnings": logo_overlay_warnings,
            "warnings": all_warnings,
            "steps": existing_steps,
        }

    return _post_process


async def post_process(state: DesignerAgentState) -> dict[str, Any]:
    """Post-process generated images (thumbnails + logo overlay).

    Standalone stub (no dependencies injected).
    Used when build_designer_agent_graph is called without logo_downloader,
    or for testing graph structure in isolation.
    """
    # Use make_post_process with no logo_downloader for basic operation
    _impl = make_post_process(logo_downloader=None)
    return await _impl(state)


# --- Constants for Upload ---

# Maximum upload retry attempts
UPLOAD_MAX_RETRIES = 3

# Backoff delays in seconds for upload retries (1s, 2s, 4s)
UPLOAD_BACKOFF_DELAYS = [1.0, 2.0, 4.0]

# Presigned URL validity in seconds (7 days)
PRESIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60  # 604800 seconds


# --- Storage Client Protocol ---


class StorageClient(Protocol):
    """Protocol for object storage operations (MinIO/S3-compatible).

    Abstracts upload and presigned URL generation to allow mocking in tests
    and swapping storage providers.
    """

    async def upload_object(
        self,
        path: str,
        data: bytes,
        content_type: str,
    ) -> None:
        """Upload an object to storage.

        Args:
            path: The object path/key in the bucket.
            data: The raw bytes to upload.
            content_type: The MIME content type (e.g., 'image/png', 'image/jpeg').

        Raises:
            Exception: On upload failure (network, permissions, etc.).
        """
        ...

    async def generate_presigned_url(
        self,
        path: str,
        expiry_seconds: int,
    ) -> str:
        """Generate a presigned URL for reading an object.

        Args:
            path: The object path/key in the bucket.
            expiry_seconds: URL validity duration in seconds.

        Returns:
            A presigned URL string valid for the specified duration.

        Raises:
            Exception: On URL generation failure.
        """
        ...


# --- Custom Exceptions for Upload ---


class FileTooLargeError(Exception):
    """Raised when a file exceeds the maximum allowed size (10 MB).

    Maps to HTTP 413 Payload Too Large.

    Attributes:
        file_size: The actual file size in bytes.
        max_size: The maximum allowed size in bytes.
        rede_social: The social network the file was for.
        http_status: The HTTP status code to map to (413).
    """

    http_status: int = 413

    def __init__(self, file_size: int, max_size: int, rede_social: str) -> None:
        self.file_size = file_size
        self.max_size = max_size
        self.rede_social = rede_social
        super().__init__(
            f"O arquivo para {rede_social} excede o limite máximo permitido de "
            f"{max_size // (1024 * 1024)} MB (tamanho: {file_size} bytes)."
        )


class UploadFailedError(Exception):
    """Raised when upload to storage fails after all retry attempts.

    Maps to HTTP 503 Service Unavailable.

    Attributes:
        path: The object path that failed to upload.
        attempts: Number of attempts made.
        last_error: The last error encountered.
        http_status: The HTTP status code to map to (503).
    """

    http_status: int = 503

    def __init__(self, path: str, attempts: int, last_error: str) -> None:
        self.path = path
        self.attempts = attempts
        self.last_error = last_error
        super().__init__(
            f"Falha no armazenamento após {attempts} tentativas. "
            f"Path: {path}. Último erro: {last_error}"
        )


# --- Utility: Generate timestamp ---


def _generate_upload_timestamp() -> str:
    """Generate a UTC compact timestamp with milliseconds: YYYYMMDDHHmmssSSS.

    Format: year(4) + month(2) + day(2) + hour(2) + minute(2) + second(2) + milliseconds(3)
    Example: 20260715143052123

    Returns:
        String with 17 characters representing the current UTC time.
    """
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    # Format: YYYYMMDDHHmmss + milliseconds (3 digits)
    return now.strftime("%Y%m%d%H%M%S") + f"{now.microsecond // 1000:03d}"


# --- Upload with Retry ---


async def _upload_with_retry(
    storage_client: StorageClient,
    path: str,
    data: bytes,
    content_type: str,
    max_retries: int = UPLOAD_MAX_RETRIES,
    backoff_delays: list[float] | None = None,
) -> None:
    """Upload a single object with exponential backoff retry.

    Attempts up to max_retries times with increasing delays between attempts.
    On final failure, raises UploadFailedError (maps to HTTP 503).

    Args:
        storage_client: The storage client to use for upload.
        path: Object path/key in the bucket.
        data: Raw bytes to upload.
        content_type: MIME content type.
        max_retries: Maximum number of attempts (default: 3).
        backoff_delays: List of delay durations in seconds (default: [1, 2, 4]).

    Raises:
        UploadFailedError: If all retry attempts fail (HTTP 503).
    """
    if backoff_delays is None:
        backoff_delays = list(UPLOAD_BACKOFF_DELAYS)

    last_error: str = ""

    for attempt in range(1, max_retries + 1):
        try:
            await storage_client.upload_object(path, data, content_type)
            return  # Success
        except Exception as exc:
            last_error = str(exc)
            logger.warning(
                "Upload attempt %d/%d failed for path=%s: %s",
                attempt,
                max_retries,
                path,
                last_error,
            )
            if attempt < max_retries:
                delay = backoff_delays[attempt - 1] if attempt - 1 < len(backoff_delays) else backoff_delays[-1]
                await asyncio.sleep(delay)

    # All retries exhausted
    logger.error(
        "Upload failed after %d attempts: path=%s, last_error=%s",
        max_retries,
        path,
        last_error,
    )
    raise UploadFailedError(path, max_retries, last_error)


# --- Constants for Persistence (Task 9.2) ---

# Agent Memory retry configuration (Requirement 10.5)
AGENT_MEMORY_MAX_RETRIES = 2
AGENT_MEMORY_RETRY_INTERVAL_SECONDS = 1.0

# Agent Memory TTL (30 days)
AGENT_MEMORY_TTL_DAYS = 30


# --- Final Structured Observability Log (Task 13.1, Req 10.2, 10.6, 10.7) ---


def _emit_final_structured_log(
    *,
    trace_id: str,
    execution_id: str,
    tenant_id: str,
    user_id: str,
    duration_ms: int,
    tokens_consumed: int,
    model_id: str,
    qtd_imagens: int,
    qtd_violacoes: int,
    status_final: str,
) -> None:
    """Emit final structured log entry summarizing the Designer Agent execution.

    Logs with INFO level for success, ERROR level for failure.
    If logging fails for any reason, continues execution normally
    and writes the event to stdout as fallback (Requirement 10.7).

    Fields logged: trace_id, execution_id, tenant_id, user_id, duração_ms,
    tokens_consumidos, modelo_utilizado, qtd_imagens, qtd_violações, status_final.

    Requirements: 10.2, 10.6, 10.7
    """
    log_entry = {
        "event": "designer_agent_execution_complete",
        "trace_id": trace_id,
        "execution_id": execution_id,
        "tenant_id": tenant_id,
        "user_id": user_id,
        "duracao_ms": duration_ms,
        "tokens_consumidos": tokens_consumed,
        "modelo_utilizado": model_id,
        "qtd_imagens": qtd_imagens,
        "qtd_violacoes": qtd_violacoes,
        "status_final": status_final,
    }

    try:
        log_level = logging.INFO if status_final == "success" else logging.ERROR
        logger.log(
            log_level,
            "designer_agent_execution_complete: "
            "trace_id=%s, execution_id=%s, tenant_id=%s, user_id=%s, "
            "duracao_ms=%d, tokens_consumidos=%d, modelo_utilizado=%s, "
            "qtd_imagens=%d, qtd_violacoes=%d, status_final=%s",
            trace_id,
            execution_id,
            tenant_id,
            user_id,
            duration_ms,
            tokens_consumed,
            model_id,
            qtd_imagens,
            qtd_violacoes,
            status_final,
        )
    except Exception:
        # Requirement 10.7: If logging fails, continue execution normally.
        # Write event to stdout as fallback for recovery.
        import sys

        try:
            fallback_json = json.dumps(log_entry, ensure_ascii=False)
            print(
                f"[FALLBACK_LOG] {fallback_json}",
                file=sys.stdout,
                flush=True,
            )
        except Exception:
            # Last resort: even stdout fallback fails — silently continue
            pass


# --- Factory: upload_and_persist node ---


def make_upload_and_persist(
    storage_client: StorageClient,
    pg_pool: asyncpg.Pool | None = None,
    timestamp_fn: Callable[[], str] | None = None,
) -> Callable[[DesignerAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the upload_and_persist node with injected dependencies.

    Uses closure pattern to inject storage_client and pg_pool into the node function.

    The node performs:
    1. Upload to MinIO with retry (Task 9.1)
    2. Persist metadata to designer_images (Task 9.2)
    3. Update designer_executions with final status (Task 9.2)
    4. Persist to Agent Memory with 2-retry graceful degradation (Task 9.2)

    Requirements: 4.1, 4.2, 4.3, 4.4, 4.6, 10.1, 10.5

    Args:
        storage_client: Client implementing StorageClient protocol for MinIO/S3 ops.
        pg_pool: asyncpg connection pool for PostgreSQL persistence (optional).
            If None, persistence steps are skipped (upload-only mode).
        timestamp_fn: Optional callable returning a timestamp string.
            Defaults to _generate_upload_timestamp(). Useful for deterministic testing.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """
    _timestamp_fn = timestamp_fn or _generate_upload_timestamp

    async def _persist_image_metadata(
        conn: asyncpg.Connection,
        execution_id: str,
        tenant_id: str,
        rede_social: str,
        aspecto_ratio: str,
        largura_px: int,
        altura_px: int,
        tamanho_bytes: int,
        formato: str,
        minio_path: str,
        minio_path_thumbnail: str,
        minio_path_sem_overlay: str | None,
        url_presigned: str,
        url_presigned_thumbnail: str,
        url_presigned_sem_overlay: str | None,
        url_presigned_expires_at: str,
        modelo_utilizado: str,
        version: int,
    ) -> dict[str, Any]:
        """Persist image metadata to designer_images table.

        Sets is_latest=false on previous versions for the same
        execution_id + rede_social before inserting the new record.

        Requirements: 4.3

        Returns:
            Dict with the persisted record fields.
        """
        # Set previous versions as not latest
        await conn.execute(
            """
            UPDATE designer_images
            SET is_latest = false
            WHERE execution_id = $1
              AND rede_social = $2
              AND is_latest = true
            """,
            execution_id,
            rede_social,
        )

        # Insert new image record
        row = await conn.fetchrow(
            """
            INSERT INTO designer_images (
                execution_id, tenant_id, rede_social, aspecto_ratio,
                largura_px, altura_px, tamanho_bytes, formato,
                minio_path, minio_path_thumbnail, minio_path_sem_overlay,
                url_presigned, url_presigned_thumbnail, url_presigned_sem_overlay,
                url_presigned_expires_at, modelo_utilizado, version, is_latest
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7, $8,
                $9, $10, $11,
                $12, $13, $14,
                $15::timestamptz, $16, $17, true
            )
            RETURNING id
            """,
            execution_id,
            tenant_id,
            rede_social,
            aspecto_ratio,
            largura_px,
            altura_px,
            tamanho_bytes,
            formato,
            minio_path,
            minio_path_thumbnail,
            minio_path_sem_overlay,
            url_presigned,
            url_presigned_thumbnail,
            url_presigned_sem_overlay,
            url_presigned_expires_at,
            modelo_utilizado,
            version,
        )

        return {
            "id": str(row["id"]) if row else None,
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "rede_social": rede_social,
            "aspecto_ratio": aspecto_ratio,
            "tamanho_bytes": tamanho_bytes,
            "minio_path": minio_path,
            "modelo_utilizado": modelo_utilizado,
            "version": version,
            "is_latest": True,
        }

    async def _update_designer_execution(
        conn: asyncpg.Connection,
        execution_id: str,
        status: str,
        modelo_utilizado: str,
        tokens_consumidos: int,
        duracao_ms: int,
        warnings: list[str],
        usou_fallback: bool,
        logo_overlay_aplicado: bool,
        version: int | None = None,
    ) -> None:
        """Update designer_executions with final status, duration, tokens, warnings.

        If version is provided (edit flow), also increments the version field.
        Requirements: 6.4
        """
        if version is not None:
            await conn.execute(
                """
                UPDATE designer_executions
                SET status = $1,
                    modelo_utilizado = $2,
                    tokens_consumidos = $3,
                    duracao_ms = $4,
                    warnings = $5,
                    usou_fallback = $6,
                    logo_overlay_aplicado = $7,
                    version = $8,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE execution_id = $9
                """,
                status,
                modelo_utilizado,
                tokens_consumidos,
                duracao_ms,
                warnings,
                usou_fallback,
                logo_overlay_aplicado,
                version,
                execution_id,
            )
        else:
            await conn.execute(
                """
                UPDATE designer_executions
                SET status = $1,
                    modelo_utilizado = $2,
                    tokens_consumidos = $3,
                    duracao_ms = $4,
                    warnings = $5,
                    usou_fallback = $6,
                    logo_overlay_aplicado = $7,
                    completed_at = NOW(),
                    updated_at = NOW()
                WHERE execution_id = $8
                """,
                status,
                modelo_utilizado,
                tokens_consumidos,
                duracao_ms,
                warnings,
                usou_fallback,
                logo_overlay_aplicado,
                execution_id,
            )

    async def _persist_edit_history(
        conn: asyncpg.Connection,
        execution_id: str,
        tenant_id: str,
        rede_social: str,
        version: int,
        instrucao_edicao: str,
        prompt_visual_utilizado: str,
    ) -> None:
        """Persist edit history entry to designer_edit_history table.

        This is ONLY called after successful image generation (inside
        upload_and_persist node), ensuring that failed generation attempts
        do NOT consume one of the 5 available edit slots.

        Requirements: 6.4, 6.6
        """
        await conn.execute(
            """
            INSERT INTO designer_edit_history (
                execution_id, tenant_id, rede_social,
                version, instrucao_edicao, prompt_visual_utilizado
            ) VALUES ($1, $2, $3, $4, $5, $6)
            """,
            execution_id,
            tenant_id,
            rede_social,
            version,
            instrucao_edicao,
            prompt_visual_utilizado,
        )

    async def _persist_agent_memory(
        conn: asyncpg.Connection,
        tenant_id: str,
        execution_id: str,
        trace_id: str,
        request: dict[str, Any],
        visual_prompts: dict[str, str],
        image_urls: dict[str, dict[str, str | None]],
        guardrail_violations: list[dict[str, Any]],
        tokens_consumed: int,
        duration_ms: int,
        model_id: str,
        version: int,
    ) -> None:
        """Persist execution to Agent Memory (short-term, 30 days TTL).

        Content includes: original request, visual prompt, generated URLs,
        guardrail violations, and execution metadata.

        Requirements: 10.1
        """
        # Lookup agent_config_id for agent_type='designer'
        agent_config_row = await conn.fetchrow(
            "SELECT id FROM agent_configs WHERE agent_type = 'designer' "
            "AND status = 'active' LIMIT 1",
        )

        if not agent_config_row:
            logger.warning(
                "No active agent_config found for designer agent, "
                "skipping agent_memory_short persistence: execution_id=%s",
                execution_id,
            )
            return

        content = json.dumps({
            "solicitacao_original": request,
            "prompt_visual": visual_prompts,
            "urls_geradas": image_urls,
            "violacoes_guardrail": guardrail_violations,
            "metadados_execucao": {
                "execution_id": execution_id,
                "trace_id": trace_id,
                "tokens_consumidos": tokens_consumed,
                "duracao_ms": duration_ms,
                "modelo_utilizado": model_id,
                "version": version,
            },
        }, ensure_ascii=False)

        metadata = json.dumps({
            "execution_id": execution_id,
            "version": version,
            "trace_id": trace_id,
            "ttl_days": AGENT_MEMORY_TTL_DAYS,
        })

        await conn.execute(
            """
            INSERT INTO agent_memory_short
                (agent_id, tenant_id, role, content, metadata)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
            """,
            str(agent_config_row["id"]),
            tenant_id,
            "assistant",
            content,
            metadata,
        )

    async def _upload_and_persist(state: DesignerAgentState) -> dict[str, Any]:
        """Upload images to MinIO and persist metadata.

        For each rede_social in state["processed_images"]:
        1. Validate file size (< 10MB per file) → reject with 413 error
        2. Build the path: {tenant_id}/designer/{execution_id}/{rede}_{timestamp}.png
        3. Upload original PNG with retry (3 attempts, backoff 1s, 2s, 4s)
        4. Upload thumbnail JPEG (_thumb.jpg) with retry
        5. If overlay exists: upload overlay PNG (_overlay.png) with retry
        6. Generate presigned URLs with 7-day validity for each uploaded object
        7. Persist image metadata to designer_images (is_latest management)
        8. Update designer_executions with final status, duration, tokens, warnings
        9. Persist to Agent Memory (short-term, 30 days)
           - If fails after 2 retries (1s interval): continue + WARNING

        Raises:
            FileTooLargeError: If any file exceeds 10 MB (HTTP 413).
            UploadFailedError: If upload fails after all retries (HTTP 503).
        """
        tenant_id = state["tenant_id"]
        execution_id = state["execution_id"]
        trace_id = state.get("trace_id", "")
        version = state.get("version", 1)
        request = state.get("request") or {}
        processed_images = state.get("processed_images") or {}
        generated_images = state.get("generated_images") or {}
        model_id = state.get("model_id", "")
        used_fallback = state.get("used_fallback", False)
        logo_overlay_applied = state.get("logo_overlay_applied", False)
        visual_prompts = state.get("visual_prompts") or {}
        guardrail_violations = state.get("guardrail_violations") or []
        existing_tokens = state.get("tokens_consumed", 0)
        existing_warnings = list(state.get("warnings") or [])
        existing_steps = list(state.get("steps") or [])

        image_urls: dict[str, dict[str, str | None]] = {}
        image_metadata: list[dict[str, Any]] = []
        upload_start = time.time()

        # --- Phase 1: Upload to MinIO (Task 9.1) ---
        for rede_social, image_data in processed_images.items():
            original_bytes: bytes = image_data.get("original_bytes", b"")
            thumbnail_bytes: bytes = image_data.get("thumbnail_bytes", b"")
            overlay_bytes: bytes | None = image_data.get("overlay_bytes")

            # Validate sizes (< 10MB)
            if len(original_bytes) > MAX_IMAGE_SIZE_BYTES:
                raise FileTooLargeError(
                    len(original_bytes), MAX_IMAGE_SIZE_BYTES, rede_social
                )
            if overlay_bytes and len(overlay_bytes) > MAX_IMAGE_SIZE_BYTES:
                raise FileTooLargeError(
                    len(overlay_bytes), MAX_IMAGE_SIZE_BYTES, rede_social
                )

            # Build paths
            timestamp = _timestamp_fn()
            base_path = f"{tenant_id}/designer/{execution_id}/{rede_social}_{timestamp}"
            original_path = f"{base_path}.png"
            thumbnail_path = f"{base_path}_thumb.jpg"
            overlay_path = f"{base_path}_overlay.png" if overlay_bytes else None

            # Upload original with retry
            await _upload_with_retry(
                storage_client, original_path, original_bytes, "image/png"
            )

            # Upload thumbnail with retry
            await _upload_with_retry(
                storage_client, thumbnail_path, thumbnail_bytes, "image/jpeg"
            )

            # Upload overlay (if exists) with retry
            if overlay_bytes and overlay_path:
                await _upload_with_retry(
                    storage_client, overlay_path, overlay_bytes, "image/png"
                )

            # --- Generate presigned URLs (7-day validity) ---
            url_thumbnail = await storage_client.generate_presigned_url(
                thumbnail_path, PRESIGNED_URL_EXPIRY_SECONDS
            )
            url_sem_overlay: str | None = None
            if overlay_path:
                # When overlay is applied:
                # - overlay_bytes is the principal version (with logo)
                # - original_bytes is the version without overlay
                # So: url → overlay_path, url_sem_overlay → original_path
                url_sem_overlay = await storage_client.generate_presigned_url(
                    original_path, PRESIGNED_URL_EXPIRY_SECONDS
                )
                url_principal = await storage_client.generate_presigned_url(
                    overlay_path, PRESIGNED_URL_EXPIRY_SECONDS
                )
            else:
                url_principal = await storage_client.generate_presigned_url(
                    original_path, PRESIGNED_URL_EXPIRY_SECONDS
                )

            image_urls[rede_social] = {
                "url": url_principal,
                "url_thumbnail": url_thumbnail,
                "url_sem_overlay": url_sem_overlay,
            }

            # --- Phase 2: Persist image metadata (Task 9.2) ---
            if pg_pool:
                # Get dimensions from generated_images
                gen_data = generated_images.get(rede_social, {})
                width = gen_data.get("width", 0)
                height = gen_data.get("height", 0)

                # Extract short aspect ratio (e.g., "4:5" from "4:5 (1080x1350px)")
                full_ratio = ASPECT_RATIO_MAP.get(rede_social, "1:1")
                aspecto_ratio = full_ratio.split(" ")[0] if " " in full_ratio else full_ratio

                # Compute URL expiration timestamp
                from datetime import datetime, timedelta, timezone

                expires_at = (
                    datetime.now(timezone.utc)
                    + timedelta(seconds=PRESIGNED_URL_EXPIRY_SECONDS)
                ).isoformat()

                try:
                    async with tenant_connection(pg_pool, tenant_id) as conn:
                        metadata_record = await _persist_image_metadata(
                            conn=conn,
                            execution_id=execution_id,
                            tenant_id=tenant_id,
                            rede_social=rede_social,
                            aspecto_ratio=aspecto_ratio,
                            largura_px=width,
                            altura_px=height,
                            tamanho_bytes=len(original_bytes),
                            formato="PNG",
                            minio_path=original_path if not overlay_path else overlay_path,
                            minio_path_thumbnail=thumbnail_path,
                            minio_path_sem_overlay=original_path if overlay_path else None,
                            url_presigned=url_principal,
                            url_presigned_thumbnail=url_thumbnail,
                            url_presigned_sem_overlay=url_sem_overlay,
                            url_presigned_expires_at=expires_at,
                            modelo_utilizado=model_id,
                            version=version,
                        )
                        image_metadata.append(metadata_record)
                except Exception as exc:
                    logger.error(
                        "Failed to persist image metadata: rede_social=%s, "
                        "execution_id=%s, error=%s",
                        rede_social,
                        execution_id,
                        str(exc),
                    )
                    raise

        # Record upload step
        upload_elapsed_ms = int((time.time() - upload_start) * 1000)
        existing_steps.append({
            "node": "upload_and_persist",
            "action": "upload_to_storage",
            "duration_ms": upload_elapsed_ms,
            "files_uploaded": sum(
                2 + (1 if img.get("overlay_bytes") else 0)
                for img in processed_images.values()
            ),
        })

        # --- Phase 3: Update designer_executions (Task 9.2) ---
        # Compute total duration from all steps
        prev_duration = sum(s.get("duration_ms", 0) for s in existing_steps)
        full_duration_ms = prev_duration

        # Determine if this is an edit flow
        is_edit = state.get("is_edit", False)
        target_social = state.get("target_social")
        edit_instruction = state.get("edit_instruction", "")

        if pg_pool:
            try:
                async with tenant_connection(pg_pool, tenant_id) as conn:
                    await _update_designer_execution(
                        conn=conn,
                        execution_id=execution_id,
                        status="generated",
                        modelo_utilizado=model_id,
                        tokens_consumidos=existing_tokens,
                        duracao_ms=full_duration_ms,
                        warnings=existing_warnings,
                        usou_fallback=used_fallback,
                        logo_overlay_aplicado=logo_overlay_applied,
                        version=version if is_edit else None,
                    )
            except Exception as exc:
                logger.error(
                    "Failed to update designer_executions: "
                    "execution_id=%s, error=%s",
                    execution_id,
                    str(exc),
                )
                raise

        # --- Phase 3.5: Persist edit history (Task 10.2, Req 6.4, 6.6) ---
        # Only persist to designer_edit_history AFTER successful generation
        # (reaching this point means generation succeeded).
        # If generation fails (AllNetworksFailedError in generate_images node),
        # the workflow never reaches upload_and_persist → edit attempt is NOT consumed.
        if is_edit and pg_pool and target_social:
            # Get the prompt used for this edit
            prompt_visual_utilizado = visual_prompts.get(target_social, "")

            try:
                async with tenant_connection(pg_pool, tenant_id) as conn:
                    await _persist_edit_history(
                        conn=conn,
                        execution_id=execution_id,
                        tenant_id=tenant_id,
                        rede_social=target_social,
                        version=version,
                        instrucao_edicao=edit_instruction or "",
                        prompt_visual_utilizado=prompt_visual_utilizado,
                    )
                logger.info(
                    "Edit history persisted: execution_id=%s, "
                    "rede_social=%s, version=%d",
                    execution_id,
                    target_social,
                    version,
                )
            except Exception as exc:
                logger.error(
                    "Failed to persist edit history: "
                    "execution_id=%s, rede_social=%s, version=%d, error=%s",
                    execution_id,
                    target_social,
                    version,
                    str(exc),
                )
                raise

        # --- Phase 4: Persist to Agent Memory (Task 9.2, Req 10.1, 10.5) ---
        # Retry up to 2 times with 1s interval. If fails: continue + WARNING.
        agent_memory_success = False
        agent_memory_error: str | None = None

        if pg_pool:
            for attempt in range(AGENT_MEMORY_MAX_RETRIES):
                try:
                    async with tenant_connection(pg_pool, tenant_id) as conn:
                        await _persist_agent_memory(
                            conn=conn,
                            tenant_id=tenant_id,
                            execution_id=execution_id,
                            trace_id=trace_id,
                            request=request,
                            visual_prompts=visual_prompts,
                            image_urls=image_urls,
                            guardrail_violations=guardrail_violations,
                            tokens_consumed=existing_tokens,
                            duration_ms=full_duration_ms,
                            model_id=model_id,
                            version=version,
                        )
                    agent_memory_success = True
                    break
                except Exception as exc:
                    agent_memory_error = str(exc)
                    logger.warning(
                        "Agent Memory persistence attempt %d/%d failed: "
                        "execution_id=%s, trace_id=%s, error=%s",
                        attempt + 1,
                        AGENT_MEMORY_MAX_RETRIES,
                        execution_id,
                        trace_id,
                        str(exc),
                    )
                    if attempt < AGENT_MEMORY_MAX_RETRIES - 1:
                        await asyncio.sleep(AGENT_MEMORY_RETRY_INTERVAL_SECONDS)

            if not agent_memory_success:
                # Req 10.5: Return images normally + WARNING in observability
                warning_msg = (
                    f"Falha na persistência da Agent Memory após "
                    f"{AGENT_MEMORY_MAX_RETRIES} tentativas: {agent_memory_error}"
                )
                existing_warnings.append(warning_msg)
                logger.warning(
                    "Agent Memory persistence failed after all retries: "
                    "execution_id=%s, trace_id=%s, error=%s",
                    execution_id,
                    trace_id,
                    agent_memory_error,
                )

        # Record persistence step
        persist_elapsed_ms = int((time.time() - upload_start) * 1000) - upload_elapsed_ms
        existing_steps.append({
            "node": "upload_and_persist",
            "action": "persist_metadata",
            "duration_ms": persist_elapsed_ms,
            "images_persisted": len(image_metadata),
            "agent_memory_success": agent_memory_success,
        })

        # --- Phase 5: Build final output JSON ---
        output_data = {
            "executionId": execution_id,
            "status": "generated",
            "images": {
                rede: {
                    "url": urls["url"],
                    "urlThumbnail": urls["url_thumbnail"],
                    "urlSemOverlay": urls.get("url_sem_overlay"),
                    "redeSocial": rede,
                    "aspectoRatio": ASPECT_RATIO_MAP.get(rede, "1:1").split(" ")[0],
                    "tamanhoBytes": next(
                        (m["tamanho_bytes"] for m in image_metadata if m["rede_social"] == rede),
                        0,
                    ),
                    "status": "generated",
                }
                for rede, urls in image_urls.items()
            },
            "modeloUtilizado": model_id,
            "usouFallback": used_fallback,
            "tokensConsumidos": existing_tokens,
            "duracaoMs": full_duration_ms,
            "version": version,
            "logoOverlayAplicado": logo_overlay_applied,
            "warnings": existing_warnings,
            "contentExecutionId": request.get("content_execution_id"),
        }

        output_json = json.dumps(output_data, ensure_ascii=False)

        # --- Phase 6: Final structured observability log (Req 10.2, 10.6, 10.7) ---
        # Emit a comprehensive structured log entry summarizing the execution.
        # Wrapped in try/catch: if logging fails, continue execution and write to stdout as fallback.
        _emit_final_structured_log(
            trace_id=trace_id,
            execution_id=execution_id,
            tenant_id=tenant_id,
            user_id=state.get("user_id", ""),
            duration_ms=full_duration_ms,
            tokens_consumed=existing_tokens,
            model_id=model_id,
            qtd_imagens=len(image_urls),
            qtd_violacoes=len(guardrail_violations),
            status_final="success",
        )

        logger.info(
            "upload_and_persist completed: execution_id=%s, "
            "images_uploaded=%d, images_persisted=%d, "
            "agent_memory=%s, duration_ms=%d",
            execution_id,
            len(image_urls),
            len(image_metadata),
            "success" if agent_memory_success else "failed",
            upload_elapsed_ms + persist_elapsed_ms,
        )

        return {
            "image_urls": image_urls,
            "image_metadata": image_metadata,
            "output": output_json,
            "warnings": existing_warnings,
            "steps": existing_steps,
            "duration_ms": full_duration_ms,
        }

    return _upload_and_persist


async def upload_and_persist(state: DesignerAgentState) -> dict[str, Any]:
    """Upload images to MinIO and persist metadata.

    Standalone stub used when build_designer_agent_graph is called
    without a storage_client. Returns empty dict (no-op).
    For production use, the graph should be built with make_upload_and_persist().
    """
    return {}


# --- Conditional Edge ---


def should_rebuild_or_generate(state: DesignerAgentState) -> str:
    """Decide next node after validate_guardrails_pre.

    Returns:
        "generate_images" - if no guardrail violations detected
        "build_visual_prompt" - if violation detected and attempts < 3 (retry with cleaned prompt)
        "__end__" - if violation detected and attempts >= 3 (blocked)
    """
    violations = state.get("guardrail_violations") or []
    if len(violations) == 0:
        return "generate_images"
    if state.get("guardrail_attempt", 0) < 3:
        return "build_visual_prompt"
    return "__end__"


# --- Graph Construction ---


def build_designer_agent_graph(
    pg_pool: asyncpg.Pool | None = None,
    qdrant_client: AsyncQdrantClient | None = None,
    embed_fn: Callable[[str], Any] | None = None,
    collection_name: str = "knowledge_hub",
    image_client: ImageGenerationClient | None = None,
    logo_downloader: LogoDownloader | None = None,
    storage_client: StorageClient | None = None,
) -> Any:
    """Build and compile the Designer Agent StateGraph.

    Constructs a DAG with 6 nodes and the following edges:
        load_context -> build_visual_prompt -> validate_guardrails_pre
        validate_guardrails_pre -> (conditional) -> generate_images | build_visual_prompt | END
        generate_images -> post_process -> upload_and_persist -> END

    Args:
        pg_pool: asyncpg connection pool (required for load_context).
        qdrant_client: Async Qdrant client (optional, for Knowledge Hub search).
        embed_fn: Embedding function (optional, for Knowledge Hub search).
        collection_name: Qdrant collection name (default: 'knowledge_hub').
        image_client: Async callable for image generation (optional).
        logo_downloader: Async callable to download logo bytes from MinIO (optional).
        storage_client: Client for MinIO/S3 storage operations (optional).

    Returns:
        A compiled LangGraph StateGraph ready for execution.
    """
    graph = StateGraph(DesignerAgentState)

    # Build load_context node with dependencies if provided
    if pg_pool:
        load_context_node = make_load_context(
            pg_pool=pg_pool,
            qdrant_client=qdrant_client,
            embed_fn=embed_fn,
            collection_name=collection_name,
        )
    else:
        # Fallback stub for testing graph structure without dependencies
        load_context_node = load_context

    # Build build_visual_prompt node with dependencies if provided
    if pg_pool:
        build_visual_prompt_node = make_build_visual_prompt(pg_pool=pg_pool)
    else:
        # Fallback stub for testing graph structure without dependencies
        build_visual_prompt_node = build_visual_prompt

    # Build validate_guardrails_pre node with dependencies if provided
    if pg_pool:
        validate_guardrails_pre_node = make_validate_guardrails_pre(pg_pool=pg_pool)
    else:
        # Fallback stub for testing graph structure without dependencies
        validate_guardrails_pre_node = validate_guardrails_pre

    # Build generate_images node with dependencies if provided
    if pg_pool and image_client:
        generate_images_node = make_generate_images(
            pg_pool=pg_pool,
            image_client=image_client,
        )
    else:
        # Fallback stub for testing graph structure without dependencies
        generate_images_node = generate_images

    # Build post_process node with logo_downloader
    post_process_node = make_post_process(logo_downloader=logo_downloader)

    # Build upload_and_persist node with storage_client if provided
    if storage_client:
        upload_and_persist_node = make_upload_and_persist(
            storage_client=storage_client,
            pg_pool=pg_pool,
        )
    else:
        # Fallback stub for testing graph structure without dependencies
        upload_and_persist_node = upload_and_persist

    # Add nodes
    graph.add_node("load_context", load_context_node)
    graph.add_node("build_visual_prompt", build_visual_prompt_node)
    graph.add_node("validate_guardrails_pre", validate_guardrails_pre_node)
    graph.add_node("generate_images", generate_images_node)
    graph.add_node("post_process", post_process_node)
    graph.add_node("upload_and_persist", upload_and_persist_node)

    # Set entry point
    graph.set_entry_point("load_context")

    # Add linear edges
    graph.add_edge("load_context", "build_visual_prompt")
    graph.add_edge("build_visual_prompt", "validate_guardrails_pre")

    # Conditional edge after guardrail pre-validation
    graph.add_conditional_edges(
        "validate_guardrails_pre",
        should_rebuild_or_generate,
        {
            "generate_images": "generate_images",
            "build_visual_prompt": "build_visual_prompt",
            "__end__": END,
        },
    )

    # Linear edges after generation
    graph.add_edge("generate_images", "post_process")
    graph.add_edge("post_process", "upload_and_persist")
    graph.add_edge("upload_and_persist", END)

    return graph.compile()
