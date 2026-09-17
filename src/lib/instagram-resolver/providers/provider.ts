/**
 * Instagram Profile Provider Interface
 *
 * Decouples profile resolution from specific external providers or APIs.
 */

import type { InstagramProfileData } from '../types';

export interface InstagramProfileProvider {
  readonly providerName: string;

  /**
   * Resolves an Instagram profile by username.
   * Returns null or throws if profile cannot be found or resolved.
   */
  resolve(username: string): Promise<InstagramProfileData>;
}
