"""Content Agent Workflow: DAG-based workflow for social media content generation.

This module defines the Content Agent state schema and graph structure.
The workflow consists of 5 nodes:
  1. load_context - loads clinic context (Business Memory + Knowledge Hub)
  2. resolve_prompt - resolves prompt templates from Prompt Registry
  3. generate_content - calls LLM to generate content
  4. validate_guardrails - validates content against regulatory guardrails
  5. persist_and_output - persists results and serializes final output

The conditional edge after validate_guardrails implements retry logic:
  - No violation -> persist_and_output
  - Violation & attempt < 3 -> generate_content (retry)
  - Violation & attempt >= 3 -> END (blocked)
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, TypedDict

import asyncpg
from langgraph.graph import END, StateGraph
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue

from src.core.exceptions import BrandIdentityMissingError, ContextLoadError
from src.core.tenant_context import tenant_connection

logger = logging.getLogger(__name__)


# --- LLM Client Interface ---


@dataclass
class LLMResponse:
    """Response from an LLM API call.

    Attributes:
        content: The raw text content returned by the LLM.
        input_tokens: Number of input/prompt tokens consumed.
        output_tokens: Number of output/completion tokens consumed.
        model_id: Identifier of the model that processed the request.
    """

    content: str
    input_tokens: int
    output_tokens: int
    model_id: str


# LLMClient signature: (system_prompt, task_prompt, model_name, temperature, max_tokens) -> LLMResponse
LLMClient = Callable[[str, str, str, float, int], Awaitable[LLMResponse]]


class LLMUnavailableError(Exception):
    """Raised when all LLM models (primary + fallback) are unavailable.

    Maps to HTTP 503 Service Unavailable.

    Attributes:
        http_status: The HTTP status code to map to (503).
    """

    http_status: int = 503

    def __init__(self, primary_error: str, fallback_error: str = "") -> None:
        self.primary_error = primary_error
        self.fallback_error = fallback_error
        detail = (
            f"Primary model failed: {primary_error}"
            + (f"; Fallback model failed: {fallback_error}" if fallback_error else "")
        )
        super().__init__(
            f"LLM service unavailable. {detail}"
        )


# --- Character limits per social network ---

CHAR_LIMITS: dict[str, int] = {
    "instagram": 2200,
    "facebook": 63206,
    "tiktok": 2200,
}

MIN_HASHTAGS = 5
MAX_HASHTAGS = 15


class ContentAgentState(TypedDict):
    """State schema for the Content Agent workflow.

    Organized in logical sections:
    - Input: data received from the API request
    - Context: data loaded from Business Memory and Knowledge Hub
    - Prompt: resolved prompt templates
    - Generation: LLM-generated content
    - Validation: guardrail check results
    - Execution: metadata for observability and output
    """

    # --- Input ---
    tenant_id: str
    user_id: str
    trace_id: str
    execution_id: str
    briefing: dict  # {tema, procedimento, publico_alvo_override, redes_sociais, idioma}
    is_refinement: bool
    original_execution_id: Optional[str]
    refinement_instructions: Optional[str]
    version: int

    # --- Context (populated by load_context) ---
    brand_identity: dict  # {tom_de_voz, valores, paleta_cores}
    publico_alvo: str
    especialidades: list[str]
    diferenciais: list[str]
    knowledge_chunks: list[dict]

    # --- Prompt (populated by resolve_prompt) ---
    system_prompt: str
    task_prompt: str

    # --- Generation (populated by generate_content) ---
    legendas: dict[str, str]  # rede -> texto
    hashtags: list[str]
    sugestoes_visuais: dict[str, dict]
    model_id: str
    used_fallback: bool

    # --- Validation ---
    guardrail_attempt: int
    guardrail_violations: list[str]
    blocked_reason: Optional[str]

    # --- Execution metadata ---
    steps: list[dict]
    tokens_input: int
    tokens_output: int
    output: str  # JSON serializado da resposta final


# --- load_context node implementation ---


async def _load_business_memory(
    conn: asyncpg.Connection,
    tenant_id: str,
) -> dict[str, Any]:
    """Load business memory entries for a tenant.

    Queries business_memory_entries for brand identity, publico-alvo,
    especialidades, and diferenciais.

    Returns:
        Dict with keys: tom_de_voz, valores, paleta_cores, publico_alvo,
        especialidades, diferenciais.
    """
    rows = await conn.fetch(
        """
        SELECT category, key, value
        FROM business_memory_entries
        WHERE category IN (
            'brand', 'audience', 'procedures', 'preferences'
        )
        """,
    )

    result: dict[str, Any] = {
        "tom_de_voz": None,
        "valores": None,
        "paleta_cores": None,
        "publico_alvo": None,
        "nome_clinica": None,
        "especialidades": [],
        "diferenciais": [],
    }

    for row in rows:
        category = row["category"]
        key = row["key"]
        value = row["value"]

        if category == "brand":
            if key in ("tom_de_voz", "voice_tone"):
                result["tom_de_voz"] = value
            elif key in ("valores", "values"):
                result["valores"] = value
            elif key in ("paleta_cores", "color_palette"):
                result["paleta_cores"] = value
            elif key in ("diferenciais", "differentials"):
                if isinstance(value, list):
                    result["diferenciais"].extend(value)
                else:
                    result["diferenciais"].append(value)
            elif key in ("nome_clinica", "clinic_name"):
                result["nome_clinica"] = value
        elif category == "audience":
            if key in ("publico_alvo", "clinic_target_audience"):
                result["publico_alvo"] = value
        elif category == "procedures":
            if key in ("especialidades", "specialties"):
                if isinstance(value, list):
                    result["especialidades"].extend(value)
                else:
                    result["especialidades"].append(value)

    return result


async def _search_knowledge_hub(
    qdrant_client: AsyncQdrantClient,
    embed_fn: Callable[[str], Any],
    tenant_id: str,
    query_text: str,
    collection_name: str = "knowledge_hub",
    top_k: int = 5,
) -> list[dict[str, Any]]:
    """Perform semantic search on Knowledge Hub via Qdrant.

    Searches for chunks matching the query text, filtered by tenant_id
    and relevant categories (marketing, procedures, compliance).

    Args:
        qdrant_client: Async Qdrant client instance.
        embed_fn: Async callable that embeds text into a vector.
        tenant_id: Tenant to filter by.
        query_text: Combined tema + procedimento text for semantic search.
        collection_name: Qdrant collection name.
        top_k: Maximum number of chunks to return.

    Returns:
        List of dicts with keys: content, score, category, metadata.
    """
    query_vector = await embed_fn(query_text)

    # Filter: must match tenant_id, should match one of the categories
    category_filter = Filter(
        must=[
            FieldCondition(
                key="tenant_id",
                match=MatchValue(value=tenant_id),
            ),
        ],
        should=[
            FieldCondition(
                key="category",
                match=MatchValue(value="marketing"),
            ),
            FieldCondition(
                key="category",
                match=MatchValue(value="procedures"),
            ),
            FieldCondition(
                key="category",
                match=MatchValue(value="compliance"),
            ),
        ],
    )

    results = await qdrant_client.search(
        collection_name=collection_name,
        query_vector=query_vector,
        query_filter=category_filter,
        limit=top_k,
        with_payload=True,
    )

    chunks = []
    for point in results:
        payload = point.payload or {}
        chunks.append({
            "content": payload.get("content", ""),
            "score": point.score,
            "category": payload.get("category", ""),
            "metadata": {
                k: v
                for k, v in payload.items()
                if k not in ("content", "category", "tenant_id")
            },
        })

    return chunks


async def _load_original_execution(
    conn: asyncpg.Connection,
    execution_id: str,
) -> dict[str, Any]:
    """Load original execution context from agent_memory_short for refinement.

    Args:
        conn: Database connection with tenant RLS context set.
        execution_id: The original execution_id to load.

    Returns:
        Dict with the original execution context (briefing, content, etc).
    """
    row = await conn.fetchrow(
        """
        SELECT briefing, context_data, generated_content, version
        FROM agent_memory_short
        WHERE execution_id = $1
        ORDER BY version DESC
        LIMIT 1
        """,
        execution_id,
    )

    if row is None:
        return {}

    return {
        "original_briefing": row["briefing"],
        "original_context": row["context_data"],
        "original_content": row["generated_content"],
        "original_version": row["version"],
    }


def make_load_context(
    pg_pool: asyncpg.Pool,
    qdrant_client: AsyncQdrantClient,
    embed_fn: Callable[[str], Any],
    collection_name: str = "knowledge_hub",
) -> Callable[[ContentAgentState], Any]:
    """Factory that creates a load_context node with injected dependencies.

    Uses closure pattern to inject pg_pool, qdrant_client, and embed_fn
    into the node function without polluting the state schema.

    Args:
        pg_pool: asyncpg connection pool for PostgreSQL access.
        qdrant_client: Async Qdrant client for vector search.
        embed_fn: Async callable that converts text to embedding vector.
        collection_name: Qdrant collection name (default: 'knowledge_hub').

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def load_context(state: ContentAgentState) -> dict[str, Any]:
        """Load clinic context from Business Memory and Knowledge Hub.

        Steps:
        1. Load Business Memory (brand identity, publico-alvo, especialidades, diferenciais)
        2. Validate tom_de_voz precondition (raise 412 if absent)
        3. Search Knowledge Hub via Qdrant with tema + procedimento
        4. If refinement: load original execution from Agent Memory
        5. Apply publicoAlvoOverride if present in briefing

        Returns:
            Dict with: brand_identity, publico_alvo, especialidades,
            diferenciais, knowledge_chunks.

        Raises:
            BrandIdentityMissingError: If tom_de_voz is not configured (HTTP 412).
            ContextLoadError: If Business Memory or Knowledge Hub is unreachable (HTTP 503).
        """
        tenant_id = state["tenant_id"]
        briefing = state["briefing"]

        # 1. Load Business Memory via PostgreSQL with RLS
        try:
            async with tenant_connection(pg_pool, tenant_id) as conn:
                bm_data = await _load_business_memory(conn, tenant_id)
        except (BrandIdentityMissingError, ContextLoadError):
            raise
        except (OSError, asyncpg.PostgresConnectionError, asyncpg.InterfaceError) as exc:
            logger.error(
                "Failed to load Business Memory: tenant_id=%s, error=%s",
                tenant_id,
                str(exc),
            )
            raise ContextLoadError("business_memory", tenant_id, str(exc)) from exc

        # 2. Validate tom_de_voz precondition
        tom_de_voz = bm_data.get("tom_de_voz")
        if not tom_de_voz or (isinstance(tom_de_voz, str) and not tom_de_voz.strip()):
            logger.warning(
                "Brand identity missing tom_de_voz: tenant_id=%s", tenant_id
            )
            raise BrandIdentityMissingError(tenant_id)

        # 3. Search Knowledge Hub via Qdrant
        tema = briefing.get("tema", "")
        procedimento = briefing.get("procedimento", "")
        query_text = f"{tema} {procedimento}".strip()

        try:
            knowledge_chunks = await _search_knowledge_hub(
                qdrant_client=qdrant_client,
                embed_fn=embed_fn,
                tenant_id=tenant_id,
                query_text=query_text,
                collection_name=collection_name,
                top_k=5,
            )
        except Exception as exc:
            logger.warning(
                "Knowledge Hub search failed (proceeding without context): "
                "tenant_id=%s, error=%s",
                tenant_id,
                str(exc),
            )
            # Graceful degradation: continue without Knowledge Hub context
            knowledge_chunks = []

        # 4. If refinement: load original execution from Agent Memory
        if state.get("is_refinement") and state.get("original_execution_id"):
            try:
                async with tenant_connection(pg_pool, tenant_id) as conn:
                    original_ctx = await _load_original_execution(
                        conn, state["original_execution_id"]
                    )
            except (OSError, asyncpg.PostgresConnectionError, asyncpg.InterfaceError) as exc:
                logger.error(
                    "Failed to load original execution for refinement: "
                    "tenant_id=%s, execution_id=%s, error=%s",
                    tenant_id,
                    state.get("original_execution_id"),
                    str(exc),
                )
                raise ContextLoadError("agent_memory", tenant_id, str(exc)) from exc

            # Merge original context into knowledge_chunks for prompt resolution
            if original_ctx:
                knowledge_chunks.append({
                    "content": (
                        f"[Previous generation context] "
                        f"{original_ctx.get('original_content', '')}"
                    ),
                    "score": 1.0,
                    "category": "refinement_context",
                    "metadata": {
                        "original_version": original_ctx.get("original_version"),
                        "source": "agent_memory",
                    },
                })

        # 5. Apply publicoAlvoOverride if present
        publico_alvo_override = briefing.get("publico_alvo_override")
        publico_alvo = (
            publico_alvo_override
            if publico_alvo_override
            else (bm_data.get("publico_alvo") or "")
        )

        # Build brand_identity dict
        brand_identity = {
            "tom_de_voz": bm_data["tom_de_voz"],
            "valores": bm_data.get("valores"),
            "paleta_cores": bm_data.get("paleta_cores"),
            "nome_clinica": bm_data.get("nome_clinica", ""),
        }

        return {
            "brand_identity": brand_identity,
            "publico_alvo": publico_alvo,
            "especialidades": bm_data.get("especialidades", []),
            "diferenciais": bm_data.get("diferenciais", []),
            "knowledge_chunks": knowledge_chunks,
        }

    return load_context


