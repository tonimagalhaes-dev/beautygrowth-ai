# Stage 1: Builder
FROM python:3.11-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc && \
    rm -rf /var/lib/apt/lists/*

# Copy project files
COPY pyproject.toml .
COPY src/ src/

# Copy proto file for stub generation
COPY proto/ proto/

# Install dependencies into a virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir .

# Generate gRPC stubs with the same protobuf version installed in the venv
RUN python -m grpc_tools.protoc \
    -I./proto \
    --python_out=./src/grpc/generated \
    --grpc_python_out=./src/grpc/generated \
    ./proto/agent_orchestration.proto && \
    sed -i 's/import agent_orchestration_pb2 as/from . import agent_orchestration_pb2 as/' \
    ./src/grpc/generated/agent_orchestration_pb2_grpc.py

# Stage 2: Runtime
FROM python:3.11-slim AS runtime

WORKDIR /app

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy application source from builder (includes generated gRPC stubs)
COPY --from=builder /app/src/ src/

# Create non-root user
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# Expose gRPC port
EXPOSE 50051

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import grpc; print('ok')" || exit 1

# Run the service via __main__.py (initializes LLM client, workflows, and gRPC server)
CMD ["python", "-m", "src"]
