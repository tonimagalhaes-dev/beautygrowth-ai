.PHONY: proto clean-proto

PROTO_DIR := ../proto
PROTO_FILE := $(PROTO_DIR)/agent_orchestration.proto
PYTHON_OUT := src/grpc/generated

# Gera stubs Python a partir do Protobuf
proto:
	@echo "==> Gerando stubs Python gRPC..."
	@mkdir -p $(PYTHON_OUT)
	python -m grpc_tools.protoc \
		--proto_path=$(PROTO_DIR) \
		--python_out=$(PYTHON_OUT) \
		--grpc_python_out=$(PYTHON_OUT) \
		--pyi_out=$(PYTHON_OUT) \
		$(PROTO_FILE)
	@touch $(PYTHON_OUT)/__init__.py
	@echo "==> Stubs Python gerados em $(PYTHON_OUT)"

# Remove stubs gerados
clean-proto:
	@echo "==> Removendo stubs gerados..."
	rm -f $(PYTHON_OUT)/agent_orchestration_pb2.py
	rm -f $(PYTHON_OUT)/agent_orchestration_pb2_grpc.py
	rm -f $(PYTHON_OUT)/agent_orchestration_pb2.pyi
	@echo "==> Limpo."