# --- Backward-compatible stub for testing ---
# Standalone load_context stub used by graph construction when no deps provided.


async def load_context(state: ContentAgentState) -> dict[str, Any]:
    """Standalone load_context stub (no dependencies injected).

    Used when build_content_agent_graph is called without dependencies,
    or for testing graph structure in isolation.
    """
    return {}


# --- Stub Node Implementations ---
# Stubs for remaining nodes. Real logic will be implemented in tasks 2.3-2.6.


async def resolve_prompt(state: ContentAgentState) -> dict[str, Any]:
    """Resolve prompt templates from Prompt Registry (stub without pg_pool).

    This stub is kept for backward compatibility with existing tests.
    The real implementation is provided by `make_resolve_prompt(pg_pool)`.
    """
    return {}


def _substitute_template_variables(
    template: str, state: ContentAgentState,
) -> str:
    """Replace {{variable_name}} placeholders in a prompt template.

    Supported variables:
        - nome_clinica: from state.brand_identity['nome_clinica']
        - tom_de_voz: from state.brand_identity['tom_de_voz']
        - especialidades: from state.especialidades (joined with comma)
        - publico_alvo: from state.publico_alvo
        - tema: from state.briefing['tema']
        - procedimento: from state.briefing.get('procedimento', 'Não especificado')
        - redes_sociais: from state.briefing['redes_sociais'] (joined with comma)
        - knowledge_context: from state.knowledge_chunks (joined chunk contents)
        - idioma: from state.briefing.get('idioma', 'pt-BR')

    Args:
        template: The prompt template string with {{variable}} placeholders.
        state: The current workflow state.

    Returns:
        The template with all recognized variables substituted.
    """
    brand_identity = state.get("brand_identity") or {}
    briefing = state.get("briefing") or {}
    especialidades = state.get("especialidades") or []
    knowledge_chunks = state.get("knowledge_chunks") or []

    # Build knowledge context from chunks
    knowledge_context_parts: list[str] = []
    for chunk in knowledge_chunks:
        if isinstance(chunk, dict) and "content" in chunk:
            knowledge_context_parts.append(chunk["content"])
        elif isinstance(chunk, str):
            knowledge_context_parts.append(chunk)
    knowledge_context = (
        "\n\n".join(knowledge_context_parts)
        if knowledge_context_parts
        else "Nenhum contexto adicional disponível."
    )

    variables: dict[str, str] = {
        "nome_clinica": brand_identity.get("nome_clinica", ""),
        "tom_de_voz": brand_identity.get("tom_de_voz", ""),
        "especialidades": ", ".join(especialidades) if especialidades else "",
        "publico_alvo": state.get("publico_alvo", ""),
        "tema": briefing.get("tema", ""),
        "procedimento": briefing.get("procedimento", "Não especificado"),
        "redes_sociais": ", ".join(briefing.get("redes_sociais", [])),
        "knowledge_context": knowledge_context,
        "idioma": briefing.get("idioma", "pt-BR"),
    }

    def _replacer(match: re.Match) -> str:
        var_name = match.group(1).strip()
        return variables.get(var_name, match.group(0))

    return re.sub(r"\{\{(\s*\w+\s*)\}\}", _replacer, template)


