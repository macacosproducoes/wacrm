/**
 * Creative Engine - Delivery Provider Interface
 *
 * Decouples creative generation from multi-channel delivery (WhatsApp, Email, Webhook, Mock).
 */

import type { CreativeJob, DeliveryOptions, DeliveryResult } from '../types';

export interface DeliveryProvider {
  readonly channelName: string;

  deliver(
    job: CreativeJob,
    options: DeliveryOptions
  ): Promise<DeliveryResult>;
}
