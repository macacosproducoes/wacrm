/**
 * Creative Engine - Mock Delivery Provider
 *
 * Used for automated testing, previews, and dry-run environments without external side-effects.
 */

import type { DeliveryProvider } from './provider';
import type { CreativeJob, DeliveryOptions, DeliveryResult } from '../types';

export class MockDeliveryProvider implements DeliveryProvider {
  readonly channelName = 'mock';

  public deliveredCalls: Array<{ job: CreativeJob; options: DeliveryOptions }> = [];

  async deliver(
    job: CreativeJob,
    options: DeliveryOptions
  ): Promise<DeliveryResult> {
    this.deliveredCalls.push({ job, options });

    return {
      success: true,
      deliveryId: `mock-del-${Date.now()}`,
      providerMessageId: `mock-msg-${Math.random().toString(36).substring(2, 9)}`,
    };
  }
}