def make_resolve_prompt(
    pg_pool: asyncpg.Pool,
) -> Callable[[ContentAgentState], Any]:
    """Factory that creates the resolve_prompt node with pg_pool dependency.

    The returned async function queries the Prompt Registry (prompts +
    prompt_versions tables) for agent_type='content', fetches the ACTIVE
    system and task prompts, substitutes template variables using state
    data, and returns the resolved prompts.

    Args:
        pg_pool: asyncpg connection pool for database access.

    Returns:
        An async node function compatible with LangGraph's StateGraph.
    """

    async def _resolve_prompt(state: ContentAgentState) -> dict[str, Any]:
        """Resolve prompt templates from Prompt Registry.

        1. Query prompts + prompt_versions for agent_type='content'
        2. Fetch ACTIVE system prompt (function='system') and task prompt (function='task')
        3. Substitute template variables with state data
        4. Return system_prompt + task_prompt

        Raises:
            RuntimeError: If no active system or task prompt is found.
        """
        tenant_id = state.get("tenant_id", "")

        logger.info(
            "Resolving prompts for agent_type='content', tenant=%s",
            tenant_id,
        )

        query = """
            SELECT p."function", pv.content
            FROM prompts p
            JOIN prompt_versions pv ON pv.prompt_id = p.id
            WHERE p.agent_type = $1
              AND pv.is_active = TRUE
            ORDER BY p."function"
        """

        async with tenant_connection(pg_pool, tenant_id) as conn:
            rows = await conn.fetch(query, "content")

        # Map function -> content
        prompt_map: dict[str, str] = {}
        for row in rows:
            prompt_map[row["function"]] = row["content"]

        system_template = prompt_map.get("system")
        task_template = prompt_map.get("task")

        if not system_template:
            raise RuntimeError(
                "No active system prompt found for agent_type='content' "
                "in Prompt Registry"
            )
        if not task_template:
            raise RuntimeError(
                "No active task prompt found for agent_type='content' "
                "in Prompt Registry"
            )

        # Substitute template variables
        system_prompt = _substitute_template_variables(system_template, state)
        task_prompt = _substitute_template_variables(task_template, state)

        logger.info(
            "Prompts resolved successfully: system=%d chars, task=%d chars",
            len(system_prompt),
            len(task_prompt),
        )

        return {
            "system_prompt": system_prompt,
            "task_prompt": task_prompt,
        }

    return _resolve_prompt


