# LangGraph Orchestration Service

Microsserviço Python responsável pela execução de workflows de agentes baseados em grafos direcionados acíclicos (DAG) usando LangGraph.

## Arquitetura

Este serviço é parte da plataforma Beauty Growth AI e se comunica com o NestJS Gateway via gRPC/Protobuf.

```
NestJS Gateway  --gRPC-->  LangGraph Service
                              ├── Workflow Engine (execução de DAGs)
                              ├── State Manager (Redis + PostgreSQL)
                              └── Agent Router (resolução de workflows)
```

## Requisitos

- Python 3.11+
- Redis (estado em voo)
- PostgreSQL (persistência)

## Setup

```bash
# Instalar dependências
pip install -e .

# Instalar dependências de desenvolvimento
pip install -e ".[dev]"

# Executar testes
pytest

# Executar com cobertura
pytest --cov=src --cov-report=term-missing
```

## Estrutura

```
langgraph-service/
├── src/
│   ├── core/           # Componentes centrais
│   │   ├── workflow_engine.py   # Motor de execução de grafos
│   │   ├── state_manager.py    # Gerenciamento de estado
│   │   └── agent_router.py     # Resolução de workflows
│   ├── grpc/           # Servidor gRPC
│   │   └── server.py
│   └── models/         # Schemas Pydantic
│       └── schemas.py
├── tests/              # Testes (pytest + hypothesis)
├── pyproject.toml      # Configuração do projeto
└── Dockerfile          # Build multi-stage
```

## gRPC

O serviço expõe a porta `50051` com o `AgentOrchestrationService` definido em Protocol Buffers.

## Docker

```bash
# Build
docker build -t langgraph-service .

# Run
docker run -p 50051:50051 langgraph-service
```
