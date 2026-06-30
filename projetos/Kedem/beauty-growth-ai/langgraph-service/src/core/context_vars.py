"""Shared context variables for the LangGraph service.

This module defines ContextVars used to propagate request-scoped metadata
(tenant_id, trace_id, user_id) across the async call stack. These are set
by the gRPC TenantValidationInterceptor and consumed by core components
(StateManager, AgentRouter, tenant_context utility).

Keeping these in a leaf module avoids circular imports between grpc and core.
"""

from contextvars import ContextVar

# Populated by TenantValidationInterceptor from gRPC metadata x-tenant-id
tenant_id_var: ContextVar[str] = ContextVar("tenant_id_var", default="")

# Populated from gRPC metadata x-trace-id
trace_id_var: ContextVar[str] = ContextVar("trace_id_var", default="")

# Populated from gRPC metadata x-user-id
user_id_var: ContextVar[str] = ContextVar("user_id_var", default="")
