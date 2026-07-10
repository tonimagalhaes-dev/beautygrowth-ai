import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';

import { LangGraphClientService } from './langgraph-client.service';
import { GrpcErrorHandler, GrpcClientError } from './grpc-error-handler';
import {
  ExecuteWorkflowRequest,
  WorkflowStreamEvent,
} from '../interfaces/grpc-types';

/**
 * Unit tests for LangGraphClientService streaming behavior.
 *
 * Validates:
 * - Stream yields WorkflowStreamEvent objects correctly
 * - Stream handles gRPC error events (wraps into GrpcClientError)
 * - Stream handles end event (terminates iteration)
 * - Connection interruption: LangGraph continues execution server-side
 *   (client simply stops consuming — this is tested by verifying the
 *    iterator completes cleanly on end without requiring cleanup)
 *
 * Requirements: 6.8
 */
describe('LangGraphClientService - Streaming', () => {
  let service: LangGraphClientService;
  let grpcErrorHandler: GrpcErrorHandler;

  /** Mock gRPC call that behaves like an EventEmitter stream */
  let mockStreamCall: EventEmitter;

  /** Mock gRPC client with ExecuteWorkflowStream method */
  let mockGrpcClient: any;

  const mockConfigValues: Record<string, any> = {
    LANGGRAPH_HOST: 'test-host',
    LANGGRAPH_PORT: 50051,
    LANGGRAPH_CALL_TIMEOUT_MS: 30000,
    LANGGRAPH_POOL_MIN: 1,
    LANGGRAPH_POOL_MAX: 10,
    LANGGRAPH_PROTO_PATH: '/fake/path/agent_orchestration.proto',
  };

  const createStreamRequest = (
    overrides: Partial<ExecuteWorkflowRequest> = {},
  ): ExecuteWorkflowRequest => ({
    agentId: 'agent-123',
    tenantId: 'tenant-456',
    userInput: 'test input',
    userId: 'user-789',
    tenantContext: {},
    workflowId: '',
    conversationId: '',
    options: {
      maxSteps: 50,
      timeoutMs: 120000,
      enableStreaming: true,
      metadata: {},
    },
    ...overrides,
  });

  beforeEach(async () => {
    mockStreamCall = new EventEmitter();

    mockGrpcClient = {
      ExecuteWorkflowStream: jest.fn().mockReturnValue(mockStreamCall),
      close: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LangGraphClientService,
        GrpcErrorHandler,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              return mockConfigValues[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LangGraphClientService>(LangGraphClientService);
    grpcErrorHandler = module.get<GrpcErrorHandler>(GrpcErrorHandler);

    // Inject mock client into the pool directly (bypassing proto loading)
    (service as any).clients = [mockGrpcClient];
    (service as any).currentIndex = 0;
  });

  describe('executeWorkflowStream - yields events correctly', () => {
    it('should yield StepStarted events', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      // Emit events asynchronously
      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'llm_call' },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].stepStarted).toEqual({
        nodeId: 'node-1',
        nodeType: 'llm_call',
      });
    });

    it('should yield StepCompleted events', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_completed: {
            result: {
              node_id: 'node-1',
              node_type: 'llm_call',
              output: 'generated text',
              duration_ms: 1500,
              status: 3,
            },
          },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].stepCompleted).toBeDefined();
      expect(events[0].stepCompleted!.result).toEqual({
        node_id: 'node-1',
        node_type: 'llm_call',
        output: 'generated text',
        duration_ms: 1500,
        status: 3,
      });
    });

    it('should yield TokenGenerated events', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          token_generated: { token: 'Hello', node_id: 'node-1' },
        });
        mockStreamCall.emit('data', {
          token_generated: { token: ' World', node_id: 'node-1' },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(2);
      expect(events[0].tokenGenerated).toEqual({ token: 'Hello', nodeId: 'node-1' });
      expect(events[1].tokenGenerated).toEqual({ token: ' World', nodeId: 'node-1' });
    });

    it('should yield WorkflowCompleted as the terminal event', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'llm_call' },
        });
        mockStreamCall.emit('data', {
          workflow_completed: {
            response: { success: true, output: 'final result' },
          },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(2);
      expect(events[1].workflowCompleted).toBeDefined();
      expect(events[1].workflowCompleted!.response).toEqual({
        success: true,
        output: 'final result',
      });
    });

    it('should yield WorkflowError event on workflow failure', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          workflow_error: {
            error_code: 'TIMEOUT',
            error_message: 'Execution timed out',
            node_id: 'node-3',
          },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].workflowError).toEqual({
        errorCode: 'TIMEOUT',
        errorMessage: 'Execution timed out',
        nodeId: 'node-3',
      });
    });

    it('should yield multiple events in chronological order', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'llm_call' },
        });
        mockStreamCall.emit('data', {
          token_generated: { token: 'Hi', node_id: 'node-1' },
        });
        mockStreamCall.emit('data', {
          step_completed: { result: { node_id: 'node-1', output: 'Hi' } },
        });
        mockStreamCall.emit('data', {
          workflow_completed: { response: { success: true, output: 'Hi' } },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(4);
      expect(events[0].stepStarted).toBeDefined();
      expect(events[1].tokenGenerated).toBeDefined();
      expect(events[2].stepCompleted).toBeDefined();
      expect(events[3].workflowCompleted).toBeDefined();
    });
  });

  describe('executeWorkflowStream - handles error events', () => {
    it('should throw GrpcClientError when stream emits a gRPC error', async () => {
      const request = createStreamRequest();

      const iteratorPromise = (async () => {
        const events: WorkflowStreamEvent[] = [];
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
        return events;
      })();

      setImmediate(() => {
        const grpcError = {
          code: 14, // UNAVAILABLE
          message: 'Connection refused',
          details: 'Connection refused',
        };
        mockStreamCall.emit('error', grpcError);
      });

      await expect(iteratorPromise).rejects.toThrow(GrpcClientError);
      await expect(iteratorPromise).rejects.toMatchObject({
        code: 14,
        isRetryable: true,
      });
    });

    it('should throw GrpcClientError on DEADLINE_EXCEEDED', async () => {
      const request = createStreamRequest();

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          // consume
        }
      })();

      setImmediate(() => {
        const timeoutError = {
          code: 4, // DEADLINE_EXCEEDED
          message: 'Deadline exceeded',
          details: 'Deadline exceeded',
        };
        mockStreamCall.emit('error', timeoutError);
      });

      await expect(iteratorPromise).rejects.toThrow(GrpcClientError);
      await expect(iteratorPromise).rejects.toMatchObject({
        code: 4,
        isRetryable: true,
      });
    });

    it('should yield events received before an error occurs', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];
      let thrownError: any = null;

      const iteratorPromise = (async () => {
        try {
          for await (const event of service.executeWorkflowStream(request)) {
            events.push(event);
          }
        } catch (err) {
          thrownError = err;
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'llm_call' },
        });
        // Small delay to ensure the data event is processed first
        setImmediate(() => {
          mockStreamCall.emit('error', {
            code: 14,
            message: 'Lost connection',
            details: 'Lost connection',
          });
        });
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].stepStarted).toEqual({
        nodeId: 'node-1',
        nodeType: 'llm_call',
      });
      expect(thrownError).toBeInstanceOf(GrpcClientError);
    });
  });

  describe('executeWorkflowStream - handles end event', () => {
    it('should terminate iteration cleanly when stream ends', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(0);
    });

    it('should complete normally after receiving all events and end', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
        return 'completed';
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'tool_call' },
        });
        mockStreamCall.emit('end');
      });

      const result = await iteratorPromise;

      expect(result).toBe('completed');
      expect(events).toHaveLength(1);
    });
  });

  describe('executeWorkflowStream - connection interruption', () => {
    /**
     * Requirements: 6.8
     * If the client disconnects, the LangGraph service continues execution
     * server-side and persists the result. From the client perspective,
     * the consumer simply stops iterating — no cleanup is required.
     *
     * This test validates that the client can stop consuming without errors.
     */
    it('should allow consumer to stop iterating without throwing', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      // Consumer stops after receiving 2 events (simulating disconnection)
      const iteratorPromise = (async () => {
        let count = 0;
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
          count++;
          if (count >= 2) {
            break; // Consumer disconnects after 2 events
          }
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          step_started: { node_id: 'node-1', node_type: 'llm_call' },
        });
        mockStreamCall.emit('data', {
          token_generated: { token: 'Hello', node_id: 'node-1' },
        });
        // These events would still be emitted server-side but client won't consume them
        mockStreamCall.emit('data', {
          step_completed: { result: { node_id: 'node-1', output: 'Hello World' } },
        });
        mockStreamCall.emit('end');
      });

      // Should complete without throwing
      await iteratorPromise;

      expect(events).toHaveLength(2);
      expect(events[0].stepStarted).toBeDefined();
      expect(events[1].tokenGenerated).toBeDefined();
    });
  });

  describe('executeWorkflowStream - metadata and deadline', () => {
    it('should call ExecuteWorkflowStream with correct metadata', async () => {
      const request = createStreamRequest({
        tenantId: 'tenant-abc',
        userId: 'user-xyz',
      });

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          // consume
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(mockGrpcClient.ExecuteWorkflowStream).toHaveBeenCalledTimes(1);

      const callArgs = mockGrpcClient.ExecuteWorkflowStream.mock.calls[0];
      const passedMetadata = callArgs[1];

      expect(passedMetadata.get('x-tenant-id')).toEqual(['tenant-abc']);
      expect(passedMetadata.get('x-user-id')).toEqual(['user-xyz']);
      expect(passedMetadata.get('x-trace-id')[0]).toMatch(/^trace-/);
    });

    it('should set deadline option on the stream call', async () => {
      const request = createStreamRequest();

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          // consume
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      const callArgs = mockGrpcClient.ExecuteWorkflowStream.mock.calls[0];
      const options = callArgs[2];

      expect(options.deadline).toBeInstanceOf(Date);
      // Deadline should be approximately now + 30000ms
      const expectedDeadline = Date.now() + 30000;
      expect(options.deadline.getTime()).toBeGreaterThan(Date.now() - 1000);
      expect(options.deadline.getTime()).toBeLessThanOrEqual(expectedDeadline + 1000);
    });

    it('should serialize request to proto format (snake_case)', async () => {
      const request = createStreamRequest({
        agentId: 'agent-test',
        tenantId: 'tenant-test',
        userInput: 'hello world',
        userId: 'user-test',
        workflowId: 'wf-1',
        conversationId: 'conv-1',
        options: {
          maxSteps: 25,
          timeoutMs: 60000,
          enableStreaming: true,
          metadata: { key: 'value' },
        },
      });

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          // consume
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      const callArgs = mockGrpcClient.ExecuteWorkflowStream.mock.calls[0];
      const protoRequest = callArgs[0];

      expect(protoRequest.agentId).toBe('agent-test');
      expect(protoRequest.tenantId).toBe('tenant-test');
      expect(protoRequest.userInput).toBe('hello world');
      expect(protoRequest.userId).toBe('user-test');
      expect(protoRequest.workflowId).toBe('wf-1');
      expect(protoRequest.conversationId).toBe('conv-1');
      expect(protoRequest.options.maxSteps).toBe(25);
      expect(protoRequest.options.timeoutMs).toBe(60000);
      expect(protoRequest.options.enableStreaming).toBe(true);
    });
  });

  describe('executeWorkflowStream - camelCase proto parsing', () => {
    it('should parse camelCase proto fields (stepStarted format)', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        // Some proto loaders emit camelCase keys
        mockStreamCall.emit('data', {
          stepStarted: { nodeId: 'node-1', nodeType: 'condition' },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].stepStarted).toEqual({
        nodeId: 'node-1',
        nodeType: 'condition',
      });
    });

    it('should parse camelCase tokenGenerated events', async () => {
      const request = createStreamRequest();
      const events: WorkflowStreamEvent[] = [];

      const iteratorPromise = (async () => {
        for await (const event of service.executeWorkflowStream(request)) {
          events.push(event);
        }
      })();

      setImmediate(() => {
        mockStreamCall.emit('data', {
          tokenGenerated: { token: 'test', nodeId: 'node-2' },
        });
        mockStreamCall.emit('end');
      });

      await iteratorPromise;

      expect(events).toHaveLength(1);
      expect(events[0].tokenGenerated).toEqual({
        token: 'test',
        nodeId: 'node-2',
      });
    });
  });
});
