import { Controller, Get } from '@nestjs/common';

import { EventBusHealth } from '../interfaces';
import { EventBusService } from '../services/event-bus.service';

/**
 * Health controller for the Event Bus.
 * Exposes GET /events/health for monitoring Event Bus status.
 *
 * Returns:
 * - Redis connection status (up/down)
 * - Number of active queues
 * - Number of active workers
 * - Aggregated metrics from the last 5 minutes
 *
 * @see Requirements 7.4
 */
@Controller('events')
export class EventBusHealthController {
  constructor(private readonly eventBusService: EventBusService) {}

  /**
   * Returns Event Bus health status including:
   * - Redis connection status (up/down)
   * - Number of active queues
   * - Number of active workers
   * - Aggregated metrics from the last 5 minutes
   */
  @Get('health')
  async getHealth(): Promise<EventBusHealth> {
    return this.eventBusService.getHealth();
  }
}