async def generate_content(state: ContentAgentState) -> dict[str, Any]:
    """Generate content via LLM using Model Registry.

    Stub implementation - passes state through unchanged.
    Used when build_content_agent_graph is called without an llm_client,
    or for testing graph structure in isolation.
    """
    return {}


# --- generate_content node implementation ---


def _truncate_legenda(text: str, rede: str) -> str:
    """Truncate a legenda to the character limit of the given social network.

    Args:
        text: The legenda text.
        rede: Social network name (instagram, facebook, tiktok).

    Returns:
        Truncated text if it exceeds the limit, otherwise unchanged.
    """
    limit = CHAR_LIMITS.get(rede)
    if limit and len(text) > limit:
        return text[:limit]
    return text


def _validate_hashtags(hashtags: list[str]) -> list[str]:
    """Ensure hashtag list is between MIN_HASHTAGS and MAX_HASHTAGS.

    If fewer than MIN_HASHTAGS, pads with generic hashtags.
    If more than MAX_HASHTAGS, truncates to MAX_HASHTAGS.

    Args:
        hashtags: List of hashtag strings.

    Returns:
        Validated list of hashtags within bounds.
    """
    if len(hashtags) > MAX_HASHTAGS:
        return hashtags[:MAX_HASHTAGS]
    if len(hashtags) < MIN_HASHTAGS:
        # Pad with generic hashtags to meet minimum
        generic = [
            "#beleza", "#estetica", "#cuidados", "#saude",
            "#bemestar", "#clinica", "#tratamento", "#pele",
            "#autocuidado", "#procedimento",
        ]
        while len(hashtags) < MIN_HASHTAGS:
            for tag in generic:
                if tag not in hashtags:
                    hashtags.append(tag)
                    if len(hashtags) >= MIN_HASHTAGS:
                        break
    return hashtags


