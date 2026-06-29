"""State Manager: manages workflow execution state with Redis and PostgreSQL."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional, Protocol

import redis.asyncio as redis

from .exceptions import PersistenceError, RedisUnavailableError, StateManagerError

logger = logging.getLogger(__name__)


class StateManager(Protocol):
    """Gerencia estado de workflows com isolamento multi-tenant.

    Estado em voo armazenado no Redis com TTL (namespace: tenant:{id}:exec:{exec_id}).
    Estado final persistido no PostgreSQL (tabela workflow_executions).
    Isolamento por tenant_id em todas as operações.
    """

    async def create_state(
        self,
        execution_id: str,
        tenant_id: str,
        workflow_id: str,
        initial_state: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Cria estado inicial no Redis com TTL configurável."""
        ...

    async def get_state(
        self,
        execution_id: str,
        tenant_id: str,
        *,
        trace_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Recupera estado do Redis. Retorna None se não encontrado."""
        ...

    async def update_state(
        self,
        execution_id: str,
        tenant_id: str,
        state_update: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Atualiza estado no Redis de forma atômica (MULTI/EXEC)."""
        ...

    async def persist_final_state(
        self,
        execution_id: str,
        tenant_id: str,
        final_state: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Persiste estado final no PostgreSQL."""
        ...

    async def get_conversation_history(
        self,
        conversation_id: str,
        tenant_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Recupera histórico de conversação."""
        ...


class RedisStateManager:
    """Implementação do StateManager usando Redis para estado em voo.

    Armazena estado de execuções de workflow no Redis com TTL configurável.
    Usa padrão de chave `tenant:{tenant_id}:exec:{execution_id}` para
    garantir isolamento multi-tenant.

    Error handling:
    - Redis errors are caught, logged with trace_id, and re-raised as
      RedisUnavailableError without affecting PostgreSQL state.
    - PostgreSQL errors in persist_final_state are retried with exponential
      backoff. After max retries, PersistenceError is raised.
    """

    def __init__(
        self,
        redis_client: redis.Redis,
        ttl: int = 3600,
        pg_pool: Any | None = None,
        max_retries: int = 3,
        base_backoff: float = 1.0,
    ) -> None:
        """Inicializa o RedisStateManager.

        Args:
            redis_client: Cliente Redis assíncrono.
            ttl: Tempo de vida da chave em segundos (padrão: 3600s = 1 hora).
            pg_pool: Pool de conexões asyncpg para PostgreSQL (opcional).
            max_retries: Número máximo de tentativas para persistência PostgreSQL.
            base_backoff: Tempo base em segundos para backoff exponencial (1s, 2s, 4s).
        """
        self._redis = redis_client
        self._ttl = ttl
        self._pg_pool = pg_pool
        self._max_retries = max_retries
        self._base_backoff = base_backoff

    def _build_key(self, tenant_id: str, execution_id: str) -> str:
        """Constrói a chave Redis com padrão de isolamento multi-tenant.

        Args:
            tenant_id: ID do tenant.
            execution_id: ID da execução.

        Returns:
            Chave no formato `tenant:{tenant_id}:exec:{execution_id}`.
        """
        return f"tenant:{tenant_id}:exec:{execution_id}"

    async def create_state(
        self,
        execution_id: str,
        tenant_id: str,
        workflow_id: str,
        initial_state: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Cria estado inicial no Redis com TTL configurável.

        O estado armazenado inclui os campos obrigatórios: user_input, tenant_id,
        agent_id, conversation_id, status='pending', created_at, além de quaisquer
        campos fornecidos em initial_state.

        Args:
            execution_id: ID da execução do workflow.
            tenant_id: ID do tenant para isolamento.
            workflow_id: ID do workflow sendo executado.
            initial_state: Estado inicial contendo campos obrigatórios.
            trace_id: ID de rastreamento para correlação distribuída.

        Raises:
            RedisUnavailableError: Se o Redis estiver indisponível.
        """
        key = self._build_key(tenant_id, execution_id)

        state = {
            **initial_state,
            "execution_id": execution_id,
            "tenant_id": tenant_id,
            "workflow_id": workflow_id,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        serialized = json.dumps(state, default=str)

        try:
            await self._redis.set(key, serialized, ex=self._ttl)
        except (
            ConnectionError,
            TimeoutError,
            redis.ConnectionError,
            redis.RedisError,
        ) as e:
            logger.error(
                "Redis unavailable during create_state",
                extra={
                    "trace_id": trace_id,
                    "execution_id": execution_id,
                    "tenant_id": tenant_id,
                    "error": str(e),
                },
            )
            raise RedisUnavailableError(
                f"Redis unavailable during create_state: {e}",
                trace_id=trace_id,
                execution_id=execution_id,
            ) from e

    async def get_state(
        self,
        execution_id: str,
        tenant_id: str,
        *,
        trace_id: str | None = None,
    ) -> dict[str, Any] | None:
        """Recupera estado do Redis.

        Retorna None se a chave não for encontrada, indicando que o estado
        em voo não está disponível (pode ter expirado ou nunca existido).

        Args:
            execution_id: ID da execução do workflow.
            tenant_id: ID do tenant para isolamento.
            trace_id: ID de rastreamento para correlação distribuída.

        Returns:
            Dicionário com o estado ou None se não encontrado.

        Raises:
            RedisUnavailableError: Se o Redis estiver indisponível.
        """
        key = self._build_key(tenant_id, execution_id)

        try:
            data = await self._redis.get(key)
        except (
            ConnectionError,
            TimeoutError,
            redis.ConnectionError,
            redis.RedisError,
        ) as e:
            logger.error(
                "Redis unavailable during get_state",
                extra={
                    "trace_id": trace_id,
                    "execution_id": execution_id,
                    "tenant_id": tenant_id,
                    "error": str(e),
                },
            )
            raise RedisUnavailableError(
                f"Redis unavailable during get_state: {e}",
                trace_id=trace_id,
                execution_id=execution_id,
            ) from e

        if data is None:
            return None

        return json.loads(data)

    async def update_state(
        self,
        execution_id: str,
        tenant_id: str,
        state_update: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Atualiza estado no Redis de forma atômica via MULTI/EXEC.

        Realiza um shallow merge: campos existentes são preservados,
        campos no state_update são adicionados ou atualizados.
        O TTL da chave é resetado após a atualização.

        A operação usa pipeline com WATCH para garantir atomicidade.
        Se houver conflito (outro writer modificou a chave), a operação
        é retentada automaticamente.

        Args:
            execution_id: ID da execução do workflow.
            tenant_id: ID do tenant para isolamento.
            state_update: Campos a serem adicionados/atualizados no estado.
            trace_id: ID de rastreamento para correlação distribuída.

        Raises:
            RedisUnavailableError: Se o Redis estiver indisponível.
        """
        key = self._build_key(tenant_id, execution_id)

        try:
            async with self._redis.pipeline(transaction=True) as pipe:
                while True:
                    try:
                        # Watch the key for changes
                        await pipe.watch(key)

                        # GET current state
                        current_data = await pipe.get(key)
                        if current_data is None:
                            await pipe.unwatch()
                            return

                        current_state = json.loads(current_data)

                        # Shallow merge: preserve existing fields, update with new ones
                        merged_state = {**current_state, **state_update}

                        serialized = json.dumps(merged_state, default=str)

                        # Start MULTI/EXEC transaction
                        pipe.multi()
                        pipe.set(key, serialized, ex=self._ttl)
                        await pipe.execute()
                        break

                    except redis.WatchError:
                        # Another client modified the key, retry
                        continue
        except (
            ConnectionError,
            TimeoutError,
            redis.ConnectionError,
            redis.RedisError,
        ) as e:
            # Don't catch WatchError here — it's handled inside the loop
            if isinstance(e, redis.WatchError):
                raise  # pragma: no cover
            logger.error(
                "Redis unavailable during update_state",
                extra={
                    "trace_id": trace_id,
                    "execution_id": execution_id,
                    "tenant_id": tenant_id,
                    "error": str(e),
                },
            )
            raise RedisUnavailableError(
                f"Redis unavailable during update_state: {e}",
                trace_id=trace_id,
                execution_id=execution_id,
            ) from e

    async def persist_final_state(
        self,
        execution_id: str,
        tenant_id: str,
        final_state: dict[str, Any],
        *,
        trace_id: str | None = None,
    ) -> None:
        """Persiste estado final no PostgreSQL com retry e backoff exponencial.

        Tenta gravar na tabela workflow_executions até max_retries vezes.
        Em cada falha intermediária, registra warning com execution_id e trace_id.
        Se todas as tentativas falharem, registra erro crítico e levanta PersistenceError.

        Args:
            execution_id: ID da execução do workflow.
            tenant_id: ID do tenant.
            final_state: Estado final contendo status, steps, tokens, etc.
            trace_id: ID de rastreamento para correlação distribuída.

        Raises:
            PersistenceError: Se todas as tentativas de persistência falharem.
        """
        last_error: Exception | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                await self._write_to_postgres(execution_id, tenant_id, final_state)
                return
            except Exception as e:
                last_error = e
                if attempt < self._max_retries:
                    backoff = self._base_backoff * (2 ** (attempt - 1))
                    logger.warning(
                        "PostgreSQL persistence failed, retrying",
                        extra={
                            "execution_id": execution_id,
                            "tenant_id": tenant_id,
                            "trace_id": trace_id,
                            "attempt": attempt,
                            "max_retries": self._max_retries,
                            "backoff_seconds": backoff,
                            "error": str(e),
                        },
                    )
                    await asyncio.sleep(backoff)

        # All retries exhausted
        logger.critical(
            "PostgreSQL persistence failed after all retries",
            extra={
                "execution_id": execution_id,
                "tenant_id": tenant_id,
                "trace_id": trace_id,
                "max_retries": self._max_retries,
                "error": str(last_error),
            },
        )
        raise PersistenceError(
            f"Failed to persist state after {self._max_retries} attempts: {last_error}",
            trace_id=trace_id,
            execution_id=execution_id,
        ) from last_error

    async def _write_to_postgres(
        self,
        execution_id: str,
        tenant_id: str,
        final_state: dict[str, Any],
    ) -> None:
        """Grava o estado final na tabela workflow_executions.

        Args:
            execution_id: ID da execução.
            tenant_id: ID do tenant.
            final_state: Estado final a ser persistido.

        Raises:
            Exception: Se a gravação falhar (será retentada pelo chamador).
        """
        if self._pg_pool is None:
            raise RuntimeError("PostgreSQL pool not configured")

        async with self._pg_pool.acquire() as conn:
            # Set RLS session variable for tenant isolation
            await conn.execute(
                "SELECT set_config('app.current_tenant', $1, true)",
                tenant_id,
            )

            await conn.execute(
                """
                INSERT INTO workflow_executions (
                    id, tenant_id, workflow_id, agent_id, conversation_id,
                    user_id, status, input, output, state_data, steps,
                    tokens_input, tokens_output, duration_ms, model_id,
                    used_fallback, error_message, blocked_reason,
                    guardrail_violations, metadata, completed_at
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11,
                    $12, $13, $14, $15,
                    $16, $17, $18,
                    $19, $20, $21
                )
                ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    output = EXCLUDED.output,
                    state_data = EXCLUDED.state_data,
                    steps = EXCLUDED.steps,
                    tokens_input = EXCLUDED.tokens_input,
                    tokens_output = EXCLUDED.tokens_output,
                    duration_ms = EXCLUDED.duration_ms,
                    error_message = EXCLUDED.error_message,
                    blocked_reason = EXCLUDED.blocked_reason,
                    guardrail_violations = EXCLUDED.guardrail_violations,
                    completed_at = EXCLUDED.completed_at,
                    updated_at = NOW()
                """,
                execution_id,
                tenant_id,
                final_state.get("workflow_id", ""),
                final_state.get("agent_id", ""),
                final_state.get("conversation_id"),
                final_state.get("user_id"),
                final_state.get("status", "completed"),
                final_state.get("user_input", ""),
                final_state.get("output", ""),
                json.dumps(final_state.get("state_data", {})),
                json.dumps(final_state.get("steps", [])),
                final_state.get("tokens_input", 0),
                final_state.get("tokens_output", 0),
                final_state.get("duration_ms"),
                final_state.get("model_id"),
                final_state.get("used_fallback", False),
                final_state.get("error_message"),
                final_state.get("blocked_reason"),
                final_state.get("guardrail_violations"),
                json.dumps(final_state.get("metadata", {})),
                final_state.get("completed_at", datetime.now(timezone.utc)),
            )

    async def get_conversation_history(
        self,
        conversation_id: str,
        tenant_id: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Recupera histórico de conversação.

        Placeholder - será implementado em task futura.
        """
        return []
