"""Shared test fixtures for the LangGraph Service test suite."""

import pytest


@pytest.fixture
def sample_tenant_id() -> str:
    """Provide a sample tenant ID for tests."""
    return "550e8400-e29b-41d4-a716-446655440000"


@pytest.fixture
def sample_execution_id() -> str:
    """Provide a sample execution ID for tests."""
    return "660e8400-e29b-41d4-a716-446655440001"


@pytest.fixture
def sample_agent_id() -> str:
    """Provide a sample agent ID for tests."""
    return "770e8400-e29b-41d4-a716-446655440002"


@pytest.fixture
def sample_initial_state(
    sample_tenant_id: str,
    sample_agent_id: str,
) -> dict:
    """Provide a sample initial workflow state."""
    return {
        "user_input": "Criar campanha de marketing para salão de beleza",
        "tenant_id": sample_tenant_id,
        "agent_id": sample_agent_id,
        "conversation_id": "",
        "messages": [],
        "intermediate_results": {},
    }
