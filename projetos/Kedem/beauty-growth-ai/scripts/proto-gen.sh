#!/usr/bin/env bash
# Script de compilação Protobuf para Python e TypeScript
# Gera stubs gRPC a partir de proto/agent_orchestration.proto
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

PROTO_DIR="$PROJECT_ROOT/proto"
PROTO_FILE="$PROTO_DIR/agent_orchestration.proto"

# Diretórios de saída
PYTHON_OUT="$PROJECT_ROOT/langgraph-service/src/grpc/generated"
TS_OUT="$PROJECT_ROOT/src/modules/agent-execution/grpc/generated"

echo "==> Compilando Protobuf para Python e TypeScript..."

# Verificar se o arquivo proto existe
if [ ! -f "$PROTO_FILE" ]; then
  echo "ERRO: Arquivo proto não encontrado: $PROTO_FILE"
  exit 1
fi

# ----------------------------------------------------------
# Python: grpcio-tools
# ----------------------------------------------------------
echo "  -> Gerando stubs Python em $PYTHON_OUT"
mkdir -p "$PYTHON_OUT"

python -m grpc_tools.protoc \
  --proto_path="$PROTO_DIR" \
  --python_out="$PYTHON_OUT" \
  --grpc_python_out="$PYTHON_OUT" \
  --pyi_out="$PYTHON_OUT" \
  "$PROTO_FILE"

# Criar __init__.py se não existir
touch "$PYTHON_OUT/__init__.py"

echo "  -> Python stubs gerados com sucesso."

# ----------------------------------------------------------
# TypeScript: ts-proto via protoc + plugin
# ----------------------------------------------------------
echo "  -> Gerando stubs TypeScript em $TS_OUT"
mkdir -p "$TS_OUT"

# Localizar o plugin ts-proto
TS_PROTO_PLUGIN="$PROJECT_ROOT/node_modules/.bin/protoc-gen-ts_proto"

if [ ! -f "$TS_PROTO_PLUGIN" ]; then
  echo "ERRO: ts-proto plugin não encontrado. Execute 'npm install' primeiro."
  exit 1
fi

protoc \
  --proto_path="$PROTO_DIR" \
  --plugin="protoc-gen-ts_proto=$TS_PROTO_PLUGIN" \
  --ts_proto_out="$TS_OUT" \
  --ts_proto_opt=nestJs=true \
  --ts_proto_opt=addGrpcMetadata=true \
  --ts_proto_opt=outputServices=grpc-js \
  --ts_proto_opt=esModuleInterop=true \
  --ts_proto_opt=snakeToCamel=true \
  "$PROTO_FILE"

echo "  -> TypeScript stubs gerados com sucesso."

echo "==> Compilação Protobuf concluída!"