def _parse_llm_response(
    content: str,
    redes_sociais: list[str],
) -> dict[str, Any]:
    """Parse the LLM response JSON into structured content.

    Expected JSON structure:
    {
        "legendas": {"instagram": "...", "facebook": "...", "tiktok": "..."},
        "hashtags": ["#tag1", "#tag2", ...],
        "sugestoes_visuais": {
            "instagram": {"formato": "1:1", "descricao": "..."},
            ...
        }
    }

    If parsing fails, attempts best-effort extraction.

    Args:
        content: Raw LLM response text (expected to be JSON).
        redes_sociais: List of social networks to extract content for.

    Returns:
        Dict with keys: legendas, hashtags, sugestoes_visuais.

    Raises:
        ValueError: If the response cannot be parsed at all.
    """
    # Try to extract JSON from the response (LLM may wrap in markdown code blocks)
    json_content = content.strip()
    if json_content.startswith("```"):
        # Remove markdown code block wrapping
        lines = json_content.split("\n")
        # Remove first line (```json) and last line (```)
        lines = [l for l in lines if not l.strip().startswith("```")]
        json_content = "\n".join(lines)

    try:
        parsed = json.loads(json_content)
    except json.JSONDecodeError:
        # Fallback: try to find JSON object within the text
        # Look for first '{' and last '}' to extract embedded JSON
        first_brace = json_content.find("{")
        last_brace = json_content.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            try:
                parsed = json.loads(json_content[first_brace:last_brace + 1])
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Failed to parse LLM response as JSON: {str(exc)[:200]}"
                ) from exc
        else:
            raise ValueError(
                f"Failed to parse LLM response as JSON: no JSON object found in response"
            )

    # Extract legendas
    legendas_raw = parsed.get("legendas", {})
    legendas: dict[str, str] = {}
    for rede in redes_sociais:
        text = legendas_raw.get(rede, "")
        legendas[rede] = _truncate_legenda(str(text), rede)

    # Extract and validate hashtags
    hashtags_raw = parsed.get("hashtags", [])
    if isinstance(hashtags_raw, list):
        hashtags = [str(h) for h in hashtags_raw]
    else:
        hashtags = []
    hashtags = _validate_hashtags(hashtags)

    # Extract sugestoes visuais
    sugestoes_raw = parsed.get("sugestoes_visuais", {})
    sugestoes_visuais: dict[str, dict] = {}
    for rede in redes_sociais:
        sv = sugestoes_raw.get(rede, {})
        if isinstance(sv, dict):
            descricao = str(sv.get("descricao", ""))[:200]
            formato = str(sv.get("formato", ""))
            sugestoes_visuais[rede] = {
                "formato": formato,
                "descricao": descricao,
            }
        else:
            sugestoes_visuais[rede] = {"formato": "", "descricao": ""}

    return {
        "legendas": legendas,
        "hashtags": hashtags,
        "sugestoes_visuais": sugestoes_visuais,
    }


