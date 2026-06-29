"""Pydantic schemas for request/response validation and serialization."""

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class ExecutionStatus(str, Enum):
    """Status de uma execução de workflow."""

    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


class TokenUsageSchema(BaseModel):
    """Schema para contabilização de tokens."""

    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)


class StepResultSchema(BaseModel):
    """Schema para resultado de um passo do workflow."""

    node_id: str
    node_type: str
    output: str = ""
    duration_ms: int = Field(default=0, ge=0)
    status: ExecutionStatus = ExecutionStatus.PENDING
    tokens_used: TokenUsageSchema = Field(default_factory=TokenUsageSchema)
    error_message: str | None = None


class ExecutionOptionsSchema(BaseModel):
    """Schema para opções de execução."""

    max_steps: int = Field(default=50, gt=0)
    timeout_ms: int = Field(default=120_000, gt=0)
    enable_streaming: bool = False
    metadata: dict[str, str] = Field(default_factory=dict)


class ExecuteWorkflowRequestSchema(BaseModel):
    """Schema para request de execução de workflow."""

    agent_id: str
    tenant_id: str
    user_input: str = Field(min_length=1)
    user_id: str = ""
    tenant_context: dict[str, str] = Field(default_factory=dict)
    workflow_id: str = ""
    conversation_id: str = ""
    options: ExecutionOptionsSchema = Field(default_factory=ExecutionOptionsSchema)


class ExecuteWorkflowResponseSchema(BaseModel):
    """Schema para resposta de execução de workflow."""

    success: bool
    output: str = ""
    trace_id: str
    model_id: str = ""
    used_fallback: bool = False
    tokens_used: TokenUsageSchema = Field(default_factory=TokenUsageSchema)
    duration_ms: int = Field(default=0, ge=0)
    blocked_reason: str | None = None
    guardrail_violations: list[str] = Field(default_factory=list)
    steps: list[StepResultSchema] = Field(default_factory=list)


class HealthCheckResponseSchema(BaseModel):
    """Schema para resposta de health check."""

    status: str
    version: str
    details: dict[str, str] = Field(default_factory=dict)


class WorkflowExecutionRecord(BaseModel):
    """Schema para registro de execução persistido no PostgreSQL."""

    id: str
    tenant_id: str
    workflow_id: str
    agent_id: str
    conversation_id: str | None = None
    user_id: str | None = None
    status: ExecutionStatus = ExecutionStatus.PENDING
    input: str
    output: str | None = None
    state_data: dict = Field(default_factory=dict)
    steps: list[StepResultSchema] = Field(default_factory=list)
    tokens_input: int = Field(default=0, ge=0)
    tokens_output: int = Field(default=0, ge=0)
    duration_ms: int | None = None
    model_id: str | None = None
    used_fallback: bool = False
    error_message: str | None = None
    blocked_reason: str | None = None
    guardrail_violations: list[str] = Field(default_factory=list)
    metadata: dict = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    completed_at: datetime | None = None
