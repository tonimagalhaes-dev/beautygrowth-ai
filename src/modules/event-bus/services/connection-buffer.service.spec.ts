import {
  BASE_RETRY_DELAY_MS,
  CONNECTION_BUFFER_TTL_MS,
  MAX_RECONNECT_DELAY_MS,
} from '../config/event-bus.constants';
import {
  BufferedEvent,
  ConnectionBuffer,
} from './connection-buffer.service';

describe('ConnectionBuffer', () => {
  let buffer: ConnectionBuffer;

  beforeEach(() => {
    buffer = new ConnectionBuffer();
  });

  describe('bufferEvent()', () => {
    it('should add event to the buffer', () => {
      const event: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'abc-123' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(event);
      expect(buffer.getBufferSize()).toBe(1);
    });

    it('should accumulate multiple events in FIFO order', () => {
      const event1: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now(),
      };
      const event2: BufferedEvent = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-2' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(event1);
      buffer.bufferEvent(event2);
      expect(buffer.getBufferSize()).toBe(2);
    });
  });

  describe('flush()', () => {
    it('should drain all buffered events via callback in FIFO order', async () => {
      const flushed: BufferedEvent[] = [];
      const event1: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now(),
      };
      const event2: BufferedEvent = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-2' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(event1);
      buffer.bufferEvent(event2);

      await buffer.flush(async (event) => {
        flushed.push(event);
      });

      expect(flushed).toHaveLength(2);
      expect(flushed[0].eventName).toBe('tenant.created');
      expect(flushed[1].eventName).toBe('brand.updated');
      expect(buffer.getBufferSize()).toBe(0);
    });

    it('should re-buffer events that fail during flush', async () => {
      const event1: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now(),
      };
      const event2: BufferedEvent = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-2' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(event1);
      buffer.bufferEvent(event2);

      let callCount = 0;
      await buffer.flush(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Redis unavailable');
        }
      });

      // First event flushed OK, second event re-buffered
      expect(buffer.getBufferSize()).toBe(1);
    });

    it('should handle empty buffer gracefully', async () => {
      const flushed: BufferedEvent[] = [];
      await buffer.flush(async (event) => {
        flushed.push(event);
      });

      expect(flushed).toHaveLength(0);
      expect(buffer.getBufferSize()).toBe(0);
    });
  });

  describe('pruneExpired()', () => {
    it('should remove events that exceed the TTL', () => {
      const expiredEvent: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now() - CONNECTION_BUFFER_TTL_MS - 1,
      };
      const freshEvent: BufferedEvent = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-2' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(expiredEvent);
      buffer.bufferEvent(freshEvent);
      buffer.pruneExpired();

      expect(buffer.getBufferSize()).toBe(1);
    });

    it('should not remove events within TTL', () => {
      const freshEvent: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(freshEvent);
      buffer.pruneExpired();

      expect(buffer.getBufferSize()).toBe(1);
    });

    it('should handle empty buffer gracefully', () => {
      buffer.pruneExpired();
      expect(buffer.getBufferSize()).toBe(0);
    });
  });

  describe('isBufferExpired()', () => {
    it('should return true when any event exceeds TTL', () => {
      const expiredEvent: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now() - CONNECTION_BUFFER_TTL_MS - 1,
      };

      buffer.bufferEvent(expiredEvent);
      expect(buffer.isBufferExpired()).toBe(true);
    });

    it('should return false when all events are within TTL', () => {
      const freshEvent: BufferedEvent = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        bufferedAt: Date.now(),
      };

      buffer.bufferEvent(freshEvent);
      expect(buffer.isBufferExpired()).toBe(false);
    });

    it('should return false for empty buffer', () => {
      expect(buffer.isBufferExpired()).toBe(false);
    });
  });

  describe('getReconnectDelay()', () => {
    it('should return BASE_RETRY_DELAY_MS on first attempt (attempt 0)', () => {
      expect(buffer.getReconnectDelay()).toBe(BASE_RETRY_DELAY_MS); // 1000
    });

    it('should follow exponential backoff sequence: 1s, 2s, 4s, 8s, 16s', () => {
      expect(buffer.getReconnectDelay()).toBe(1000);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectDelay()).toBe(2000);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectDelay()).toBe(4000);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectDelay()).toBe(8000);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectDelay()).toBe(16000);
    });

    it('should cap at MAX_RECONNECT_DELAY_MS (16000)', () => {
      // Go well beyond the cap
      for (let i = 0; i < 10; i++) {
        buffer.incrementReconnectAttempt();
      }
      expect(buffer.getReconnectDelay()).toBe(MAX_RECONNECT_DELAY_MS);
    });
  });

  describe('incrementReconnectAttempt()', () => {
    it('should increment the attempt counter', () => {
      expect(buffer.getReconnectAttemptCount()).toBe(0);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectAttemptCount()).toBe(1);

      buffer.incrementReconnectAttempt();
      expect(buffer.getReconnectAttemptCount()).toBe(2);
    });
  });

  describe('resetReconnectAttempt()', () => {
    it('should reset the attempt counter to 0', () => {
      buffer.incrementReconnectAttempt();
      buffer.incrementReconnectAttempt();
      buffer.incrementReconnectAttempt();

      buffer.resetReconnectAttempt();
      expect(buffer.getReconnectAttemptCount()).toBe(0);
      expect(buffer.getReconnectDelay()).toBe(BASE_RETRY_DELAY_MS);
    });
  });
});