async def _get_model_config(
    conn: asyncpg.Connection,
    agent_type: str = "content",
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Query ai_models and agent_configs for primary and fallback models.

    Args:
        conn: Database connection with tenant RLS set.
        agent_type: The agent type to find models for.

    Returns:
        Tuple of (primary_model_config, fallback_model_config).
        Each config dict has: model_name, temperature, max_tokens.
        Returns None for missing configs.
    """
    row = await conn.fetchrow(
        """
        SELECT ac.model_id, ac.fallback_model_id, ac.temperature, ac.max_tokens
        FROM agent_configs ac
        WHERE ac.agent_type = $1
          AND ac.status = 'active'
        LIMIT 1
        """,
        agent_type,
    )

    if row is None:
        return None, None

    temperature = float(row["temperature"]) if row["temperature"] else 0.7
    max_tokens = int(row["max_tokens"]) if row["max_tokens"] else 4096

    # Resolve primary model name
    primary = None
    if row["model_id"]:
        model_row = await conn.fetchrow(
            "SELECT name FROM ai_models WHERE id = $1",
            row["model_id"],
        )
        if model_row:
            primary = {
                "model_name": model_row["name"],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }

    # Resolve fallback model name
    fallback = None
    if row["fallback_model_id"]:
        fallback_row = await conn.fetchrow(
            "SELECT name FROM ai_models WHERE id = $1",
            row["fallback_model_id"],
        )
        if fallback_row:
            fallback = {
                "model_name": fallback_row["name"],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }

    return primary, fallback


def make_generate_content(
    pg_pool: asyncpg.Pool,
    llm_client: LLMClient,
) -> Callable[[ContentAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the generate_content node with injected dependencies.

    Uses closure pattern to inject pg_pool and llm_client
    into the node function.

    Args:
        pg_pool: asyncpg connection pool for querying Model Registry.
        llm_client: Async callable conforming to LLMClient interface.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _generate_content(state: ContentAgentState) -> dict[str, Any]:
        """Generate content via LLM using Model Registry.

        Steps:
        1. Query ai_models + agent_configs for primary & fallback model
        2. Call LLM with system_prompt + task_prompt using primary model
        3. If primary fails, try fallback model
        4. Parse LLM response (legendas, hashtags, sugestoes_visuais)
        5. Validate character limits (truncate if exceeded)
        6. Validate hashtag count (5-15)
        7. Track token usage and model_id in state

        Returns:
            Dict with: legendas, hashtags, sugestoes_visuais, model_id,
            used_fallback, tokens_input, tokens_output.

        Raises:
            LLMUnavailableError: If both primary and fallback models fail (HTTP 503).
            ValueError: If LLM response cannot be parsed.
        """
        tenant_id = state["tenant_id"]
        system_prompt = state.get("system_prompt", "")
        task_prompt = state.get("task_prompt", "")
        redes_sociais = state.get("briefing", {}).get("redes_sociais", [])

        # 1. Get model configuration from Model Registry
        async with tenant_connection(pg_pool, tenant_id) as conn:
            primary_config, fallback_config = await _get_model_config(conn)

        if not primary_config:
            raise LLMUnavailableError(
                "No model configured for agent_type='content' in Model Registry"
            )

        # 2. Try primary model
        used_fallback = False
        primary_error = ""

        try:
            llm_response = await llm_client(
                system_prompt,
                task_prompt,
                primary_config["model_name"],
                primary_config["temperature"],
                primary_config["max_tokens"],
            )
        except Exception as exc:
            primary_error = str(exc)
            logger.warning(
                "Primary model '%s' failed: %s. Attempting fallback.",
                primary_config["model_name"],
                primary_error,
            )
            llm_response = None

        # 3. If primary failed, try fallback
        if llm_response is None:
            if not fallback_config:
                raise LLMUnavailableError(primary_error)

            try:
                llm_response = await llm_client(
                    system_prompt,
                    task_prompt,
                    fallback_config["model_name"],
                    fallback_config["temperature"],
                    fallback_config["max_tokens"],
                )
                used_fallback = True
            except Exception as exc:
                fallback_error = str(exc)
                logger.error(
                    "Fallback model '%s' also failed: %s",
                    fallback_config["model_name"],
                    fallback_error,
                )
                raise LLMUnavailableError(primary_error, fallback_error) from exc

        # 4. Parse LLM response
        parsed = _parse_llm_response(llm_response.content, redes_sociais)

        # 5 & 6. Character limits and hashtag validation already done in _parse_llm_response

        # 7. Track token usage and model_id
        # Accumulate tokens (in case of retries from guardrail loop)
        existing_tokens_input = state.get("tokens_input", 0)
        existing_tokens_output = state.get("tokens_output", 0)

        return {
            "legendas": parsed["legendas"],
            "hashtags": parsed["hashtags"],
            "sugestoes_visuais": parsed["sugestoes_visuais"],
            "model_id": llm_response.model_id,
            "used_fallback": used_fallback,
            "tokens_input": existing_tokens_input + llm_response.input_tokens,
            "tokens_output": existing_tokens_output + llm_response.output_tokens,
        }

    return _generate_content


async def validate_guardrails(state: ContentAgentState) -> dict[str, Any]:
    """Validate generated content against regulatory guardrails (stub).

    This stub is kept for backward compatibility with existing tests
    that construct the graph without dependencies.
    The real implementation is provided by `make_validate_guardrails(pg_pool)`.
    """
    return {}


def _check_guardrail_against_text(
    text: str,
    rule: dict[str, Any],
) -> bool:
    """Check if a text violates a single guardrail rule.

    Checks both regex pattern and keyword matches (case-insensitive).

    Args:
        text: The text to validate.
        rule: The guardrail rule JSONB containing 'pattern' and/or 'keywords'.

    Returns:
        True if a violation is detected, False otherwise.
    """
    text_lower = text.lower()

    # Check regex pattern
    pattern = rule.get("pattern")
    if pattern:
        try:
            if re.search(pattern, text, re.IGNORECASE):
                return True
        except re.error:
            logger.warning("Invalid regex pattern in guardrail rule: %s", pattern)

    # Check keywords
    keywords = rule.get("keywords") or []
    for keyword in keywords:
        if keyword.lower() in text_lower:
            return True

    return False


def make_validate_guardrails(
    pg_pool: asyncpg.Pool,
) -> Callable[[ContentAgentState], Any]:
    """Factory that creates the validate_guardrails node with pg_pool dependency.

    The returned async function queries the guardrails table for active
    system guardrails (tenant_id IS NULL) and tenant-specific guardrails,
    then validates each legenda against each guardrail's pattern and keywords.

    Args:
        pg_pool: asyncpg connection pool for database access.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _validate_guardrails(state: ContentAgentState) -> dict[str, Any]:
        """Validate generated legendas against regulatory guardrails.

        Steps:
        1. Query guardrails table for active system + tenant-specific rules
        2. For each legenda, check regex pattern and keyword matches
        3. If violations found:
           - Increment guardrail_attempt
           - Record violation names in guardrail_violations
           - If attempt >= 3: set blocked_reason
        4. If no violations: clear guardrail_violations

        Returns:
            Dict with updated guardrail_attempt, guardrail_violations,
            and optionally blocked_reason.
        """
        tenant_id = state["tenant_id"]
        legendas = state.get("legendas") or {}
        current_attempt = state.get("guardrail_attempt", 0)

        # 1. Query active guardrails (system + tenant)
        query = """
            SELECT name, rule
            FROM guardrails
            WHERE is_active = TRUE
              AND (tenant_id IS NULL OR tenant_id = $1)
        """

        try:
            async with tenant_connection(pg_pool, tenant_id) as conn:
                rows = await conn.fetch(query, tenant_id)
        except Exception as exc:
            logger.error(
                "Failed to load guardrails: tenant_id=%s, error=%s",
                tenant_id,
                str(exc),
            )
            # If we can't load guardrails, pass through (fail-open for availability)
            return {"guardrail_violations": []}

        # 2. Build guardrail list from query results
        guardrails_list: list[dict[str, Any]] = []
        for row in rows:
            rule_data = row["rule"]
            # rule is JSONB, asyncpg returns it as dict or str
            if isinstance(rule_data, str):
                try:
                    rule_data = json.loads(rule_data)
                except json.JSONDecodeError:
                    logger.warning(
                        "Invalid JSON in guardrail rule: name=%s", row["name"]
                    )
                    continue
            guardrails_list.append({
                "name": row["name"],
                "rule": rule_data,
            })

        # 3. Check each legenda against each guardrail
        violations: list[str] = []
        for _rede, legenda_text in legendas.items():
            if not legenda_text:
                continue
            for guardrail in guardrails_list:
                if _check_guardrail_against_text(legenda_text, guardrail["rule"]):
                    violation_name = guardrail["name"]
                    if violation_name not in violations:
                        violations.append(violation_name)

        # 4. Determine outcome
        if not violations:
            # No violations - clear violations list so conditional edge routes
            # to persist_and_output
            logger.info(
                "Guardrail validation passed: tenant_id=%s, execution_id=%s",
                tenant_id,
                state.get("execution_id", ""),
            )
            return {"guardrail_violations": []}

        # Violations found - increment attempt
        new_attempt = current_attempt + 1

        logger.warning(
            "Guardrail violations detected: tenant_id=%s, execution_id=%s, "
            "attempt=%d, violations=%s",
            tenant_id,
            state.get("execution_id", ""),
            new_attempt,
            violations,
        )

        result: dict[str, Any] = {
            "guardrail_attempt": new_attempt,
            "guardrail_violations": violations,
        }

        # If attempt >= 3, set blocked_reason (conditional edge will route to END)
        if new_attempt >= 3:
            result["blocked_reason"] = (
                f"Conteúdo bloqueado após {new_attempt} tentativas de regeneração. "
                f"Violações persistentes: {', '.join(violations)}. "
                f"O conteúdo solicitado não pode ser gerado em conformidade "
                f"com as políticas vigentes."
            )
            logger.error(
                "Content blocked after %d attempts: tenant_id=%s, "
                "execution_id=%s, violations=%s",
                new_attempt,
                tenant_id,
                state.get("execution_id", ""),
                violations,
            )

        return result

    return _validate_guardrails


async def persist_and_output(state: ContentAgentState) -> dict[str, Any]:
    """Persist results to Agent Memory and prepare final output.

    Stub implementation - passes state through unchanged.
    Used when build_content_agent_graph is called without dependencies,
    or for testing graph structure in isolation.
    The real implementation is provided by `make_persist_and_output(pg_pool)`.
    """
    return {}


def _compute_duration_ms(steps: list[dict]) -> int:
    """Compute total execution duration from step timestamps.

    Sums up duration_ms from each step entry. If no steps have duration,
    returns 0.

    Args:
        steps: List of step dicts, each optionally containing 'duration_ms'.

    Returns:
        Total duration in milliseconds.
    """
    total = 0
    for step in steps:
        duration = step.get("duration_ms", 0)
        if isinstance(duration, (int, float)):
            total += int(duration)
    return total


def _serialize_output(state: ContentAgentState) -> str:
    """Serialize generated content fields into a JSON string for the output field.

    Includes: legendas, hashtags, sugestoes_visuais, model_id, used_fallback,
    tokens (input + output).

    Args:
        state: Current workflow state.

    Returns:
        JSON string of the serialized output.
    """
    output_data = {
        "legendas": state.get("legendas") or {},
        "hashtags": state.get("hashtags") or [],
        "sugestoes_visuais": state.get("sugestoes_visuais") or {},
        "model_id": state.get("model_id", ""),
        "used_fallback": state.get("used_fallback", False),
        "tokens": {
            "input": state.get("tokens_input", 0),
            "output": state.get("tokens_output", 0),
        },
    }
    return json.dumps(output_data, ensure_ascii=False)


def make_persist_and_output(
    pg_pool: asyncpg.Pool,
) -> Callable[[ContentAgentState], Awaitable[dict[str, Any]]]:
    """Factory that creates the persist_and_output node with pg_pool dependency.

    The returned async function:
    1. Serializes generated content into the state's output field
    2. Persists to Agent Memory (agent_memory_short) table
    3. Records an observability log entry in workflow_executions
    4. If persistence fails: logs warning but still returns the output (graceful degradation)

    Args:
        pg_pool: asyncpg connection pool for database access.

    Returns:
        An async node function compatible with LangGraph StateGraph.
    """

    async def _persist_and_output(state: ContentAgentState) -> dict[str, Any]:
        """Persist results to Agent Memory and prepare final output.

        Steps:
        1. Serialize output (legendas, hashtags, sugestoes_visuais, model_id, tokens)
        2. Persist to agent_memory_short: agent_id='content', tenant_id, role='assistant',
           content=serialized output, metadata={execution_id, version, trace_id}
        3. Record observability in workflow_executions: trace_id, execution_id,
           tenant_id, user_id, duration_ms, tokens, model_id, guardrail_violations, status
        4. If persistence fails → log warning, still return output

        Returns:
            Dict with: output (serialized JSON string).
        """
        tenant_id = state.get("tenant_id", "")
        execution_id = state.get("execution_id", "")
        trace_id = state.get("trace_id", "")
        user_id = state.get("user_id", "")
        version = state.get("version", 1)

        # 1. Serialize output
        output_json = _serialize_output(state)

        # Compute duration from steps
        steps = state.get("steps") or []
        duration_ms = _compute_duration_ms(steps)

        # Prepare observability fields
        tokens_input = state.get("tokens_input", 0)
        tokens_output = state.get("tokens_output", 0)
        model_id = state.get("model_id", "")
        guardrail_violations = state.get("guardrail_violations") or []
        status = "success"

        # 2. Persist to Agent Memory (short-term)
        try:
            async with tenant_connection(pg_pool, tenant_id) as conn:
                # Lookup agent_config_id for agent_type='content'
                agent_config_row = await conn.fetchrow(
                    "SELECT id FROM agent_configs WHERE agent_type = 'content' AND status = 'active' LIMIT 1",
                )
                if agent_config_row:
                    await conn.execute(
                        """
                        INSERT INTO agent_memory_short
                            (agent_id, tenant_id, role, content, metadata)
                        VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
                        """,
                        str(agent_config_row["id"]),
                        tenant_id,
                        "assistant",
                        output_json,
                        json.dumps({
                            "execution_id": execution_id,
                            "version": version,
                            "trace_id": trace_id,
                        }),
                    )
                else:
                    logger.warning(
                        "No active agent_config found for content agent, "
                        "skipping agent_memory_short persistence"
                    )
        except Exception as exc:
            # Requirement 6.5: If persistence fails, return content normally + warning log
            logger.warning(
                "Failed to persist to Agent Memory (graceful degradation): "
                "tenant_id=%s, execution_id=%s, trace_id=%s, error=%s",
                tenant_id,
                execution_id,
                trace_id,
                str(exc),
            )

        # 3. Record observability log entry
        try:
            async with tenant_connection(pg_pool, tenant_id) as conn:
                await conn.execute(
                    """
                    INSERT INTO workflow_executions
                        (tenant_id, workflow_id, agent_id, user_id, status,
                         input, output, tokens_input, tokens_output,
                         duration_ms, model_id, guardrail_violations, metadata)
                    VALUES (
                        $1::uuid, $2, $3::uuid, $4::uuid, $5,
                        $6, $7, $8, $9,
                        $10, $11, $12, $13::jsonb
                    )
                    """,
                    tenant_id,
                    "content_agent",
                    execution_id,
                    user_id,
                    status,
                    json.dumps(state.get("briefing") or {}),
                    output_json,
                    tokens_input,
                    tokens_output,
                    duration_ms,
                    model_id,
                    guardrail_violations,
                    json.dumps({
                        "trace_id": trace_id,
                        "execution_id": execution_id,
                        "version": version,
                        "guardrail_violation_count": len(guardrail_violations),
                    }),
                )
        except Exception as exc:
            # Observability persistence failure is also non-fatal
            logger.warning(
                "Failed to persist observability log (graceful degradation): "
                "tenant_id=%s, execution_id=%s, trace_id=%s, error=%s",
                tenant_id,
                execution_id,
                trace_id,
                str(exc),
            )

        logger.info(
            "persist_and_output completed: execution_id=%s, trace_id=%s, "
            "duration_ms=%d, tokens_in=%d, tokens_out=%d, status=%s",
            execution_id,
            trace_id,
            duration_ms,
            tokens_input,
            tokens_output,
            status,
        )

        # 4. Return output field in state
        return {"output": output_json}

    return _persist_and_output


# --- Conditional Edge ---


def should_retry_or_output(state: ContentAgentState) -> str:
    """Decide the next node after validate_guardrails.

    Returns:
        "persist_and_output" - if no guardrail violations detected
        "generate_content" - if violation detected and attempts < 3 (retry)
        "__end__" - if violation detected and attempts >= 3 (blocked)
    """
    violations = state.get("guardrail_violations") or []
    if len(violations) == 0:
        return "persist_and_output"
    if state.get("guardrail_attempt", 0) < 3:
        return "generate_content"
    return "__end__"


# --- Graph Construction ---


def build_content_agent_graph(
    pg_pool: asyncpg.Pool | None = None,
    qdrant_client: AsyncQdrantClient | None = None,
    embed_fn: Callable[[str], Any] | None = None,
    collection_name: str = "knowledge_hub",
    llm_client: LLMClient | None = None,
) -> Any:
    """Build and compile the Content Agent StateGraph.

    Constructs a DAG with 5 nodes and the following edges:
        load_context -> resolve_prompt -> generate_content -> validate_guardrails
        validate_guardrails -> (conditional) -> persist_and_output | generate_content | END
        persist_and_output -> END

    Args:
        pg_pool: asyncpg connection pool (required for load_context, resolve_prompt, generate_content).
        qdrant_client: Async Qdrant client (required for load_context).
        embed_fn: Embedding function (required for load_context).
        collection_name: Qdrant collection name.
        llm_client: Async LLM client callable (required for generate_content).

    Returns:
        A compiled LangGraph StateGraph ready for execution.
    """
    graph = StateGraph(ContentAgentState)

    # Build load_context node with dependencies if provided
    if pg_pool and qdrant_client and embed_fn:
        load_context_node = make_load_context(
            pg_pool=pg_pool,
            qdrant_client=qdrant_client,
            embed_fn=embed_fn,
            collection_name=collection_name,
        )
    else:
        # Fallback stub for testing graph structure without dependencies
        async def load_context_node(state: ContentAgentState) -> dict[str, Any]:
            return {}

    # Build resolve_prompt node with pg_pool if provided
    resolve_prompt_node = (
        make_resolve_prompt(pg_pool) if pg_pool else resolve_prompt
    )

    # Build generate_content node with dependencies if provided
    if pg_pool and llm_client:
        generate_content_node = make_generate_content(pg_pool, llm_client)
    else:
        generate_content_node = generate_content

    # Build validate_guardrails node with pg_pool if provided
    validate_guardrails_node = (
        make_validate_guardrails(pg_pool) if pg_pool else validate_guardrails
    )

    # Build persist_and_output node with pg_pool if provided
    persist_and_output_node = (
        make_persist_and_output(pg_pool) if pg_pool else persist_and_output
    )

    # Add nodes
    graph.add_node("load_context", load_context_node)
    graph.add_node("resolve_prompt", resolve_prompt_node)
    graph.add_node("generate_content", generate_content_node)
    graph.add_node("validate_guardrails", validate_guardrails_node)
    graph.add_node("persist_and_output", persist_and_output_node)

    # Set entry point
    graph.set_entry_point("load_context")

    # Add edges
    graph.add_edge("load_context", "resolve_prompt")
    graph.add_edge("resolve_prompt", "generate_content")
    graph.add_edge("generate_content", "validate_guardrails")

    # Conditional edge after guardrail validation
    graph.add_conditional_edges(
        "validate_guardrails",
        should_retry_or_output,
        {
            "persist_and_output": "persist_and_output",
            "generate_content": "generate_content",
            "__end__": END,
        },
    )

    # Terminal edge
    graph.add_edge("persist_and_output", END)

    return graph.compile()
